"""Bounded statement-level Python CFG construction from one checkpoint document."""
import ast
import hashlib
import json
from pathlib import PurePosixPath

MAX_SOURCE_BYTES = 1_048_576
MAX_BLOCKS = 500
MAX_EDGES = 800
MAX_NESTING = 160


def _utf16_offset(lines, line, byte_column, prefixes):
    current = lines[line - 1] if 0 < line <= len(lines) else ""
    column = len(current.encode("utf-8")[:byte_column].decode("utf-8", errors="ignore"))
    return prefixes[line - 1] + len(current[:column].encode("utf-16-le")) // 2


def _position(lines, prefixes, line, byte_column):
    return {"offset": _utf16_offset(lines, line, byte_column, prefixes), "line": line,
            "column": len(lines[line - 1].encode("utf-8")[:byte_column].decode("utf-8", errors="ignore").encode("utf-16-le")) // 2 + 1}


def _identity(parts):
    return hashlib.sha256(json.dumps(parts, ensure_ascii=True, separators=(",", ":")).encode()).hexdigest()[-16:]


def build_python_control_flow(data):
    documents = data.get("documents")
    if not isinstance(documents, list) or len(documents) != 1 or not isinstance(documents[0], dict):
        raise ValueError("Python control flow requires exactly one checkpoint document")
    document = documents[0]
    path = document.get("path")
    content = document.get("content")
    source_digest = document.get("source_digest")
    symbol = data.get("symbol")
    if not isinstance(path, str) or not path or PurePosixPath(path).is_absolute() or ".." in PurePosixPath(path).parts or "\\" in path or not path.endswith(".py"):
        raise ValueError("Python control-flow checkpoint path is invalid")
    if not isinstance(content, str):
        raise ValueError("Python control-flow checkpoint source is invalid")
    source_bytes = content.encode("utf-8")
    if len(source_bytes) > MAX_SOURCE_BYTES:
        raise ValueError("Python control-flow source exceeds the 1 MiB budget")
    if not isinstance(source_digest, str) or hashlib.sha256(source_bytes).hexdigest() != source_digest:
        raise ValueError("Python control-flow source digest mismatch")
    if not isinstance(symbol, dict) or not isinstance(symbol.get("id"), str) or not symbol["id"] or not isinstance(symbol.get("name"), str) or not symbol["name"]:
        raise ValueError("Python control-flow symbol identity is invalid")
    symbol_offset = symbol.get("start_offset")
    if isinstance(symbol_offset, bool) or not isinstance(symbol_offset, int) or symbol_offset < 0:
        raise ValueError("Python control-flow symbol offset is invalid")

    lines = content.splitlines(keepends=True)
    prefixes = [0]
    for line in lines:
        prefixes.append(prefixes[-1] + len(line.encode("utf-16-le")) // 2)
    try:
        tree = ast.parse(content, filename=path)
    except SyntaxError as error:
        return {"format": "craft-python-control-flow-v1", "status": "partial", "language": "python",
                "blocks": [], "edges": [], "entry_id": None, "exit_id": None, "partial_reasons": ["SyntaxErrors"],
                "syntax_error_lines": [error.lineno] if error.lineno else [], "source_content_included": False}

    target = None
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) or node.name != symbol["name"]:
            continue
        line = lines[node.lineno - 1]
        start = line.find(node.name, len(line) - len(line.lstrip()))
        offset = _utf16_offset(lines, node.lineno, len(line[:start].encode("utf-8")), prefixes)
        if offset == symbol_offset:
            target = node
            break
    if target is None:
        raise ValueError("Python control-flow symbol does not match a function in the checkpoint")

    blocks = []
    edges = []
    partial_reasons = set()
    unsupported_expression_types = (ast.BoolOp, ast.IfExp, ast.Yield, ast.YieldFrom, ast.Await)

    def mark_unsupported_expressions(node):
        if node is not None:
            for child in ast.walk(node):
                if isinstance(child, unsupported_expression_types):
                    partial_reasons.add(type(child).__name__)

    def add_block(kind, node=None):
        if len(blocks) >= MAX_BLOCKS:
            raise ValueError("Python control-flow graph exceeds the 500 block budget")
        if node is None:
            start = end = {"offset": 0, "line": 1, "column": 1}
            syntax_kind = None
        else:
            start = _position(lines, prefixes, node.lineno, node.col_offset)
            end = _position(lines, prefixes, node.end_lineno or node.lineno, node.end_col_offset or node.col_offset)
            syntax_kind = type(node).__name__
        block_id = "py_cfg_" + _identity([symbol["id"], len(blocks), kind, start["offset"], end["offset"]])
        block = {"id": block_id, "kind": kind, "span": {"start_offset": start["offset"], "end_offset": end["offset"],
                 "start_line": start["line"], "start_column": start["column"], "end_line": end["line"], "end_column": end["column"]}}
        if syntax_kind:
            block["syntax_kind"] = syntax_kind
        blocks.append(block)
        return block_id

    def add_edge(source, target_id, kind, loop_back=False):
        if len(edges) >= MAX_EDGES:
            raise ValueError("Python control-flow graph exceeds the 800 edge budget")
        edges.append({"from_block_id": source, "to_block_id": target_id, "kind": kind, **({"loop_back": True} if loop_back else {})})

    def atom(node):
        block = add_block("statement", node)
        mark_unsupported_expressions(node)
        for child in ast.walk(node):
            if isinstance(child, (ast.BoolOp, ast.IfExp, ast.Yield, ast.YieldFrom, ast.Await, ast.Match, ast.Try, ast.With, ast.AsyncWith, ast.Break, ast.Continue)):
                partial_reasons.add(type(child).__name__)
        return block

    entry_id = add_block("entry")
    exit_id = add_block("exit")

    def compile_sequence(statements, depth=0):
        entry = None
        exits = []
        for statement in statements:
            fragment = compile_statement(statement, depth + 1)
            if entry is None:
                entry = fragment[0]
            else:
                for source, kind in exits:
                    add_edge(source, fragment[0], kind)
            exits = fragment[1]
        return entry, exits

    def compile_statement(node, depth):
        if depth > MAX_NESTING:
            partial_reasons.add("NestingLimit")
            block = add_block("statement", node)
            return block, [(block, "normal")]
        if isinstance(node, ast.If):
            mark_unsupported_expressions(node.test)
            condition = add_block("condition", node)
            yes_entry, yes_exits = compile_sequence(node.body, depth)
            no_entry, no_exits = compile_sequence(node.orelse, depth)
            add_edge(condition, yes_entry, "true")
            if no_entry:
                add_edge(condition, no_entry, "false")
            return condition, (yes_exits if yes_entry else [(condition, "true")]) + (no_exits if no_entry else [(condition, "false")])
        if isinstance(node, (ast.While, ast.For, ast.AsyncFor)):
            mark_unsupported_expressions(getattr(node, "test", None) or getattr(node, "iter", None))
            condition = add_block("loop_condition", node)
            body_entry, body_exits = compile_sequence(node.body, depth)
            add_edge(condition, body_entry, "true")
            for source, _ in body_exits:
                add_edge(source, condition, "loop_back", True)
            else_entry, else_exits = compile_sequence(node.orelse, depth)
            if else_entry:
                add_edge(condition, else_entry, "false")
                return condition, else_exits
            return condition, [(condition, "false")]
        if isinstance(node, ast.Return):
            block = add_block("return", node)
            add_edge(block, exit_id, "return")
            mark_unsupported_expressions(node.value)
            return block, []
        if isinstance(node, ast.Raise):
            block = add_block("raise", node)
            add_edge(block, exit_id, "exception")
            mark_unsupported_expressions(node.exc)
            return block, []
        block = atom(node)
        if isinstance(node, (ast.Try, ast.With, ast.AsyncWith, ast.Match, ast.Break, ast.Continue)):
            partial_reasons.add(type(node).__name__)
        return block, [(block, "normal")]

    body_entry, body_exits = compile_sequence(target.body)
    add_edge(entry_id, body_entry, "normal")
    for source, kind in body_exits:
        add_edge(source, exit_id, kind)
    return {"format": "craft-python-control-flow-v1", "status": "partial" if partial_reasons else "complete", "language": "python",
            "blocks": blocks, "edges": edges, "entry_id": entry_id, "exit_id": exit_id,
            "partial_reasons": sorted(partial_reasons), "source_content_included": False}
