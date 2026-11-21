import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { ProgramMemorySubmissionCoordinator } from "../core/application/coordinators/program-memory-submission.ts";

const plan = { candidate: { id: "candidate", version: 2, digest: "candidate-digest", scope: { kind: "project", id: "project:fixture" } },
  request_id: "submission-operation", procedure_id: "procedure", design: { contract_digest: "frozen" } };
const receipt = { request_id: plan.request_id, procedure_id: plan.procedure_id, procedure_candidate_version: 1 };

test("cross-owner submission recovers a committed target after response loss and Context restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-submission-"));
  const target = await new CraftStore(craftPaths(join(root, "experience"))).open({ fileRecords: true });
  let source = await new CraftStore(craftPaths(join(root, "context"))).open({ fileRecords: true });
  let loseResponse = true, executions = 0;
  const execute = () => {
    const result = target.transaction(() => {
      const prior = target.find("submission", plan.request_id);
      if (prior) return receipt;
      target.create("submission", plan.request_id, { receipt }); executions++;
      return receipt;
    });
    if (loseResponse) { loseResponse = false; throw new Error("response lost"); }
    return result;
  };
  try {
    assert.throws(() => new ProgramMemorySubmissionCoordinator(source).submit(plan, execute), /response lost/);
    assert.equal(source.list("program_memory_submission")[0]?.status, "retryable");
    source.close(); source = await new CraftStore(craftPaths(join(root, "context"))).open();
    const coordinator = new ProgramMemorySubmissionCoordinator(source);
    assert.deepEqual(coordinator.submit(plan, execute), receipt);
    assert.deepEqual(coordinator.submit(plan, () => { throw new Error("must reuse receipt"); }), receipt);
    assert.equal(executions, 1);
    assert.throws(() => coordinator.submit({ ...plan, design: { contract_digest: "changed" } }, execute), /intent conflict/);
    assert.equal(source.list("program_memory_submission")[0]?.attempts, 2);
  } finally { source.close(); target.close(); rmSync(root, { recursive: true, force: true }); }
});

test("cross-owner submission rejects mismatched receipts and invalid project or version", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-submission-reject-"));
  const store = await new CraftStore(craftPaths(root)).open({ fileRecords: true });
  const coordinator = new ProgramMemorySubmissionCoordinator(store);
  try {
    for (const bad of [{ request_id: "wrong" }, { procedure_id: "wrong" }, { procedure_candidate_version: 0 }, { procedure_candidate_version: 1.5 }]) {
      assert.throws(() => coordinator.submit(plan, () => ({ ...receipt, ...bad })), /mismatched receipt/);
      assert.equal(store.list("program_memory_submission")[0]?.reason, "receipt_mismatch");
    }
    for (const candidate of [{ ...plan.candidate, version: 0 }, { ...plan.candidate, version: 1.5 },
      { ...plan.candidate, scope: { kind: "session", id: "project:fixture" } },
      { ...plan.candidate, scope: { kind: "project", id: "foreign" } },
      { ...plan.candidate, scope: { kind: "project", id: 7 } }]) {
      assert.throws(() => coordinator.submit({ ...plan, candidate } as JsonObject, () => receipt), /exact project candidate/);
    }
    assert.throws(() => coordinator.submit(plan, () => { throw "offline"; }), error => error === "offline");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
