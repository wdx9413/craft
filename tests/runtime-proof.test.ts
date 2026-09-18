import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore } from "../src/store.ts";
import { craftPaths } from "../src/paths.ts";
import { RuntimeProofKernel } from "../src/runtime-proof.ts";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "craft-runtime-proof-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return new RuntimeProofKernel(store);
}
const checks = { workspace_boundary: true, network_boundary: true, credential_boundary: true, process_cleanup: true, resource_limits: true, cancel_observed: true };

test("Runtime Proof manifests, probes, conformance and attestations are idempotent", async () => {
  const proof = await setup();
  const first = proof.manifest({ runtime_id: "local", platform: "darwin", adapter_id: "sandbox-exec", workspace_digest: "sha256:w", resources: { cpu: 1 } });
  const same = proof.manifest({ runtime_id: "local", platform: "darwin", adapter_id: "sandbox-exec", workspace_digest: "sha256:w", resources: { cpu: 1 } });
  assert.equal((same as any).idempotent, true);
  assert.throws(() => proof.manifest({ runtime_id: "local", platform: "darwin", adapter_id: "other", workspace_digest: "sha256:w" }), /idempotency/);
  const id = String((first as any).manifest.id);
  const probed = proof.probe({ manifest_id: id, environment_digest: "sha256:e", checks, probe_id: "probe-local" });
  assert.equal((proof.probe({ manifest_id: id, environment_digest: "sha256:e", checks, probe_id: "probe-local" }) as any).idempotent, true);
  assert.throws(() => proof.probe({ manifest_id: id, environment_digest: "sha256:changed", checks, probe_id: "probe-local" }), /idempotency/);
  assert.equal((probed as any).probe.environment_digest, "sha256:e");
  const defaultProbe = proof.probe({ manifest_id: id, environment_digest: "sha256:default" });
  assert.equal((defaultProbe as any).probe.manifest_id, id);
  const conformance = proof.conformance({ manifest_id: id, checks, verifier: "fixture", conformance_id: "conf-local" });
  assert.equal((conformance as any).conformance.status, "verified");
  assert.equal((proof.conformance({ manifest_id: id, checks, verifier: "fixture", conformance_id: "conf-local" }) as any).idempotent, true);
  assert.throws(() => proof.conformance({ manifest_id: id, checks: {}, verifier: "fixture", conformance_id: "conf-local" }), /idempotency/);
  const attested = proof.attest({ conformance_id: String((conformance as any).conformance.id), run_id: "run-1", environment_digest: "sha256:e", profile_version: "p1", expires_at: new Date(Date.now() + 60_000).toISOString(), evidence_ids: ["e1"], attestation_id: "att-local" });
  assert.equal((attested as any).attestation.run_id, "run-1");
  assert.equal((proof.attest({ conformance_id: String((conformance as any).conformance.id), run_id: "run-1", environment_digest: "sha256:e", profile_version: "p1", expires_at: (attested as any).attestation.expires_at, evidence_ids: ["e1"], attestation_id: "att-local" }) as any).idempotent, true);
  assert.throws(() => proof.attest({ conformance_id: String((conformance as any).conformance.id), run_id: "run-1", environment_digest: "changed", profile_version: "p1", expires_at: (attested as any).attestation.expires_at, attestation_id: "att-local" }), /idempotency/);
  const defaultAttestation = proof.attest({ conformance_id: String((conformance as any).conformance.id), run_id: "run-2", environment_digest: "sha256:e", profile_version: "p1", expires_at: new Date(Date.now() + 60_000).toISOString() });
  assert.equal((defaultAttestation as any).attestation.run_id, "run-2");
  assert.equal(proof.rehydrate({ checkpoint_id: "cp", expected_environment_digest: "sha256:e", current_environment_digest: "sha256:e" }).status, "ready");
  assert.equal(proof.rehydrate({ checkpoint_id: "cp", expected_environment_digest: "sha256:e", current_environment_digest: "sha256:x" }).status, "needs_replan");
});

test("Runtime Proof blocks missing checks, unsupported Windows isolation and unverified attestations", async () => {
  const proof = await setup();
  const blocked = proof.manifest({ runtime_id: "win", platform: "win32", adapter_id: "none", workspace_digest: "sha256:w" });
  const conformance = proof.conformance({ manifest_id: String((blocked as any).manifest.id), verifier: "fixture" });
  assert.equal((conformance as any).conformance.status, "blocked");
  assert.throws(() => proof.attest({ conformance_id: String((conformance as any).conformance.id), run_id: "r", environment_digest: "e", profile_version: "p", expires_at: new Date().toISOString() }), /not verified/);
  assert.throws(() => proof.probe({ manifest_id: "missing", environment_digest: "e" }), /Unknown/);
  assert.throws(() => proof.conformance({ manifest_id: String((blocked as any).manifest.id), checks: {}, verifier: "" }), /verifier/);
  const noEvidence = proof.manifest({ runtime_id: "linux", platform: "linux", adapter_id: "bwrap", workspace_digest: "sha256:w" });
  const verified = proof.conformance({ manifest_id: String((noEvidence as any).manifest.id), checks, verifier: "fixture" });
  proof.attest({ conformance_id: String((verified as any).conformance.id), run_id: "run-no-evidence", environment_digest: "e", profile_version: "p", expires_at: new Date().toISOString(), evidence_ids: "not-an-array" });
  const windowsRunner = proof.manifest({ runtime_id: "win-runner", platform: "win32", adapter_id: "external-runner", workspace_digest: "sha256:w" });
  assert.equal((proof.conformance({ manifest_id: String((windowsRunner as any).manifest.id), checks, verifier: "fixture" }) as any).conformance.status, "verified");
});
