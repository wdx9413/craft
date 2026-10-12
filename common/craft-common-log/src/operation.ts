import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { CraftStore } from "../../craft-common-store-local/src/store.ts";
import { stableDigest } from "../../craft-common-base/src/digest.ts";
import { telemetryEvent, type TelemetryEvent } from "./telemetry.ts";
import { StoreTelemetrySink } from "./store-sink.ts";

export type OperationEvent = { event: TelemetryEvent; phase: "started" | "completed" | "failed"; refs: string[] };
type OperationContext = { store: CraftStore; traceId: string; spanId: string; observe?: (event: OperationEvent) => void; onError?: (error: unknown) => void };
// Standalone bundles each include common-log; share only the async carrier across copies.
const contextKey = Symbol.for("craft.operation.context");
const processState = globalThis as typeof globalThis & { [contextKey]?: AsyncLocalStorage<OperationContext> };
const context = processState[contextKey] ??= new AsyncLocalStorage<OperationContext>();
const ref = (value: unknown): value is string => typeof value === "string" && /^[\w:./@-]{1,240}$/u.test(value);
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Stable categories only: exception messages may contain user material or credentials. */
export function operationErrorCode(error: unknown): string {
  const value = object(error);
  if (typeof value.code === "string" && /^(?:ERR_[A-Z_]+|EACCES|ENOENT|EEXIST|EPERM|ETIMEDOUT)$/u.test(value.code)) return value.code;
  const message = error instanceof Error ? error.message : "";
  if (/denied|unauthorized|forbidden/iu.test(message)) return "ACCESS_DENIED";
  if (/conflict|stale|drift/iu.test(message)) return "STATE_CONFLICT";
  if (/budget|limit|exceed/iu.test(message)) return "LIMIT_EXCEEDED";
  if (/unavailable|not mounted/iu.test(message)) return "UNAVAILABLE";
  if (/must|requires?|invalid|unsupported|unknown|missing/iu.test(message)) return "INVALID_INPUT";
  return "OPERATION_FAILED";
}

export function operationResultStatus(result: unknown): string {
  const value = object(result);
  if (value.denied === true) return "denied";
  if (value.isError === true || value.valid === false || value.status === "failed") return "failed";
  if (value.partial === true || object(value.receipt).partial === true) return "partial";
  if (["unavailable", "blocked", "disabled", "skipped", "empty", "inconclusive"].includes(String(value.status))) return String(value.status);
  if (object(value.codebase).status === "unavailable" || value.manifest_status === "unavailable") return "partial";
  return "completed";
}

function references(result: unknown): string[] {
  const outer = object(result), value = Array.isArray(outer.args) ? object(outer.args.find(item => item && typeof item === "object" && !Array.isArray(item))) : outer, refs: string[] = [];
  for (const key of ["receipt", "pack_receipt", "working_set", "procedure", "invocation", "run", "observation", "evidence", "claim", "source", "memory", "index", "workspace", "artifact", "document", "dispatch"]) {
    const id = object(value[key]).id;
    if (ref(id)) refs.push(id);
  }
  for (const key of ["receipt_id", "invocation_id", "procedure_id", "workspace_id", "index_id", "snapshot_id", "task_id", "task_run_id", "evidence_id", "source_id", "memory_id", "claim_id", "dispatch_id"]) if (ref(value[key])) refs.push(value[key]);
  for (const key of ["input_refs", "output_refs"]) for (const id of Object.values(object(value[key]))) if (ref(id)) refs.push(id);
  return [...new Set(refs)].slice(0, 8);
}

export function currentOperation(store: CraftStore): OperationContext | undefined {
  const current = context.getStore();
  return current?.store.paths.root === store.paths.root ? current : undefined;
}

