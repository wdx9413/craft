import assert from "node:assert/strict";
import test from "node:test";
import { hookVerificationGap } from "../core/hook-verification-gap.ts";

test("missing journals remain unknown and explicit Host readiness takes priority", () => {
  assert.deepEqual(hookVerificationGap(null), {
    reason: "verification_unobserved", host_authentication: "unknown", hook_trust: "unknown",
  });
  assert.equal(hookVerificationGap({ verification_outcome: "passed" }, {
    authentication: "unavailable", hook_trust: "untrusted",
  }).reason, "host_auth_unavailable");
  assert.equal(hookVerificationGap({}, { authentication: "available", hook_trust: "untrusted" }).reason, "hook_untrusted");
});

test("verification outcomes and pending gaps are evaluated only after the latest edit", () => {
  assert.equal(hookVerificationGap({ verification_outcome: "passed" }).reason, null);
  assert.equal(hookVerificationGap({ verification_outcome: "failed" }).reason, null);
  assert.equal(hookVerificationGap({ signals: [
    { kind: "verification_gap", verifier: "test", gap_reason: "pending_background" },
  ] }, { authentication: "available", hook_trust: "trusted" }).reason, "pending_background");
  assert.equal(hookVerificationGap({ signals: [
    { kind: "verification_gap", verifier: "test", gap_reason: "unsupported_native_envelope" },
  ] }).reason, "unsupported_native_envelope");
  assert.equal(hookVerificationGap({ signals: [
    { kind: "verification_gap", verifier: "old", gap_reason: "pending_background" },
    { kind: "edit" },
    { kind: "verification_gap", verifier: "current", gap_reason: "unsupported_native_envelope" },
    { kind: "verification", verifier: "current" },
  ] }).reason, "verification_unobserved");
  assert.equal(hookVerificationGap({ signals: "invalid" }).reason, "verification_unobserved");
  assert.equal(hookVerificationGap({ signals: [null, "bad", []] }).reason, "verification_unobserved");
});
