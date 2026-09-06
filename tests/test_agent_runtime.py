from __future__ import annotations

import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError

from craft_core.agent_runtime import AgentRuntime, http_transport
from craft_core.cli import build_parser, main as cli_main
from craft_core.mcp import McpServer, TOOLS
from craft_core.service import CraftService
from craft_core.store import CraftStore


TMP = Path(__file__).resolve().parent / ".tmp"
TMP.mkdir(exist_ok=True)


class SequenceRuntime:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.requests = []

    def complete(self, provider, messages, tools):
        self.requests.append((provider, list(messages), tools))
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return response


def answer(text="done", usage=None):
    return {"text": text, "tool_calls": [], "usage": usage or {},
            "assistant_message": {"role": "assistant", "content": text}}


class RuntimeTests(unittest.TestCase):
    def provider(self, protocol="openai-compatible", key=None):
        return {"protocol": protocol, "base_url": "https://models.example/api",
                "model": "m", "api_key_env": key, "options": {"timeout_seconds": 3}}

    def test_openai_normalizes_text_tools_options_and_secret(self):
        captured = {}
        def transport(url, headers, payload, timeout):
            captured.update(url=url, headers=headers, payload=payload, timeout=timeout)
            return {"choices": [{"message": {"content": None, "tool_calls": [
                {"id": "c1", "function": {"name": "lookup", "arguments": '{"q":"x"}'}},
                {"function": {"name": "empty", "arguments": {}}},
            ]}}], "usage": {"total_tokens": 8}}
        provider = self.provider(key="CRAFT_TEST_KEY")
        provider["options"].update(temperature=0.1, max_tokens=7, top_p=0.9)
        with patch.dict(os.environ, {"CRAFT_TEST_KEY": "secret"}):
            result = AgentRuntime(transport).complete(provider, [{"role": "user", "content": "x"}], [
                {"name": "lookup", "description": "d", "parameters": {"type": "object"}}
            ])
        self.assertEqual(result["text"], "")
        self.assertEqual(result["tool_calls"][0]["arguments"], {"q": "x"})
        self.assertEqual(result["tool_calls"][1]["id"], "tool_call")
        self.assertEqual(captured["headers"]["Authorization"], "Bearer secret")
        self.assertTrue(captured["url"].endswith("/chat/completions"))
        self.assertEqual(captured["timeout"], 3)
        self.assertEqual(captured["payload"]["temperature"], 0.1)

    def test_openai_no_secret_no_tools_and_bad_responses(self):
        seen = {}
        runtime = AgentRuntime(lambda u, h, p, t: seen.update(headers=h, payload=p) or
                               {"choices": [{"message": {"content": "ok"}}]})
        result = runtime.complete(self.provider(), [], [])
        self.assertEqual(result["text"], "ok")
        self.assertNotIn("Authorization", seen["headers"])
        self.assertNotIn("tools", seen["payload"])
        for payload in ({}, {"choices": []}, {"choices": [None]}):
            with self.assertRaisesRegex(RuntimeError, "no assistant message"):
                AgentRuntime(lambda *_: payload).complete(self.provider(), [], [])

    def test_anthropic_normalizes_text_and_tools(self):
        seen = {}
        def transport(url, headers, payload, timeout):
            seen.update(url=url, headers=headers, payload=payload)
            return {"content": [{"type": "text", "text": "hi"},
                                {"type": "tool_use", "name": "lookup", "input": {}, "id": None}],
                    "usage": {"input_tokens": 2}}
        result = AgentRuntime(transport).complete(
            self.provider("anthropic"),
            [{"role": "system", "content": "sys"}, {"role": "user", "content": "x"}],
            [{"name": "lookup", "description": "d", "parameters": {"type": "object"}}],
        )
        self.assertEqual(result["text"], "hi")
        self.assertEqual(result["tool_calls"][0]["id"], "tool_call")
        self.assertEqual(seen["payload"]["system"], "sys")
        self.assertEqual(seen["payload"]["max_tokens"], 2048)
        self.assertTrue(seen["url"].endswith("/v1/messages"))
        self.assertNotIn("x-api-key", seen["headers"])

    def test_anthropic_secret_options_and_errors(self):
        provider = self.provider("anthropic", "ANTHROPIC_TEST_KEY")
        provider["options"]["max_tokens"] = 99
        seen = {}
        with patch.dict(os.environ, {"ANTHROPIC_TEST_KEY": "key"}):
            AgentRuntime(lambda u, h, p, t: seen.update(h=h, p=p) or {"content": []}).complete(
                provider, [], []
            )
        self.assertEqual(seen["h"]["x-api-key"], "key")
        self.assertEqual(seen["p"]["max_tokens"], 99)
        self.assertNotIn("system", seen["p"])
        self.assertNotIn("tools", seen["p"])
        with self.assertRaisesRegex(RuntimeError, "no assistant content"):
            AgentRuntime(lambda *_: {}).complete(self.provider("anthropic"), [], [])

    def test_runtime_validation(self):
        with self.assertRaisesRegex(ValueError, "Unsupported provider"):
            AgentRuntime().complete({"protocol": "other"}, [], [])
        with self.assertRaisesRegex(ValueError, "not set"):
            AgentRuntime().complete(self.provider(key="MISSING_CRAFT_KEY"), [], [])
        for value in ("bad", "[]"):
            with self.assertRaisesRegex(RuntimeError, "tool arguments"):
                AgentRuntime._arguments(value)
        with self.assertRaisesRegex(RuntimeError, "non-object"):
            AgentRuntime._arguments([])

    def test_http_transport_success_and_sanitized_errors(self):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = b'{"ok":true}'
        with patch("craft_core.agent_runtime.urlopen", return_value=response):
            self.assertEqual(http_transport("https://x", {}, {"a": 1}, 1), {"ok": True})
        errors = [
            (HTTPError("x", 401, "secret body", {}, None), "HTTP error: 401"),
            (URLError("private hostname"), "connection failed: str"),
        ]
        for exc, expected in errors:
            with patch("craft_core.agent_runtime.urlopen", side_effect=exc):
                with self.assertRaisesRegex(RuntimeError, expected):
                    http_transport("https://x", {}, {}, 1)
        for body in (b"not-json", b"\xff"):
            response.read.return_value = body
            with patch("craft_core.agent_runtime.urlopen", return_value=response):
                with self.assertRaisesRegex(RuntimeError, "invalid JSON"):
                    http_transport("https://x", {}, {}, 1)


class AgentServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=TMP)
        self.service = CraftService(CraftStore(Path(self.temp.name) / "data"))

    def tearDown(self):
        self.temp.cleanup()

    def save_provider(self, **changes):
        values = dict(name="Local", protocol="openai-compatible",
                      base_url="https://models.example/v1", model="test")
        values.update(changes)
        return self.service.model_provider_save(**values)

    def test_provider_crud_version_and_info(self):
        first = self.save_provider(options={"temperature": 0, "max_tokens": 512})
        second = self.save_provider(provider_id=first["id"], model="test-2", enabled=False)
        self.assertEqual(second["version"], 2)
        self.assertEqual(self.service.model_provider_get(first["id"], 1)["model"], "test")
        self.assertEqual(self.service.model_provider_get(first["id"])["model"], "test-2")
        self.assertEqual(self.service.model_provider_list()["providers"], [])
        self.assertEqual(len(self.service.model_provider_list(999, True)["providers"]), 1)
        self.assertEqual(self.service.info()["counts"]["model_providers"], 2)
        with self.assertRaisesRegex(ValueError, "Unknown model provider"):
            self.service.model_provider_get("missing")

    def test_provider_validation(self):
        cases = [
            ({"name": "", "protocol": "anthropic", "base_url": "https://x", "model": "m"}, "must not be empty"),
            ({"name": "n", "protocol": "other", "base_url": "https://x", "model": "m"}, "Unsupported"),
            ({"name": "n", "protocol": "anthropic", "base_url": "file:///x", "model": "m"}, "absolute"),
            ({"name": "n", "protocol": "anthropic", "base_url": "https://u:p@x", "model": "m"}, "must not contain"),
            ({"name": "n", "protocol": "anthropic", "base_url": "https://x?q=1", "model": "m"}, "must not contain"),
            ({"name": "n", "protocol": "anthropic", "base_url": "https://x", "model": "m", "api_key_env": "bad-key"}, "uppercase"),
            ({"name": "n", "protocol": "anthropic", "base_url": "https://x", "model": "m", "options": []}, "object"),
            ({"name": "n", "protocol": "anthropic", "base_url": "https://x", "model": "m", "options": {"api_key": "secret"}}, "Unsupported provider options"),
        ]
        for kwargs, error in cases:
            with self.assertRaisesRegex(ValueError, error):
                self.service.model_provider_save(**kwargs)
        invalid_options = [
            ({"timeout_seconds": True}, "finite number"),
            ({"temperature": float("nan")}, "finite number"),
            ({"top_p": "high"}, "finite number"),
            ({"timeout_seconds": 0}, "between"),
            ({"temperature": 3}, "between"),
            ({"top_p": 2}, "between"),
            ({"max_tokens": True}, "positive integer"),
            ({"max_tokens": 0}, "positive integer"),
        ]
        for options, error in invalid_options:
            with self.assertRaisesRegex(ValueError, error):
                self.save_provider(options=options)

    def test_session_validation_and_lists(self):
        disabled = self.save_provider(enabled=False)
        with self.assertRaisesRegex(ValueError, "disabled"):
            self.service.agent_session_start(disabled["id"])
        enabled = self.save_provider()
        for rounds in (-1, 21, True, "4"):
            with self.assertRaises(ValueError):
                self.service.agent_session_start(enabled["id"], max_tool_rounds=rounds)
        with self.assertRaisesRegex(ValueError, "array"):
            self.service.agent_session_start(enabled["id"], allowed_tools="bad")
        with self.assertRaisesRegex(ValueError, "Unsupported agent tools"):
            self.service.agent_session_start(enabled["id"], allowed_tools=["shell"])
        session = self.service.agent_session_start(
            enabled["id"], title="T", system_prompt="S", max_tool_rounds=2,
            allowed_tools=["craft_task_list"], session_id="fixed",
        )
        self.assertEqual(session["allowed_tools"], ["craft_task_list"])
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.service.agent_session_start(enabled["id"], session_id="fixed")
        self.assertEqual(len(self.service.agent_session_list(999, "active")["sessions"]), 1)
        self.assertEqual(len(self.service.agent_session_list()["sessions"]), 1)
        self.assertEqual(self.service.agent_session_list(status="closed")["sessions"], [])
        with self.assertRaisesRegex(ValueError, "Unknown agent session"):
            self.service.agent_session_get("missing")

        now = "2026-01-01T00:00:00+00:00"
        with self.service.store.transaction() as db:
            db.execute(
                "INSERT INTO agent_turns(id,session_id,position,input_text,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                ("busy", "fixed", 1, "x", "running", now, now),
            )
        with self.assertRaisesRegex(ValueError, "running turn"):
            self.service.agent_turn_run("fixed", "next", runtime=SequenceRuntime([answer()]))

    def test_turn_conversation_usage_events_and_tool_loop(self):
        provider = self.save_provider()
        session = self.service.agent_session_start(
            provider["id"], system_prompt="system", max_tool_rounds=2,
            allowed_tools=["craft_task_list"],
        )
        tool_message = {"role": "assistant", "content": None, "tool_calls": []}
        runtime = SequenceRuntime([
            {"text": "", "usage": {"total_tokens": 3, "ignored": True},
             "assistant_message": tool_message,
             "tool_calls": [{"id": "c1", "name": "craft_task_list", "arguments": {}}]},
            answer("first", {"total_tokens": 4}),
            answer("second", {"total_tokens": 2}),
        ])
        events = []
        first = self.service.agent_turn_run(session["id"], "hello", events.append, runtime)
        self.assertEqual(first["usage"], {"total_tokens": 7})
        self.assertEqual(first["output_text"], "first")
        second = self.service.agent_turn_run(session["id"], "again", runtime=runtime)
        self.assertEqual(second["position"], 2)
        self.assertEqual(runtime.requests[-1][1][-3]["content"], "hello")
        self.assertEqual([e["event_type"] for e in events], [
            "turn.started", "provider.requested", "tool.requested", "tool.completed",
            "provider.requested", "assistant.completed",
        ])
        stored = self.service.agent_session_get(session["id"])
        self.assertEqual(stored["events"][-1]["payload"]["text"], "second")
        completed = self.service.agent_turn_run(
            session["id"], "callback", lambda _: (_ for _ in ()).throw(RuntimeError("ui")),
            SequenceRuntime([answer("still done")]),
        )
        self.assertEqual(completed["status"], "completed")

    def test_anthropic_tool_result_and_failures(self):
        provider = self.save_provider(protocol="anthropic")
        session = self.service.agent_session_start(
            provider["id"], max_tool_rounds=1, allowed_tools=["craft_task_list"]
        )
        runtime = SequenceRuntime([
            {"text": "", "usage": {}, "assistant_message": {"role": "assistant", "content": []},
             "tool_calls": [{"id": "a", "name": "craft_task_list", "arguments": {}}]},
            answer("ok"),
        ])
        self.service.agent_turn_run(session["id"], "x", runtime=runtime)
        self.assertEqual(runtime.requests[1][1][-1]["content"][0]["type"], "tool_result")
        for bad_runtime, error in [
            (SequenceRuntime([RuntimeError("provider down")]), "provider down"),
            (SequenceRuntime([{**answer(), "tool_calls": [{"id": "x", "name": "shell", "arguments": {}}]}]), "outside its allowlist"),
        ]:
            with self.assertRaisesRegex(RuntimeError, error):
                self.service.agent_turn_run(session["id"], "fail", lambda _: None, bad_runtime)
        self.assertEqual(self.service.agent_session_get(session["id"])["turns"][-1]["status"], "failed")

    def test_turn_rejections_round_limit_and_internal_unknown_tool(self):
        provider = self.save_provider()
        session = self.service.agent_session_start(provider["id"], max_tool_rounds=0)
        with self.assertRaisesRegex(ValueError, "must not be empty"):
            self.service.agent_turn_run(session["id"], "")
        with self.service.store.transaction() as db:
            db.execute("UPDATE agent_sessions SET status='closed' WHERE id=?", (session["id"],))
        with self.assertRaisesRegex(ValueError, "not active"):
            self.service.agent_turn_run(session["id"], "x")
        with self.service.store.transaction() as db:
            db.execute("UPDATE agent_sessions SET status='active' WHERE id=?", (session["id"],))
        calls = [{"id": "x", "name": "craft_task_list", "arguments": {}}]
        with self.assertRaisesRegex(RuntimeError, "max_tool_rounds"):
            self.service.agent_turn_run(session["id"], "x", runtime=SequenceRuntime([
                {"text": "", "usage": {}, "assistant_message": {}, "tool_calls": calls}
            ]))
        with self.assertRaisesRegex(RuntimeError, "Unknown agent tool"):
            self.service._run_agent_tool("missing", {})

    def test_provider_disabled_after_session(self):
        provider = self.save_provider()
        session = self.service.agent_session_start(provider["id"])
        self.save_provider(provider_id=provider["id"], enabled=False)
        # Sessions pin immutable provider versions, so a later disabled version does not break them.
        self.assertEqual(self.service.agent_turn_run(
            session["id"], "x", runtime=SequenceRuntime([answer()])
        )["status"], "completed")
        with self.service.store.transaction() as db:
            db.execute("UPDATE model_providers SET enabled=0 WHERE id=? AND version=1", (provider["id"],))
        with self.assertRaisesRegex(ValueError, "disabled"):
            self.service.agent_turn_run(session["id"], "y", runtime=SequenceRuntime([answer()]))


