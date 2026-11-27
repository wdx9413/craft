import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { ContextExtensionsKernel } from "../core/context-extensions.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths, sessionStorageScopeId } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { LocalSupervisor } from "../core/supervisor.ts";
import { SupervisorClient } from "../core/supervisor.ts";
import { startContextSupervisor } from "../core/interfaces/context-supervisor.ts";
import { atomicPrivateJson } from "../core/infrastructure/paths.ts";

test("Context data is shared through the supervisor without session database records", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-context-memory-"));
  const paths = craftPaths(root);
  const store = await new CraftStore(paths).open();
  const supervisor = new LocalSupervisor(new CraftService(store), paths);
  try {
    await supervisor.start();
    const args = { session_id: "session", session_host: "codex" };
    const first = new ContextExtensionsKernel(store);
    await first.recordEphemeral({ ...args, items: [{ text: "useful observation" }] });
    await first.checkpointResume({ ...args, tasks: ["continue work"] });
    const supervisorModule = pathToFileURL(join(process.cwd(), "core/interfaces/supervisor.ts")).href;
    const pathsModule = pathToFileURL(join(process.cwd(), "core/infrastructure/paths.ts")).href;
    const script = `import { SupervisorClient } from ${JSON.stringify(supervisorModule)};
      import { craftPaths, sessionStorageScopeId } from ${JSON.stringify(pathsModule)};
      const client = new SupervisorClient(craftPaths(process.argv[1]));
      const result = await client.contextGet({ session_key: sessionStorageScopeId("codex", "session"), key: process.argv[2] });
      process.stdout.write(JSON.stringify(result));`;
    const index = await first.recordEphemeral({ ...args, source: "cross-process", items: [{ text: "visible to another process" }] });
    const child = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, root, `index:${index.index_id}`]);
    assert.equal(JSON.parse(child.stdout).status, "available");
    const second = new ContextExtensionsKernel(store);
    assert.equal((await second.searchEphemeral({ ...args, query: "observation" })).reason, "matched");
    assert.equal((await second.getResume(args)).resume_available, true);
    assert.equal(store.list("context_ephemeral_index", 10).length, 0);
    assert.equal(store.list("context_resume_snapshot", 10).length, 0);
    assert.equal((await second.purgeEphemeral(args)).removed, 2);
    assert.equal((await second.searchEphemeral({ ...args, query: "observation" })).reason, "index_unavailable");
    assert.equal((await second.getResume(args)).resume_available, true);
    await supervisor.close();
    await supervisor.start();
    assert.equal((await second.getResume(args)).reason, "snapshot_unavailable");
  } finally { await supervisor.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a surviving MCP connection reopens unavailable Context storage after its owner stops", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-context-recovery-"));
  const paths = craftPaths(root);
  const store = await new CraftStore(paths).open();
  const service = new CraftService(store);
  const first = await startContextSupervisor(service, 20);
  const second = await startContextSupervisor(service, 20);
  const client = new SupervisorClient(paths);
  const args = { session_key: `codex--${"a".repeat(64)}`, key: "resume" };
  try {
    await client.contextPut({ ...args, value: { task: "work" }, ttl_ms: 10000 });
    await first();
    let recovered = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await client.contextGet(args)).status === "unavailable") { recovered = true; break; }
      } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    assert.equal(recovered, true);
    await client.contextPut({ ...args, value: { task: "next" }, ttl_ms: 10000 });
    assert.equal((await client.contextGet(args)).status, "available");
  } finally { await second(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a separate MCP process takes over after the Context owner exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-context-process-"));
  const paths = craftPaths(root);
  const store = await new CraftStore(paths).open();
  const first = await startContextSupervisor(new CraftService(store), 20);
  const moduleUrl = (path: string) => pathToFileURL(join(process.cwd(), path)).href;
  const script = `import { CraftStore } from ${JSON.stringify(moduleUrl("core/infrastructure/store.ts"))};
    import { craftPaths } from ${JSON.stringify(moduleUrl("core/infrastructure/paths.ts"))};
    import { CraftService } from ${JSON.stringify(moduleUrl("core/service.ts"))};
    import { startContextSupervisor } from ${JSON.stringify(moduleUrl("core/interfaces/context-supervisor.ts"))};
    const store = await new CraftStore(craftPaths(process.argv[1])).open();
    const stop = await startContextSupervisor(new CraftService(store), 20);
    process.stdout.write("ready\\n");
    process.stdin.resume();
    process.stdin.once("data", async () => { await stop(); store.close(); process.exit(0); });`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, root], { stdio: ["pipe", "pipe", "pipe"] });
  const client = new SupervisorClient(paths);
  const args = { session_key: `codex--${"b".repeat(64)}`, key: "resume" };
  try {
    await once(child.stdout, "data");
    await client.contextPut({ ...args, value: { task: "work" }, ttl_ms: 10000 });
    await first();
    let recovered = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await client.contextGet(args)).status === "unavailable") { recovered = true; break; }
      } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    assert.equal(recovered, true);
    await client.contextPut({ ...args, value: { task: "next" }, ttl_ms: 10000 });
    assert.equal((await client.contextGet(args)).status, "available");
  } finally {
    const exited = once(child, "exit");
    child.stdin.end("stop");
    await exited;
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an owner repairs unavailable health state without discarding live Context data", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-context-owner-recovery-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open();
  const stop = await startContextSupervisor(new CraftService(store), 20);
  const client = new SupervisorClient(paths);
  try {
    assert.equal((await client.status()).status, "ok");
    const session = sessionStorageScopeId("codex", "health-state");
    await client.contextPut({ session_key: session, key: "test:live", value: { marker: "preserved" }, ttl_ms: 60_000 });
    await atomicPrivateJson(join(paths.runtimeDir, "supervisor.json"), { status: "stopped" });
    let recovered = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await client.status()).status === "ok") { recovered = true; break; } }
      catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    assert.equal(recovered, true);
    assert.deepEqual((await client.contextGet({ session_key: session, key: "test:live" })).value, { marker: "preserved" });
  } finally { await stop(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("an owner never republishes Context state when its lock or health proof is invalid", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-context-health-failed-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open();
  const stop = await startContextSupervisor(new CraftService(store), 20);
  const statePath = join(paths.runtimeDir, "supervisor.json"), lockPath = join(paths.runtimeDir, "supervisor.lock.json");
  const lock = await readFile(lockPath, "utf8"), fetchOriginal = globalThis.fetch;
  try {
    await atomicPrivateJson(statePath, { status: "stopped" });
    await atomicPrivateJson(lockPath, { owner_id: "other" });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).status, "stopped");
    await writeFile(lockPath, lock);
    globalThis.fetch = async () => new Response(JSON.stringify({ status: "bad", owner_id: "other" }), { status: 503 });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).status, "stopped");
    globalThis.fetch = fetchOriginal;
    const client = new SupervisorClient(paths);
    let recovered = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await client.status()).status === "ok") { recovered = true; break; } }
      catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    assert.equal(recovered, true);
  } finally { globalThis.fetch = fetchOriginal; await writeFile(lockPath, lock); await stop(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("the Context stdio MCP starts the memory supervisor before accepting calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-context-mcp-start-"));
  const child = spawn(process.execPath, ["--experimental-strip-types", "bin/craft-mcp.ts", "--product", "context"], {
    cwd: process.cwd(), env: { ...process.env, CRAFT_DATA_DIR: root, CRAFT_CONTINUOUS_LEARNING: "1", CRAFT_EXPERIENCE_ASSET_MIGRATION: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) + "\n");
    const [response] = await once(child.stdout, "data");
    assert.equal(JSON.parse(String(response)).id, 1);
    assert.equal((await new SupervisorClient(craftPaths(root)).status()).status, "ok");
    await access(join(root, "runtime", "learning-worker-knowledge.lock.json"));
  } finally {
    const done = once(child, "exit");
    child.stdin.end();
    await done;
    assert.equal(child.exitCode, 0, stderr);
    await rm(root, { recursive: true, force: true });
  }
});

