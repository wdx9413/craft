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
