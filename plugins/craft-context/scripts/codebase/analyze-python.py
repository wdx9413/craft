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
import json
from pathlib import Path, PurePosixPath
import sys
import tempfile
import jedi


def analyze(data):
    documents = data["documents"]
    if not documents or len(documents) > 1000 or len(json.dumps(data)) > 2_000_000:
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

        def utf16(path, line, column):
            lines = sources[path]["content"].splitlines(keepends=True)
            return len(("".join(lines[:line - 1]) + lines[line - 1][:column]).encode("utf-16-le")) // 2

        def add_node(path, name, line, column, kind):
            start = utf16(path, line, column) if kind == "symbol" else 0
            identity = "py_" + hashlib.sha256(json.dumps([path, name, start]).encode()).hexdigest()[:24]
            node = {"id": identity, "kind": kind, "path": path, "name": name, "language": "python",
                    "source_digest": sources[path]["source_digest"],
                    "span": {"start_offset": start, "end_offset": start + len(name.encode("utf-16-le")) // 2 if kind == "symbol" else 0}}
            nodes.append(node)
            lookup[(path, line, column)] = identity
            return identity

        scripts, file_nodes = {}, {}
        for path, doc in sources.items():
            file_nodes[path] = add_node(path, path, 0, 0, "file")
            script = jedi.Script(doc["content"], path=root / path, project=project)
            if script.get_syntax_errors():
                raise ValueError("Python syntax errors in checkpoint")
            scripts[path] = script
            for name in script.get_names(all_scopes=True, definitions=True, references=False):
                add_node(path, name.name, name.line, name.column, "symbol")
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
        if len(nodes) > 10000 or len(edges) > 20000:
            raise ValueError("Python graph exceeds import budget")
        return {"format": "craft-static-analysis-v1", "analyzer": "jedi-static", "analyzer_version": jedi.__version__,
                "nodes": nodes, "edges": edges, "diagnostics": {"unresolved_calls": unresolved, "external_resolution": False}}


if __name__ == "__main__":
    print(json.dumps(analyze(json.loads(Path(sys.argv[1]).read_text())), ensure_ascii=False))
