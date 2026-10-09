import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fixture, scope, spec } from "./helpers/procedure-invocation-fixture.ts";
import { experienceGraphTemplate } from "../capability/craft-experience/procedure-templates.ts";
import { checkedExperiencePath, experienceGraphDirectory, ProcedureDefinitionStore } from "../capability/craft-experience/procedure-definition.ts";
import { validateExperienceConfiguration } from "../capability/craft-experience/procedure-configuration.ts";
import { stableDigest } from "../core/digest.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { McpServer } from "../core/mcp.ts";

const config = (): JsonObject => ({ title: "互联网产研", procedure_kind: "graph", definition: experienceGraphTemplate("internet-product-engineering") });
const workflow = (): JsonObject => ({ title: "Review", procedure_kind: "workflow", scenario_id: "review", definition: spec() });

test("readable English scene IDs are exact directory names and old hashed drafts/revisions stay usable", async () => {
  const f = await fixture();
  try {
    const id = "product-development", plain = experienceGraphDirectory(f.store.paths, id), old = experienceGraphDirectory(f.store.paths, id, true);
    assert.equal(plain, join(f.store.paths.experienceDir, "graph", id)); assert.notEqual(old, plain);
    for (const unsafe of ["../outside", "CON", "con", "a/b", "a".repeat(97)]) assert.notEqual(experienceGraphDirectory(f.store.paths, unsafe), join(f.store.paths.experienceDir, "graph", unsafe));
    const saved = f.service.experienceGraphEdit({ action: "save", graph_id: id, scope, configuration: config() });
    assert.equal(saved.path, join(plain, "draft.json"));
    renameSync(plain, old);
    const draft = f.service.experienceGraphInspect({ action: "draft", graph_id: id, scope }); assert.equal(draft.path, join(old, "draft.json"));
    const submitted = f.service.experienceGraphEdit({ action: "submit", graph_id: id, scope, expected_draft_digest: draft.draft_digest }).procedure as JsonObject;
    const ref = submitted.definition_ref as JsonObject, filename = "000001.json", legacyRef = { ...ref, path: join(old, "versions", filename) };
    mkdirSync(join(old, "versions")); renameSync(String(ref.path), String(legacyRef.path));
    const definitions = new ProcedureDefinitionStore(f.store.paths);
    assert.equal(definitions.read(legacyRef as never).procedure_id, id);
    assert.equal(definitions.migrate(legacyRef as never).path, join(plain, "versions", filename));
    assert.ok(existsSync(String(legacyRef.path)));
    assert.equal(f.service.experienceGraphInspect({ action: "draft", graph_id: id, scope }).path, join(old, "draft.json"));
    writeFileSync(join(plain, "draft.json"), readFileSync(String(draft.path)));
    assert.equal(f.service.experienceGraphInspect({ action: "draft", graph_id: id, scope }).path, join(plain, "draft.json"));
  } finally { await f.close(); }
});

