# v0.12.13 Runtime Completion

> Status: implemented and unit-tested locally; OS services, cloud providers, remote registries, A2A identity, and production sandboxes still require deployment adapters and evidence.

v0.12.13 moves Verified Autonomous Work from recording actions to bounded local action execution with independent acceptance.

## Implemented

- `ActionGatewayKernel`: workspace reads/writes only, traversal protection, explicit approval for local writes, and fail-closed shell/browser/MCP adapter boundaries.
- `AcceptanceGateKernel`: Host completion never creates a successful Outcome; a verified Outcome requires independent acceptance with Artifact and Evidence references.
- `DurableWorkerKernel`: persisted worker state, job leases, bounded ticks, and expired-lease recovery. Process hosting and desktop notifications remain OS adapters.
- `ProviderRouterKernel`: preferred provider, fallback order, budget digest, and actual-use receipts. Protocols, streaming, and credentials remain Model/Host adapter concerns.
- `A2AProtocolKernel`: digest-only `message/send`, `message/stream`, and `tasks/list` entry points without remote raw-content trust or automatic execution authority.
- CLI `run`: creates a Context Manifest, Verified Work record, and Acceptance Gate; a successful Host now becomes `needs_review` instead of a passed Outcome.

## Boundary

This release is not an OS sandbox, a complete remote Worker service, a production A2A identity system, or an official MCP Registry. Those require deployment evidence for isolation, Secret Broker, OAuth, object storage, notifications, and receipts.

## Acceptance path

```text
Goal → Context Manifest → Model/Host
     → Action Gateway → Receipt → Reobserve
     → Acceptance Gate → Delivery → Outcome → Trace
```
