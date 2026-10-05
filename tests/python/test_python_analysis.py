import copy
import hashlib
import importlib.util
import json
import contextlib
import io
import runpy
import sys
import tempfile
from unittest.mock import patch
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("craft_python", Path(__file__).parents[2] / "scripts/codebase/analyze-python.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def document(path, content):
    return {"path": path, "content": content, "source_digest": hashlib.sha256(content.encode()).hexdigest()}


class PythonAnalysisTest(unittest.TestCase):
    def test_real_cross_file_alias_method_and_negative_calls(self):
        data = {"documents": [document("pkg/__init__.py", ""), document("pkg/a.py", "def target():\n    return 1\nclass Box:\n    def method(self):\n        return target()\n"),
                              document("b.py", "from pkg.a import target as alias, Box\ndef caller():\n    alias()\n    Box().method()\n# target()\ntext='target()'\nprint(text)\n") ]}
        result = module.analyze(data)
        nodes = {node["id"]: node for node in result["nodes"]}
        target = next(node for node in nodes.values() if node["name"] == "target")
        incoming = [edge for edge in result["edges"] if edge["to_node_id"] == target["id"]]
        self.assertEqual({nodes[edge["from_node_id"]]["name"] for edge in incoming}, {"caller", "method"})
        self.assertEqual(len(incoming), 2)
        self.assertEqual(result["diagnostics"]["unresolved_calls"], 1)
        self.assertFalse(result["diagnostics"]["external_resolution"])

    def test_unicode_uses_utf16_offsets(self):
        body = "def 方法():\n    return 1\nemoji = '😀'; 方法()\n"
        result = module.analyze({"documents": [document("unicode.py", body)]})
        edge = result["edges"][0]
        start = edge["source_span"]["start_offset"]
        self.assertEqual(body.encode("utf-16-le")[start * 2:].decode("utf-16-le").split("(")[0], "方法")

    def test_lambda_and_graph_budget_remain_explicit(self):
        result = module.analyze({"documents": [document("lambda.py", "func = lambda: 1\nfunc()\n")]})
        self.assertEqual(result["diagnostics"]["unresolved_calls"], 1)
        large = "\n".join(f"v{n}=1" for n in range(10001))
        with self.assertRaisesRegex(ValueError, "graph exceeds"):
            module.analyze({"documents": [document("many.py", large)]})

    def test_command_entrypoint_accepts_checkpoint_json(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "input.json"
            path.write_text(json.dumps({"documents": [document("a.py", "def target():\n    return 1\ntarget()\n")]}))
            output = io.StringIO()
            with patch.object(sys, "argv", [module.__file__, str(path)]), contextlib.redirect_stdout(output):
                runpy.run_path(module.__file__, run_name="__main__")
            self.assertEqual(len(json.loads(output.getvalue())["edges"]), 1)

    def test_invalid_inputs_fail_before_analysis(self):
        with self.assertRaises(ValueError):
            module.analyze({"documents": []})
        for path in ("../escape.py", "/absolute.py", "a\\b.py", "readme.md"):
            with self.assertRaises(ValueError):
                module.analyze({"documents": [document(path, "x=1")]})
        with self.assertRaises(ValueError):
            module.analyze({"documents": [document("a.py", "x=1")] * 2})
        bad = document("a.py", "x=1"); bad["source_digest"] = "bad"
        with self.assertRaises(ValueError):
            module.analyze({"documents": [bad]})
        with self.assertRaises(ValueError):
            module.analyze({"documents": [document("a.py", "def ???")]})


if __name__ == "__main__":
    unittest.main()
