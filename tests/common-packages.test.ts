import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CraftTelemetry, StoreTelemetrySink, telemetryEvent, toOtlpTrace, exportOtlp } from "../common/craft-common-log/src/index.ts";
import { CraftStore } from "../common/craft-common-store-local/src/store.ts";
import { craftPaths } from "../common/craft-common-store-local/src/paths.ts";
import { ComponentTraceKernel } from "../core/component-trace.ts";
import { TraceKernel } from "../core/trace-kernel.ts";
import { EvaluationContractKernel } from "../common/craft-common-log/src/evaluation-contract.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("shared telemetry separates sink failure from successful business work and enforces content-free events", async () => {
  const failing = new CraftTelemetry({ append: () => { throw new Error("offline"); } });
  const captured = await failing.capture({ capability_id: "external", operation: "read", trace_id: "t" }, () => 42);
  assert.equal(captured.result, 42);
  assert.deepEqual(captured.telemetry.map(item => item.recorded), [false, false]);
  const base = { signal: "evaluation" as const, capability_id: "external", operation: "check", trace_id: "t", span_id: "s", parent_span_id: null, outcome: "verified" as const };
  assert.throws(() => telemetryEvent(base), /requires evidence_ids/);
  assert.throws(() => telemetryEvent({ ...base, evidence_ids: ["e"], attributes: { password: "secret" } }), /not allowed/);
  assert.throws(() => telemetryEvent({ ...base, evidence_ids: ["e"], attributes: { cost_usd: -1 } }), /non-negative/);
  assert.throws(() => telemetryEvent({ ...base, signal: "usage", outcome: "observed", evidence_ids: [] }), /requires measured/);
  assert.throws(() => telemetryEvent({ ...base, signal: "metric", outcome: "observed", attributes: { name: "hits" } }), /numeric measurement/);
  assert.throws(() => telemetryEvent({ ...base, signal: "usage", outcome: "observed", attributes: { input_tokens: 1.5 } }), /non-negative integer/);
  assert.throws(() => telemetryEvent({ ...base, signal: "other" as never }), /signal is unsupported/);
  assert.throws(() => telemetryEvent({ ...base, outcome: "other" as never }), /outcome is unsupported/);
  assert.throws(() => telemetryEvent({ ...base, evidence_ids: ["e"], occurred_at: "tomorrow" }), /ISO timestamp/);
  assert.throws(() => telemetryEvent({ ...base, evidence_ids: Array(33).fill("e") }), /bounded array/);
  assert.throws(() => telemetryEvent({ ...base, evidence_ids: ["e"], attributes: null as never }), /attributes must be an object/);
  assert.throws(() => telemetryEvent({ ...base, evidence_ids: ["e"], attributes: { reason_code: "password=secretvalue" } }), /unsafe content/);
  assert.throws(() => telemetryEvent({ ...base, evidence_ids: ["e"], attributes: { extra_id: { nested: true } as never } }), /must be scalar/);
  assert.throws(() => telemetryEvent({ ...base, evidence_ids: ["e"], event_id: "e".repeat(257) }), /at most 256/);
  assert.equal(telemetryEvent({ ...base, evidence_ids: ["e"], parent_span_id: "parent" }).parent_span_id, "parent");
  assert.throws(() => telemetryEvent({ ...base, signal: "metric", outcome: "observed" }), /numeric measurement/);
  assert.throws(() => telemetryEvent({ ...base, evidence_ids: ["e"], attributes: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`item${i}_id`, "x"])) }), /32-field limit/);
  assert.equal(telemetryEvent({ ...base, signal: "metric", outcome: "observed", attributes: { count: 2 } }).attributes.count, 2);
  assert.equal(telemetryEvent({ ...base, evidence_ids: ["e"] }).evidence_ids[0], "e");
  const accepted = new CraftTelemetry({ append: () => {} });
  assert.equal((await accepted.record({ ...base, evidence_ids: ["e"] })).recorded, true);
  const rawSink = new CraftTelemetry({ append: () => { throw "offline"; } });
  assert.equal((await rawSink.record({ ...base, evidence_ids: ["e"] })).error?.message, "offline");
  await assert.rejects(() => failing.capture({ capability_id: "external", operation: "write", trace_id: "t" }, () => { throw new Error("business failed"); }), /business failed/);
  await assert.rejects(() => failing.capture({ capability_id: "external", operation: "write", trace_id: "t" }, () => { throw "raw failure"; }), /raw failure/);
});

