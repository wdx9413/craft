import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import {
  LocalProcessSandboxAdapter, localProcessEnvironment, localProcessRequestDigest,
  localProcessWorkspace, runLocalProcess,
} from "../core/local-process-sandbox.ts";

const capabilities = {
  filesystem: "workspace_overlay", network: "unrestricted",
  network_allowlist: [], features: ["process_isolation", "cancel"],
  limits: { timeout_ms: 10_000, output_limit: 65_536 },
};

const node = (script: string) => [process.execPath, "-e", script];

async function scratch(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "craft-local-sandbox-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("local process environment forwards only allowlisted names and drops credentials", () => {
  const source = { PATH: "/bin", HOME: "/home/me", OPENAI_API_KEY: "secret", MY_TOKEN: "secret", LANG: "C" };
  const env = localProcessEnvironment({ SAFE_MARKER: "visible", AWS_SECRET_ACCESS_KEY: "nope" }, source);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/home/me");
  assert.equal(env.LANG, "C");
  assert.equal(env.SAFE_MARKER, "visible");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.MY_TOKEN, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.throws(() => localProcessEnvironment({ SAFE_MARKER: 1 as never }), /must be a string/u);
});

test("local process workspace refuses paths that escape the runtime root", async () => {
  const { root, cleanup } = await scratch();
  try {
    assert.equal(localProcessWorkspace(root, "ticket"), join(root, "ticket"));
    assert.throws(() => localProcessWorkspace(root, "../outside"), /escapes/u);
    assert.throws(() => localProcessWorkspace(root, "a/../../outside"), /escapes/u);
    assert.throws(() => localProcessWorkspace(root, ""), /must not be empty|must be a string/u);
  } finally { await cleanup(); }
});

test("runLocalProcess returns the exit code, output and scrub credentials", async () => {
  const { root, cleanup } = await scratch();
  try {
    const result = await runLocalProcess(node("process.stdout.write('hello'); process.stderr.write('api_key=abc123'); process.exit(7)"), {
      cwd: root, timeoutMs: 10_000, outputLimit: 65_536, env: localProcessEnvironment(),
    });
    assert.equal(result.code, 7);
    assert.equal(result.stdout, "hello");
    assert.match(result.stderr, /api_key=\[REDACTED\]/u);
    assert.equal(result.timed_out, false);
    assert.equal(result.output_limited, false);
  } finally { await cleanup(); }
});

test("runLocalProcess terminates a long child on timeout", async () => {
  const { root, cleanup } = await scratch();
  try {
    const started = Date.now();
    const result = await runLocalProcess(node("setTimeout(() => {}, 60000)"), {
      cwd: root, timeoutMs: 300, outputLimit: 65_536, env: localProcessEnvironment(),
    });
    assert.equal(result.timed_out, true);
    assert.ok(Date.now() - started < 20_000, "timeout must terminate promptly");
  } finally { await cleanup(); }
});

test("runLocalProcess stops a child that floods stdout", async () => {
  const { root, cleanup } = await scratch();
  try {
    const result = await runLocalProcess(node("for (let i = 0; i < 200000; i++) process.stdout.write('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n')"), {
      cwd: root, timeoutMs: 20_000, outputLimit: 4_096, env: localProcessEnvironment(),
    });
    assert.equal(result.output_limited, true);
    assert.ok(Buffer.byteLength(result.stdout) <= 4_096);
  } finally { await cleanup(); }
});

test("the adapter probes, runs conformance and executes inside the confined workspace", async () => {
  const { root, cleanup } = await scratch();
  try {
    const adapter = new LocalProcessSandboxAdapter();
    const probe = await adapter.probe(root, capabilities);
    assert.equal(probe.status, "passed");
    assert.equal(probe.os_sandbox_guaranteed, false);

    const conformance = await adapter.conformance("ticket-conformance", root, capabilities);
    assert.equal(conformance.status, "passed");
    assert.equal(conformance.os_sandbox_guaranteed, false);
    assert.deepEqual((conformance.checks as Array<{ check: string; passed: boolean }>).map((c) => [c.check, c.passed]), [
      ["baseline", true], ["workspace_write", true], ["env_allowlisted", true],
      ["timeout_cancel", true], ["output_limit", true],
    ]);

    const command = node("require('node:fs').writeFileSync('out.txt','ok'); process.stdout.write(String(process.cwd()))");
    const workspace = localProcessWorkspace(root, "ticket-run");
    const executed = await adapter.execute({
      ticket_id: "ticket-run", runtime_root: root, command, capabilities,
      request_digest: localProcessRequestDigest(command, workspace),
    });
    assert.equal(executed.status, "passed");
    assert.equal(executed.os_sandbox_guaranteed, false);
    assert.equal(await readFile(join(workspace, "out.txt"), "utf8"), "ok");
    // macOS may expose the temporary directory through /var or /private/var.
    assert.equal(String(executed.stdout), await realpath(workspace));
  } finally { await cleanup(); }
});