test("a scenario draft is discoverable, editable on disk and submitted as an immutable candidate across restarts", async () => {
  const f = await fixture();
  try {
    const inspect = (args: JsonObject) => f.service.experienceGraphInspect({ scope, ...args });
    const edit = (args: JsonObject) => f.service.experienceGraphEdit({ scope, graph_id: "engineering", ...args });
    const seed = inspect({ action: "template" }); assert.equal(seed.execution_authorized, false); assert.ok(seed.schema);
    assert.throws(() => inspect({ action: "template", template_id: "unknown" }), /Unknown/);
    const saved = edit({ action: "save", template_id: "internet-product-engineering" });
    assert.equal(inspect({ action: "diff", graph_id: "engineering" }).valid, true);
    assert.match(String(saved.path), /experience\/graph\/engineering\/draft.json$/);
    assert.equal(f.store.count("experience_procedure"), 0);
    assert.equal((inspect({ action: "list", scenario_id: "internet-product-engineering" }).drafts as JsonObject[]).length, 1);
    assert.equal((inspect({ action: "list", scenario_id: "missing" }).drafts as JsonObject[]).length, 0);
    assert.throws(() => edit({ action: "save", configuration: config() }), /digest conflict/);
    assert.throws(() => edit({ action: "submit", expected_draft_digest: "wrong" }), /digest conflict/);
    const raw = JSON.parse(readFileSync(String(saved.path), "utf8")) as JsonObject;
    ((raw.definition as JsonObject).nodes as JsonObject[])[0]!.instruction = "Confirm product outcome";
    writeFileSync(String(saved.path), JSON.stringify(raw));
    const draft = inspect({ action: "draft", graph_id: "engineering" }); assert.notEqual(draft.draft_digest, saved.draft_digest);
    const submitted = edit({ action: "submit", expected_draft_digest: draft.draft_digest });
    const first = submitted.procedure as JsonObject;
    assert.equal(first.routeable, false); assert.equal(first.content_version, 1); assert.equal(f.store.count("experience_observation"), 0);
    assert.match(String((first.definition_ref as JsonObject).path), /versions\/000001.json$/);
    assert.equal(edit({ action: "submit", expected_draft_digest: draft.draft_digest }).idempotent, true);
    await f.reopen();
    assert.equal((inspect({ action: "read", graph_id: "engineering" }).definition as JsonObject).procedure_version, 1);
    const same = inspect({ action: "diff", graph_id: "engineering" }); assert.deepEqual(same.gates_to_revalidate, []);
    const change = config(); ((change.definition as JsonObject).nodes as JsonObject[])[2]!.instruction = "Run regression";
    const preview = inspect({ action: "diff", graph_id: "engineering", configuration: change });
    assert.ok((preview.changed_nodes as string[]).length); assert.ok((preview.affected_subscenarios as string[]).length);
    assert.equal((preview.gates_to_revalidate as string[]).length, 4);
    assert.equal(inspect({ action: "diff", graph_id: "engineering", configuration: { ...config(), title: "Renamed" } }).metadata_changed, true);
    assert.throws(() => edit({ action: "save", expected_version: 100, expected_draft_digest: draft.draft_digest, configuration: change }), /base version conflict/);
    const revised = edit({ action: "save", expected_version: first.version, expected_draft_digest: draft.draft_digest, configuration: change });
    const broken = JSON.parse(readFileSync(String(revised.path), "utf8")); broken.base_definition_digest = "wrong";
    writeFileSync(String(revised.path), JSON.stringify(broken));
    const brokenDraft = inspect({ action: "draft", graph_id: "engineering" });
    assert.throws(() => edit({ action: "submit", expected_draft_digest: brokenDraft.draft_digest }), /base definition digest conflict/);
    writeFileSync(String(revised.path), JSON.stringify({ ...broken, base_definition_digest: first.definition_digest }));
    const next = edit({ action: "submit", expected_draft_digest: revised.draft_digest }).procedure as JsonObject;
    assert.equal(next.content_version, 2); assert.deepEqual(next.completed_gates, []);
    assert.equal(inspect({ action: "read", graph_id: "engineering", version: first.version }).historical, true);
    assert.throws(() => edit({ action: "submit", expected_draft_digest: draft.draft_digest }), /digest conflict/);
    const list = inspect({ action: "list" }); assert.equal((list.graphs as JsonObject[])[0]!.eligible_version, null);
    assert.equal((list.graphs as JsonObject[])[0]!.template_id, "internet-product-engineering");
    assert.equal((inspect({ action: "list", scenario_id: "internet-product-engineering" }).graphs as JsonObject[]).length, 1);
    assert.equal((inspect({ action: "list", scenario_id: "other" }).graphs as JsonObject[]).length, 0);
    assert.throws(() => inspect({ action: "list", limit: 101 }), /limit/);
    assert.throws(() => inspect({ action: "read", graph_id: "engineering", scope: "project:other" }), /scope/);
    assert.throws(() => edit({ action: "save", scope: "project:other", configuration: config() }), /scope/);
    assert.throws(() => inspect({ action: "unknown", graph_id: "engineering" }), /Unknown/);
    assert.throws(() => edit({ action: "unknown" }), /Unknown/);
  } finally { await f.close(); }
});

