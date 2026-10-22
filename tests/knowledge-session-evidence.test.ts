import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftService } from "../core/service.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";

const sha = (digit: string) => `sha256:${digit.repeat(64)}`;
const input = (): JsonObject => ({ scope: "project:demo", task_id: "task-1", source_session_id: "session-1", turn_id: "turn-1",
  source_ref: sha("a"), task_goal: "修复 Knowledge 证据链。", task_result: "定向验证通过。", sanitized: true,
  verification_artifacts: [{ runner: "javascript", command_digest: sha("b"), result_digest: sha("c"), call_digest: sha("d"),
    exit_code: 0, summary_kind: "tests_passed", content_stored: false }] });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-session-evidence-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  service.scopeAliasBind({ scope_kind: "project", scope_id: "project:demo", alias_kind: "path", alias: root });
  return { root, store, service };
}

test("stores sanitized verification evidence as a project Knowledge fragment readable by semantic review", async () => {
  const f = await fixture();
  try {
    const saved = f.service.knowledgeSessionEvidenceRecord(input());
    const evidence = saved.evidence as JsonObject;
    assert.equal(evidence.source_type, "program");
    assert.equal(evidence.confidence, "confirmed");
    assert.equal(evidence.source_id, saved.source_id);
    assert.equal(evidence.fragment_id, saved.fragment_id);
    assert.equal(saved.sanitized_content_stored, true);
    assert.equal(saved.raw_content_stored, false);
    const fragment = f.store.get("knowledge_fragment", String(saved.fragment_id));
    assert.match(String((fragment.content_ref as JsonObject).path), /\.craft_data\/knowledge\/md/u);
    assert.equal((fragment.content_ref as JsonObject).scope, "project:demo");
    const claim = f.service.knowledgeClaimSave({ claim_id: "session-claim", kind: "fact", title: "已验证的修复",
      content: "定向验证通过。", scope: "project:demo", source_id: saved.source_id, evidence_ids: [evidence.id] }).claim as JsonObject;
    const packetResult = f.service.knowledgeSemanticReviewPacket({ claim_id: String(claim.id) });
    assert.equal(packetResult.status, "ready");
    assert.equal(packetResult.claim_status, claim.status);
    const packet = packetResult.packet as JsonObject;
    assert.equal("status" in (packet.claim as JsonObject), false, "lifecycle metadata is outside the canonical evidence packet");
    const fragments = packet.evidence_fragments as JsonObject[];
    assert.equal(fragments.length, 1);
    assert.match(String(fragments[0]!.content), /修复 Knowledge 证据链/u);
    assert.match(String(fragments[0]!.content), /定向验证通过/u);
    assert.doesNotMatch(String(fragments[0]!.content), /pnpm test/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("retries are idempotent and persist evidence only in the exact project scope", async () => {
  const f = await fixture();
  try {
    const first = f.service.knowledgeSessionEvidenceRecord(input());
    const again = f.service.knowledgeSessionEvidenceRecord(input());
    assert.equal(again.evidence_id, undefined);
    assert.equal(again.evidence && (again.evidence as JsonObject).id, (first.evidence as JsonObject).id);
    assert.equal(again.source_id, first.source_id);
    assert.equal(again.fragment_id, first.fragment_id);
    assert.equal(f.store.list("knowledge_fragment", 20).filter(item => item.id === first.fragment_id).length, 1);
    assert.equal(f.store.list("evidence", 20).filter(item => item.id === (first.evidence as JsonObject).id).length, 1);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("rejects missing verification, wrong scope, unsanitized text and malformed artifacts before writing", async () => {
  const f = await fixture();
  try {
    const invalid: JsonObject[] = [
      { ...input(), sanitized: false },
      { ...input(), task_id: undefined },
      { ...input(), task_id: "   " },
      { ...input(), task_id: "x".repeat(161) },
      { ...input(), task_id: "task\nid" },
      { ...input(), scope: "global" },
      { ...input(), source_ref: "not-a-digest" },
      { ...input(), task_goal: "token=abcdefgh12345678" },
      { ...input(), task_result: "https://example.invalid/secret" },
      { ...input(), task_goal: "contact me@example.com" },
      { ...input(), task_goal: "local /Users/alice/project" },
      { ...input(), task_goal: "host 192.168.1.2" },
      { ...input(), task_goal: "password: hidden" },
      { ...input(), observed_at: "not-a-time" },
      { ...input(), verification_artifacts: [] },
      { ...input(), verification_artifacts: new Array(9).fill((input().verification_artifacts as JsonObject[])[0]) },
      { ...input(), verification_artifacts: [null] },
      { ...input(), verification_artifacts: [{ ...(input().verification_artifacts as JsonObject[])[0], runner: "shell" }] },
      { ...input(), verification_artifacts: [{ ...(input().verification_artifacts as JsonObject[])[0], command_digest: "bad" }] },
      { ...input(), verification_artifacts: [{ ...(input().verification_artifacts as JsonObject[])[0], result_digest: "bad" }] },
      { ...input(), verification_artifacts: [{ ...(input().verification_artifacts as JsonObject[])[0], call_digest: "bad" }] },
      { ...input(), verification_artifacts: [{ ...(input().verification_artifacts as JsonObject[])[0], exit_code: 1 }] },
      { ...input(), verification_artifacts: [{ ...(input().verification_artifacts as JsonObject[])[0], summary_kind: "other" }] },
      { ...input(), verification_artifacts: [{ ...(input().verification_artifacts as JsonObject[])[0], content_stored: true }] },
      { ...input(), verification_artifacts: [{ ...(input().verification_artifacts as JsonObject[])[0], raw_output: "private output" }] },
    ];
    for (const args of invalid) assert.throws(() => f.service.knowledgeSessionEvidenceRecord(args));
    assert.equal(f.store.list("evidence", 20).length, 0);
    assert.equal(f.store.list("knowledge_fragment", 20).length, 0);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("fails closed when the deterministic project source is disabled or an evidence identity is corrupted", async () => {
  const f = await fixture();
  try {
    const first = f.service.knowledgeSessionEvidenceRecord(input());
    const sourceId = String(first.source_id);
    const source = f.store.get("knowledge_source", sourceId);
    f.store.save("knowledge_source", sourceId, { ...source, status: "disabled" });
    assert.throws(() => f.service.knowledgeSessionEvidenceRecord({ ...input(), task_id: "task-2" }), /not active/u);
    f.store.save("knowledge_source", sourceId, { ...source, status: "active" });
    const evidenceId = String((first.evidence as JsonObject).id);
    const evidence = f.store.get("evidence", evidenceId);
    f.store.save("evidence", evidenceId, { ...evidence, identity_digest: "corrupt" });
    assert.throws(() => f.service.knowledgeSessionEvidenceRecord(input()), /idempotency conflict/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
