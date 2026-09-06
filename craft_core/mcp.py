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
    {"name": "craft_workflow_save", "description": "Save a versioned workflow with executable steps, deterministic criteria, and a bounded repair policy.", "inputSchema": schema({"name": {"type": "string"}, "goal": {"type": "string"}, "steps": {"type": "array", "minItems": 1, "items": {"type": "object"}}, "scope": {"type": "string", "enum": ["task", "project", "user"], "default": "user"}, "status": {"type": "string", "enum": ["candidate", "tested", "reusable", "deprecated"], "default": "candidate"}, "source_task_id": {"type": "string"}, "workflow_id": {"type": "string"}, "inputs": {"type": "array", "items": {"type": "object"}}, "success_criteria": {"type": "array", "items": {}}, "preconditions": {"type": "array", "items": {"type": "object"}}, "repair_policy": {"type": "object"}, "artifacts": {"type": "array", "items": {"type": "object"}}}, ["name", "goal", "steps"])},
    {"name": "craft_workflow_search", "description": "Search the latest non-deprecated versions of saved workflows.", "inputSchema": schema({"query": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 20, "default": 6}, "scope": {"type": "string", "enum": ["task", "project", "user"]}}, ["query"]), "annotations": {"readOnlyHint": True}},
    {"name": "craft_workflow_get", "description": "Read the latest or a specified version of a saved workflow.", "inputSchema": schema({"workflow_id": {"type": "string"}, "version": {"type": "integer", "minimum": 1}}, ["workflow_id"]), "annotations": {"readOnlyHint": True}},
    {"name": "craft_workflow_plan", "description": "Resolve workflow inputs and preview executable steps without running them.", "inputSchema": schema({"workflow_id": {"type": "string"}, "project_root": {"type": "string"}, "version": {"type": "integer", "minimum": 1}, "inputs": {"type": "object"}}, ["workflow_id", "project_root"]), "annotations": {"readOnlyHint": True}},
    {"name": "craft_workflow_run", "description": "Run one approved workflow attempt and return deterministic repair evidence on failure.", "inputSchema": schema({"workflow_id": {"type": "string"}, "project_root": {"type": "string"}, "version": {"type": "integer", "minimum": 1}, "inputs": {"type": "object"}, "run_id": {"type": "string"}, "allow_execution": {"type": "boolean", "default": False}}, ["workflow_id", "project_root", "allow_execution"]), "annotations": {"destructiveHint": True}},
    {"name": "craft_workflow_run_get", "description": "Read a workflow run and all deterministic attempt receipts.", "inputSchema": schema({"run_id": {"type": "string"}}, ["run_id"]), "annotations": {"readOnlyHint": True}},
]


class McpServer:
    def __init__(self, service: CraftService | None = None) -> None:
        self.service = service or CraftService()
        self.handlers: dict[str, Callable[..., Any]] = {
            f"craft_{name}": getattr(self.service, name) for name in (
                "source_add", "source_list", "source_update", "source_remove",
                "source_scan", "capability_search", "capability_get",
                "task_open", "task_list", "task_checkpoint", "feedback_record",
                "workflow_save", "workflow_search", "workflow_get",
                "workflow_plan", "workflow_run", "workflow_run_get",
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
            return self._ok(request_id, {"protocolVersion": version, "capabilities": {"tools": {}}, "serverInfo": {"name": "craft", "version": "0.1.0"}, "instructions": "Use Craft to search user-configured capabilities, continue saved tasks, and persist explicit progress or feedback. Craft data is local under ~/.craft_data by default."})
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