test("Workflow shares graph storage; relation edges are checked and do not become execution transitions", async () => {
  const f = await fixture();
  try {
    const edit = (a: JsonObject) => f.service.experienceGraphEdit({ scope, graph_id: "review", ...a });
    const value = workflow(); (value.definition as JsonObject).relations = [{ id: "strategy", from: "review", to: "review", kind: "supports", evidence_ids: ["acceptance:review"] }];
    const draft = edit({ action: "save", json: JSON.stringify(value) });
    const saved = edit({ action: "submit", expected_draft_digest: draft.draft_digest }).procedure as JsonObject;
    assert.equal(saved.procedure_kind, "workflow"); assert.match(String((saved.definition_ref as JsonObject).path), /experience\/graph\/review\//);
    const same = f.service.experienceGraphInspect({ scope, graph_id: "review", action: "diff", json: JSON.stringify(value) }); assert.equal(same.relation_execution, false);
    const changed = workflow(); ((changed.definition as JsonObject).steps as JsonObject[])[0]!.instruction = "Read all changes";
    const preview = f.service.experienceGraphInspect({ scope, graph_id: "review", action: "diff", configuration: changed }); assert.deepEqual(preview.changed_nodes, ["review"]);
    f.store.save("experience_procedure", "review", { ...saved, lifecycle: "routeable", routeable: true });
    assert.ok((f.service.experienceGraphInspect({ scope, action: "list" }).graphs as JsonObject[])[0]!.eligible_version);
    assert.equal((f.service.experienceGraphInspect({ scope, action: "list", scenario_id: "review" }).graphs as JsonObject[]).length, 1);
    assert.throws(() => f.service.experienceGraphEdit({ scope, graph_id: "new", action: "save", configuration: workflow(), expected_version: 1 }), /base version/);
    assert.throws(() => f.service.experienceGraphEdit({ scope, graph_id: "new", action: "save", configuration: workflow(), expected_draft_digest: "missing" }), /digest conflict/);
    const privateEnvelope = { audience: { mode: "private", principal_ids: ["owner"] } };
    assert.throws(() => f.service.experienceGraphEdit({ scope, graph_id: "private", action: "save", configuration: workflow(), scope_envelope: privateEnvelope }), /audience/);
    const privateDraft = f.service.experienceGraphEdit({ scope, graph_id: "private", action: "save", configuration: workflow(), scope_envelope: privateEnvelope, principal_id: "owner" });
    assert.throws(() => f.service.experienceGraphInspect({ scope, graph_id: "private", action: "draft" }), /audience/);
    assert.equal((f.service.experienceGraphInspect({ scope, graph_id: "private", action: "draft", principal_id: "owner" }).draft as JsonObject).title, "Review");
    f.service.experienceGraphEdit({ scope, graph_id: "private", action: "submit", expected_draft_digest: privateDraft.draft_digest, principal_id: "owner" });
    assert.throws(() => f.service.experienceGraphInspect({ scope, graph_id: "private", action: "read" }), /audience/);
    assert.equal((f.service.experienceGraphInspect({ scope, action: "list" }).graphs as JsonObject[]).length, 1);
    assert.equal(f.service.experienceGraphInspect({ scope, action: "list", limit: 1, principal_id: "owner" }).has_more, true);
    f.store.create("experience_procedure", "prompt", { scope, title: "Prompt" });
    assert.throws(() => f.service.experienceGraphInspect({ scope, graph_id: "prompt", action: "read" }), /checked JSON/);
    const oldPrompt = f.store.create("experience_procedure", "legacy-prompt", { scope });
    f.store.save("experience_procedure", "legacy-prompt", saved);
    assert.throws(() => f.service.experienceGraphInspect({ scope, graph_id: "legacy-prompt", action: "read", version: oldPrompt.version }), /checked JSON/);
  } finally { await f.close(); }
});

test("authoring validation rejects bad JSON, credentials, oversized inputs and invalid typed relations without publishing", async () => {
  const f = await fixture();
  try {
    const validate = (args: JsonObject) => f.service.experienceGraphInspect({ action: "validate", ...args });
    assert.equal(validate({ configuration: config() }).valid, true);
    assert.equal(validate({ ...config() }).valid, true);
    assert.equal(validate({ json: "{oops" }).valid, false);
    assert.equal(validate({ json: "x".repeat(1_000_001) }).valid, false);
    assert.equal(validate({ json: "[]" }).valid, false);
    assert.equal(validate({ configuration: { ...config(), template_id: "unknown" } }).valid, false);
    assert.equal(validate({ json: JSON.stringify(config()), configuration: config() }).valid, false);
    assert.equal(validate({ configuration: { ...config(), title: "api_key=sk-secret" } }).valid, false);
    assert.throws(() => validateExperienceConfiguration({ ...workflow(), title: "x".repeat(512_001) }), /512000/);
    const base = { id: "r", from: "review", to: "review", kind: "depends_on", evidence_ids: [] };
    for (const relations of [null, Array(101).fill(base), [base, base], [{ ...base, kind: "success" }], [{ ...base, to: "missing" }], [{ ...base, evidence_ids: "proof" }], [{ ...base, evidence_ids: [""] }], [{ ...base, evidence_ids: Array(101).fill("e") }], [null]]) {
      const input = workflow(); (input.definition as JsonObject).relations = relations;
      assert.equal(validate({ configuration: input }).valid, false);
    }
    const valid = config(); (valid.definition as JsonObject).relations = [{ id: "dependency", from: "test", to: "implement", kind: "depends_on", evidence_ids: [] }];
    assert.equal(validate({ configuration: valid }).valid, true);
    assert.equal(f.store.count("experience_procedure"), 0);
    assert.throws(() => f.service.experienceGraphEdit({ action: "save", scope, graph_id: "conflict", template_id: "internet-product-engineering", configuration: config() }), /Choose template/);
    assert.throws(() => f.service.experienceGraphEdit({ action: "save", scope, graph_id: "conflict", template_id: "internet-product-engineering", json: "{}" }), /Choose template/);
  } finally { await f.close(); }
});

test("legacy revisions copy idempotently and preserve pinned references and digests", async () => {
  const f = await fixture();
  try {
    const p = f.create(), canonical = p.definition_ref as never;
    const definitions = new ProcedureDefinitionStore(f.store.paths), value = definitions.read(canonical);
    const legacyPath = join(f.store.paths.experienceProcedureDir, "workflows", "old.v1.json"); mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify(value));
    const legacy = { ...(p.definition_ref as JsonObject), path: legacyPath };
    f.store.save("experience_procedure", String(p.id), { ...p, definition_ref: legacy });
    const current = f.store.get("experience_procedure", String(p.id));
    assert.equal(definitions.read(legacy as never).procedure_id, p.id);
    const migrate = (a: JsonObject = {}) => f.service.experienceGraphEdit({ action: "migrate", scope, graph_id: p.id, expected_version: current.version, ...a });
    assert.throws(() => migrate({ expected_version: 1 }), /version conflict/);
    assert.throws(() => f.service.experienceGraphEdit({ action: "migrate", scope, graph_id: "missing" }), /Unknown/);
    const copied = migrate(); assert.equal(copied.legacy_files_preserved, true); assert.equal(copied.has_more, false);
    assert.equal(stableDigest(definitions.read((copied.migrated_refs as JsonObject[])[0] as never)), stableDigest(value));
    assert.deepEqual(migrate().migrated_refs, copied.migrated_refs); assert.ok(existsSync(legacyPath));
    assert.equal((f.store.get("experience_procedure", String(p.id)).definition_ref as JsonObject).path, legacyPath);
    const discovered = f.service.experienceGraphInspect({ action: "list", scope }).graphs as JsonObject[];
    assert.equal(discovered[0]!.scenario_id, null); assert.equal(discovered[0]!.provenance, "learned");
    f.store.create("experience_procedure", "alias", { ...current, scenario_signature: { scenario_id: "aliased" } });
    assert.equal((f.service.experienceGraphInspect({ action: "list", scope, scenario_id: "aliased" }).graphs as JsonObject[])[0]!.scenario_id, "aliased");
    for (let i = 0; i < 100; i++) f.store.save("experience_procedure", String(p.id), current);
    const paged = migrate({ expected_version: f.store.get("experience_procedure", String(p.id)).version }); assert.equal(paged.has_more, true); assert.ok(paged.next_before_version);
    assert.equal(migrate({ expected_version: f.store.get("experience_procedure", String(p.id)).version, before_version: paged.next_before_version }).has_more, false);
    assert.throws(() => definitions.read({ ...legacy, path: join(f.root, "outside.v1.json") } as never), /outside/);
    const tampered = { ...value, trigger: "changed" }; writeFileSync(legacyPath, JSON.stringify(tampered));
    assert.throws(() => migrate({ expected_version: f.store.get("experience_procedure", String(p.id)).version }), /digest drifted/);
  } finally { await f.close(); }
});

