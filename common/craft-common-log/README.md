# craft-common-log

Content-free observability SDK for third-party and built-in capabilities. Signals: log, trace, metric, usage/cost, and evaluation. `CraftTelemetry.record()` returns a receipt that separates telemetry failure from the business result. `StoreTelemetrySink` persists events to `craft-common-store-local`; custom sinks can implement `TelemetrySink`. OTLP helpers export stable span links and reject partial acceptance. Evaluation Contract reports are distinct from stages verified by a bound eligible assessment.

```ts
import { CraftTelemetry, StoreTelemetrySink } from "craft-common-log";
import { CraftStore, craftPaths } from "craft-common-store-local";
const store = await new CraftStore(craftPaths("/path/to/data")).open();
const telemetry = new CraftTelemetry(new StoreTelemetrySink(store));
const receipt = await telemetry.record({ signal: "usage", capability_id: "my-capability", operation: "model", trace_id: "trace-1", span_id: "span-1", parent_span_id: null, outcome: "observed", attributes: { input_tokens: 12, output_tokens: 8, cost_usd: 0.001 } });
```

Attributes are limited to bounded identifiers, digests, counters and status fields. Raw prompts, tool results, and credentials are rejected.

`observeOperation(store, component, operation, input, run)` preserves synchronous and async return types and propagates parent spans through awaited calls. Capability registrations use `observedKernel`; the CraftService facade, MCP and Hook entrances also create canonical Traces. Standalone kernel classes can use `observedKernel` explicitly. Only input/result digests, bounded receipt identifiers, duration, safe error categories and business status are retained. A returned handler is distinct from `partial`, `unavailable` or `denied` business results. Telemetry-only Traces are excluded from automatic experience learning.

Normal plugin calls and service startup run a bounded Trace retention sweep when due. The cadence and last success/failure are persisted as `maintenance_component:trace_retention`, visible through component diagnosis. Archive v2 includes associated telemetry and is read back before hot records are removed; v1 archives remain readable. This is on-use maintenance: an idle process does not wake itself, while the existing worker supports continuous maintenance. Usage requires actual measurements; an empty cost ledger reports unknown totals, while measured zero remains zero.