test("local telemetry sink is idempotent and queryable by trace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "craft-common-log-"));
  const store = await new CraftStore(craftPaths(dir)).open();
  try {
    const sink = new StoreTelemetrySink(store);
    const event = telemetryEvent({ event_id: "evt", signal: "usage", capability_id: "external", operation: "model", trace_id: "t", span_id: "s", parent_span_id: null, outcome: "observed", attributes: { input_tokens: 4, output_tokens: 5, cost_usd: 0.01 } });
    sink.append(event); sink.append(event);
    assert.equal(sink.list("t").length, 1);
    assert.equal(sink.list("other").length, 0);
    assert.throws(() => sink.append({ ...event, operation: "other" }), /idempotency conflict/);
    assert.throws(() => sink.list("t", 1001), /query bounds/);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("two calls can join one Trace and telemetry failure cannot reverse business success", async () => {
  const dir = await mkdtemp(join(tmpdir(), "craft-shared-trace-"));
  const store = await new CraftStore(craftPaths(dir)).open();
  try {
    const kernel = new ComponentTraceKernel(new TraceKernel(store), "session");
    for (const requestId of ["one", "two"]) {
      const response = await kernel.capture({ requestId, component: "external", operation: "read", input: { trace_id: "joined" }, handler: () => ({ ok: true }) });
      assert.equal(response.ok, true);
    }
    assert.equal(store.list("trace_event", 20, item => item.trace_id === "joined").length, 4);
    const original = kernel.trace.append.bind(kernel.trace);
    kernel.trace.append = (() => { throw new Error("telemetry unavailable"); }) as typeof kernel.trace.append;
    const business = await kernel.capture({ requestId: "three", component: "external", operation: "read", input: { trace_id: "joined" }, handler: () => ({ value: 7 }) });
    assert.equal(business.ok, true);
    assert.equal(business.result?.value, 7);
    assert.equal(business.telemetry_error, "Error");
    kernel.trace.append = original;
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("OTLP preserves parent links and timestamps and rejects partial receiver acceptance", async () => {
  const input = { trace_id: "t", created_at: "2026-10-04T00:00:00.000Z" };
  const events = [
    { trace_id: "t", span_id: "parent", sequence: 1, event_kind: "run", created_at: "2026-10-04T00:00:00.000Z" },
    { trace_id: "t", span_id: "child", parent_span_id: "parent", sequence: 2, event_kind: "tool.call", created_at: "2026-10-04T00:00:01.000Z", duration_ms: 4 },
  ];
  const payload = toOtlpTrace(input, events);
  const spans = ((payload.resourceSpans as Record<string, unknown>[])[0]!.scopeSpans as Record<string, unknown>[])[0]!.spans as Record<string, unknown>[];
  assert.equal(spans[1]!.parentSpanId, spans[0]!.spanId);
  assert.equal(BigInt(String(spans[1]!.endTimeUnixNano)) - BigInt(String(spans[1]!.startTimeUnixNano)), 4_000_000n);
  await assert.rejects(() => exportOtlp("https://otel.example/v1/traces", payload, async () => ({ status: 200, body: '{"partialSuccess":{"rejectedSpans":1}}' })), /partial success/);
  await assert.rejects(() => exportOtlp("https://otel.example/v1/traces", payload, async () => ({ status: 200, body: '{"partialSuccess":{"rejectedSpans":-1}}' })), /invalid/);
  assert.equal((await exportOtlp("https://otel.example/v1/traces", payload, async () => ({ status: 200, body: '{"partialSuccess":{"rejectedSpans":0}}' }))).accepted, true);
  assert.throws(() => toOtlpTrace(input, [...events, { trace_id: "other", event_kind: "run" }]), /one trace/);
  assert.throws(() => toOtlpTrace(input, [{ trace_id: "t", event_kind: "run", created_at: "bad" }]), /timestamp/);
  assert.throws(() => toOtlpTrace(input, [{ trace_id: "t", event_kind: "run", duration_ms: -1 }]), /duration_ms/);
  const external = toOtlpTrace({ trace_id: "0123456789abcdef0123456789abcdef" }, [{ trace_id: "0123456789abcdef0123456789abcdef", span_id: "child", parent_span_id: "fedcba9876543210", event_kind: "tool.call", status: "failed" }]);
  const externalSpan = (((external.resourceSpans as Record<string, unknown>[])[0]!.scopeSpans as Record<string, unknown>[])[0]!.spans as Record<string, unknown>[])[0]!;
  assert.equal(externalSpan.parentSpanId, "fedcba9876543210");
  assert.equal((externalSpan.status as Record<string, unknown>).code, 2);
  assert.equal(externalSpan.traceId, "0123456789abcdef0123456789abcdef");
  const completed = toOtlpTrace({ trace_id: "done", status: "completed" });
  const completedSpan = (((completed.resourceSpans as Record<string, unknown>[])[0]!.scopeSpans as Record<string, unknown>[])[0]!.spans as Record<string, unknown>[])[0]!;
  assert.equal((completedSpan.status as Record<string, unknown>).code, 1);
  assert.throws(() => toOtlpTrace(null as never), /must be an object/);
  await assert.rejects(() => exportOtlp("bad-url", payload, async () => ({ status: 200, body: "{}" })), /valid HTTP/);
  assert.equal((await exportOtlp("https://otel.example/v1/traces", payload, async () => ({ status: 200, body: '{"partialSuccess":{}}' }))).accepted, true);
});

test("evaluation stage reports remain untrusted without an eligible, bound assessment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "craft-eval-gate-"));
  const store = await new CraftStore(craftPaths(dir)).open();
  try {
    const kernel = new EvaluationContractKernel(store);
    const id = String((kernel.define({ capability_id: "external", capability_version: 1, input_contract: "in", output_contract: "out" }).contract as Record<string, unknown>).id);
    kernel.record({ contract_id: id, stage: "mechanism_passed", evidence: ["claim"] });
    assert.equal(kernel.get(id).routeable, false);
    store.create("verification_plan", "plan", { change_ref: `${id}:mechanism_passed`, requires_real_host: false, candidate_change: true });
    store.create("verification_assessment", "assessment", { verification_id: "plan", verdict: "eligible" });
    const verified = kernel.record({ contract_id: id, stage: "mechanism_passed", evidence: ["assessment"] });
    assert.equal(verified.verified_stage, "mechanism_passed");
    kernel.record({ contract_id: id, stage: "fixture_passed", evidence: ["claim"] });
    assert.equal(kernel.get(id).routeable, false);
    store.create("verification_plan", "late-fixture-plan", { change_ref: `${id}:fixture_passed`, requires_real_host: false, candidate_change: true });
    store.create("verification_assessment", "late-fixture-assessment", { verification_id: "late-fixture-plan", verdict: "eligible" });
    kernel.record({ contract_id: id, stage: "conformance_passed", evidence: ["claim"] });
    assert.throws(() => kernel.record({ contract_id: id, stage: "fixture_passed", evidence: ["claim"] }), /cannot move backwards/);
    const late = kernel.record({ contract_id: id, stage: "fixture_passed", evidence: ["late-fixture-assessment"] });
    assert.equal(late.reported_stage, "conformance_passed");
    assert.equal(late.verified_stage, "fixture_passed");
    assert.equal((late.stage_history as Array<{ stage: string; verification: string }>)[1]?.verification, "trusted");
    assert.equal(kernel.record({ contract_id: id, stage: "conformance_passed", evidence: ["claim"] }).verified_stage, "fixture_passed");
    store.create("verification_plan", "late-conformance-plan", { change_ref: `${id}:conformance_passed`, requires_real_host: false, candidate_change: true });
    store.create("verification_assessment", "late-conformance-assessment", { verification_id: "late-conformance-plan", verdict: "eligible" });
    assert.equal(kernel.record({ contract_id: id, stage: "conformance_passed", evidence: ["late-conformance-assessment"] }).verified_stage, "conformance_passed");
    const trustedId = String((kernel.define({ capability_id: "trusted", capability_version: 1, input_contract: "in", output_contract: "out" }).contract as Record<string, unknown>).id);
    for (const stage of ["mechanism_passed", "fixture_passed", "conformance_passed", "integration_passed", "host_verified", "business_eligible", "routeable"] as const) {
      store.create("verification_plan", `plan-${stage}`, { change_ref: `${trustedId}:${stage}`, requires_real_host: true, candidate_change: true });
      store.create("verification_assessment", `assessment-${stage}`, { verification_id: `plan-${stage}`, verdict: "eligible" });
      kernel.record({ contract_id: trustedId, stage, evidence: [`assessment-${stage}`] });
    }
    assert.equal(kernel.get(trustedId).routeable, true);
    const negativeId = String((kernel.define({ capability_id: "negative", capability_version: 1, input_contract: "in", output_contract: "out" }).contract as Record<string, unknown>).id);
    store.create("verification_assessment", "missing-plan", { verification_id: "unknown", verdict: "eligible" });
    kernel.record({ contract_id: negativeId, stage: "mechanism_passed", evidence: ["missing-plan"] });
    store.create("verification_plan", "wrong-plan", { change_ref: "other:mechanism_passed", requires_real_host: true, candidate_change: true });
    store.create("verification_assessment", "wrong-assessment", { verification_id: "wrong-plan", verdict: "eligible" });
    kernel.record({ contract_id: negativeId, stage: "mechanism_passed", evidence: ["wrong-assessment"] });
    for (const stage of ["mechanism_passed", "fixture_passed", "conformance_passed", "integration_passed", "host_verified", "business_eligible", "routeable"] as const) {
      store.create("verification_plan", `negative-plan-${stage}`, { change_ref: `${negativeId}:${stage}`, requires_real_host: stage !== "host_verified", candidate_change: stage !== "routeable" });
      store.create("verification_assessment", `negative-assessment-${stage}`, { verification_id: `negative-plan-${stage}`, verdict: "eligible" });
      kernel.record({ contract_id: negativeId, stage, evidence: [`negative-assessment-${stage}`] });
    }
    assert.equal(kernel.get(negativeId).routeable, false);
    store.create("evaluation_contract", "legacy", { status: "mechanism_passed", stage_history: [] });
    assert.equal(kernel.record({ contract_id: "legacy", stage: "fixture_passed", evidence: ["claim"] }).reported_stage, "fixture_passed");
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("third-party telemetry runs from packages without a Store or capability registry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "craft-telemetry-consumer-"));
  try {
    const nodeModules = join(dir, "node_modules");
    for (const name of ["craft-common-store-local", "craft-common-base", "craft-common-log"]) {
      const source = join(root, "common", name); const target = join(nodeModules, name);
      await mkdir(target, { recursive: true });
      await cp(join(source, "dist"), join(target, "dist"), { recursive: true });
      await cp(join(source, "package.json"), join(target, "package.json"));
    }
    const source = `
      import { CraftTelemetry } from 'craft-common-log';
      const events = [];
      const telemetry = new CraftTelemetry({ append: event => events.push(event) });
      const receipt = await telemetry.capture({ capability_id: 'third-party', operation: 'read', trace_id: 'outside' }, () => 7);
      if (receipt.result !== 7 || events.length !== 2 || events[0].capability_id !== 'third-party') throw new Error('telemetry failed');
      console.log('telemetry-only-ok');
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /telemetry-only-ok/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("each capability package loads and registers outside the harness checkout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "craft-isolated-package-"));
  try {
    const nodeModules = join(dir, "node_modules");
    await mkdir(nodeModules, { recursive: true });
    for (const name of ["craft-common-store-local", "craft-common-base", "craft-common-log"]) {
      const source = join(root, "common", name); const target = join(nodeModules, name);
      await mkdir(target, { recursive: true });
      await cp(join(source, "dist"), join(target, "dist"), { recursive: true });
      await cp(join(source, "package.json"), join(target, "package.json"));
    }
    for (const name of ["knowledge", "memory", "experience", "codebase"]) {
      const source = join(root, "capability", `craft-${name}`); const target = join(nodeModules, "@craft", `capability-${name}`);
      await mkdir(target, { recursive: true });
      await cp(join(source, "dist"), join(target, "dist"), { recursive: true });
      await cp(join(source, "package.json"), join(target, "package.json"));
      const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as Record<string, unknown>;
      assert.equal(manifest.peerDependencies, undefined);
      assert.equal((manifest.dependencies as Record<string, unknown>)["craft-agent-harness"], undefined);
    }
    await symlink(realpathSync(join(root, "node_modules", "typescript")), join(nodeModules, "typescript"), "dir");
    const source = `
      import { CraftStore, craftPaths } from 'craft-common-store-local';
      import { CraftTelemetry, StoreTelemetrySink } from 'craft-common-log';
      import { buildCapabilityRegistry, CORE_KERNELS } from 'craft-common-base';
      import { knowledgeCapability } from '@craft/capability-knowledge';
      import { memoryCapability } from '@craft/capability-memory';
      import { experienceCapability } from '@craft/capability-experience';
      import { ExperienceGraphAssets } from '@craft/capability-experience/graph-assets';
      import { codebaseCapability } from '@craft/capability-codebase';
      const store = await new CraftStore(craftPaths(process.env.CRAFT_TEST_DATA_DIR)).open();
      try {
        store.create('external', 'record', { value: 1 });
        for (const capability of [knowledgeCapability, memoryCapability, experienceCapability, codebaseCapability]) {
          buildCapabilityRegistry([capability], { [CORE_KERNELS.store]: store, [CORE_KERNELS.modelProviders]: [], [CORE_KERNELS.telemetry]: new CraftTelemetry(new StoreTelemetrySink(store)) });
        }
        if (store.get('external', 'record').value !== 1) throw new Error('store round trip failed');
        const graphs = new ExperienceGraphAssets(store);
        const template = graphs.inspect({ action: 'template' });
        const draft = graphs.edit({ action: 'save', graph_id: 'sdk-scene', scope: 'project:sdk', configuration: template.configuration });
        const submitted = graphs.edit({ action: 'submit', graph_id: 'sdk-scene', scope: 'project:sdk', expected_draft_digest: draft.draft_digest });
        if (submitted.procedure.content_version !== 1 || submitted.procedure.routeable) throw new Error('isolated graph authoring failed');
        console.log('isolated-capabilities-ok');
      } finally { store.close(); }
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: dir, env: { ...process.env, CRAFT_TEST_DATA_DIR: join(dir, "data") }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /isolated-capabilities-ok/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("published tarball contents typecheck and run outside the monorepo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "craft-tarball-consumer-"));
  try {
    const nodeModules = join(dir, "node_modules");
    await mkdir(nodeModules, { recursive: true });
    for (const relative of ["common/craft-common-store-local", "common/craft-common-base", "common/craft-common-log",
      "capability/craft-knowledge", "capability/craft-memory", "capability/craft-experience", "capability/craft-codebase"]) {
      const sourceDir = join(root, relative);
      const packed = spawnSync("npm", ["pack", `./${relative}`, "--offline", "--ignore-scripts", "--pack-destination", dir, "--json"], {
        cwd: root, env: { ...process.env, NPM_CONFIG_CACHE: join(dir, "npm-cache") }, encoding: "utf8",
      });
      assert.equal(packed.status, 0, packed.stderr);
      const [{ filename }] = JSON.parse(packed.stdout) as Array<{ filename: string }>;
      const manifest = JSON.parse(await readFile(join(sourceDir, "package.json"), "utf8")) as { name: string };
      const target = join(nodeModules, manifest.name);
      await mkdir(target, { recursive: true });
      const extracted = spawnSync("tar", ["-xzf", join(dir, filename), "--strip-components=1", "-C", target], { encoding: "utf8" });
      assert.equal(extracted.status, 0, extracted.stderr);
    }
    await symlink(realpathSync(join(root, "node_modules", "typescript")), join(nodeModules, "typescript"), "dir");
    await symlink(realpathSync(join(root, "node_modules", "@types")), join(nodeModules, "@types"), "dir");
    const source = `
      import { CraftStore, craftPaths } from 'craft-common-store-local';
      import { CraftTelemetry } from 'craft-common-log';
      import { buildCapabilityRegistry, CORE_KERNELS } from 'craft-common-base';
      import { KeywordRetrievalPort } from 'craft-common-base/keyword-retrieval';
      import { temporalMemorySelect } from 'craft-common-base/memory-temporal-policy';
      import { OpenAiCompatibleEmbeddingRetrievalPort } from 'craft-common-base/embedding-retrieval';
      import { knowledgeCapability } from '@craft/capability-knowledge';
      import { memoryCapability } from '@craft/capability-memory';
      import { experienceCapability } from '@craft/capability-experience';
      import { ExperienceGraphAssets } from '@craft/capability-experience/graph-assets';
      import { codebaseCapability } from '@craft/capability-codebase';
      const store = await new CraftStore(craftPaths('./data')).open();
      try {
        const keyword = await new KeywordRetrievalPort().search('alpha', [{ id: 'a', body: 'alpha' }]);
        if (keyword.hits[0]?.id !== 'a') throw new Error('focused keyword export failed');
        if (temporalMemorySelect([], new Date(), false).selected.length) throw new Error('focused temporal export failed');
        if ((await new OpenAiCompatibleEmbeddingRetrievalPort({}).search('alpha', [])).execution.unavailable_reason !== 'embedding_provider_unavailable') throw new Error('focused provider export failed');
        const events = [];
        const telemetry = new CraftTelemetry({ append: event => { events.push(event); } });
        for (const capability of [knowledgeCapability, memoryCapability, experienceCapability, codebaseCapability]) {
          buildCapabilityRegistry([capability], { [CORE_KERNELS.store]: store, [CORE_KERNELS.modelProviders]: [], [CORE_KERNELS.telemetry]: telemetry });
        }
        await telemetry.record({ signal: 'log', capability_id: 'third-party', operation: 'read', trace_id: 'tarball', span_id: 'span', parent_span_id: null, outcome: 'succeeded' });
        if (events.length !== 1) throw new Error('tarball telemetry failed');
        const graphs = new ExperienceGraphAssets(store);
        const template = graphs.inspect({ action: 'template' });
        const draft = graphs.edit({ action: 'save', graph_id: 'tarball-graph', scope: 'project:sdk', configuration: template.configuration });
        graphs.edit({ action: 'submit', graph_id: 'tarball-graph', scope: 'project:sdk', expected_draft_digest: draft.draft_digest });
        console.log('tarball-consumer-ok');
      } finally { store.close(); }
    `;
    await writeFile(join(dir, "consumer.mjs"), source);
    await writeFile(join(dir, "consumer.mts"), "import type { RetrievalPort } from 'craft-common-base/retrieval-contract';\n" + source + "\nconst checkedPort: RetrievalPort = new KeywordRetrievalPort(); void checkedPort;\n");
    const typecheck = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2024", "--types", "node", "consumer.mts"], { cwd: dir, encoding: "utf8" });
    assert.equal(typecheck.status, 0, typecheck.stdout + typecheck.stderr);
    const runtime = spawnSync(process.execPath, ["consumer.mjs"], { cwd: dir, encoding: "utf8" });
    assert.equal(runtime.status, 0, runtime.stderr);
    assert.match(runtime.stdout, /tarball-consumer-ok/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