test("the adapter refuses a mismatched request digest and an unsupported capability claim", async () => {
  const { root, cleanup } = await scratch();
  try {
    const adapter = new LocalProcessSandboxAdapter();
    await assert.rejects(() => adapter.execute({
      ticket_id: "ticket", runtime_root: root, command: node("process.exit(0)"), capabilities,
      request_digest: "sha256:wrong",
    }), /digest mismatch/u);
    // Claiming network denial is not something a plain child process can enforce.
    await assert.rejects(() => adapter.probe(root, { ...capabilities, network: "denied" }), /cannot deny network/u);
    // Claiming a feature it cannot enforce is refused rather than silently ignored.
    await assert.rejects(() => adapter.probe(root, { ...capabilities, features: ["process_isolation", "cancel", "snapshot"] }), /unsupported features/u);
    await assert.rejects(() => adapter.probe(root, { ...capabilities, limits: { memory_mb: 128 } }), /unsupported resource limit/u);
  } finally { await cleanup(); }
});

test("the backend refuses a filesystem mode it cannot confine", async () => {
  const { root, cleanup } = await scratch();
  try {
    await assert.rejects(() => new LocalProcessSandboxAdapter().probe(root, { ...capabilities, filesystem: "none" }),
      /requires workspace_overlay/u);
  } finally { await cleanup(); }
});

function fakeChild(overrides: Record<string, unknown> = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; pid?: number; killed?: NodeJS.Signals; kill: (signal?: NodeJS.Signals) => boolean;
  };
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.pid = 424242;
  // Close only once the kill arrives, so the timeout path actually runs.
  child.kill = (signal) => { child.killed = signal; setImmediate(() => child.emit("close", 137)); return true; };
  return Object.assign(child, overrides);
}

const options = (root: string) => ({ cwd: root, timeoutMs: 1_000, outputLimit: 4_096, env: localProcessEnvironment() });

test("runLocalProcess rejects when the child emits an error before closing", async () => {
  const { root, cleanup } = await scratch();
  try {
    const child = fakeChild();
    const pending = runLocalProcess(node(""), options(root), (() => {
      setImmediate(() => {
        child.emit("error", new Error("spawn failed"));
        // A late close after the error must not settle the promise twice.
        child.emit("close", 1);
      });
      return child;
    }) as never);
    await assert.rejects(pending, /spawn failed/u);
  } finally { await cleanup(); }
});

test("runLocalProcess rejects when spawning throws synchronously", async () => {
  const { root, cleanup } = await scratch();
  try {
    await assert.rejects(runLocalProcess(node(""), options(root), (() => { throw new Error("no such binary"); }) as never), /no such binary/u);
  } finally { await cleanup(); }
});

test("a timeout on POSIX falls back to child.kill when the process group is gone", async () => {
  const { root, cleanup } = await scratch();
  try {
    const child = fakeChild();
    const pending = runLocalProcess(node(""), { ...options(root), timeoutMs: 20 }, (() => child) as never, "linux");
    const result = await pending;
    assert.equal(result.timed_out, true);
    assert.equal(child.killed, "SIGKILL");
  } finally { await cleanup(); }
});

test("a timeout without a child pid still terminates the child", async () => {
  const { root, cleanup } = await scratch();
  try {
    const child = fakeChild({ pid: undefined });
    const pending = runLocalProcess(node(""), { ...options(root), timeoutMs: 20 }, (() => child) as never, "win32");
    const result = await pending;
    assert.equal(result.timed_out, true);
    assert.equal(child.killed, "SIGKILL");
  } finally { await cleanup(); }
});

