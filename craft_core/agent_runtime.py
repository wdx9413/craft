from __future__ import annotations

import json
import os
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


Transport = Callable[[str, dict[str, str], dict[str, Any], float], dict[str, Any]]


def http_transport(
    url: str, headers: dict[str, str], payload: dict[str, Any], timeout: float
) -> dict[str, Any]:
    request = Request(
        url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST"
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        raise RuntimeError(f"Provider HTTP error: {exc.code}") from None
    except URLError as exc:
        raise RuntimeError(f"Provider connection failed: {type(exc.reason).__name__}") from None
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise RuntimeError("Provider returned an invalid JSON response") from None


class AgentRuntime:
    """Small provider-neutral model loop. Secrets are resolved only at request time."""

    def __init__(self, transport: Transport | None = None) -> None:
        self.transport = transport or http_transport

    def complete(
        self,
        provider: dict[str, Any],
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> dict[str, Any]:
        protocol = provider["protocol"]
        if protocol == "openai-compatible":
            return self._openai(provider, messages, tools)
        if protocol == "anthropic":
            return self._anthropic(provider, messages, tools)
        raise ValueError(f"Unsupported provider protocol: {protocol}")

    @staticmethod
    def _secret(provider: dict[str, Any]) -> str | None:
        env_name = provider.get("api_key_env")
        if not env_name:
            return None
        value = os.environ.get(env_name)
        if not value:
            raise ValueError(f"Provider credential environment variable is not set: {env_name}")
        return value

    def _openai(
        self, provider: dict[str, Any], messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> dict[str, Any]:
        headers = {"Content-Type": "application/json"}
        secret = self._secret(provider)
        if secret:
            headers["Authorization"] = f"Bearer {secret}"
        options = provider["options"]
        payload: dict[str, Any] = {
            "model": provider["model"], "messages": messages,
        }
        if tools:
            payload["tools"] = [
                {"type": "function", "function": tool} for tool in tools
            ]
        for key in ("temperature", "max_tokens", "top_p"):
            if key in options:
                payload[key] = options[key]
        data = self.transport(
            provider["base_url"].rstrip("/") + "/chat/completions",
            headers, payload, float(options.get("timeout_seconds", 60)),
        )
        try:
            message = data["choices"][0]["message"]
        except (KeyError, IndexError, TypeError):
            raise RuntimeError("Provider response has no assistant message") from None
        calls = []
        for call in message.get("tool_calls") or []:
            function = call.get("function") or {}
            calls.append({
                "id": call.get("id") or "tool_call",
                "name": function.get("name", ""),
                "arguments": self._arguments(function.get("arguments", {})),
            })
        return {
            "text": message.get("content") or "", "tool_calls": calls,
            "usage": data.get("usage") or {},
            "assistant_message": message,
        }

    def _anthropic(
        self, provider: dict[str, Any], messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> dict[str, Any]:
        secret = self._secret(provider)
        headers = {
            "Content-Type": "application/json", "anthropic-version": "2023-06-01",
        }
        if secret:
            headers["x-api-key"] = secret
        options = provider["options"]
        system = "\n".join(
            str(item.get("content", "")) for item in messages if item.get("role") == "system"
        )
        converted = [item for item in messages if item.get("role") != "system"]
        payload: dict[str, Any] = {
            "model": provider["model"], "messages": converted,
            "max_tokens": int(options.get("max_tokens", 2048)),
        }
        if system:
            payload["system"] = system
        if tools:
            payload["tools"] = [
                {"name": t["name"], "description": t["description"],
                 "input_schema": t["parameters"]} for t in tools
            ]
        data = self.transport(
            provider["base_url"].rstrip("/") + "/v1/messages",
            headers, payload, float(options.get("timeout_seconds", 60)),
        )
        content = data.get("content")
        if not isinstance(content, list):
            raise RuntimeError("Provider response has no assistant content")
        text = "".join(block.get("text", "") for block in content if block.get("type") == "text")
        calls = [
            {"id": block.get("id") or "tool_call", "name": block.get("name", ""),
             "arguments": self._arguments(block.get("input", {}))}
            for block in content if block.get("type") == "tool_use"
        ]
        return {
            "text": text, "tool_calls": calls, "usage": data.get("usage") or {},
            "assistant_message": {"role": "assistant", "content": content},
        }

    @staticmethod
    def _arguments(value: Any) -> dict[str, Any]:
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                raise RuntimeError("Provider returned invalid tool arguments") from None
        if not isinstance(value, dict):
            raise RuntimeError("Provider returned non-object tool arguments")
        return value
