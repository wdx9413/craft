"""Checkpoint-only Python may-reaching definitions tests."""
import hashlib
import importlib.util
from pathlib import Path
from unittest.mock import patch
import unittest

MODULE_PATH = Path(__file__).parents[2] / "capability/craft-codebase/analyzers/python-data-flow.py"
SPEC = importlib.util.spec_from_file_location("craft_python_data_flow", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def request(content, name="route", variable="value", path="src/flow.py", symbol_id="symbol-route", start_line=1):
    lines = content.splitlines(keepends=True)
    line = lines[start_line - 1]
    prefix = sum(len(item.encode("utf-16-le")) // 2 for item in lines[:start_line - 1])
    column = len(line[:line.index(name)].encode("utf-16-le")) // 2
    return {"documents": [{"path": path, "content": content, "source_digest": hashlib.sha256(content.encode()).hexdigest()}],
            "symbol": {"id": symbol_id, "name": name, "start_offset": prefix + column}, "variable": variable}


class PythonDataFlowTests(unittest.TestCase):
    def test_branches_reassignments_and_utf16_spans(self):
        content = "# 😀 header\ndef route(flag):\n    value = 0\n    if flag:\n        value = 1\n    else:\n        value = 2\n    return value\n"
        result = MODULE.build_python_data_flow(request(content, start_line=2))
        self.assertEqual(result["status"], "complete")
        self.assertFalse(result["source_content_included"])
        self.assertEqual(len(result["candidates"]), 1)
        definitions = result["definitions"]
        final_use = result["uses"][-1]
        self.assertEqual(len([flow for flow in result["flows"] if flow["to_use_id"] == final_use["id"]]), 2)
        self.assertEqual(result["candidates"][0]["declaration_span"]["start_offset"], definitions[0]["span"]["start_offset"])
        self.assertGreater(definitions[0]["span"]["start_offset"], 11)

    def test_loop_fixed_point_augmented_assignment_and_dead_code(self):
        loop = MODULE.build_python_data_flow(request("def route(items):\n    value = 0\n    for item in items:\n        value += item\n    return value\n"))
        self.assertEqual(loop["status"], "complete")
        self.assertEqual(loop["uses"][-1]["name"], "value")
        loop_sources = [flow["from_definition_id"] for flow in loop["flows"] if flow["to_use_id"] == loop["uses"][-1]["id"]]
        self.assertEqual(set(loop_sources), {item["id"] for item in loop["definitions"]})
        dead = MODULE.build_python_data_flow(request("def route():\n    value = 1\n    return value\n    value = 2\n    return value\n"))
        self.assertEqual(dead["definitions"][1]["reachable"], False)
        self.assertEqual(dead["uses"][1]["reachable"], False)
        self.assertEqual(len(dead["flows"]), 1)

    def test_shadow_scopes_destructuring_and_nonlocals_are_partial(self):
        for content, reason in [
            ("def route():\n    value = 1\n    def nested():\n        return value\n    return value\n", "NestedScopeReferenceNotModeled"),
            ("def route(pair):\n    value, other = pair\n    return value\n", "DestructuredVariable"),
            ("def route():\n    value = {}\n    value.field = 1\n    return value\n", "FieldWriteNotModeled"),
            ("value = 0\ndef route():\n    global value\n    value = 1\n    return value\n", "GlobalOrNonlocalNameNotModeled"),
            ("def route(items):\n    value = 0\n    return [value for item in items]\n", "ComprehensionScopeNotModeled"),
        ]:
            result = MODULE.build_python_data_flow(request(content, start_line=2 if content.startswith("value =") else 1))
            self.assertEqual(result["status"], "partial")
            self.assertIn(reason, result["partial_reasons"])

    def test_import_definition_not_found_and_flow_budget(self):
        imported = MODULE.build_python_data_flow(request("def route():\n    import math as value\n    return value\n"))
        self.assertEqual(imported["status"], "complete")
        self.assertEqual(imported["definitions"][0]["source"], "import")
        missing = MODULE.build_python_data_flow(request("def route(value):\n    return other\n", variable="absent"))
        self.assertEqual(missing["status"], "not_found")
        original = MODULE.MAX_FLOWS
        MODULE.MAX_FLOWS = 1
        try:
            limited = MODULE.build_python_data_flow(request("def route(flag):\n    value = 0\n    if flag:\n        value = 1\n    else:\n        value = 2\n    return value\n"))
            self.assertEqual(limited["status"], "partial")
            self.assertIn("FlowBudgetExceeded", limited["partial_reasons"])
            self.assertEqual(limited["omitted_flow_count"], 1)
        finally:
            MODULE.MAX_FLOWS = original

    def test_invalid_inputs_and_checkpoint_digest_are_rejected(self):
        valid = request("def route(value):\n    return value\n")
        for mutation, error in [
            ({"documents": []}, "exactly one"),
            ({"documents": [{**valid["documents"][0], "source_digest": "wrong"}]}, "digest mismatch"),
            ({"variable": "bad name"}, "must be an identifier"),
            ({"variable": ""}, "name is invalid"),
        ]:
            with self.subTest(error=error), self.assertRaisesRegex(ValueError, error):
                MODULE.build_python_data_flow({**valid, **mutation})

    def test_parameter_kinds_and_assignment_forms(self):
        content = "def route(first, /, value, *rest, named, **options):\n    import os as value\n    value: int\n    (value := 1)\n    value = value = 2\n    return value\n"
        result = MODULE.build_python_data_flow(request(content))
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["candidates"][0]["kind"], "parameter")
        self.assertIn("MultipleWritesInStatement", result["partial_reasons"])
        self.assertTrue(any(item["source"] == "import" for item in result["definitions"]))
        self.assertTrue(any(item["source"] == "parameter" for item in result["definitions"]))

    def test_imports_loops_context_managers_handlers_and_deletes(self):
        content = "def route(items):\n    import os, math as value\n    from os import name, path as value\n    other: int = 1\n    value: int = 1\n    for value in items:\n        pass\n    with open('x'), open('y') as other, open('z') as value:\n        pass\n    try:\n        pass\n    except Exception as value:\n        pass\n    del other\n    del value\n    return value\n"
        result = MODULE.build_python_data_flow(request(content))
        for reason in ["LoopTargetAssignmentApproximate", "WithTargetAssignmentNotModeled",
                       "ExceptionTargetNotModeled", "DeleteNotModeled"]:
            self.assertIn(reason, result["partial_reasons"])
        self.assertTrue(any(item["source"] == "loop_target" for item in result["definitions"]))

    def test_comprehension_and_nested_scope_without_query_name(self):
        content = "def route(items):\n    value = 1\n    def helper():\n        return other\n    return [item for item in items] + [value]\n"
        result = MODULE.build_python_data_flow(request(content))
        self.assertEqual(result["status"], "complete")
        self.assertTrue(result["flows"])

    def test_vararg_kwarg_and_uninitialized_annotation(self):
        for parameter in ("*value", "**value"):
            with self.subTest(parameter=parameter):
                result = MODULE.build_python_data_flow(request(f"def route({parameter}):\n    return value\n"))
                self.assertEqual(result["candidates"][0]["kind"], "parameter")
                self.assertTrue(any(item["source"] == "parameter" for item in result["definitions"]))
        annotated = MODULE.build_python_data_flow(request("def route():\n    value: int\n    return value\n"))
        self.assertIn("UninitializedAnnotation", annotated["partial_reasons"])

    def test_syntax_partial_and_symbol_mismatch(self):
        malformed = request("def route(:\n    pass\n")
        result = MODULE.build_python_data_flow(malformed)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["partial_reasons"], ["SyntaxErrors"])

        valid = request("def route():\n    value = 1\n    return value\n")
        original_loader = MODULE._load_control_flow
        real_cfg = original_loader().build_python_control_flow(valid)
        class FakeAdapter:
            def build_python_control_flow(self, data):
                # Keep the valid checkpoint CFG but make the AST lookup disagree.
                data["symbol"]["start_offset"] += 1
                return real_cfg
        with patch.object(MODULE, "_load_control_flow", return_value=FakeAdapter()):
            with self.assertRaisesRegex(ValueError, "does not match"):
                MODULE.build_python_data_flow(valid)

    def test_analysis_budgets_unmapped_spans_and_cfg_endpoints(self):
        content = "def route(flag):\n    value = 0\n    if flag:\n        value = 1\n    else:\n        value = 2\n    return value\n"
        valid = request(content)
        real_adapter = MODULE._load_control_flow()
        real_cfg = real_adapter.build_python_control_flow(valid)
        class FakeAdapter:
            def __init__(self, cfg):
                self.cfg = cfg
            def build_python_control_flow(self, data):
                return self.cfg

        with patch.object(MODULE, "MAX_EVENTS", 1):
            limited = MODULE.build_python_data_flow(request("def route():\n    value = 0\n    value = 1\n    return value\n"))
            self.assertIn("EventBudgetExceeded", limited["partial_reasons"])
            self.assertGreater(limited["omitted_event_count"], 0)
        with patch.object(MODULE, "MAX_DEFINITIONS", 0):
            limited = MODULE.build_python_data_flow(request("def route():\n    value = 0\n    return value\n"))
            self.assertIn("EventBudgetExceeded", limited["partial_reasons"])
        with patch.object(MODULE, "MAX_FIXED_POINT_STEPS", 0):
            limited = MODULE.build_python_data_flow(valid)
            self.assertIn("FixedPointBudgetExceeded", limited["partial_reasons"])
        entry_block = next(block for block in real_cfg["blocks"] if block["id"] == real_cfg["entry_id"])
        with patch.object(MODULE, "_load_control_flow", return_value=FakeAdapter({**real_cfg, "blocks": [{**entry_block, "span": {"start_offset": 0, "end_offset": 0}}], "edges": []})):
            unmapped = MODULE.build_python_data_flow(valid)
            self.assertIn("UnmappedDefinition", unmapped["partial_reasons"])
            self.assertIn("UnmappedUse", unmapped["partial_reasons"])
        cfg_bad_edge = {**real_cfg, "edges": [*real_cfg["edges"], {"from_block_id": "missing", "to_block_id": "missing"}]}
        with patch.object(MODULE, "_load_control_flow", return_value=FakeAdapter(cfg_bad_edge)):
            # The invalid edge is ignored without introducing a checkpoint source.
            self.assertEqual(MODULE.build_python_data_flow(valid)["status"], "complete")

    def test_control_flow_loader_failure_and_nested_comprehension_scope(self):
        with patch.object(MODULE.importlib.util, "spec_from_file_location", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "unavailable"):
                MODULE._load_control_flow()
        cases = [
            "def route(items):\n    value = 1\n    return {value for item in items}\n",
            "def route(items):\n    value = 1\n    return {item: value for item in items}\n",
            "def route(items):\n    value = 1\n    return (value for item in items)\n",
            "def route():\n    value = 1\n    class Nested:\n        field = value\n    return value\n",
        ]
        for content in cases:
            with self.subTest(content=content):
                self.assertEqual(MODULE.build_python_data_flow(request(content))["status"], "partial")


if __name__ == "__main__":
    unittest.main()