test("content publication checks failure recovery, stable ID paths and removed-edge impact", async () => {
  const f = await fixture();
  try {
    const definitions = new ProcedureDefinitionStore(f.store.paths), p = f.create(), value = definitions.read(p.definition_ref as never);
    for (const invalid of [null, [], "bad", { ...value, procedure_version: 0 }, { ...value, kind: "prompt" }]) assert.throws(() => definitions.write(invalid as never, "Unused title"), /invalid/);
    const leaf = definitions.write({ ...value, procedure_id: "🌿" }, "First title");
    assert.match(leaf.path, /graph\/untitled--/);
    assert.equal(definitions.write({ ...value, procedure_id: "🌿" }, "Renamed").path, leaf.path);
    const original = fs.renameSync;
    let fault = mock.method(fs, "renameSync", () => { throw "injected publication failure"; }); syncBuiltinESMExports();
    try { assert.throws(() => definitions.write({ ...value, procedure_id: "failed" }, "Fail"), e => e === "injected publication failure"); }
    finally { fault.mock.restore(); syncBuiltinESMExports(); }
    fault = mock.method(fs, "renameSync", (from, to) => { original(from, to); throw new Error("ambiguous publication outcome"); }); syncBuiltinESMExports();
    try { assert.throws(() => definitions.write({ ...value, procedure_id: "ambiguous" }, "Ambiguous"), /ambiguous/); }
    finally { fault.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(definitions.write({ ...value, procedure_id: "ambiguous" }, "Retry").procedure_id, "ambiguous");
    const lstat = fs.lstatSync;
    const denied = join(f.store.paths.experienceDir, "denied.json");
    const statFault = mock.method(fs, "lstatSync", (path: fs.PathLike) => { if (String(path) === denied) throw Object.assign(new Error("permission denied"), { code: "EACCES" }); return lstat(path); }); syncBuiltinESMExports();
    try { assert.throws(() => checkedExperiencePath(f.store.paths, denied), /permission denied/); }
    finally { statFault.mock.restore(); syncBuiltinESMExports(); }
    const c = config(); (c.definition as JsonObject).edges = [...((c.definition as JsonObject).edges as JsonObject[]), { id: "extra", from: "test", to: "implement", kind: "retry", max_traversals: 1 }];
    const saved = f.service.procedureConfigurationSave({ ...c, scope, procedure_id: "impact" }).procedure as JsonObject;
    const preview = f.service.experienceGraphInspect({ action: "diff", scope, graph_id: saved.id, configuration: config() });
    assert.deepEqual(preview.changed_edges, ["extra"]);
  } finally { await f.close(); }
});

test("draft and immutable paths reject symlink escapes and direct version tampering", async () => {
  const f = await fixture();
  try {
    const definitions = new ProcedureDefinitionStore(f.store.paths), p = f.create(), ref = p.definition_ref as JsonObject;
    const value = definitions.read(ref as never);
    assert.throws(() => checkedExperiencePath(f.store.paths, f.store.paths.experienceDir), /outside/);
    assert.throws(() => checkedExperiencePath(f.store.paths, join(f.root, "other.json")), /outside/);
    writeFileSync(String(ref.path), JSON.stringify({ ...value, procedure_id: "another" }));
    assert.throws(() => definitions.read(ref as never), /metadata drifted/);
    writeFileSync(String(ref.path), "null"); assert.throws(() => definitions.read(ref as never), /invalid/);
    writeFileSync(String(ref.path), JSON.stringify({ ...value, schema_version: "unknown" })); assert.throws(() => definitions.read(ref as never), /invalid/);
    writeFileSync(String(ref.path), JSON.stringify(value));
    rmSync(String(ref.path)); symlinkSync(join(f.root, "missing.json"), String(ref.path));
    assert.throws(() => definitions.read(ref as never), /symbolic link/);
    rmSync(String(ref.path)); writeFileSync(String(ref.path), JSON.stringify(value));
    const id = "escape", directory = experienceGraphDirectory(f.store.paths, id); symlinkSync(f.root, directory);
    assert.throws(() => f.service.experienceGraphEdit({ action: "save", graph_id: id, scope, configuration: config() }), /symbolic link/);
    unlinkSync(directory); symlinkSync(join(f.root, "missing-directory"), directory);
    assert.throws(() => f.service.experienceGraphEdit({ action: "save", graph_id: id, scope, configuration: config() }), /EEXIST|symbolic link/);
    unlinkSync(directory); mkdirSync(directory); const draftPath = join(directory, "draft.json");
    symlinkSync(f.root, draftPath); assert.throws(() => f.service.experienceGraphEdit({ action: "save", graph_id: id, scope, configuration: config() }), /symbolic link/); unlinkSync(draftPath);
    writeFileSync(draftPath, "x".repeat(1_000_001)); assert.throws(() => f.service.experienceGraphInspect({ action: "draft", graph_id: id, scope }), /exceeds/);
    writeFileSync(draftPath, JSON.stringify({ schema_version: "wrong", graph_id: id })); assert.throws(() => f.service.experienceGraphInspect({ action: "draft", graph_id: id, scope }), /metadata/);
    writeFileSync(draftPath, JSON.stringify({ schema_version: "craft.experience.graph-draft.v1", graph_id: "wrong" })); assert.throws(() => f.service.experienceGraphInspect({ action: "draft", graph_id: id, scope }), /metadata/);
    rmSync(draftPath); const saved = f.service.experienceGraphEdit({ action: "save", graph_id: id, scope, configuration: config() });
    const raw = JSON.parse(readFileSync(String(saved.path), "utf8")); raw.scope = "project:other"; writeFileSync(String(saved.path), JSON.stringify(raw));
    assert.throws(() => f.service.experienceGraphInspect({ action: "draft", graph_id: id, scope }), /scope/);
  } finally { await f.close(); }
});

test("publication failures remain retryable and both standalone and Context MCP expose the authoring loop", async () => {
  const f = await fixture();
  try {
    const original = fs.renameSync;
    const fault = mock.method(fs, "renameSync", () => { throw new Error("injected rename failure"); }); syncBuiltinESMExports();
    try { assert.throws(() => f.service.experienceGraphEdit({ action: "save", graph_id: "retry", scope, configuration: config() }), /rename failure/); }
    finally { fault.mock.restore(); syncBuiltinESMExports(); assert.equal(fs.renameSync, original); }
    const saved = f.service.experienceGraphEdit({ action: "save", graph_id: "retry", scope, configuration: config() }); assert.ok(saved.path);
    for (const surface of ["component-experience-daily", "component-context-daily", "component-experience"]) {
      const mcp = new McpServer(f.service, surface);
      const tools = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      assert.ok(((tools!.result as JsonObject).tools as JsonObject[]).some(t => t.name === "craft_experience_graph_inspect"));
      assert.ok(((tools!.result as JsonObject).tools as JsonObject[]).some(t => t.name === "craft_experience_graph_edit"));
      assert.ok(((tools!.result as JsonObject).tools as JsonObject[]).some(t => t.name === "craft_procedure_invocation_transition"));
      assert.ok(((tools!.result as JsonObject).tools as JsonObject[]).some(t => t.name === "craft_procedure_invocation_evaluate"));
      const response = await mcp.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "craft_experience_graph_inspect", arguments: { action: "template" } } });
      assert.equal((response!.result as JsonObject).isError, false);
      const call = await mcp.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "craft_experience_graph_edit", arguments: { action: "save", graph_id: `mcp-${surface}`, scope, configuration: config() } } });
      assert.equal((call!.result as JsonObject).isError, false);
    }
  } finally { await f.close(); }
});

