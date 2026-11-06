import type { CraftStore, JsonObject } from "../../craft-common-store-local/src/store.ts";
import type { TelemetryEvent, TelemetrySink } from "./index.ts";

/** Append-only local sink; an event id can be retried only with identical content. */
export class StoreTelemetrySink implements TelemetrySink {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  append(event: TelemetryEvent): void {
    const previous = this.store.find("telemetry_event", event.event_id);
    if (previous) {
      const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...payload } = previous;
      if (JSON.stringify(payload) !== JSON.stringify(event)) throw new Error("telemetry event idempotency conflict");
      return;
    }
    this.store.create("telemetry_event", event.event_id, event as unknown as JsonObject);
  }

  list(traceId: string, limit = 100): TelemetryEvent[] {
    if (!traceId.trim() || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("invalid telemetry query bounds");
    return this.store.list("telemetry_event", limit, item => item.trace_id === traceId)
      .map(({ id: _id, version: _version, created_at: _created, updated_at: _updated, ...event }) => event as unknown as TelemetryEvent);
  }
}