class SurfaceTests(unittest.TestCase):
    def test_parser_and_mcp_surface(self):
        self.assertEqual(build_parser().parse_args([
            "provider-save", "n", "anthropic", "https://x", "m"
        ]).protocol, "anthropic")
        names = {tool["name"] for tool in TOOLS}
        self.assertIn("craft_agent_turn_run", names)
        service = Mock(spec=CraftService)
        service.logger = Mock()
        service.model_provider_list.return_value = {"providers": []}
        server = McpServer(service)
        response = server.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                  "params": {"name": "craft_model_provider_list", "arguments": {}}})
        self.assertFalse(response["result"]["isError"])
        service.agent_turn_run.side_effect = RuntimeError("provider unavailable")
        failed = server.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                                "params": {"name": "craft_agent_turn_run", "arguments": {
                                    "session_id": "s", "message": "x"}}})
        self.assertTrue(failed["result"]["isError"])

    def test_cli_provider_and_session_routes(self):
        service = Mock(spec=CraftService)
        service.model_provider_save.return_value = {"id": "p"}
        service.model_provider_get.return_value = {"id": "p"}
        service.model_provider_list.return_value = {"providers": []}
        service.agent_session_start.return_value = {"id": "s"}
        service.agent_session_get.return_value = {"id": "s"}
        service.agent_session_list.return_value = {"sessions": []}
        service.agent_turn_run.return_value = {"output_text": "ok"}
        commands = [
            ["provider-save", "n", "openai-compatible", "https://x", "m"],
            ["provider-get", "p"], ["provider-list"],
            ["agent-session-start", "p"], ["agent-session-get", "s"],
            ["agent-session-list"], ["chat", "--session-id", "s", "--message", "hi"],
            ["chat", "--provider-id", "p", "--message", "hi", "--json-events"],
        ]
        for argv in commands:
            with patch("sys.argv", ["craft", *argv]), patch("craft_core.cli.CraftService", return_value=service), patch("sys.stdout", new=io.StringIO()):
                cli_main()
        with patch("sys.argv", ["craft", "chat", "--message", "x"]), patch("craft_core.cli.CraftService", return_value=service):
            with self.assertRaisesRegex(ValueError, "requires"):
                cli_main()
        with patch("sys.argv", ["craft", "chat", "--session-id", "s"]), patch("craft_core.cli.CraftService", return_value=service), patch("builtins.input", side_effect=["hello", "/exit"]), patch("sys.stdout", new=io.StringIO()):
            cli_main()
        with patch("sys.argv", ["craft", "chat", "--session-id", "s", "--json-events"]), patch("craft_core.cli.CraftService", return_value=service), patch("builtins.input", side_effect=["hello", "/quit"]), patch("sys.stdout", new=io.StringIO()):
            cli_main()
        with patch("sys.argv", ["craft", "chat", "--session-id", "s"]), patch("craft_core.cli.CraftService", return_value=service), patch("builtins.input", side_effect=EOFError), patch("sys.stdout", new=io.StringIO()):
            cli_main()


if __name__ == "__main__":
    unittest.main()
