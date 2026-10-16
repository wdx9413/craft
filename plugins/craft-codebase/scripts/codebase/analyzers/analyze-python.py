# /// script
# requires-python = ">=3.10"
# dependencies = ["jedi==0.19.2"]
# ///
"""Static Jedi analysis of supplied checkpoint documents. Never imports their code.
Usage: uv run scripts/codebase/analyze-python.py checkpoint-documents.json
Input: {"documents": [{"path": "module.py", "content": "...", "source_digest": "sha256 hex"}]}
Output is accepted by craft_codebase_analysis_import. External/dynamic targets remain unresolved.
"""
import ast
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import sys
import tempfile
try:
    import jedi
except ImportError:
    jedi = None

MAX_NODES = 60_000
MAX_EDGES = 150_000
MAX_ANALYSIS_CHARS = 32_000_000
PYTHON_ANALYZER_SCHEMA = "craft-python-semantic-v4"


def analyze_with_jedi(data):
    documents = data["documents"]
    if not documents or len(documents) > 2000 or len(json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > 24_000_000:
        raise ValueError("Python checkpoint exceeds budget or is empty")
    nodes, edges, lookup, sources = [], [], {}, {}
    with tempfile.TemporaryDirectory(prefix="craft-python-analysis-") as directory:
        root = Path(directory)
        for doc in documents:
            path = PurePosixPath(doc["path"])
            if path.is_absolute() or ".." in path.parts or "\\" in str(path) or path.suffix != ".py" or str(path) in sources:
                raise ValueError("Unsafe, duplicate or unsupported Python path")
            body = doc["content"]
            if hashlib.sha256(body.encode()).hexdigest() != doc["source_digest"]:
                raise ValueError("Python checkpoint digest mismatch")
            absolute = root / str(path)
            absolute.parent.mkdir(parents=True, exist_ok=True)
            absolute.write_text(body, encoding="utf-8")
            sources[str(path)] = doc
        project = jedi.Project(directory, sys_path=[directory], smart_sys_path=False, load_unsafe_extensions=False)
        # Analysis is serial and checkpoint files are immutable for the entire run.

        lines_by_path = {path: doc["content"].splitlines(keepends=True) for path, doc in sources.items()}
        line_offsets = {path: _line_prefixes(lines) for path, lines in lines_by_path.items()}
        nodes_by_id = {}

        def utf16(path, line, column):
            lines = lines_by_path[path]
            current = lines[line - 1] if 0 < line <= len(lines) else ""
            return line_offsets[path][line - 1] + len(current[:column].encode("utf-16-le")) // 2

        def add_node(path, name, line, column, kind, declaration_kind=None):
            start = utf16(path, line, column) if kind == "symbol" else 0
            identity = "py_" + hashlib.sha256(json.dumps([path, name, start]).encode()).hexdigest()[:24]
            node = {"id": identity, "kind": kind, "path": path, "name": name, "language": "python",
                    "source_digest": sources[path]["source_digest"],
                    "span": {"start_offset": start, "end_offset": start + len(name.encode("utf-16-le")) // 2 if kind == "symbol" else 0}}
            if kind == "symbol":
                node["declaration_kind"] = declaration_kind or "symbol"
            nodes.append(node)
            nodes_by_id[identity] = node
            lookup[(path, line, column)] = identity
            return identity

        scripts, file_nodes = {}, {}
        for path, doc in sources.items():
            file_nodes[path] = add_node(path, path, 0, 0, "file")
            script = jedi.Script(doc["content"], path=root / path, project=project)
            if script.get_syntax_errors():
                raise ValueError("Python syntax errors in checkpoint")
            scripts[path] = script
            declaration_spans = {}
            lines = lines_by_path[path]
            for item in ast.walk(ast.parse(doc["content"], filename=path)):
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and item.end_lineno is not None and item.end_col_offset is not None:
                    declaration_spans[(item.lineno, item.name)] = {
                        "start_offset": _utf16_offset(lines, item.lineno, item.col_offset, line_offsets[path]),
                        "end_offset": _utf16_offset(lines, item.end_lineno, item.end_col_offset, line_offsets[path]),
                    }
            for name in script.get_names(all_scopes=True, definitions=True, references=False):
                declaration_kind = {"function": "function", "class": "class", "statement": "variable", "param": "parameter",
                                    "module": "module", "import": "import"}.get(name.type, "symbol")
                node_id = add_node(path, name.name, name.line, name.column, "symbol", declaration_kind)
                declaration_span = declaration_spans.get((name.line, name.name))
                if declaration_span:
                    nodes_by_id[node_id]["declaration_span"] = declaration_span
        unresolved = 0
        for path, script in scripts.items():
            body = sources[path]["content"]
            lines = body.splitlines(keepends=True)
            for call in (node for node in ast.walk(ast.parse(body)) if isinstance(node, ast.Call)):
                expr = call.func
                line = expr.end_lineno
                column = len(lines[line - 1].encode()[:expr.end_col_offset].decode())
                target_ids = set()
                for target in script.infer(line, column):
                    try:
                        target_path = str(target.module_path.relative_to(root))
                    except (AttributeError, ValueError):
                        continue
                    target_id = lookup.get((target_path, target.line, target.column))
                    if target_id:
                        target_ids.add(target_id)
                owner = script.get_context(call.lineno, len(lines[call.lineno - 1].encode()[:call.col_offset].decode()))
                from_id = lookup.get((path, owner.line, owner.column), file_nodes[path])
                start_column = len(lines[expr.lineno - 1].encode()[:expr.col_offset].decode())
                for target_id in sorted(target_ids):
                    edges.append({"kind": "calls", "from_node_id": from_id, "to_node_id": target_id,
                                  "source_span": {"start_offset": utf16(path, expr.lineno, start_column), "end_offset": utf16(path, line, column)}})
                if not target_ids:
                    unresolved += 1
        return bound_graph({"format": "craft-static-analysis-v1", "analyzer": "jedi-static", "analyzer_version": f"{jedi.__version__}:{PYTHON_ANALYZER_SCHEMA}",
                "nodes": nodes, "edges": edges, "diagnostics": {"unresolved_calls": unresolved, "external_resolution": False}})


def _line_prefixes(lines):
    prefixes = [0]
    for item in lines:
        prefixes.append(prefixes[-1] + len(item.encode("utf-16-le")) // 2)
    return prefixes


def _utf16_offset(lines, line, byte_column, prefixes=None):
    prefixes = prefixes if prefixes is not None else _line_prefixes(lines)
    current = lines[line - 1] if 0 < line <= len(lines) else ""
    column = len(current.encode("utf-8")[:byte_column].decode("utf-8", errors="ignore"))
    return prefixes[line - 1] + len(current[:column].encode("utf-16-le")) // 2


def _node_id(path, name, start):
    identity = json.dumps([path, name, start], ensure_ascii=True, separators=(",", ":"))
    return "py_" + hashlib.sha256(identity.encode()).hexdigest()[:24]


def _module_path(path, module, level=0):
    parts = list(PurePosixPath(path).parent.parts) if level else []
    if level:
        parts = parts[:max(0, len(parts) - level + 1)]
    if module:
        parts.extend(module.split("."))
    return "/".join(part for part in parts if part and part != ".")


def analyze_with_ast(data):
    documents = data["documents"]
    if not documents or len(documents) > 2000 or len(json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > 24_000_000:
        raise ValueError("Python checkpoint exceeds budget or is empty")
    parsed, sources, syntax_errors, lines_by_path, offsets_by_path = {}, {}, [], {}, {}
    for doc in documents:
        path = PurePosixPath(doc["path"])
        if path.is_absolute() or ".." in path.parts or "\\" in str(path) or path.suffix != ".py" or str(path) in sources:
            raise ValueError("Unsafe, duplicate or unsupported Python path")
        body = doc["content"]
        if not isinstance(body, str) or hashlib.sha256(body.encode()).hexdigest() != doc["source_digest"]:
            raise ValueError("Python checkpoint digest mismatch")
        sources[str(path)] = doc
        lines_by_path[str(path)] = body.splitlines(keepends=True)
        offsets_by_path[str(path)] = _line_prefixes(lines_by_path[str(path)])
    output_paths = data.get("include_paths", list(sources))
    if not isinstance(output_paths, list) or len(output_paths) != len(set(output_paths)) or any(path not in sources for path in output_paths):
        raise ValueError("Python analysis include_paths must be unique checkpoint paths")
    output_paths = set(output_paths)

    # An incremental request may reuse symbols and class method membership for
    # unaffected modules. If any checkpoint/cache identity is incomplete, parse
    # the full checkpoint and return complete file units instead.
    cached_units = data.get("cached_file_units")
    cache_by_path = {unit.get("path"): unit for unit in cached_units if isinstance(unit, dict)} if isinstance(cached_units, list) else {}
    expected_cached = set(sources) - output_paths
    cache_valid = bool(expected_cached) and len(cache_by_path) == len(cached_units or []) and set(cache_by_path) == expected_cached
    if cache_valid:
        for path, unit in cache_by_path.items():
            if (unit.get("source_digest") != sources[path]["source_digest"] or unit.get("analyzer") != "python-ast-static"
                or unit.get("analyzer_version") != PYTHON_ANALYZER_SCHEMA or unit.get("incremental_safe") is not True
                or unit.get("budget_limited") is not False or not isinstance(unit.get("nodes"), list)
                or not isinstance(unit.get("edges"), list) or not isinstance(unit.get("class_methods"), list)):
                cache_valid = False
                break
    cache_fallback = bool(expected_cached) and not cache_valid
    if cache_fallback:
        output_paths = set(sources)
        cache_by_path = {}
    parse_paths = output_paths if cache_valid else set(sources)
    for path in parse_paths:
        try:
            parsed[path] = ast.parse(sources[path]["content"], filename=path)
        except SyntaxError as error:
            syntax_errors.append({"path": path, "line": error.lineno, "kind": "syntax_error"})

    nodes, edges, file_nodes, definitions, symbols_by_location, class_method_ids, imports = [], [], {}, {}, {}, {}, {}
    for path, doc in sources.items():
        body = doc["content"]
        lines = lines_by_path[path]
        file_id = _node_id(path, path, 0)
        file_nodes[path] = file_id
        if path in output_paths:
            nodes.append({"id": file_id, "kind": "file", "path": path, "name": path, "language": "python",
                          "source_digest": doc["source_digest"], "span": {"start_offset": 0, "end_offset": 0}})
        tree = parsed.get(path)
        if tree is None:
            continue
        parent_by_node = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
        for item in ast.walk(tree):
            if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                line = item.lineno
                source_line = lines[line - 1]
                name_column = source_line.find(item.name, len(source_line) - len(source_line.lstrip()))
                start = _utf16_offset(lines, line, len(source_line[:name_column].encode("utf-8")), offsets_by_path[path])
                identifier = _node_id(path, item.name, start)
                end = start + len(item.name.encode("utf-16-le")) // 2
                declaration_kind = "class" if isinstance(item, ast.ClassDef) else "method" if isinstance(parent_by_node.get(item), ast.ClassDef) else "function"
                if path in output_paths:
                    declaration_start = _utf16_offset(lines, item.lineno, item.col_offset, offsets_by_path[path])
                    declaration_end = _utf16_offset(lines, item.end_lineno, item.end_col_offset, offsets_by_path[path])
                    nodes.append({"id": identifier, "kind": "symbol", "path": path, "name": item.name, "language": "python",
                                  "declaration_kind": declaration_kind,
                                  "source_digest": doc["source_digest"], "span": {"start_offset": start, "end_offset": end},
                                  "declaration_span": {"start_offset": declaration_start, "end_offset": declaration_end}})
                definitions.setdefault((path, item.name), []).append(identifier)
                symbols_by_location[(path, item.lineno, item.name)] = identifier
        for item in ast.walk(tree):
            if isinstance(item, ast.ClassDef):
                class_id = symbols_by_location.get((path, item.lineno, item.name))
                if class_id is None:
                    continue
                methods = {}
                for child in item.body:
                    if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        method_id = symbols_by_location.get((path, child.lineno, child.name))
                        if method_id:
                            methods.setdefault(child.name, []).append(method_id)
                class_method_ids[(path, item.name)] = {"class_id": class_id, "methods": methods}

    for path, unit in cache_by_path.items():
        # Keep unchanged nodes available to the graph-budget and dangling-edge
        # checks. Only requested file units are emitted below.
        nodes.extend(unit["nodes"])
        edges.extend(unit["edges"])
        for node in unit["nodes"]:
            if node.get("kind") == "symbol" and isinstance(node.get("name"), str) and isinstance(node.get("id"), str):
                definitions.setdefault((path, node["name"]), []).append(node["id"])
        for entry in unit["class_methods"]:
            name, class_id, methods = entry.get("name"), entry.get("class_id"), entry.get("methods")
            if isinstance(name, str) and isinstance(class_id, str) and isinstance(methods, dict):
                class_method_ids[(path, name)] = {"class_id": class_id, "methods": methods}

    def add_edge(kind, source, target, path, start_line, start_col, end_line, end_col):
        if path not in output_paths:
            return
        body_lines = lines_by_path[path]
        start = _utf16_offset(body_lines, start_line, start_col, offsets_by_path[path])
        end = _utf16_offset(body_lines, end_line, end_col, offsets_by_path[path])
        edges.append({"kind": kind, "from_node_id": source, "to_node_id": target,
                      "source_span": {"start_offset": start, "end_offset": end}})

    module_files = {}
    for path in sources:
        stem = path[:-3] if path.endswith(".py") else path
        module_files[stem.replace("/", ".")] = path
        module_files[stem] = path
        if stem.endswith("/__init__"):
            module_files[stem[:-9].replace("/", ".")] = path
    unresolved_imports_by_path = {path: 0 for path in output_paths}
    for path, tree in parsed.items():
        aliases = {}
        imports[path] = aliases
        for item in ast.walk(tree):
            if isinstance(item, ast.Import):
                for alias in item.names:
                    module = alias.name if alias.asname else alias.name.split(".")[0]
                    target_path = module_files.get(alias.name if alias.asname else module)
                    aliases[module] = (target_path, "")
                    if target_path:
                        add_edge("imports", file_nodes[path], file_nodes[target_path], path, item.lineno, item.col_offset, item.end_lineno, item.end_col_offset)
                    else:
                        if path in output_paths:
                            unresolved_imports_by_path[path] += 1
            elif isinstance(item, ast.ImportFrom):
                module = _module_path(path, item.module or "", item.level)
                target_path = module_files.get(module)
                for alias in item.names:
                    local = alias.asname or alias.name
                    aliases[local] = (target_path, alias.name)
                if target_path:
                    add_edge("imports", file_nodes[path], file_nodes[target_path], path, item.lineno, item.col_offset, item.end_lineno, item.end_col_offset)
                else:
                    if path in output_paths:
                        unresolved_imports_by_path[path] += 1

    unresolved_calls_by_path = {path: 0 for path in output_paths}
    unresolved_relations_by_path = {path: 0 for path in output_paths}

    def class_method(path, class_name, method_name):
        methods = class_method_ids.get((path, class_name), {}).get("methods", {}).get(method_name, [])
        if not isinstance(methods, list) or len(methods) != 1:
            return []
        return methods

    def resolve_name(path, name):
        alias = imports.get(path, {}).get(name)
        if alias:
            if not alias[0]:
                return []
            return definitions.get((alias[0], alias[1] or name), [])
        return definitions.get((path, name), [])

    for path, tree in parsed.items():
        if path not in output_paths:
            continue
        lines = lines_by_path[path]
        parent_map = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
        owner_by_node = {}

        def visit(node, owner=None, class_name=None):
            current_owner = owner
            current_class = class_name
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                start = _utf16_offset(lines, node.lineno, len(lines[node.lineno - 1][:node.col_offset].encode("utf-8")), offsets_by_path[path])
                current_owner = definitions.get((path, node.name), [file_nodes[path]])[0]
                if isinstance(node, ast.ClassDef):
                    current_class = node.name
                    for base in node.bases:
                        targets = resolve_name(path, base.id) if isinstance(base, ast.Name) else []
                        if len(targets) == 1:
                            add_edge("extends", current_owner, targets[0], path, base.lineno, base.col_offset, base.end_lineno, base.end_col_offset)
                        else:
                            unresolved_relations_by_path[path] += 1
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    annotations = [argument.annotation for argument in [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs,
                        *([node.args.vararg] if node.args.vararg else []), *([node.args.kwarg] if node.args.kwarg else [])] if argument.annotation]
                    if node.returns:
                        annotations.append(node.returns)
                    for annotation in annotations:
                        for item in ast.walk(annotation):
                            if isinstance(item, ast.Name):
                                for target in resolve_name(path, item.id):
                                    add_edge("type_definition", current_owner, target, path, item.lineno, item.col_offset, item.end_lineno, item.end_col_offset)
            elif isinstance(node, ast.AnnAssign):
                for item in ast.walk(node.annotation):
                    if isinstance(item, ast.Name):
                        for target in resolve_name(path, item.id):
                            add_edge("type_definition", current_owner or file_nodes[path], target, path, item.lineno, item.col_offset, item.end_lineno, item.end_col_offset)
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
                parent = parent_map.get(node)
                if not (isinstance(parent, ast.Call) and parent.func is node):
                    for target in resolve_name(path, node.id):
                        add_edge("references", current_owner or file_nodes[path], target, path, node.lineno, node.col_offset, node.end_lineno, node.end_col_offset)
            if isinstance(node, ast.Call):
                name = node.func.id if isinstance(node.func, ast.Name) else node.func.attr if isinstance(node.func, ast.Attribute) else None
                targets = []
                alias = imports.get(path, {}).get(name) if name else None
                if alias and alias[0]:
                    target_path, imported_name = alias
                    target_name = imported_name or name
                    targets = definitions.get((target_path, target_name), [])
                elif isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) and node.func.value.id in ("self", "cls") and current_class:
                    targets = class_method(path, current_class, node.func.attr)
                elif isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Call) and isinstance(node.func.value.func, ast.Name):
                    class_alias = imports.get(path, {}).get(node.func.value.func.id)
                    class_path, class_name_resolved = class_alias if class_alias else (path, node.func.value.func.id)
                    class_name_resolved = class_name_resolved or node.func.value.func.id
                    targets = class_method(class_path, class_name_resolved, node.func.attr)
                elif name:
                    targets = resolve_name(path, name)
                if len(targets) == 1:
                    add_edge("calls", current_owner or file_nodes[path], targets[0], path, node.func.lineno, node.func.col_offset, node.func.end_lineno, node.func.end_col_offset)
                    add_edge("references", current_owner or file_nodes[path], targets[0], path, node.func.lineno, node.func.col_offset, node.func.end_lineno, node.func.end_col_offset)
                else:
                    unresolved_calls_by_path[path] += 1
            for child in ast.iter_child_nodes(node):
                visit(child, current_owner, current_class)

        for statement in tree.body:
            visit(statement, file_nodes[path])

    diagnostics = {"unresolved_calls": sum(unresolved_calls_by_path.values()), "unresolved_imports": sum(unresolved_imports_by_path.values()),
                   "unresolved_relations": sum(unresolved_relations_by_path.values()),
                   "syntax_errors": syntax_errors, "external_resolution": False, "backend": "python-ast" if jedi is None else "jedi"}
    if cache_valid:
        diagnostics.update({"incremental_mode": "incremental", "incremental_reason": "cached_symbols_and_class_methods"})
    elif cache_fallback:
        diagnostics.update({"incremental_mode": "full", "incremental_reason": "python_file_cache_incompatible"})
    analysis = bound_graph({"format": "craft-static-analysis-v1", "analyzer": "python-ast-static" if jedi is None else "jedi-static",
                            "analyzer_version": PYTHON_ANALYZER_SCHEMA if jedi is None else f"{jedi.__version__}:{PYTHON_ANALYZER_SCHEMA}",
                            "nodes": nodes, "edges": edges, "diagnostics": diagnostics})
    if data.get("include_file_units") is True:
        node_paths = {node["id"]: node["path"] for node in analysis["nodes"]}
        nodes_by_path, edges_by_path = {}, {}
        for node in analysis["nodes"]:
            nodes_by_path.setdefault(node["path"], []).append(node)
        for edge in analysis["edges"]:
            owner = node_paths.get(edge["from_node_id"])
            if owner:
                edges_by_path.setdefault(owner, []).append(edge)
        units = []
        for path in sorted(output_paths):
            tree = parsed.get(path)
            incremental_safe = tree is not None and _python_module_is_incrementally_safe(tree)
            class_methods = [{"class_id": value["class_id"], "name": name, "methods": value["methods"]}
                for (class_path, name), value in class_method_ids.items() if class_path == path]
            unit = {"path": path, "source_digest": sources[path]["source_digest"], "analyzer": analysis["analyzer"],
                    "analyzer_version": analysis["analyzer_version"], "nodes": nodes_by_path.get(path, []), "edges": edges_by_path.get(path, []),
                    "class_methods": class_methods,
                    "unresolved_calls": unresolved_calls_by_path[path], "unresolved_imports": unresolved_imports_by_path[path],
                    "unresolved_relations": unresolved_relations_by_path[path], "incremental_safe": incremental_safe,
                    "budget_limited": analysis["diagnostics"]["budget_limited"]}
            unit["unit_digest"] = "sha256:" + hashlib.sha256(json.dumps(unit, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode()).hexdigest()
            units.append(unit)
        analysis["file_units"] = units
        # File units are the lossless representation used by the incremental
        # Host path; avoiding a second graph copy keeps the response bounded.
        analysis["nodes"], analysis["edges"] = [], []
    return analysis


def _python_module_is_incrementally_safe(tree):
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and any(alias.name == "*" for alias in node.names):
            return False
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id in {"eval", "exec", "__import__"}:
                return False
            if isinstance(node.func, ast.Attribute) and node.func.attr == "import_module" and isinstance(node.func.value, ast.Name) and node.func.value.id == "importlib":
                return False
    return True


def bound_graph(analysis):
    nodes = analysis["nodes"]
    ordered_nodes = [node for node in nodes if node["kind"] == "file"] + [node for node in nodes if node["kind"] != "file"]
    kept_nodes, node_ids = [], set()
    used = 256
    omitted_nodes = 0
    for node in ordered_nodes:
        size = len(json.dumps(node, ensure_ascii=True, separators=(",", ":"))) + (1 if kept_nodes else 0)
        if len(kept_nodes) >= MAX_NODES or used + size > MAX_ANALYSIS_CHARS:
            omitted_nodes += 1
            continue
        kept_nodes.append(node)
        node_ids.add(node["id"])
        used += size
    kept_edges, omitted_edges = [], 0
    for edge in analysis["edges"]:
        if edge["from_node_id"] not in node_ids or edge["to_node_id"] not in node_ids:
            omitted_edges += 1
            continue
        size = len(json.dumps(edge, ensure_ascii=True, separators=(",", ":"))) + (1 if kept_edges else 0)
        if len(kept_edges) >= MAX_EDGES or used + size > MAX_ANALYSIS_CHARS:
            omitted_edges += 1
            continue
        kept_edges.append(edge)
        used += size
    diagnostics = dict(analysis["diagnostics"])
    diagnostics.update({"omitted_nodes": omitted_nodes, "omitted_edges": omitted_edges,
                        "budget_limited": omitted_nodes > 0 or omitted_edges > 0})
    analysis["nodes"], analysis["edges"], analysis["diagnostics"] = kept_nodes, kept_edges, diagnostics
    return analysis


def analyze(data):
    if data.get("operation") in ("control_flow_query", "data_flow_query"):
        if data.get("operation") == "data_flow_query":
            flow_path = Path(__file__).resolve().with_name("python-data-flow.py")
            spec = importlib.util.spec_from_file_location("craft_python_data_flow", flow_path)
            if spec is None or spec.loader is None:
                raise RuntimeError("Python data-flow analyzer is unavailable")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module.build_python_data_flow(data)
        flow_path = Path(__file__).resolve().with_name("python-control-flow.py")
        spec = importlib.util.spec_from_file_location("craft_python_control_flow", flow_path)
        if spec is None or spec.loader is None:
            raise RuntimeError("Python control-flow analyzer is unavailable")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.build_python_control_flow(data)
    if jedi is None:
        return analyze_with_ast(data)
    try:
        return analyze_with_jedi(data)
    except (ValueError, SyntaxError):
        return analyze_with_ast(data)


if __name__ == "__main__":
    argument = sys.argv[1] if len(sys.argv) > 1 else "-"
    source = sys.stdin.read() if argument == "-" else Path(argument).read_text(encoding="utf-8")
    print(json.dumps(analyze(json.loads(source)), ensure_ascii=False, separators=(",", ":")))
