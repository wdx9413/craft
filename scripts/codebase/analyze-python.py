"""Compatibility entrypoint for the checkpoint-only Python analyzer.

Usage: python3 -I scripts/codebase/analyze-python.py [checkpoint.json|-]
The analyzer consumes only the supplied immutable checkpoint documents.
"""
import importlib.util
import json
from pathlib import Path
import sys


def _implementation():
    here = Path(__file__).resolve().parent
    candidates = [here / "analyzers" / "analyze-python.py",
                  Path(__file__).resolve().parents[2] / "capability" / "craft-codebase" / "analyzers" / "analyze-python.py"]
    path = next((item for item in candidates if item.is_file()), None)
    if path is None:
        raise RuntimeError("Python analyzer implementation is unavailable")
    spec = importlib.util.spec_from_file_location("craft_python_analyzer", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_module = _implementation()
analyze = _module.analyze


if __name__ == "__main__":
    argument = sys.argv[1] if len(sys.argv) > 1 else "-"
    raw = sys.stdin.read() if argument == "-" else Path(argument).read_text(encoding="utf-8")
    print(json.dumps(analyze(json.loads(raw)), ensure_ascii=False, separators=(",", ":")))
