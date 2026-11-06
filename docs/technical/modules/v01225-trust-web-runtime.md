# v0.12.25 Trust and Web Runtime

## Trust Profile

`TrustProfileKernel` records evidence for one exact scope: task class, project, capability revision, model, host, effect and data scope. It returns a recommendation only:

- `human_approval` while evidence is insufficient;
- `notify_only` after repeated passing evidence;
- `automatic` only after a larger, stable, intervention-free sample;
- `blocked` after expiry or revocation.

The recommendation is not an authorization. The existing policy, approval and Adapter gates remain the only execution authority. Profiles expire and can be revoked, so “trust compounding” cannot become permanent privilege escalation.

## File and web operations

Existing `craft_action_gateway_*` remains the file boundary: workspace paths are normalized, traversal is rejected, writes require explicit approval, and receipts record observed results.

`craft_web_fetch` is a read-only HTTP observation. It accepts only HTTP(S), defaults to GET, sends no cookies or credentials, bounds time and bytes, and stores only metadata and a digest in Craft’s durable ledger. The response body is returned to the caller as untrusted observation and is never persisted as Craft state.

`craft_web_action_prepare` and `craft_web_action_complete` are the browser boundary. Navigation, click, fill and submit are contracts for a host/plugin Adapter; Craft does not pretend that a browser was operated and does not grant the Adapter permission by itself. The Adapter must return a receipt and the normal acceptance/evidence gates still apply.

## MCP transport

`craft-mcp` remains stdio and is the lowest-friction local integration. `craft-mcp-http` exposes the same mounted surface at `POST /mcp` with a 4 MiB body limit, JSON/SSE Accept validation, no-store responses and fail-closed malformed requests. TLS, authentication, network exposure and tenant policy belong to the deployment Adapter.

## Release boundary

This release closes the local, testable contracts. It does not claim to ship a universal browser driver, OS-level sandbox, Secret Broker, remote model loop, or production HTTP identity layer. Those are platform-specific Adapter evidence, not permissions that should be inferred from a local record.
