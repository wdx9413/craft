import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { learningWorkerDiagnostic } from "../core/learning-worker-diagnostic.ts";

test("worker diagnostics distinguish old, matching, different and invalid lock records without trusting liveness", async () => {
  const dir = await mkdtemp(join(tmpdir(), "craft-worker-diagnostic-")), file = join(dir, "learning-worker-knowledge.lock.json");
  try {
    assert.equal(learningWorkerDiagnostic(dir, "knowledge", "0.12.120").status, "not_observed");
    for (const [version, relation] of [[undefined, "unknown"], ["invalid", "unknown"], ["0.12.120", "same"], ["0.12.119", "different"]] as const) {
      await writeFile(file, JSON.stringify({ pid: 123, owner_id: "owner", runtime_version: version }));
      const result = learningWorkerDiagnostic(dir, "knowledge", "0.12.120");
      assert.equal(result.status, "owner_recorded"); assert.equal(result.version_relation, relation); assert.equal(result.liveness, "unverified");
      assert.equal(result.owner_version, relation === "unknown" ? null : version);
    }
    for (const value of ["{", "null", JSON.stringify({ pid: 0, owner_id: "owner" }), JSON.stringify({ pid: 123, owner_id: "" }), "x".repeat(4097)]) {
      await writeFile(file, value); assert.equal(learningWorkerDiagnostic(dir, "knowledge", "0.12.120").status, "unavailable");
    }
    await rm(file); await symlink(dir, file);
    assert.equal(learningWorkerDiagnostic(dir, "knowledge", "0.12.120").status, "unavailable");
    assert.equal(learningWorkerDiagnostic(dir, "experience", "0.12.120").status, "not_observed");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