/** Preserve sync SDK contracts and propagate the same context through awaited child calls. */
export function observeOperation<T>(store: CraftStore, component: string, operation: string, input: unknown, run: () => T,
  options: { traceId?: string; parentSpanId?: string; observe?: OperationContext["observe"]; onError?: OperationContext["onError"] } = {}): T {
  const parent = currentOperation(store);
  const spanId = `span_${randomUUID()}`, traceId = options.traceId ?? parent?.traceId ?? `sdk_${randomUUID()}`;
  const active: OperationContext = { store, traceId, spanId, observe: options.observe ?? parent?.observe, onError: options.onError ?? parent?.onError };
  const started = performance.now();
  const emit = (phase: OperationEvent["phase"], result?: unknown, error?: unknown): void => {
    try {
      const status = phase === "started" ? "running" : phase === "failed" ? "failed" : operationResultStatus(result);
      const refs = phase === "completed" ? references(result) : phase === "started" ? references(input) : [];
      const event = telemetryEvent({ signal: "trace", capability_id: component, operation, trace_id: traceId, span_id: spanId,
        parent_span_id: options.parentSpanId ?? (parent?.traceId === traceId ? parent.spanId : null),
        outcome: phase === "started" ? "observed" : phase === "failed" || ["failed", "denied"].includes(status) ? "failed" : status === "completed" ? "succeeded" : "unverified",
        attributes: { stage: phase, status, duration_ms: Math.max(0, performance.now() - started),
          ...(phase === "started" ? { input_digest: stableDigest(input ?? null) } : phase === "failed" ? { reason_code: operationErrorCode(error), error_digest: stableDigest(error instanceof Error ? `${error.name}:${error.message}` : String(error)) } : { result_digest: stableDigest(result ?? null) }),
          ...Object.fromEntries(refs.map((id, index) => [`${phase === "started" ? "input" : "output"}_ref_${index}_id`, id])) } });
      // Independent sinks: a failed Trace projection must not suppress common-log.
      try { new StoreTelemetrySink(store).append(event); } catch (failure) { active.onError?.(failure); }
      try { active.observe?.({ event, phase, refs }); } catch (failure) { active.onError?.(failure); }
    } catch (failure) { active.onError?.(failure); }
  };
  return context.run(active, () => {
    emit("started");
    try {
      const result = run();
      if (result instanceof Promise) return result.then(value => { emit("completed", value); return value; }, error => { emit("failed", undefined, error); throw error; }) as T;
      emit("completed", result); return result;
    } catch (error) { emit("failed", undefined, error); throw error; }
  });
}

/** Instrument a facade once, retaining synchronous methods and its existing public shape. */
export function observeMethods(target: object, store: CraftStore, select: (method: string) => string | null,
  capture?: (component: string, name: string, args: unknown[], run: () => unknown) => unknown): void {
  const seen = new Set<string>();
  for (let prototype: object | null = Object.getPrototypeOf(target); prototype && prototype !== Object.prototype; prototype = Object.getPrototypeOf(prototype)) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const component = select(name), descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (!component || typeof descriptor?.value !== "function") continue;
      const method = descriptor.value as (...args: unknown[]) => unknown;
      Object.defineProperty(target, name, { configurable: true, writable: true, value: function (this: object, ...args: unknown[]) {
        return capture ? capture(component, name, args, () => method.apply(this, args)) : observeOperation(store, component, name, args, () => method.apply(this, args));
      } });
    }
  }
}

/** SDK registration observes public kernel calls without instrumenting private helper recursion. */
export function observedKernel<T extends object>(store: CraftStore, component: string, kernel: T): T {
  const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  return new Proxy(kernel, { get(target, key) {
    const value: unknown = Reflect.get(target, key, target);
    if (typeof value !== "function" || key === "constructor") return value;
    let method = methods.get(key);
    if (!method) {
      method = (...args: unknown[]) => observeOperation(store, component, `${target.constructor.name}.${String(key)}`, args, () => Reflect.apply(value, target, args));
      methods.set(key, method);
    }
    return method;
  } });
}
