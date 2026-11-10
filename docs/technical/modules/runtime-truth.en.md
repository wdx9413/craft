# Runtime Truth Layer (v0.12.8)

v0.12.8 turns runtime facts into a host-neutral protocol:

- `craft.trace.v1` remains readable; new records use the versionless `craft.trace` envelope and evolve through `schema_revision`.
- Internal Host automatically correlates model requests, Tool Calls, tool results, final turns, and failures. Traces store bounded summaries, digests, references, and usage—not prompts or business bodies.
- OpenAI-compatible and Anthropic Tool Calls normalize to `{id,name,arguments}`. SSE parsing accepts JSON `data:` frames and ignores `[DONE]`.
- When a conversation exceeds its window, system constraints and recent work are retained while older turns become a digest-backed compaction note. Resume reads only the same session checkpoint.
- `craft.trace` maps to OTLP/HTTP `resourceSpans`; the host must provide the endpoint and network permission.

Runtime Truth does not enlarge the default MCP surface. The route Skill still decides whether Craft is needed, and selected Runtime/Trace capabilities are mounted only through Full MCP or explicit syscall calls.
