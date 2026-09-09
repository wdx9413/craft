import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { DockerSandboxAdapter, dockerRequestDigest, runDocker, type DockerResult, type DockerRunner } from "../src/docker-sandbox.ts";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

const dockerCaps = { filesystem: "workspace_overlay", network: "denied", features: ["process_isolation", "cancel"],
  network_allowlist: [], limits: { memory_mb: 128, timeout_ms: 1_000, pids: 32, cpu_count: 0.5 } };
const ok: DockerResult = { code: 0, stdout: "ok", stderr: "", timed_out: false, output_limited: false };

test("Docker Adapter probes hardened flags and executes only an exact verified ticket", async () => {
  const root = join(tmpdir(), `craft-docker-${process.pid}-${Date.now()}`); const store = await new CraftStore(craftPaths(root)).open();
  const calls: string[][] = []; const runner: DockerRunner = async (argv) => {
    calls.push(argv);
    if (argv.includes("sleep 60")) return { ...ok, code: 1, timed_out: true };
    if (argv[0] === "ps") return { ...ok, stdout: "" };
    return ok;
  };
  const service = new CraftService(store, undefined, undefined, new DockerSandboxAdapter(runner));
  try {
    const task = service.taskOpen({ title: "Docker", goal: "Run isolated" }).task as JsonObject;
    service.sandboxProfileSave({ profile_id: "docker_profile", name: "Docker", backend: "container", adapter_id: "docker", capabilities: dockerCaps });
    const probed = await service.dockerSandboxProbe({ profile_id: "docker_profile", profile_version: 1, image: "busybox:1" });
    assert.equal((probed.profile as JsonObject).lifecycle, "declared"); assert.equal(calls.length, 3);
    assert.deepEqual(calls[0], ["version", "--format", "{{.Server.Version}}"]); assert.deepEqual(calls[1], ["image", "inspect", "busybox:1"]);
    assert.ok(calls[2].includes("--network")); assert.ok(calls[2].includes("none")); assert.ok(calls[2].includes("--read-only"));
    assert.ok(calls[2].includes("no-new-privileges")); assert.ok(calls[2].includes("--cap-drop"));
    const conformed = await service.dockerSandboxConformance({ profile_id: "docker_profile", profile_version: 1,
      image: "busybox:1", probe_id: "primary" });
    assert.equal((conformed.profile as JsonObject).lifecycle, "verified");
    assert.equal(((conformed.conformance as JsonObject).checks as JsonObject[]).length, 7);
    const digest = service.dockerSandboxRequestDigest({ image: "busybox:1", argv: ["echo", "hello"] }).request_digest;
    service.sandboxPlan({ task_id: task.id, profile_id: "docker_profile", profile_version: 2,
      requirements: { filesystem: "workspace_overlay", network: "denied", features: ["process_isolation", "cancel"], limits: { memory_mb: 64 } },
      request_digest: digest, ticket_id: "docker_ticket" });
    const executed = await service.dockerSandboxExecute({ ticket_id: "docker_ticket", receipt_id: "docker_receipt", image: "busybox:1", argv: ["echo", "hello"] });
    assert.equal((executed.result as JsonObject).status, "passed"); assert.equal((executed.receipt as JsonObject).boundary_matches, true);
    const run = calls.find((call) => call.includes("echo") && call.includes("hello")) as string[];
    assert.ok(run.includes("--mount")); assert.ok(run.includes("/workspace")); assert.deepEqual(run.slice(-3), ["busybox:1", "echo", "hello"]);

    const server = new McpServer(service, "full");
    const response = await server.handle({ id: 1, method: "tools/call", params: { name: "craft_docker_sandbox_request_digest",
      arguments: { image: "busybox:1", argv: ["true"] } } });
    assert.equal((response?.result as JsonObject).isError, false);
    service.sandboxProfileSave({ profile_id: "mcp_docker", name: "MCP Docker", backend: "container", adapter_id: "docker", capabilities: dockerCaps });
    const mcpProbe = await server.handle({ id: 2, method: "tools/call", params: { name: "craft_docker_sandbox_probe",
      arguments: { profile_id: "mcp_docker", profile_version: 1, image: "busybox:1" } } });
    assert.equal((mcpProbe?.result as JsonObject).isError, false);
    const mcpConformance = await server.handle({ id: 22, method: "tools/call", params: { name: "craft_docker_sandbox_conformance",
      arguments: { profile_id: "mcp_docker", profile_version: 1, image: "busybox:1" } } });
    assert.equal((mcpConformance?.result as JsonObject).isError, false);
    const mcpDigest = dockerRequestDigest("busybox:1", ["true"]);
    service.sandboxPlan({ task_id: task.id, profile_id: "mcp_docker", profile_version: 2,
      requirements: { filesystem: "workspace_overlay", network: "denied", features: [], limits: {} },
      request_digest: mcpDigest, ticket_id: "mcp_docker_ticket" });
    const mcpExecute = await server.handle({ id: 3, method: "tools/call", params: { name: "craft_docker_sandbox_execute",
      arguments: { ticket_id: "mcp_docker_ticket", receipt_id: "mcp_docker_receipt", image: "busybox:1", argv: ["true"] } } });
    assert.equal((mcpExecute?.result as JsonObject).isError, false);
    await assert.rejects(service.dockerSandboxProbe({ profile_id: "docker_profile", profile_version: 2, image: "busybox:1" }), /exact declared/);
    await assert.rejects(service.dockerSandboxConformance({ profile_id: "docker_profile", profile_version: 2, image: "busybox:1" }), /exact declared/);
    service.sandboxProfileSave({ profile_id: "remote_profile", name: "Remote", backend: "remote", adapter_id: "docker", capabilities: dockerCaps });
    await assert.rejects(service.dockerSandboxProbe({ profile_id: "remote_profile", profile_version: 1, image: "busybox:1" }), /exact declared/);
    await assert.rejects(service.dockerSandboxConformance({ profile_id: "remote_profile", profile_version: 1, image: "busybox:1" }), /exact declared/);
    service.sandboxProfileSave({ profile_id: "other_profile", name: "Other", backend: "container", adapter_id: "other", capabilities: dockerCaps });
    await assert.rejects(service.dockerSandboxProbe({ profile_id: "other_profile", profile_version: 1, image: "busybox:1" }), /exact declared/);
    await assert.rejects(service.dockerSandboxConformance({ profile_id: "other_profile", profile_version: 1, image: "busybox:1" }), /exact declared/);
    const probeEvidence = (conformed.evidence as JsonObject).id;
    for (const profileId of ["remote_profile", "other_profile"]) {
      service.sandboxProfileVerify({ profile_id: profileId, profile_version: 1, observed_capabilities: dockerCaps,
        evidence_ids: [probeEvidence], verifier: "test" });
      service.sandboxPlan({ task_id: task.id, profile_id: profileId, profile_version: 2,
        requirements: { filesystem: "workspace_overlay", network: "denied", features: [], limits: {} },
        request_digest: dockerRequestDigest("busybox:1", ["true"]), ticket_id: `${profileId}_ticket` });
      await assert.rejects(service.dockerSandboxExecute({ ticket_id: `${profileId}_ticket`, receipt_id: `${profileId}_receipt`,
        image: "busybox:1", argv: ["true"] }), /not assigned/);
    }
    const failedDigest = dockerRequestDigest("busybox:1", ["false"]);
    service.sandboxPlan({ task_id: task.id, profile_id: "docker_profile", profile_version: 2,
      requirements: { filesystem: "workspace_overlay", network: "denied", features: [], limits: {} },
      request_digest: failedDigest, ticket_id: "docker_failed_ticket" });
    const failingService = new CraftService(store, undefined, undefined,
      new DockerSandboxAdapter(async () => ({ ...ok, code: 1 })));
    const failedExecution = await failingService.dockerSandboxExecute({ ticket_id: "docker_failed_ticket",
      receipt_id: "docker_failed_receipt", image: "busybox:1", argv: ["false"] });
    assert.equal((failedExecution.result as JsonObject).status, "failed"); assert.equal((failedExecution.evidence as JsonObject).confidence, "rejected");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Docker Adapter fails closed for unsupported boundaries, probes, digests, limits, and outcomes", async () => {
  const sequence = (results: DockerResult[]): DockerRunner => async () => results.shift() ?? ok;
  const adapter = new DockerSandboxAdapter(sequence([{ ...ok, code: 1 }]));
  await assert.rejects(adapter.probe("busybox", dockerCaps), /failed closed/);
  await assert.rejects(new DockerSandboxAdapter(sequence([ok, { ...ok, timed_out: true }])).probe("busybox", dockerCaps), /failed closed/);
  await assert.rejects(new DockerSandboxAdapter(sequence([ok, ok, { ...ok, output_limited: true }])).probe("busybox", dockerCaps), /failed closed/);
  await assert.rejects(new DockerSandboxAdapter().probe(" ", dockerCaps), /image/);
  for (const caps of [
    { ...dockerCaps, filesystem: "read_only" }, { ...dockerCaps, network: "unrestricted" },
    { ...dockerCaps, features: ["process_isolation"] }, { ...dockerCaps, features: ["process_isolation", "cancel", "snapshot"] },
  ]) await assert.rejects(new DockerSandboxAdapter(sequence([])).probe("busybox", caps), /Docker Adapter/);
  for (const limits of [{ memory_mb: 1 }, { timeout_ms: 1 }, { pids: 0 }, { cpu_count: 0 }, { gpu_count: 1 }]) {
    await assert.rejects(new DockerSandboxAdapter(sequence([])).probe("busybox", { ...dockerCaps, limits }), /limit|resource/);
  }
  const runtimeRoot = join(tmpdir(), `craft-docker-runtime-${process.pid}-${Date.now()}`);
  const conforming: DockerRunner = async (argv) => {
    if (argv.includes("sleep 60")) return { ...ok, code: 1, timed_out: true };
    if (argv[0] === "ps") return { ...ok, stdout: "" };
    return ok;
  };
  const conformance = await new DockerSandboxAdapter(conforming).conformance("probe", "busybox", dockerCaps, runtimeRoot);
  assert.equal(conformance.status, "passed");
  await assert.rejects(new DockerSandboxAdapter(conforming).conformance(" ", "busybox", dockerCaps, runtimeRoot), /probe_id/);
  await assert.rejects(new DockerSandboxAdapter(conforming).conformance("probe", " ", dockerCaps, runtimeRoot), /image/);
  await assert.rejects(new DockerSandboxAdapter(conforming).conformance("probe", "busybox", dockerCaps, " "), /runtime_root/);
  await assert.rejects(new DockerSandboxAdapter(async (argv) => argv.includes("sleep 60")
    ? { ...ok, code: 1, timed_out: true } : argv[0] === "ps" ? { ...ok, stdout: "leftover" } : ok)
    .conformance("residual", "busybox", dockerCaps, runtimeRoot), /failed closed/);
  await assert.rejects(new DockerSandboxAdapter(async (argv) => argv.includes("sleep 60")
    ? ok : argv[0] === "ps" ? { ...ok, stdout: "" } : ok)
    .conformance("no-timeout", "busybox", dockerCaps, runtimeRoot), /failed closed/);
  await assert.rejects(new DockerSandboxAdapter(async () => ({ ...ok, code: 1 }))
    .conformance("failure", "busybox", dockerCaps, runtimeRoot), /failed closed/);
  const execute = (extra: JsonObject, runner: DockerRunner = sequence([ok])) => new DockerSandboxAdapter(runner).execute({
    ticket_id: "ticket", runtime_root: runtimeRoot, image: "busybox", command: ["true"],
    request_digest: dockerRequestDigest("busybox", ["true"]), capabilities: dockerCaps, ...extra });
  await assert.rejects(execute({ image: " " }), /image/); await assert.rejects(execute({ command: [] }), /non-empty/);
  await assert.rejects(execute({ command: [" "] }), /command/); await assert.rejects(execute({ request_digest: "wrong" }), /digest/);
  await assert.rejects(execute({ ticket_id: "." }), /escapes/); await assert.rejects(execute({ runtime_root: " " }), /runtime_root/);
  const timedCalls: string[][] = [];
  const timed = await execute({}, async (argv) => { timedCalls.push(argv);
    if (argv[0] === "run") return { ...ok, timed_out: true }; if (argv[0] === "ps") return { ...ok, stdout: "" }; return ok; });
  assert.equal(timed.status, "timed_out"); assert.equal((timed.cleanup as JsonObject).passed, true);
  assert.ok(timedCalls.some((call) => call[0] === "rm")); assert.ok(timedCalls.some((call) => call[0] === "ps"));
  assert.equal((await execute({}, async (argv) => argv[0] === "run" ? { ...ok, timed_out: true }
    : argv[0] === "ps" ? { ...ok, stdout: "leftover" } : ok)).status, "failed");
  assert.equal((await execute({}, sequence([{ ...ok, code: 1 }]))).status, "failed");
  assert.equal((await execute({}, async (argv) => argv[0] === "run" ? { ...ok, output_limited: true }
    : argv[0] === "ps" ? { ...ok, stdout: "" } : ok)).status, "failed");
  await rm(runtimeRoot, { recursive: true, force: true });
});

function fakeSpawn(onStart: (child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean }) => void): typeof import("node:child_process").spawn {
  return (() => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { queueMicrotask(() => child.emit("close", null)); return true; };
    queueMicrotask(() => onStart(child)); return child;
  }) as unknown as typeof import("node:child_process").spawn;
}

test("Docker CLI runner bounds output, redacts secrets, handles timeout, close, and spawn errors", async () => {
  const passed = await runDocker(["version"], 1_000, 100, fakeSpawn((child) => {
    child.stdout.write("token=abc done"); child.stderr.write("password:xyz"); child.emit("close", 0);
  }));
  assert.equal(passed.code, 0); assert.equal(passed.stdout, "token=[REDACTED] done"); assert.equal(passed.stderr, "password=[REDACTED]");
  const limited = await runDocker(["run"], 1_000, 4, fakeSpawn((child) => { child.stdout.write("12345"); }));
  assert.equal(limited.output_limited, true); assert.equal(limited.code, 1);
  const timed = await runDocker(["run"], 10, undefined, fakeSpawn(() => undefined));
  assert.equal(timed.timed_out, true); assert.equal(timed.code, 1);
  await assert.rejects(runDocker(["run"], 100, 10, fakeSpawn((child) => child.emit("error", new Error("docker missing")))), /docker missing/);
});