test("a concurrent configuration revision rejects a stale draft without changing either version", async () => {
  const f = await fixture();
  try {
    const first = f.service.procedureConfigurationSave({ ...config(), procedure_id: "shared", scope }).procedure as JsonObject;
    const local = config(); ((local.definition as JsonObject).nodes as JsonObject[])[0]!.instruction = "Local edit";
    const draft = f.service.experienceGraphEdit({ action: "save", graph_id: "shared", scope, expected_version: first.version, configuration: local });
    const remote = config(); ((remote.definition as JsonObject).nodes as JsonObject[])[0]!.instruction = "Another editor";
    const next = f.service.procedureConfigurationSave({ ...remote, procedure_id: "shared", scope, expected_version: first.version }).procedure as JsonObject;
    assert.throws(() => f.service.experienceGraphEdit({ action: "submit", graph_id: "shared", scope, expected_draft_digest: draft.draft_digest }), /version conflict/);
    assert.equal(f.store.get("experience_procedure", "shared").version, next.version);
    assert.equal(f.service.experienceGraphInspect({ action: "draft", graph_id: "shared", scope }).draft_digest, draft.draft_digest);
    assert.ok(existsSync(String((first.definition_ref as JsonObject).path)));
    assert.ok(existsSync(String((next.definition_ref as JsonObject).path)));
  } finally { await f.close(); }
});

test("a published draft remains recoverable when its discovery index transaction fails", async () => {
  const f = await fixture();
  try {
    const save = f.store.save.bind(f.store);
    f.store.save = ((kind: string, id: string, data: JsonObject) => {
      if (kind === "experience_graph_draft") throw new Error("injected discovery index failure");
      return save(kind, id, data);
    }) as typeof f.store.save;
    assert.throws(() => f.service.experienceGraphEdit({ action: "save", graph_id: "recover", scope, configuration: config() }), /index failure/);
    f.store.save = save;
    assert.equal(f.store.count("experience_graph_draft"), 0);
    const draft = f.service.experienceGraphInspect({ action: "draft", graph_id: "recover", scope });
    f.service.experienceGraphEdit({ action: "save", graph_id: "recover", scope, configuration: config(), expected_draft_digest: draft.draft_digest });
    assert.equal((f.service.experienceGraphInspect({ action: "list", scope }).drafts as JsonObject[]).length, 1);
    assert.equal((f.service.experienceGraphEdit({ action: "submit", graph_id: "recover", scope, expected_draft_digest: draft.draft_digest }).procedure as JsonObject).content_version, 1);
  } finally { await f.close(); }
});