test("the full stdio MCP starts and stops its Context supervisor", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-context-full-start-"));
  const child = spawn(process.execPath, ["--experimental-strip-types", "bin/craft-mcp-full.ts"], {
    cwd: process.cwd(), env: { ...process.env, CRAFT_DATA_DIR: root }, stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) + "\n");
    const [response] = await once(child.stdout, "data");
    assert.equal(JSON.parse(String(response)).id, 1);
    assert.equal((await new SupervisorClient(craftPaths(root)).status()).status, "ok");
  } finally {
    const done = once(child, "exit");
    child.stdin.end();
    await done;
    assert.equal(child.exitCode, 0, stderr);
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP startup reports an unavailable data root", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-context-start-error-"));
  const invalidRoot = join(root, "file");
  await writeFile(invalidRoot, "not a directory");
  try {
    for (const args of [["bin/craft-mcp.ts", "--product", "context"], ["bin/craft-mcp-full.ts"]]) {
      const child = spawn(process.execPath, ["--experimental-strip-types", ...args], {
        cwd: process.cwd(), env: { ...process.env, CRAFT_DATA_DIR: invalidRoot }, stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += String(chunk); });
      const done = once(child, "exit");
      child.stdin.end();
      await done;
      assert.equal(child.exitCode, 1);
      assert.match(stderr, /MCP failed to start/u);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("MCP entry closes started workers on startup failure and normal shutdown", async () => {
  for (const [entry, scenario, exitCode, markers] of [
    ["bin/craft-mcp.ts", "runtime", 0, ["runtime:true", "asset:false", "asset-stopped", "trace-stopped", "learning-stopped", "supervisor-stopped"]],
    ["bin/craft-mcp.ts", "experience", 0, ["runtime:false", "asset:true", "supervisor-stopped"]],
    ["bin/craft-mcp.ts", "standalone", 0, ["runtime:true", "asset:true"]],
    ["bin/craft-mcp.ts", "asset-failure", 1, ["trace-stopped", "learning-stopped", "supervisor-stopped"]],
    ["bin/craft-mcp.ts", "learning-failure", 1, ["supervisor-stopped"]],
    ["bin/craft-mcp.ts", "missing", 1, []],
    ["bin/craft-mcp-full.ts", "missing", 1, []],
  ] as const) {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--experimental-loader", join(process.cwd(), "tests/fixtures/mcp-entry-loader.mjs"), entry],
      { cwd: process.cwd(), env: { ...process.env, CRAFT_TEST_ENTRY: scenario }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", chunk => { output += String(chunk); });
    const [code] = await once(child, "exit");
    assert.equal(code, exitCode, `${entry}: ${scenario}`);
    for (const marker of markers) assert.match(output, new RegExp(marker));
  }
});