test("a Windows timeout with a pid goes through the process-tree kill", async () => {
  const { root, cleanup } = await scratch();
  try {
    const child = fakeChild();
    // The Windows branch spawns `taskkill` instead of calling child.kill, so the
    // fake child has to close itself after the timeout fires.
    setTimeout(() => child.emit("close", 137), 80);
    const pending = runLocalProcess(node(""), { ...options(root), timeoutMs: 20 }, (() => child) as never, "win32");
    const result = await pending;
    assert.equal(result.timed_out, true);
  } finally { await cleanup(); }
});

test("a child that exits without a code reports 1", async () => {
  const { root, cleanup } = await scratch();
  try {
    const child = fakeChild();
    const pending = runLocalProcess(node(""), options(root), (() => { setImmediate(() => child.emit("close", null)); return child; }) as never);
    assert.equal((await pending).code, 1);
  } finally { await cleanup(); }
});

test("the adapter rejects an empty command and an invalid limit", async () => {
  const { root, cleanup } = await scratch();
  try {
    const adapter = new LocalProcessSandboxAdapter();
    await assert.rejects(() => adapter.execute({ ticket_id: "t", runtime_root: root, command: [], capabilities,
      request_digest: "sha256:x" }), /non-empty string array/u);
    await assert.rejects(() => adapter.probe(root, { ...capabilities, limits: { timeout_ms: 5 } }), /timeout_ms limit is unsupported/u);
  } finally { await cleanup(); }
});

test("the adapter fails closed when the runner cannot satisfy a probe or a conformance check", async () => {
  const { root, cleanup } = await scratch();
  try {
    const failing = new LocalProcessSandboxAdapter(async () => ({ code: 1, stdout: "", stderr: "", timed_out: false, output_limited: false }));
    await assert.rejects(() => failing.probe(root, capabilities), /probe failed closed/u);
    await assert.rejects(() => failing.conformance("ticket", root, capabilities), /conformance failed closed/u);
  } finally { await cleanup(); }
});

test("execute treats a timeout as timed_out and accepts or ignores the environment shape", async () => {
  const { root, cleanup } = await scratch();
  try {
    const timeouts = new LocalProcessSandboxAdapter(async () => ({ code: 0, stdout: "", stderr: "", timed_out: true, output_limited: false }));
    const command = node("process.exit(0)");
    const workspace = localProcessWorkspace(root, "ticket-timeout");
    const timedOut = await timeouts.execute({ ticket_id: "ticket-timeout", runtime_root: root, command, capabilities,
      request_digest: localProcessRequestDigest(command, workspace) });
    assert.equal(timedOut.status, "timed_out");

    const seen: Array<Record<string, unknown>> = [];
    const recorder = new LocalProcessSandboxAdapter(async (_argv, opts) => {
      seen.push(opts.env);
      return { code: 1, stdout: "", stderr: "", timed_out: false, output_limited: false };
    });
    for (const environment of [undefined, [], "nope", { SAFE_MARKER: "visible" }]) {
      const result = await recorder.execute({ ticket_id: "ticket-env", runtime_root: root, command, capabilities,
        request_digest: localProcessRequestDigest(command, localProcessWorkspace(root, "ticket-env")),
        ...(environment === undefined ? {} : { environment }) });
      assert.equal(result.status, "failed");
    }
    // Only the object-shaped environment reaches the child; the other shapes are
    // ignored rather than forwarded.
    assert.equal(seen[0]!.SAFE_MARKER, undefined);
    assert.equal(seen[3]!.SAFE_MARKER, "visible");
  } finally { await cleanup(); }
});

test("execute invokes the beforeStart hook exactly once before running", async () => {
  const { root, cleanup } = await scratch();
  try {
    let started = 0;
    const adapter = new LocalProcessSandboxAdapter(async () => ({ code: 0, stdout: "", stderr: "", timed_out: false, output_limited: false }));
    const command = node("process.exit(0)");
    await adapter.execute({ ticket_id: "ticket-hook", runtime_root: root, command, capabilities,
      request_digest: localProcessRequestDigest(command, localProcessWorkspace(root, "ticket-hook")) }, () => { started += 1; });
    assert.equal(started, 1);
  } finally { await cleanup(); }
});
