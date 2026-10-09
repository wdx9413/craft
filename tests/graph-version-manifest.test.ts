import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { parse } from "yaml";
import { fixture, scope, spec } from "./helpers/procedure-invocation-fixture.ts";
import { experienceGraphTemplate } from "../capability/craft-experience/procedure-templates.ts";
import { syncGraphVersionManifest } from "../capability/craft-experience/graph-version-manifest.ts";
import { ProcedureStore } from "../capability/craft-experience/procedure-projection.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";

test("two-field YAML follows candidate, promotion, failed evaluation and historical reads using content versions", async () => {
  const f = await fixture();
  try {
    const id = "product-development";
    const saved = f.service.experienceGraphEdit({ action: "save", scope, graph_id: id, template_id: "internet-product-engineering" });
    const path = String(saved.manifest_path), read = () => parse(readFileSync(path, "utf8"));
    assert.equal(path, join(dirname(String(saved.path)), "graph.yml"));
    assert.deepEqual(read(), { current_version: null, test_version: null });
    assert.equal(fs.statSync(path).mode & 0o777, 0o600);
    assert.equal(existsSync(join(dirname(path), "README.md")), false);
    let p = f.service.experienceGraphEdit({ action: "submit", scope, graph_id: id, expected_draft_digest: saved.draft_digest }).procedure as JsonObject;
    assert.deepEqual(read(), { current_version: null, test_version: 1 });
    let canaryIds: string[] = [];
    for (const stage of ["shadow", "held_out", "signoff", "canary"]) {
      const ids: string[] = [];
      for (const entry of p.entrypoints as JsonObject[]) for (const route of entry.routes as JsonObject[]) {
        const evidence_id = `${stage}:${entry.id}:${route.subscenario_id}`; ids.push(evidence_id);
        f.store.create("evidence", evidence_id, { confidence: "confirmed", metadata: { procedure_definition_digest: p.definition_digest, entry_id: entry.id, exit_id: route.exit_id, subscenario_id: route.subscenario_id, stage, status: "passed" } });
      }
      p = (new ProcedureStore(f.store).gate({ procedure_id: id, stage, passed: true, evidence_ids: ids }).procedure as JsonObject);
      canaryIds = ids;
      assert.deepEqual(read(), stage === "canary" ? { current_version: 1, test_version: null } : { current_version: null, test_version: 1 });
    }
    assert.equal(p.version, 5); assert.equal(p.content_version, 1);
    new ProcedureStore(f.store).gate({ procedure_id: id, stage: "canary", passed: true, evidence_ids: canaryIds });
    const changed = experienceGraphTemplate("internet-product-engineering"); (changed.nodes as JsonObject[])[0]!.instruction = "Confirm target";
    const next = f.service.procedureConfigurationSave({ procedure_id: id, scope, title: "互联网产研", procedure_kind: "graph", definition: changed, expected_version: p.version }).procedure as JsonObject;
    assert.equal(next.content_version, 2); assert.deepEqual(read(), { current_version: 1, test_version: 2 });
    f.store.create("evidence", "failed", { confidence: "confirmed" });
    new ProcedureStore(f.store).gate({ procedure_id: id, stage: "shadow", passed: false, evidence_ids: ["failed"] });
    assert.deepEqual(read(), { current_version: 1, test_version: 2 });
    writeFileSync(path, "current_version: 999\ntest_version: 888\n");
    const history = f.service.experienceGraphInspect({ action: "read", scope, graph_id: id, version: 1 });
    assert.equal(history.historical, true); assert.equal(history.current_version, 1); assert.equal(history.test_version, 2);
    assert.deepEqual(read(), { current_version: 1, test_version: 2 });
    assert.equal(f.store.get("experience_procedure", id).routeable, false);
    await f.reopen();
    assert.equal(f.service.experienceGraphInspect({ action: "draft", scope, graph_id: id }).test_version, 2);
  } finally { await f.close(); }
});

test("existing human notes are preserved; stale YAML repairs on idempotent save and failures do not undo committed candidates", async () => {
  const f = await fixture();
  try {
    const config = { procedure_id: "code-review", scope, title: "Review", scenario_id: "review", procedure_kind: "workflow", definition: spec() };
    const created = f.service.procedureConfigurationSave(config); const path = String(created.manifest_path);
    const notes = join(dirname(path), "README.md"); writeFileSync(notes, "user notes");
    writeFileSync(path, "current_version: 400\ntest_version: null\n");
    assert.equal(f.service.procedureConfigurationSave(config).idempotent, true);
    assert.deepEqual(parse(readFileSync(path, "utf8")), { current_version: null, test_version: 1 });
    assert.equal(readFileSync(notes, "utf8"), "user notes");
    const rename = fs.renameSync;
    const fault = mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => { if (String(to).endsWith("graph.yml")) throw new Error("manifest publication failed"); return rename(from, to); }); syncBuiltinESMExports();
    try {
      const result = f.service.procedureConfigurationSave({ ...config, procedure_id: "manifest-retry" });
      assert.equal(result.manifest_status, "unavailable"); assert.equal((result.procedure as JsonObject).content_version, 1);
      assert.equal(f.store.get("experience_procedure", "manifest-retry").routeable, false);
    } finally { fault.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(f.service.experienceGraphInspect({ action: "read", scope, graph_id: "manifest-retry" }).manifest_status, "ready");
    const write = fs.writeFileSync;
    const writeFault = mock.method(fs, "writeFileSync", (file: fs.PathOrFileDescriptor, ...args: any[]) => { if (String(file).includes("graph.yml")) throw "write unavailable"; return (write as (...args: any[]) => void)(file, ...args); }); syncBuiltinESMExports();
    try { assert.equal(syncGraphVersionManifest(f.store, "code-review").manifest_error_type, "unknown"); }
    finally { writeFault.mock.restore(); syncBuiltinESMExports(); }
  } finally { await f.close(); }
});

test("manifest links and invalid JSON references fail closed without writing outside the data directory", async () => {
  const f = await fixture();
  try {
    const result = f.service.procedureConfigurationSave({ procedure_id: "guard", scope, title: "Review", scenario_id: "review", procedure_kind: "workflow", definition: spec() });
    const path = String(result.manifest_path), outside = join(f.root, "owner.yml"); writeFileSync(outside, "preserve");
    unlinkSync(path); symlinkSync(outside, path);
    assert.equal(syncGraphVersionManifest(f.store, "guard").manifest_status, "unavailable"); assert.equal(readFileSync(outside, "utf8"), "preserve");
    unlinkSync(path); mkdirSync(path);
    assert.equal(syncGraphVersionManifest(f.store, "guard").manifest_status, "unavailable"); rmSync(path, { recursive: true });
    const procedure = f.store.get("experience_procedure", "guard"); const ref = procedure.definition_ref as JsonObject;
    f.store.save("experience_procedure", "guard", { ...procedure, routeable: true, lifecycle: "candidate" });
    assert.equal(syncGraphVersionManifest(f.store, "guard").test_version, 1);
    writeFileSync(String(ref.path), "null"); assert.equal(syncGraphVersionManifest(f.store, "guard").manifest_status, "unavailable");
    assert.equal(syncGraphVersionManifest(f.store, "no-asset").current_version, null);
    f.store.create("experience_procedure", "flag-disagreement", { ...procedure, routeable: true, lifecycle: "candidate", definition_ref: undefined });
    assert.equal(syncGraphVersionManifest(f.store, "flag-disagreement").test_version, null);
  } finally { await f.close(); }
});
