from __future__ import annotations

import json
import sys
import traceback
from typing import Any, Callable

from .service import CraftService


OBJECT = {"type": "object", "additionalProperties": False}


def schema(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {**OBJECT, "properties": properties, "required": required or []}


TOOLS = [
    {"name": "craft_info", "description": "Show Craft data location and local record counts.", "inputSchema": schema({}), "annotations": {"readOnlyHint": True}},
    {"name": "craft_source_add", "description": "Add a user-selected local capability directory and optionally index its SKILL.md files.", "inputSchema": schema({"path": {"type": "string"}, "label": {"type": "string"}, "scan": {"type": "boolean", "default": True}}, ["path"])},
    {"name": "craft_source_list", "description": "List configured capability sources with requested and resolved real paths.", "inputSchema": schema({}), "annotations": {"readOnlyHint": True}},
    {"name": "craft_source_update", "description": "Enable, disable, or relabel a configured source without modifying its files.", "inputSchema": schema({"source_id": {"type": "string"}, "enabled": {"type": "boolean"}, "label": {"type": "string"}}, ["source_id"])},
    {"name": "craft_source_remove", "description": "Remove a source and its local index entries without deleting source files.", "inputSchema": schema({"source_id": {"type": "string"}}, ["source_id"])},
    {"name": "craft_source_scan", "description": "Incrementally rescan one configured source or every enabled source.", "inputSchema": schema({"source_id": {"type": "string"}})},
    {"name": "craft_capability_search", "description": "Refresh stale sources, then search the local index and return a small candidate set.", "inputSchema": schema({"query": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 20, "default": 6}, "kind": {"type": "string"}, "refresh": {"type": "boolean", "default": True}, "stale_after_seconds": {"type": "integer", "minimum": 0, "default": 300}}, ["query"]), "annotations": {"readOnlyHint": True}},
    {"name": "craft_capability_get", "description": "Read a specific indexed capability version, including its instructions and source path.", "inputSchema": schema({"asset_id": {"type": "string"}}, ["asset_id"]), "annotations": {"readOnlyHint": True}},
    {"name": "craft_task_open", "description": "Create a Craft task or load its continuation pack by task ID.", "inputSchema": schema({"task_id": {"type": "string"}, "title": {"type": "string"}, "goal": {"type": "string"}, "project_id": {"type": "string"}})},
    {"name": "craft_task_list", "description": "List recent Craft tasks so a user can select work to continue.", "inputSchema": schema({"limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 10}, "status": {"type": "string", "enum": ["active", "paused", "completed", "cancelled"]}, "project_id": {"type": "string"}}), "annotations": {"readOnlyHint": True}},
    {"name": "craft_task_checkpoint", "description": "Persist explicit task progress, decisions, artifact references, pending work, and status.", "inputSchema": schema({"task_id": {"type": "string"}, "summary": {"type": "string"}, "completed": {"type": "array", "items": {"type": "string"}}, "pending": {"type": "array", "items": {"type": "string"}}, "decisions": {"type": "array", "items": {"type": "object"}}, "artifacts": {"type": "array", "items": {"type": "object"}}, "status": {"type": "string", "enum": ["active", "paused", "completed", "cancelled"]}, "source": {"type": "string", "default": "agent_reported"}}, ["task_id", "summary"])},
    {"name": "craft_feedback_record", "description": "Record an explicit user correction, preference, fact, exception, or process rule with scope.", "inputSchema": schema({"corrected": {"type": "string"}, "kind": {"type": "string", "enum": ["correction", "preference", "fact", "exception", "process"], "default": "correction"}, "scope": {"type": "string", "enum": ["task", "project", "user"], "default": "task"}, "task_id": {"type": "string"}, "original": {"type": "string"}, "applies_to": {"type": "string"}, "source": {"type": "string", "default": "user_explicit"}}, ["corrected"])},
    {"name": "craft_eval_suite_save", "description": "Save an immutable version of a reusable evaluation Case Suite.", "inputSchema": schema({"name": {"type": "string"}, "cases": {"type": "array", "minItems": 1, "items": {"type": "object"}}, "description": {"type": "string"}, "scope": {"type": "string", "enum": ["task", "project", "user"], "default": "user"}, "suite_id": {"type": "string"}}, ["name", "cases"])},
    {"name": "craft_eval_suite_get", "description": "Read the latest or a specified immutable evaluation suite version.", "inputSchema": schema({"suite_id": {"type": "string"}, "version": {"type": "integer", "minimum": 1}}, ["suite_id"]), "annotations": {"readOnlyHint": True}},
    {"name": "craft_eval_suite_list", "description": "List or search the latest reusable evaluation Suite versions.", "inputSchema": schema({"limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20}, "query": {"type": "string"}, "scope": {"type": "string", "enum": ["task", "project", "user"]}}), "annotations": {"readOnlyHint": True}},
    {"name": "craft_eval_run_start", "description": "Start an evaluation run for a capability, Skill, Workflow, tool, MCP, plugin, Agent, model, system, or combination.", "inputSchema": schema({"suite_id": {"type": "string"}, "subject_kind": {"type": "string", "enum": ["capability", "skill", "workflow", "tool", "mcp", "plugin", "agent", "model", "system", "combination"]}, "subject_id": {"type": "string"}, "suite_version": {"type": "integer", "minimum": 1}, "subject_version": {"type": "string"}, "metadata": {"type": "object"}}, ["suite_id", "subject_kind", "subject_id"])},
    {"name": "craft_eval_result_submit", "description": "Submit one immutable Case result with score, metrics, evidence, and provenance.", "inputSchema": schema({"run_id": {"type": "string"}, "case_id": {"type": "string"}, "verdict": {"type": "string", "enum": ["passed", "failed", "blocked", "skipped"]}, "score": {"type": "number", "minimum": 0, "maximum": 1}, "metrics": {"type": "object"}, "evidence": {"type": "array", "items": {"type": "object"}}, "notes": {"type": "string"}, "provenance": {"type": "string", "enum": ["agent_reported", "model_judged", "program_verified", "human_approved", "human_rejected"], "default": "agent_reported"}}, ["run_id", "case_id", "verdict"])},
    {"name": "craft_eval_run_get", "description": "Read an evaluation run, Case results, and deterministic aggregate metrics.", "inputSchema": schema({"run_id": {"type": "string"}}, ["run_id"]), "annotations": {"readOnlyHint": True}},
    {"name": "craft_eval_run_list", "description": "List evaluation history by Suite, subject, or status.", "inputSchema": schema({"limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20}, "suite_id": {"type": "string"}, "subject_kind": {"type": "string", "enum": ["capability", "skill", "workflow", "tool", "mcp", "plugin", "agent", "model", "system", "combination"]}, "subject_id": {"type": "string"}, "status": {"type": "string", "enum": ["running", "completed"]}}), "annotations": {"readOnlyHint": True}},
    {"name": "craft_eval_compare", "description": "Compare two or more subjects evaluated with the same Case Suite version.", "inputSchema": schema({"run_ids": {"type": "array", "minItems": 2, "items": {"type": "string"}}}, ["run_ids"]), "annotations": {"readOnlyHint": True}},
    {"name": "craft_agent_profile_save", "description": "Save an immutable Agent Profile version with host, provider, model, role, capabilities, and side-effect limits.", "inputSchema": schema({"name": {"type": "string"}, "role": {"type": "string"}, "host": {"type": "string"}, "provider": {"type": "string"}, "model": {"type": "string"}, "reasoning_effort": {"type": "string"}, "capabilities": {"type": "array", "items": {"type": "string"}}, "allowed_side_effects": {"type": "array", "items": {"type": "string", "enum": ["read_only", "local_write", "external_write", "destructive"]}}, "metadata": {"type": "object"}, "enabled": {"type": "boolean", "default": True}, "profile_id": {"type": "string"}}, ["name", "role", "host", "provider", "model"])},
    {"name": "craft_agent_profile_get", "description": "Read the latest or a specified immutable Agent Profile version.", "inputSchema": schema({"profile_id": {"type": "string"}, "version": {"type": "integer", "minimum": 1}}, ["profile_id"]), "annotations": {"readOnlyHint": True}},
    {"name": "craft_agent_profile_list", "description": "List latest Agent Profiles by role, host, or enabled state.", "inputSchema": schema({"limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20}, "role": {"type": "string"}, "host": {"type": "string"}, "enabled": {"type": "boolean", "default": True}}), "annotations": {"readOnlyHint": True}},
    {"name": "craft_orchestration_plan_create", "description": "Create a dependency-aware multi-Agent plan with ordered fallback profiles and bounded concurrency.", "inputSchema": schema({"goal": {"type": "string"}, "nodes": {"type": "array", "minItems": 1, "items": {"type": "object"}}, "task_id": {"type": "string"}, "max_concurrency": {"type": "integer", "minimum": 1, "maximum": 32, "default": 4}, "policy": {"type": "object"}}, ["goal", "nodes"])},
    {"name": "craft_orchestration_plan_get", "description": "Read a multi-Agent plan, node states, routes, leases, results, and evidence.", "inputSchema": schema({"plan_id": {"type": "string"}}, ["plan_id"]), "annotations": {"readOnlyHint": True}},
    {"name": "craft_orchestration_plan_list", "description": "Find orchestration plans by linked task or current status.", "inputSchema": schema({"limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20}, "task_id": {"type": "string"}, "status": {"type": "string", "enum": ["running", "completed", "failed"]}}), "annotations": {"readOnlyHint": True}},
    {"name": "craft_orchestration_dispatch", "description": "Lease ready plan nodes up to the concurrency limit and return host-executable Agent requests.", "inputSchema": schema({"plan_id": {"type": "string"}, "claimed_by": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 32}}, ["plan_id", "claimed_by"])},
    {"name": "craft_orchestration_submit", "description": "Close an Agent lease with evidence; failure selects the next configured profile when available.", "inputSchema": schema({"lease_id": {"type": "string"}, "verdict": {"type": "string", "enum": ["passed", "failed", "blocked"]}, "result": {"type": "object"}, "evidence": {"type": "array", "items": {"type": "object"}}, "provenance": {"type": "string", "enum": ["agent_reported", "model_judged", "program_verified", "human_approved", "human_rejected"], "default": "agent_reported"}}, ["lease_id", "verdict"])},
    {"name": "craft_workflow_save", "description": "Save a versioned workflow with declarative invariants, executable steps, evidence requirements, and bounded policies.", "inputSchema": schema({"name": {"type": "string"}, "goal": {"type": "string"}, "steps": {"type": "array", "minItems": 1, "items": {"type": "object"}}, "scope": {"type": "string", "enum": ["task", "project", "user"], "default": "user"}, "status": {"type": "string", "enum": ["candidate", "tested", "reusable", "deprecated"], "default": "candidate"}, "source_task_id": {"type": "string"}, "workflow_id": {"type": "string"}, "inputs": {"type": "array", "items": {"type": "object"}}, "success_criteria": {"type": "array", "items": {}}, "preconditions": {"type": "array", "items": {"type": "object"}}, "repair_policy": {"type": "object"}, "artifacts": {"type": "array", "items": {"type": "object"}}, "invariants": {"type": "array", "items": {"type": "object"}}, "permission_policy": {"type": "object"}}, ["name", "goal", "steps"])},
    {"name": "craft_workflow_search", "description": "Search the latest non-deprecated versions of saved workflows.", "inputSchema": schema({"query": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 20, "default": 6}, "scope": {"type": "string", "enum": ["task", "project", "user"]}}, ["query"]), "annotations": {"readOnlyHint": True}},
    {"name": "craft_workflow_get", "description": "Read the latest or a specified version of a saved workflow.", "inputSchema": schema({"workflow_id": {"type": "string"}, "version": {"type": "integer", "minimum": 1}}, ["workflow_id"]), "annotations": {"readOnlyHint": True}},
    {"name": "craft_workflow_plan", "description": "Resolve workflow inputs and preview executable steps without running them.", "inputSchema": schema({"workflow_id": {"type": "string"}, "project_root": {"type": "string"}, "version": {"type": "integer", "minimum": 1}, "inputs": {"type": "object"}}, ["workflow_id", "project_root"]), "annotations": {"readOnlyHint": True}},
    {"name": "craft_workflow_run", "description": "Run one approved deterministic workflow attempt within explicit side-effect grants.", "inputSchema": schema({"workflow_id": {"type": "string"}, "project_root": {"type": "string"}, "version": {"type": "integer", "minimum": 1}, "inputs": {"type": "object"}, "run_id": {"type": "string"}, "allow_execution": {"type": "boolean", "default": False}, "approved_side_effects": {"type": "array", "items": {"type": "string", "enum": ["read_only", "local_write", "external_write", "destructive"]}}}, ["workflow_id", "project_root", "allow_execution"]), "annotations": {"destructiveHint": True}},
    {"name": "craft_workflow_run_get", "description": "Read a workflow run and all deterministic attempt receipts.", "inputSchema": schema({"run_id": {"type": "string"}}, ["run_id"]), "annotations": {"readOnlyHint": True}},
    {"name": "craft_workflow_start", "description": "Start a mixed workflow and stop at external work or an unapproved side-effect boundary.", "inputSchema": schema({"workflow_id": {"type": "string"}, "project_root": {"type": "string"}, "version": {"type": "integer", "minimum": 1}, "inputs": {"type": "object"}, "allow_execution": {"type": "boolean", "default": False}, "approved_side_effects": {"type": "array", "items": {"type": "string", "enum": ["read_only", "local_write", "external_write", "destructive"]}}}, ["workflow_id", "project_root"]), "annotations": {"destructiveHint": True}},
    {"name": "craft_workflow_continue", "description": "Continue a mixed workflow with explicit side-effect grants.", "inputSchema": schema({"session_id": {"type": "string"}, "allow_execution": {"type": "boolean", "default": False}, "approved_side_effects": {"type": "array", "items": {"type": "string", "enum": ["read_only", "local_write", "external_write", "destructive"]}}}, ["session_id"]), "annotations": {"destructiveHint": True}},
    {"name": "craft_workflow_submit", "description": "Submit structured, provenance-bearing output for the pending external node and advance.", "inputSchema": schema({"session_id": {"type": "string"}, "step_id": {"type": "string"}, "result": {"type": "object"}, "submitted_by": {"type": "string", "default": "host_agent"}, "allow_execution": {"type": "boolean", "default": False}, "approved_side_effects": {"type": "array", "items": {"type": "string", "enum": ["read_only", "local_write", "external_write", "destructive"]}}}, ["session_id", "step_id", "result"]), "annotations": {"destructiveHint": True}},
    {"name": "craft_workflow_session_get", "description": "Read mixed workflow state, pending work, provenance, and event history.", "inputSchema": schema({"session_id": {"type": "string"}}, ["session_id"]), "annotations": {"readOnlyHint": True}},
    {"name": "craft_workflow_checkpoint_list", "description": "List trusted program-verified or human-approved recovery points for a session.", "inputSchema": schema({"session_id": {"type": "string"}}, ["session_id"]), "annotations": {"readOnlyHint": True}},
    {"name": "craft_workflow_restore", "description": "Create a new auditable session branch from a trusted checkpoint.", "inputSchema": schema({"checkpoint_id": {"type": "string"}, "allow_execution": {"type": "boolean", "default": False}, "approved_side_effects": {"type": "array", "items": {"type": "string", "enum": ["read_only", "local_write", "external_write", "destructive"]}}}, ["checkpoint_id"]), "annotations": {"destructiveHint": True}},
]


class McpServer:
    def __init__(self, service: CraftService | None = None) -> None:
        self.service = service or CraftService()
        self.handlers: dict[str, Callable[..., Any]] = {
            f"craft_{name}": getattr(self.service, name) for name in (
                "source_add", "source_list", "source_update", "source_remove",
                "source_scan", "capability_search", "capability_get",
                "task_open", "task_list", "task_checkpoint", "feedback_record",
                "eval_suite_save", "eval_suite_get", "eval_suite_list", "eval_run_start",
                "eval_result_submit", "eval_run_get", "eval_run_list", "eval_compare",
                "agent_profile_save", "agent_profile_get", "agent_profile_list",
                "orchestration_plan_create", "orchestration_plan_get", "orchestration_plan_list",
                "orchestration_dispatch", "orchestration_submit",
                "workflow_save", "workflow_search", "workflow_get",
                "workflow_plan", "workflow_run", "workflow_run_get",
                "workflow_start", "workflow_continue", "workflow_submit", "workflow_session_get",
                "workflow_checkpoint_list", "workflow_restore",
            )
        }
        self.handlers["craft_info"] = self.service.info

    def handle(self, message: dict[str, Any]) -> dict[str, Any] | None:
        if not isinstance(message, dict):
            return self._error(None, -32600, "Invalid Request")
        method = message.get("method")
        request_id = message.get("id")
        if method == "notifications/initialized" or request_id is None:
            return None
        if method == "initialize":
            requested = message.get("params", {}).get("protocolVersion")
            supported = {"2025-03-26", "2025-06-18", "2025-11-25"}
            version = requested if requested in supported else "2025-11-25"
            return self._ok(request_id, {"protocolVersion": version, "capabilities": {"tools": {}}, "serverInfo": {"name": "craft", "version": "0.1.0"}, "instructions": "Use Craft to discover capabilities, continue durable tasks, coordinate host-mediated multi-agent plans, preserve evidence, and compare evaluations. Craft data is local under ~/.craft_data by default."})
        if method == "ping":
            return self._ok(request_id, {})
        if method == "tools/list":
            return self._ok(request_id, {"tools": TOOLS})
        if method == "tools/call":
            params = message.get("params") or {}
            name = params.get("name")
            if name not in self.handlers:
                return self._error(request_id, -32602, f"Unknown tool: {name}")
            try:
                result = self.handlers[name](**(params.get("arguments") or {}))
                return self._ok(request_id, {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, indent=2)}], "structuredContent": result, "isError": False})
            except (TypeError, ValueError) as exc:
                self.service.logger.warning(
                    "event=mcp_call_rejected tool=%s error_type=%s", name, type(exc).__name__
                )
                return self._ok(request_id, {"content": [{"type": "text", "text": str(exc)}], "isError": True})
        return self._error(request_id, -32601, f"Method not found: {method}")

    @staticmethod
    def _ok(request_id: Any, result: Any) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": request_id, "result": result}

    @staticmethod
    def _error(request_id: Any, code: int, message: str) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}

    def run(self) -> None:
        for raw in sys.stdin:
            try:
                message = json.loads(raw)
                response = self.handle(message)
                if response is not None:
                    sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
                    sys.stdout.flush()
            except json.JSONDecodeError:
                sys.stdout.write(json.dumps(self._error(None, -32700, "Parse error")) + "\n")
                sys.stdout.flush()
            except Exception:
                traceback.print_exc(file=sys.stderr)


def main() -> None:
    McpServer().run()
