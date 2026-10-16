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
        box = next(node for node in nodes.values() if node["name"] == "Box")
        method = next(node for node in nodes.values() if node["name"] == "method")
        self.assertEqual(target["declaration_kind"], "function")
        self.assertEqual(box["declaration_kind"], "class")
        self.assertEqual(method["declaration_kind"], "method")
        target_source = data["documents"][1]["content"]
        target_span = target["declaration_span"]
        self.assertEqual(target_source[target_span["start_offset"]:target_span["end_offset"]], "def target():\n    return 1")
        incoming = [edge for edge in result["edges"] if edge["to_node_id"] == target["id"] and edge["kind"] == "calls"]
        self.assertEqual({nodes[edge["from_node_id"]]["name"] for edge in incoming}, {"caller", "method"})
        self.assertEqual(len(incoming), 2)
        self.assertEqual(sum(edge["kind"] == "references" and edge["to_node_id"] == target["id"] for edge in result["edges"]), 2)
        self.assertEqual(result["diagnostics"]["unresolved_calls"], 1)
        self.assertFalse(result["diagnostics"]["external_resolution"])

    def test_unicode_uses_utf16_offsets(self):
        body = "def 方法():\n    return 1\nemoji = '😀'; 方法()\n"
        result = module.analyze({"documents": [document("unicode.py", body)]})
        edge = next(edge for edge in result["edges"] if edge["kind"] == "calls")
        start = edge["source_span"]["start_offset"]
        self.assertEqual(body.encode("utf-16-le")[start * 2:].decode("utf-16-le").split("(")[0], "方法")

    def test_same_named_methods_resolve_within_their_class(self):
        body = "class First:\n    def run(self): pass\nclass Second:\n    def run(self): pass\nFirst().run()\nSecond().run()\n"
        result = module.analyze({"documents": [document("classes.py", body)]})
        nodes = {node["id"]: node for node in result["nodes"]}
        calls = [edge for edge in result["edges"] if edge["kind"] == "calls" and nodes[edge["to_node_id"]]["name"] == "run"]
        targets = [nodes[edge["to_node_id"]] for edge in calls]
        self.assertEqual([target["name"] for target in targets], ["run", "run"])
        self.assertEqual([target["span"]["start_offset"] for target in targets], [body.index("run"), body.index("run", body.index("run") + 1)])

    def test_value_references_and_local_type_annotations_are_indexed(self):
        body = "class Target: pass\ndef helper(): pass\ndef caller() -> Target:\n    value: Target = Target()\n    callback = helper\n    return value\n"
        result = module.analyze({"documents": [document("refs.py", body)]})
        nodes = {node["id"]: node for node in result["nodes"]}
        helper = next(node for node in nodes.values() if node["name"] == "helper")
        target = next(node for node in nodes.values() if node["name"] == "Target")
        caller = next(node for node in nodes.values() if node["name"] == "caller")
        edges = result["edges"]
        self.assertTrue(any(edge["kind"] == "references" and edge["from_node_id"] == caller["id"] and edge["to_node_id"] == helper["id"] for edge in edges))
        self.assertTrue(any(edge["kind"] == "type_definition" and edge["from_node_id"] == caller["id"] and edge["to_node_id"] == target["id"] for edge in edges))

    def test_ast_file_units_support_bounded_incremental_reanalysis_and_preserve_cross_file_edges(self):
        data = {"documents": [document("pkg/base.py", "class Box:\n    def run(self): pass\n"),
                              document("pkg/caller.py", "from .base import Box\ndef caller():\n    return Box().run()\n"),
                              document("pkg/unused.py", "def unused():\n    return 0\n")]}
        full = module._module.analyze_with_ast({**data, "include_file_units": True})
        self.assertEqual(full["nodes"], [])
        self.assertEqual(full["edges"], [])
        self.assertEqual(len(full["file_units"]), 3)
        self.assertTrue(all(unit["incremental_safe"] for unit in full["file_units"]))
        cached = [unit for unit in full["file_units"] if unit["path"] != "pkg/caller.py"]
        original_parse = module._module.ast.parse
        with patch.object(module._module.ast, "parse", wraps=original_parse) as parse:
            caller = module._module.analyze_with_ast({**data, "include_paths": ["pkg/caller.py"], "include_file_units": True,
                                                       "cached_file_units": cached})
        self.assertEqual([call.kwargs.get("filename") for call in parse.call_args_list], ["pkg/caller.py"])
        self.assertEqual([unit["path"] for unit in caller["file_units"]], ["pkg/caller.py"])
        unit = caller["file_units"][0]
        symbols = {node["id"]: node for node in [*unit["nodes"], *cached[0]["nodes"]]}
        self.assertTrue(any(edge["kind"] == "calls" and symbols[edge["to_node_id"]]["name"] == "run" for edge in unit["edges"]))
        self.assertEqual(caller["diagnostics"]["unresolved_calls"], 0)
        self.assertTrue(unit["unit_digest"].startswith("sha256:"))
        merged = [unit, *cached]
        self.assertEqual(sorted(node["id"] for item in merged for node in item["nodes"]),
                         sorted(node["id"] for item in full["file_units"] for node in item["nodes"]))
        self.assertEqual(sorted(json.dumps(edge, sort_keys=True) for item in merged for edge in item["edges"]),
                         sorted(json.dumps(edge, sort_keys=True) for item in full["file_units"] for edge in item["edges"]))
        invalid_cache = [{**cached[0], "source_digest": "stale-checkpoint"}, cached[1]]
        with patch.object(module._module.ast, "parse", wraps=original_parse) as fallback_parse:
            fallback = module._module.analyze_with_ast({**data, "include_paths": ["pkg/caller.py"], "include_file_units": True,
                                                          "cached_file_units": invalid_cache})
        self.assertEqual(fallback["diagnostics"]["incremental_mode"], "full")
        self.assertEqual(len(fallback["file_units"]), len(data["documents"]))
        self.assertEqual({call.kwargs.get("filename") for call in fallback_parse.call_args_list},
                         {item["path"] for item in data["documents"]})

    def test_old_python_symbol_cache_schema_forces_full_reanalysis(self):
        data = {"documents": [document("pkg/base.py", "class Box:\n    def run(self): pass\n"),
                              document("pkg/caller.py", "def caller():\n    return 1\n")]}
        full = module._module.analyze_with_ast({**data, "include_file_units": True})
        old_units = [{**unit, "analyzer_version": "stdlib-2"} for unit in full["file_units"] if unit["path"] == "pkg/base.py"]
        refreshed = module._module.analyze_with_ast({**data, "include_paths": ["pkg/caller.py"], "include_file_units": True,
                                                       "cached_file_units": old_units})
        self.assertEqual(refreshed["diagnostics"]["incremental_mode"], "full")
        self.assertEqual(len(refreshed["file_units"]), len(data["documents"]))
        declarations = {node["name"]: node["declaration_kind"] for unit in refreshed["file_units"]
                        for node in unit["nodes"] if node["kind"] == "symbol"}
        self.assertEqual(declarations["Box"], "class")
        self.assertEqual(declarations["run"], "method")

    def test_dynamic_import_and_star_import_disable_python_incremental_reuse(self):
        dynamic = module._module.analyze_with_ast({"documents": [document("dynamic.py", "from pkg import *\nmodule = __import__('pkg')\n")], "include_file_units": True})
        self.assertFalse(dynamic["file_units"][0]["incremental_safe"])

    def test_local_inheritance_is_an_explicit_relation_and_external_bases_stay_unresolved(self):
        body = "class Base: pass\nclass Child(Base): pass\nclass External(UnknownBase): pass\n"
        result = module.analyze({"documents": [document("inheritance.py", body)]})
        nodes = {node["id"]: node for node in result["nodes"]}
        child = next(node for node in nodes.values() if node["name"] == "Child")
        base = next(node for node in nodes.values() if node["name"] == "Base")
        relation = next(edge for edge in result["edges"] if edge["kind"] == "extends")
        self.assertEqual((relation["from_node_id"], relation["to_node_id"]), (child["id"], base["id"]))
        self.assertEqual(result["diagnostics"]["unresolved_relations"], 1)

    def test_lambda_and_graph_budget_remain_explicit(self):
        result = module.analyze({"documents": [document("lambda.py", "func = lambda: 1\nfunc()\n")]})
        self.assertEqual(result["diagnostics"]["unresolved_calls"], 1)
        large = "\n".join(f"def v{n}(): pass" for n in range(60001))
        bounded = module.analyze({"documents": [document("many.py", large)]})
        self.assertTrue(bounded["diagnostics"]["budget_limited"])
        self.assertGreater(bounded["diagnostics"]["omitted_nodes"], 0)

    def test_command_entrypoint_accepts_checkpoint_json(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "input.json"
            path.write_text(json.dumps({"documents": [document("a.py", "def target():\n    return 1\ntarget()\n")]}))
            output = io.StringIO()
            with patch.object(sys, "argv", [module.__file__, str(path)]), contextlib.redirect_stdout(output):
                runpy.run_path(module.__file__, run_name="__main__")
            self.assertEqual(len([edge for edge in json.loads(output.getvalue())["edges"] if edge["kind"] == "calls"]), 1)

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
        result = module.analyze({"documents": [document("a.py", "def ???")]})
        self.assertEqual(result["diagnostics"]["syntax_errors"][0]["kind"], "syntax_error")


if __name__ == "__main__":
    unittest.main()
