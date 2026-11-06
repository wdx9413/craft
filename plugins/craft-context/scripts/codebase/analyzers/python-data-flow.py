"""Bounded, intra-procedural Python may-reaching definitions for one checkpoint document."""
import ast
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath

MAX_SOURCE_BYTES = 1_048_576
MAX_EVENTS = 4_000
MAX_DEFINITIONS = 2_000
MAX_FLOWS = 12_000
MAX_FIXED_POINT_STEPS = 2_000


def _identity(parts):
    return hashlib.sha256(json.dumps(parts, ensure_ascii=True, separators=(",", ":")).encode()).hexdigest()[-20:]


def _load_control_flow():
    path = Path(__file__).resolve().with_name("python-control-flow.py")
    spec = importlib.util.spec_from_file_location("craft_python_control_flow", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Python control-flow analyzer is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _offsets(content):
    lines = content.splitlines(keepends=True)
    prefixes = [0]
    for line in lines:
        prefixes.append(prefixes[-1] + len(line.encode("utf-16-le")) // 2)

    def offset(line, byte_column):
        current = lines[line - 1] if 0 < line <= len(lines) else ""
        column = len(current.encode("utf-8")[:byte_column].decode("utf-8", errors="ignore"))
        return prefixes[line - 1] + len(current[:column].encode("utf-16-le")) // 2

    return lines, offset


def _find_target(tree, lines, offset, symbol):
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) or node.name != symbol["name"]:
            continue
        line = lines[node.lineno - 1]
        start = line.find(node.name, len(line) - len(line.lstrip()))
        if start >= 0 and offset(node.lineno, len(line[:start].encode("utf-8"))) == symbol["start_offset"]:
            return node
    return None


def _contains_name(node, name):
    return any(isinstance(child, ast.Name) and child.id == name for child in ast.walk(node))


def build_python_data_flow(data):
    # Reuse the CFG adapter's strict path, source digest, symbol and syntax checks.
    cfg = _load_control_flow().build_python_control_flow(data)
    documents = data["documents"]
    document = documents[0]
    content = document["content"]
    path = document["path"]
    symbol = data["symbol"]
    variable = data.get("variable")
    if not isinstance(variable, str) or not variable.strip() or len(variable) > 256:
        raise ValueError("Python data-flow variable name is invalid")
    if not variable.isidentifier():
        raise ValueError("Python data-flow variable must be an identifier")
    if cfg.get("status") == "partial" and not cfg.get("blocks"):
        return {"format": "craft-python-data-flow-v1", "status": "partial", "language": "python", "symbol_id": symbol["id"],
                "variable": variable, "candidates": [], "definitions": [], "uses": [], "flows": [],
                "partial_reasons": cfg.get("partial_reasons", ["SyntaxErrors"]), "source_content_included": False,
                "interprocedural": False}

    tree = ast.parse(content, filename=path)
    lines, offset = _offsets(content)
    target = _find_target(tree, lines, offset, symbol)
    if target is None:
        raise ValueError("Python data-flow symbol does not match a function in the checkpoint")

    unsupported = set(cfg.get("partial_reasons", []))
    local_nodes = []
    nested_scope_reference = False

    def collect(node):
        nonlocal nested_scope_reference
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
            if _contains_name(node, variable):
                nested_scope_reference = True
            return
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            if _contains_name(node, variable):
                unsupported.add("ComprehensionScopeNotModeled")
            return
        local_nodes.append(node)
        for child in ast.iter_child_nodes(node):
            collect(child)

    for statement in target.body:
        collect(statement)
    if nested_scope_reference:
        unsupported.add("NestedScopeReferenceNotModeled")

    blocks = cfg["blocks"]
    block_ids = [block["id"] for block in blocks]
    entry_id = cfg["entry_id"]
    candidates = []
    declarations = []
    parameters = [*target.args.posonlyargs, *target.args.args, *target.args.kwonlyargs]
    if target.args.vararg:
        parameters.append(target.args.vararg)
    if target.args.kwarg:
        parameters.append(target.args.kwarg)
    for argument in parameters:
        if argument.arg == variable:
            start = offset(argument.lineno, argument.col_offset)
            end = offset(argument.end_lineno or argument.lineno, argument.end_col_offset or argument.col_offset)
            declarations.append({"span": {"start_offset": start, "end_offset": end}, "kind": "parameter", "node": argument})

    for node in local_nodes:
        if isinstance(node, (ast.Global, ast.Nonlocal)) and variable in node.names:
            unsupported.add("GlobalOrNonlocalNameNotModeled")
        if isinstance(node, ast.Name) and node.id == variable and isinstance(node.ctx, ast.Store):
            declarations.append({"span": {"start_offset": offset(node.lineno, node.col_offset),
                "end_offset": offset(node.end_lineno or node.lineno, node.end_col_offset or node.col_offset)},
                "kind": "local", "node": node})
        if isinstance(node, ast.Import):
            for alias in node.names:
                bound_name = alias.asname or alias.name.split(".")[0]
                if bound_name == variable:
                    declarations.append({"span": {"start_offset": offset(alias.lineno, alias.col_offset),
                        "end_offset": offset(alias.end_lineno or alias.lineno, alias.end_col_offset or alias.col_offset)},
                        "kind": "local", "node": alias})
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if (alias.asname or alias.name) == variable:
                    declarations.append({"span": {"start_offset": offset(alias.lineno, alias.col_offset),
                        "end_offset": offset(alias.end_lineno or alias.lineno, alias.end_col_offset or alias.col_offset)},
                        "kind": "local", "node": alias})
    # Python has one local slot per name in a function. Preserve a single candidate even when it has many definitions.
    has_local = bool(declarations)
    if not has_local:
        return {"format": "craft-python-data-flow-v1", "status": "not_found", "language": "python", "symbol_id": symbol["id"],
                "variable": variable, "candidates": [], "definitions": [], "uses": [], "flows": [],
                "partial_reasons": sorted(unsupported), "source_content_included": False, "interprocedural": False}
    candidate_span = next((item["span"] for item in declarations if item["kind"] == "parameter"), declarations[0]["span"])
    variable_id = "py_data_flow_var_" + _identity([symbol["id"], variable, candidate_span["start_offset"]])
    candidates = [{"variable_id": variable_id, "name": variable,
                   "kind": "parameter" if any(item["kind"] == "parameter" for item in declarations) else "local",
                   "declaration_span": candidate_span}]

    # Route AST positions through the existing checkpoint CFG's smallest containing block.
    def block_for(start, end):
        matching = []
        for block in blocks:
            span = block["span"]
            if span["start_offset"] <= start and span["end_offset"] >= end:
                matching.append((span["end_offset"] - span["start_offset"], block["id"]))
        return min(matching)[1] if matching else None

    events = []
    definitions = []
    uses = []
    omitted_events = 0
    omitted_flows = 0

    def span_for(node):
        return {"start_offset": offset(node.lineno, node.col_offset),
                "end_offset": offset(node.end_lineno or node.lineno, node.end_col_offset or node.col_offset)}

    def add_definition(node, source, order=None):
        nonlocal omitted_events
        if len(events) >= MAX_EVENTS or len(definitions) >= MAX_DEFINITIONS:
            omitted_events += 1
            unsupported.add("EventBudgetExceeded")
            return
        span = span_for(node)
        block = block_for(span["start_offset"], span["end_offset"])
        if block is None:
            unsupported.add("UnmappedDefinition")
            return
        definition = {"id": "py_data_flow_def_" + _identity([variable_id, span["start_offset"], source]),
                      "variable_id": variable_id, "name": variable, "source": source, "span": span, "block": block}
        definitions.append(definition)
        events.append((block, order if order is not None else span["end_offset"] + 1, "definition", definition))

    def add_use(node):
        nonlocal omitted_events
        if len(events) >= MAX_EVENTS:
            omitted_events += 1
            unsupported.add("EventBudgetExceeded")
            return
        span = span_for(node)
        block = block_for(span["start_offset"], span["end_offset"])
        if block is None:
            unsupported.add("UnmappedUse")
            return
        use = {"id": "py_data_flow_use_" + _identity([variable_id, span["start_offset"]]),
               "variable_id": variable_id, "name": variable, "span": span, "block": block}
        uses.append(use)
        events.append((block, span["start_offset"], "use", use))

    for item in declarations:
        node = item["node"]
        if isinstance(node, ast.arg) and item["kind"] == "parameter":
            definition = {"id": "py_data_flow_def_" + _identity([variable_id, "parameter"]),
                          "variable_id": variable_id, "name": variable, "source": "parameter", "span": item["span"], "block": entry_id}
            definitions.append(definition)
            events.append((entry_id, -1, "definition", definition))

    def assignment_targets(node):
        direct = []
        mentions = False
        for child in ast.walk(node):
            if isinstance(child, ast.Name) and child.id == variable:
                mentions = True
                if isinstance(child.ctx, ast.Store):
                    direct.append(child)
        if mentions and not (isinstance(node, ast.Name) and direct):
            unsupported.add("FieldWriteNotModeled" if isinstance(node, ast.Attribute) else "DestructuredVariable")
        return direct

    for node in local_nodes:
        if isinstance(node, ast.Assign):
            targets = [name for target_node in node.targets for name in assignment_targets(target_node)]
            if len(targets) > 1:
                unsupported.add("MultipleWritesInStatement")
            for name in targets:
                add_definition(name, "assignment", offset(node.end_lineno or node.lineno, node.end_col_offset or node.col_offset) + 1)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                bound_name = alias.asname or (alias.name.split(".")[0] if isinstance(node, ast.Import) else alias.name)
                if bound_name == variable:
                    add_definition(alias, "import", offset(node.end_lineno or node.lineno, node.end_col_offset or node.col_offset) + 1)
        elif isinstance(node, ast.AnnAssign):
            targets = assignment_targets(node.target)
            if targets and node.value is not None:
                for name in targets:
                    add_definition(name, "assignment", offset(node.end_lineno or node.lineno, node.end_col_offset or node.col_offset) + 1)
            elif targets:
                unsupported.add("UninitializedAnnotation")
        elif isinstance(node, ast.NamedExpr):
            for name in assignment_targets(node.target):
                add_definition(name, "assignment", offset(node.end_lineno or node.lineno, node.end_col_offset or node.col_offset) + 1)
        elif isinstance(node, ast.AugAssign) and isinstance(node.target, ast.Name) and node.target.id == variable:
            add_use(node.target)
            add_definition(node.target, "assignment", offset(node.end_lineno or node.lineno, node.end_col_offset or node.col_offset) + 1)
        elif isinstance(node, (ast.For, ast.AsyncFor)):
            targets = assignment_targets(node.target)
            if targets:
                unsupported.add("LoopTargetAssignmentApproximate")
                for name in targets:
                    add_definition(name, "loop_target", offset(node.end_lineno or node.lineno, node.end_col_offset or node.col_offset) + 1)
        elif isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                if item.optional_vars:
                    if assignment_targets(item.optional_vars):
                        unsupported.add("WithTargetAssignmentNotModeled")
        elif isinstance(node, ast.ExceptHandler) and node.name == variable:
            unsupported.add("ExceptionTargetNotModeled")
        elif isinstance(node, ast.Delete):
            if _contains_name(node, variable):
                unsupported.add("DeleteNotModeled")

    for node in local_nodes:
        if isinstance(node, ast.Name) and node.id == variable and isinstance(node.ctx, ast.Load):
            add_use(node)

    definitions_by_block = {}
    for block, order, kind, value in events:
        if kind == "definition":
            definitions_by_block.setdefault(block, []).append((order, value))

    successors = {block_id: [] for block_id in block_ids}
    predecessors = {block_id: [] for block_id in block_ids}
    for edge in cfg["edges"]:
        source, target_id = edge["from_block_id"], edge["to_block_id"]
        if source in successors and target_id in predecessors:
            successors[source].append(target_id)
            predecessors[target_id].append(source)
    reachable = set()
    pending = [entry_id]
    while pending:
        current = pending.pop()
        if current in reachable:
            continue
        reachable.add(current)
        pending.extend(successors[current])

    incoming = {block_id: set() for block_id in block_ids}
    outgoing = {block_id: set() for block_id in block_ids}
    changed = True
    steps = 0
    while changed and steps < MAX_FIXED_POINT_STEPS:
        changed = False
        steps += 1
        for block_id in block_ids:
            if block_id not in reachable:
                continue
            next_in = set().union(*(outgoing[source] for source in predecessors[block_id] if source in reachable))
            block_definitions = sorted(definitions_by_block.get(block_id, []), key=lambda item: item[0])
            next_out = set(next_in)
            for _, definition in block_definitions:
                next_out.clear()
                next_out.add(definition["id"])
            if next_in != incoming[block_id] or next_out != outgoing[block_id]:
                incoming[block_id], outgoing[block_id] = next_in, next_out
                changed = True
    if changed:
        unsupported.add("FixedPointBudgetExceeded")

    for definition in definitions:
        definition["reachable"] = definition["block"] in reachable
    flows = []
    events_by_block = {}
    for event in events:
        events_by_block.setdefault(event[0], []).append(event)
    for block_id, block_events in events_by_block.items():
        state = set(incoming[block_id])
        for _, _, kind, value in sorted(block_events, key=lambda event: (event[1], 0 if event[2] == "use" else 1)):
            if kind == "use":
                value["reachable"] = block_id in reachable
                if block_id in reachable:
                    for definition_id in sorted(state):
                        if len(flows) >= MAX_FLOWS:
                            omitted_flows += 1
                            unsupported.add("FlowBudgetExceeded")
                            break
                        flows.append({"from_definition_id": definition_id, "to_use_id": value["id"],
                                      "variable_id": variable_id, "kind": "may_reach"})
            else:
                state.clear()
                state.add(value["id"])
    return {"format": "craft-python-data-flow-v1", "status": "partial" if unsupported else "complete", "language": "python",
            "symbol_id": symbol["id"], "variable": variable, "candidates": candidates, "definitions": definitions,
            "uses": uses, "flows": flows[:MAX_FLOWS], "partial_reasons": sorted(unsupported),
            "omitted_event_count": omitted_events, "omitted_flow_count": omitted_flows,
            "source_content_included": False, "interprocedural": False,
            "max_events": MAX_EVENTS, "max_flows": MAX_FLOWS}
