import { realpathSync, readFileSync, statSync, lstatSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, posix } from "node:path";
import { getQuickJS, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime } from "quickjs-emscripten";
import type { JsonObject } from "./infrastructure/store.ts";

const MEMORY_LIMIT_BYTES = 16 * 1024 * 1024;
const STACK_LIMIT_BYTES = 512 * 1024;
const MAX_HOOK_TIMEOUT_MS = 30_000;
const MAX_RESULT_BYTES = 256 * 1024;

export type ModSandboxResult = { value: unknown; elapsed_ms: number; sandbox: "quickjs-wasm" };

/** @internal Converts QuickJS job errors into host failures and releases the owned handle. */
export function throwPendingModJobError(context: Pick<QuickJSContext, "dump">, jobs: { error?: QuickJSHandle }): void {
  if (!jobs.error) return;
  const error = context.dump(jobs.error);
  jobs.error.dispose();
  throw new Error(`Mod sandbox promise failed: ${typeof error === "string" ? error : JSON.stringify(error)}`);
}

/** @internal Unwraps QuickJS-owned return/error handles for the host boundary. */
export function valueResult(context: Pick<QuickJSContext, "dump">, result: unknown): QuickJSHandle {
  const outcome = result as { value?: QuickJSHandle; error?: QuickJSHandle };
  if (outcome.error) {
    const detail = context.dump(outcome.error);
    outcome.error.dispose();
    throw new Error(`Mod sandbox error: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
  if (!outcome.value) throw new Error("Mod sandbox returned no value");
  return outcome.value;
}

/** @internal Resolves one reviewed-package module without allowing links or escapes. */
export function confinedModule(root: string, moduleName: string): string {
  if (moduleName.startsWith("/") || moduleName.split(/[\\/]+/u).includes("..") || !moduleName.endsWith(".mjs")) {
    throw new Error("Mod sandbox permits only relative .mjs modules inside the reviewed package");
  }
  const candidate = resolve(root, moduleName);
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Mod import escapes the reviewed package");
  if (lstatSync(candidate).isSymbolicLink() || !statSync(candidate).isFile()) throw new Error("Mod imports must resolve to regular files");
  const real = realpathSync(candidate);
  const realRelative = relative(root, real);
  if (!realRelative || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) throw new Error("Mod import escapes the reviewed package");
  return real;
}

async function settle(context: QuickJSContext, runtime: QuickJSRuntime, promiseLike: QuickJSHandle, deadline: number): Promise<QuickJSHandle> {
  const resultPromise = context.resolvePromise(promiseLike);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    const remaining = Math.max(1, deadline - Date.now());
    timer = setTimeout(() => reject(new Error("Mod Hook exceeded its execution timeout")), remaining);
  });
  try {
    while (runtime.hasPendingJob()) {
      const jobs = runtime.executePendingJobs(1_000);
      throwPendingModJobError(context, jobs);
      if (Date.now() >= deadline) throw new Error("Mod Hook exceeded its execution timeout");
      await Promise.resolve();
    }
    const settled = await Promise.race([resultPromise, timeout]);
    return valueResult(context, settled);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function jsonResult(context: QuickJSContext, value: QuickJSHandle): unknown {
  const jsonObject = context.getProp(context.global, "JSON");
  const stringify = context.getProp(jsonObject, "stringify");
  const serialized = valueResult(context, context.callFunction(stringify, jsonObject, value));
  jsonObject.dispose();
  stringify.dispose();
  if (context.typeof(serialized) === "undefined") { serialized.dispose(); return undefined; }
  const source = context.getString(serialized);
  serialized.dispose();
  if (Buffer.byteLength(source) > MAX_RESULT_BYTES) throw new Error("Mod Hook result exceeds 256 KiB");
  return JSON.parse(source) as unknown;
}

/** Execute one Hook in a fresh QuickJS WASM runtime with no Node or host APIs. */
export async function executeModHook(packageRootValue: string, manifest: JsonObject, event: string, input: JsonObject, timeoutValue: number): Promise<ModSandboxResult> {
  const timeoutMs = Number(timeoutValue);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > MAX_HOOK_TIMEOUT_MS) throw new Error("Mod Hook timeout is unsupported");
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const packageRoot = realpathSync(packageRootValue);
  const entry = String(manifest.entry);
  const sourceEntry = confinedModule(packageRoot, entry);
  const declared = new Map(((manifest.hooks ?? []) as JsonObject[]).map((hook) => [String(hook.event), hook]));
  const registered = new Map<string, QuickJSHandle>();
  const runtimeModule = await getQuickJS();
  const runtime = runtimeModule.newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(STACK_LIMIT_BYTES);
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  const context = runtime.newContext();
  try {
    runtime.setModuleLoader((moduleName) => readFileSync(confinedModule(packageRoot, moduleName), "utf8"), (baseModuleName, requestedName) => {
      if (!requestedName.startsWith(".") || requestedName.includes("\\") || requestedName.includes(":")) {
        throw new Error("Mod sandbox blocks bare, absolute, and builtin imports");
      }
      const normalized = posix.normalize(posix.join(posix.dirname(baseModuleName), requestedName));
      if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) throw new Error("Mod import escapes the reviewed package");
      confinedModule(packageRoot, normalized);
      return normalized;
    });
    const register = context.newFunction("__craftRegister", (eventHandle, handlerHandle) => {
      const eventName = context.getString(eventHandle);
      if (!declared.has(eventName)) throw new Error(`Mod registered undeclared event: ${eventName}`);
      if (context.typeof(handlerHandle) !== "function") throw new Error("Mod Hook handler must be a function");
      if (registered.has(eventName)) throw new Error(`Mod registered Hook more than once: ${eventName}`);
      registered.set(eventName, handlerHandle.dup());
      return context.undefined;
    });
    context.setProp(context.global, "__craftRegister", register);
    register.dispose();
    const bootstrap = context.evalCode(`import { register } from ${JSON.stringify(`./${entry}`)}; await register((event, handler) => __craftRegister(event, handler));`, "bootstrap.mjs", { type: "module" });
    const bootstrapPromise = valueResult(context, bootstrap);
    try {
      const loaded = await settle(context, runtime, bootstrapPromise, deadline);
      loaded.dispose();
    } finally { bootstrapPromise.dispose(); }
    context.setProp(context.global, "__craftRegister", context.undefined);
    if (registered.size !== declared.size) throw new Error("Mod must register every declared Hook exactly once");
    const handler = registered.get(event);
    if (!handler) return { value: undefined, elapsed_ms: Date.now() - startedAt, sandbox: "quickjs-wasm" };
    const serializedInput = JSON.stringify(input);
    if (Buffer.byteLength(serializedInput) > MAX_RESULT_BYTES) throw new Error("Mod Hook input exceeds 256 KiB");
    const eventHandle = valueResult(context, context.evalCode(`JSON.parse(${JSON.stringify(serializedInput)})`, "event-input.js", { type: "global" }));
    try {
      const returned = valueResult(context, context.callFunction(handler, context.undefined, eventHandle));
      try {
        const settled = await settle(context, runtime, returned, deadline);
        try { return { value: jsonResult(context, settled), elapsed_ms: Date.now() - startedAt, sandbox: "quickjs-wasm" }; }
        finally { settled.dispose(); }
      } finally { returned.dispose(); }
    } finally { eventHandle.dispose(); }
  } finally {
    for (const handle of registered.values()) handle.dispose();
    context.dispose();
    runtime.dispose();
  }
}
