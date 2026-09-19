// Restores the remote branch's Runtime Proof test, which the merge lost: both sides added
// `tests/runtime-proof.test.ts`, and this branch's file (the v0.12.30 remote-task, acceptance
// and attestation tests) won the path. The subject here is `src/runtime-proof.ts`, so the file
// is named after the kernel it drives.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { RuntimeProofKernel } from "../src/runtime-proof.ts";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "craft-runtime-proof-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return new RuntimeProofKernel(store);
}
const checks = { workspace_boundary: true, network_boundary: true, credential_boundary: true, process_cleanup: true, resource_limits: true, cancel_observed: true };
const manifestId = (result: JsonObject): string => String((result.manifest as JsonObject).id);
const conformanceId = (result: JsonObject): string => String((result.conformance as JsonObject).id);

test("Runtime Proof manifests, probes, conformance and attestations are idempotent", async () => {
  const proof = await setup();
  const first = proof.manifest({ runtime_id: "local", platform: "darwin", adapter_id: "sandbox-exec", workspace_digest: "sha256:w", resources: { cpu: 1 } });
  const same = proof.manifest({ runtime_id: "local", platform: "darwin", adapter_id: "sandbox-exec", workspace_digest: "sha256:w", resources: { cpu: 1 } });
  assert.equal(same.idempotent, true);
  assert.throws(() => proof.manifest({ runtime_id: "local", platform: "darwin", adapter_id: "other", workspace_digest: "sha256:w" }), /idempotency/);
  const id = manifestId(first);
  const probed = proof.probe({ manifest_id: id, environment_digest: "sha256:e", checks, probe_id: "probe-local" });
  assert.equal(proof.probe({ manifest_id: id, environment_digest: "sha256:e", checks, probe_id: "probe-local" }).idempotent, true);
  assert.throws(() => proof.probe({ manifest_id: id, environment_digest: "sha256:changed", checks, probe_id: "probe-local" }), /idempotency/);
  assert.equal((probed.probe as JsonObject).environment_digest, "sha256:e");
  const defaultProbe = proof.probe({ manifest_id: id, environment_digest: "sha256:default" });
  assert.equal((defaultProbe.probe as JsonObject).manifest_id, id);
  const conformance = proof.conformance({ manifest_id: id, checks, verifier: "fixture", conformance_id: "conf-local" });
  assert.equal((conformance.conformance as JsonObject).status, "verified");
  assert.equal(proof.conformance({ manifest_id: id, checks, verifier: "fixture", conformance_id: "conf-local" }).idempotent, true);
  assert.throws(() => proof.conformance({ manifest_id: id, checks: {}, verifier: "fixture", conformance_id: "conf-local" }), /idempotency/);
  const attested = proof.attest({ conformance_id: conformanceId(conformance), run_id: "run-1", environment_digest: "sha256:e", profile_version: "p1", expires_at: new Date(Date.now() + 60_000).toISOString(), evidence_ids: ["e1"], attestation_id: "att-local" });
  assert.equal((attested.attestation as JsonObject).run_id, "run-1");
  assert.equal(proof.attest({ conformance_id: conformanceId(conformance), run_id: "run-1", environment_digest: "sha256:e", profile_version: "p1", expires_at: (attested.attestation as JsonObject).expires_at, evidence_ids: ["e1"], attestation_id: "att-local" }).idempotent, true);
  assert.throws(() => proof.attest({ conformance_id: conformanceId(conformance), run_id: "run-1", environment_digest: "changed", profile_version: "p1", expires_at: (attested.attestation as JsonObject).expires_at, attestation_id: "att-local" }), /idempotency/);
  const defaultAttestation = proof.attest({ conformance_id: conformanceId(conformance), run_id: "run-2", environment_digest: "sha256:e", profile_version: "p1", expires_at: new Date(Date.now() + 60_000).toISOString() });
  assert.equal((defaultAttestation.attestation as JsonObject).run_id, "run-2");
  assert.equal(proof.rehydrate({ checkpoint_id: "cp", expected_environment_digest: "sha256:e", current_environment_digest: "sha256:e" }).status, "ready");
  assert.equal(proof.rehydrate({ checkpoint_id: "cp", expected_environment_digest: "sha256:e", current_environment_digest: "sha256:x" }).status, "needs_replan");
});

test("Runtime Proof blocks missing checks, unsupported Windows isolation and unverified attestations", async () => {
  const proof = await setup();
  const blocked = proof.manifest({ runtime_id: "win", platform: "win32", adapter_id: "none", workspace_digest: "sha256:w" });
  const blockedId = manifestId(blocked);
  const conformance = proof.conformance({ manifest_id: blockedId, verifier: "fixture" });
  assert.equal((conformance.conformance as JsonObject).status, "blocked");
  assert.throws(() => proof.attest({ conformance_id: conformanceId(conformance), run_id: "r", environment_digest: "e", profile_version: "p", expires_at: new Date().toISOString() }), /not verified/);
  assert.throws(() => proof.probe({ manifest_id: "missing", environment_digest: "e" }), /Unknown/);
  assert.throws(() => proof.conformance({ manifest_id: blockedId, checks: {}, verifier: "" }), /verifier/);
  const noEvidence = proof.manifest({ runtime_id: "linux", platform: "linux", adapter_id: "bwrap", workspace_digest: "sha256:w" });
  const verified = proof.conformance({ manifest_id: manifestId(noEvidence), checks, verifier: "fixture" });
  proof.attest({ conformance_id: conformanceId(verified), run_id: "run-no-evidence", environment_digest: "e", profile_version: "p", expires_at: new Date().toISOString(), evidence_ids: "not-an-array" });
  const windowsRunner = proof.manifest({ runtime_id: "win-runner", platform: "win32", adapter_id: "external-runner", workspace_digest: "sha256:w" });
  assert.equal((proof.conformance({ manifest_id: manifestId(windowsRunner), checks, verifier: "fixture" }).conformance as JsonObject).status, "verified");
});
