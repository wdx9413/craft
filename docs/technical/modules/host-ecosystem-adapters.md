# TraeWork / WorkBuddy host adapters

> Implementation baseline: v0.11.62. These are local integration and marketplace-submission packages, not claims that Craft has been approved by either marketplace or that a cloud MCP service exists.

## Goal

Craft's provider phase must not be tied to one coding Host. The portable boundary is MCP: the same `CraftService`, local state store, evidence rules and activation policy are exposed through a stdio server. A Skill is intentionally small and tells a Host when to use the high-level routing tools; it does not reimplement Craft's policy in prose.

```text
Codex / Claude / TraeWork / WorkBuddy
   ├─ craft-route Skill (only default Skill) ── decide whether Craft is needed
   ├─ MCP client ── craft-mcp (Core) ── Craft core ── ~/.craft_data
   │                                     ├─ Task / Evidence / Workflow
   │                                     └─ approval and evaluation gates
   └─ craft-mcp-full ─ explicit user-approved administration only
```

`craft-mcp` plus exactly one default Skill, `craft-route`, is the default in Codex, Claude, TraeWork and the WorkBuddy Expert. Routing, continuity, bounded context, evidence and profile-bound tickets cover ordinary governed work without polluting tool selection. `craft` and `craft-clarify` remain separate opt-in Skill packages. `craft-mcp-full` remains the explicit compatibility endpoint for registering, reviewing or changing external capability sources; the WorkBuddy Connector packages this advanced surface for users who deliberately need it. The two modes share data and enforcement; neither turns an unapproved effect into an approved one.

## TraeWork

[`adapters/trae-work/`](../../../adapters/trae-work/README.md) provides the exact JSON accepted by TraeWork's manual local MCP configuration and uploadable Skills. `craft-route` is the only recommended default upload; `craft` and `craft-clarify` are separately selectable opt-in packages. Its `mcp.json` starts Core; `mcp-full.json` is the deliberate advanced alternative. Local stdio MCP runs only on TraeWork Desktop. Web and cloud tasks require a deployment-owned HTTPS MCP Adapter, its own identity and authorization design, and a new evidence review. The package deliberately does not claim that local Craft state is reachable from cloud tasks.

## WorkBuddy

[`adapters/workbuddy-connector/`](../../../adapters/workbuddy-connector/README.md) follows WorkBuddy's MCP + Skill connector structure: one MCP server, `connector-meta.json`, market icon and exactly one route Skill. It is the explicit Full-MCP Connector, not the Expert entry. [`adapters/workbuddy-expert/`](../../../adapters/workbuddy-expert/README.md) is the separately uploadable, route-first Expert package: `.codebuddy-plugin/plugin.json`, a PNG avatar, one Agent, exactly one `craft-route` Skill, and a Core MCP dependency. The local command expects a separately installed Craft executable; this avoids a brittle Git bootstrap during Connector startup. Publishing remains a WorkBuddy review step. A future remote connector must use HTTPS and preserve Craft's approval/evidence boundary rather than forwarding raw user context to an untrusted service.

## Non-goals and next deployment step

- No private Host API is used and neither host's proprietary plugin manifest is treated as a portable standard.
- No Skill or connector automatically installs external Sources, stores credentials, starts remote Agents, or grants write effects.
- No cloud MCP endpoint, WorkBuddy marketplace publication, TraeWork marketplace publication, or SSO bridge exists yet.

The next production step is an authenticated, observable HTTPS MCP deployment Adapter with tenant-scoped storage and a test case that proves its Host receipt and Craft Evidence lineage. That is a deployment capability, not something a static manifest can safely simulate.
