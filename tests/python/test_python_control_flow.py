"""Checkpoint-only bounded Python CFG tests."""
import hashlib
import importlib.util
from pathlib import Path
import unittest

MODULE_PATH = Path(__file__).parents[2] / "capability/craft-codebase/analyzers/python-control-flow.py"
SPEC = importlib.util.spec_from_file_location("craft_python_control_flow", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def request(content, name="route", path="src/flow.py", symbol_id="symbol-route", start_line=1):
    lines = content.splitlines(keepends=True)
    line = lines[start_line - 1]
    byte_column = len(line[:line.find(name)].encode("utf-8"))
    prefix = sum(len(item.encode("utf-16-le")) // 2 for item in lines[:start_line - 1])
    column = len(line[:line.find(name)].encode("utf-16-le")) // 2
    return {"documents": [{"path": path, "content": content, "source_digest": hashlib.sha256(content.encode()).hexdigest()}],
            "symbol": {"id": symbol_id, "name": name, "start_offset": prefix + column}, "byte_column": byte_column}


class PythonControlFlowTests(unittest.TestCase):
    def test_branches_loops_returns_raises_and_unicode_spans(self):
        content = "# 😀 header\ndef route(flag, items):\n    if flag:\n        value = 1\n    else:\n        value = 2\n    for item in items:\n        if item:\n            return value\n    else:\n        value = 3\n    for unused in items:\n        pass\n    raise ValueError()\n"
        data = request(content, start_line=2)
        result = MODULE.build_python_control_flow(data)
        self.assertEqual(result["status"], "complete")
        self.assertFalse(result["source_content_included"])
        self.assertEqual(result["partial_reasons"], [])
        self.assertTrue(any(edge["kind"] == "true" for edge in result["edges"]))
        self.assertTrue(any(edge["kind"] == "false" for edge in result["edges"]))
        self.assertTrue(any(edge.get("loop_back") for edge in result["edges"]))
        self.assertTrue(any(edge["kind"] == "return" for edge in result["edges"]))
        self.assertTrue(any(edge["kind"] == "exception" for edge in result["edges"]))
        self.assertGreater(result["blocks"][2]["span"]["start_offset"], 0)
        conditional = MODULE.build_python_control_flow(request("def route(left, right):\n    if left and right:\n        return\n    return 0\n"))
        self.assertEqual(conditional["partial_reasons"], ["BoolOp"])
        unicode_content = "def route():\n    value = \"😀\"; return 1\n"
        unicode_flow = MODULE.build_python_control_flow(request(unicode_content))
        return_block = next(block for block in unicode_flow["blocks"] if block["kind"] == "return")
        return_line = unicode_content.splitlines()[1]
        self.assertEqual(return_block["span"]["start_column"], len(return_line[:return_line.index("return")].encode("utf-16-le")) // 2 + 1)

    def test_empty_function_and_simple_sequence(self):
        empty = request("def route():\n    pass\n")
        result = MODULE.build_python_control_flow(empty)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(len(result["blocks"]), 3)
        self.assertEqual(result["edges"][0]["kind"], "normal")

    def test_unsupported_and_syntax_constructs_are_partial(self):
        content = "def route(flag):\n    try:\n        if flag and not flag:\n            return 1\n    except ValueError:\n        return 0\n    continue\n"
        result = MODULE.build_python_control_flow(request(content))
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["partial_reasons"], ["BoolOp", "Continue", "Try"])
        invalid = MODULE.build_python_control_flow(request("def route(:\n"))
        self.assertEqual(invalid["partial_reasons"], ["SyntaxErrors"])
        self.assertEqual(invalid["syntax_error_lines"], [1])
        expression = MODULE.build_python_control_flow(request("def route(left, right):\n    return left and right\n"))
        self.assertEqual(expression["partial_reasons"], ["BoolOp"])

    def test_checkpoint_and_symbol_validation(self):
        valid = request("def route():\n    return 1\n")
        for mutation, error in [
            ({"documents": []}, "exactly one"),
            ({"documents": [valid["documents"][0], valid["documents"][0]]}, "exactly one"),
            ({"documents": [{**valid["documents"][0], "path": "../flow.py"}]}, "path is invalid"),
            ({"documents": [{**valid["documents"][0], "path": "flow.txt"}]}, "path is invalid"),
            ({"documents": [{**valid["documents"][0], "path": 1}]}, "path is invalid"),
            ({"documents": [{**valid["documents"][0], "content": 1}]}, "source is invalid"),
            ({"documents": [{**valid["documents"][0], "source_digest": "wrong"}]}, "digest mismatch"),
            ({"symbol": {"id": "", "name": "route", "start_offset": 0}}, "identity is invalid"),
            ({"symbol": {"id": "route", "name": "route", "start_offset": True}}, "offset is invalid"),
            ({"symbol": {"id": "route", "name": "route", "start_offset": -1}}, "offset is invalid"),
            ({"symbol": {"id": "route", "name": "other", "start_offset": 0}}, "does not match"),
            ({"symbol": {"id": "route", "name": "route", "start_offset": 2}}, "does not match"),
        ]:
            data = {**valid, **mutation}
            with self.subTest(error=error), self.assertRaisesRegex(ValueError, error):
                MODULE.build_python_control_flow(data)
        with self.assertRaisesRegex(ValueError, "1 MiB budget"):
            MODULE.build_python_control_flow(request("x" * (MODULE.MAX_SOURCE_BYTES + 1)))
        with self.assertRaisesRegex(ValueError, "path is invalid"):
            MODULE.build_python_control_flow(request("def route(): pass\n", path="/flow.py"))

    def test_block_edge_and_nesting_budgets(self):
        request_data = request("def route():\n    return 1\n")
        original = MODULE.MAX_BLOCKS
        MODULE.MAX_BLOCKS = 2
        try:
            with self.assertRaisesRegex(ValueError, "500 block budget"):
                MODULE.build_python_control_flow(request_data)
        finally:
            MODULE.MAX_BLOCKS = original
        original = MODULE.MAX_EDGES
        MODULE.MAX_EDGES = 1
        try:
            with self.assertRaisesRegex(ValueError, "800 edge budget"):
                MODULE.build_python_control_flow(request_data)
        finally:
            MODULE.MAX_EDGES = original
        original = MODULE.MAX_NESTING
        MODULE.MAX_NESTING = 1
        try:
            result = MODULE.build_python_control_flow(request("def route():\n    if True:\n        if False:\n            pass\n"))
            self.assertIn("NestingLimit", result["partial_reasons"])
        finally:
            MODULE.MAX_NESTING = original


if __name__ == "__main__":
    unittest.main()
