import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";

const HOUR = 60 * 60 * 1000;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-approval-grant-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  const dir = join(root, "repo"); await mkdir(dir);
  const workspace = (service.workspaceResolveOrCreate({ root_path: dir }) as JsonObject).workspace as JsonObject;
  return { root, store, service, workspaceId: String(workspace.id) };
}

function base(workspaceId: string, now = Date.now(), overrides: JsonObject = {}): JsonObject {
  return { workspace_id: workspaceId, action: "workspace_write", action_fingerprint: "sha256:abc", effect: "local_write",
    risk_level: "R2", policy_version: "policy-v1", granted_by: "human", expires_at: new Date(now + 2 * HOUR).toISOString(), ...overrides };
}

function checkOf(workspaceId: string, overrides: JsonObject = {}): JsonObject {
  return { workspace_id: workspaceId, action: "workspace_write", action_fingerprint: "sha256:abc",
    effect: "local_write", risk_level: "R2", policy_version: "policy-v1", ...overrides };
}

test("an exact R2 approval grant is remembered for at most 24 hours", async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    const grant = (f.service.approvalGrantCreate(base(f.workspaceId, now)) as JsonObject).grant as JsonObject;
    assert.equal(grant.status, "active");
    assert.equal(grant.execution_authority, false);
    assert.equal((f.service.approvalGrants.check(checkOf(f.workspaceId), now) as JsonObject).allowed, true);
    // Fingerprint, effect, risk and policy must match exactly.
    for (const override of [{ action_fingerprint: "sha256:def" }, { effect: "external_write" }, { risk_level: "R1" }, { policy_version: "policy-v2" }]) {
      assert.equal((f.service.approvalGrants.check(checkOf(f.workspaceId, override), now) as JsonObject).allowed, false);
    }
    // A different workspace never reuses this grant.
    const otherDir = join(f.root, "other"); await mkdir(otherDir);
    const other = (f.service.workspaceResolveOrCreate({ root_path: otherDir }) as JsonObject).workspace as JsonObject;
    assert.equal((f.service.approvalGrants.check(checkOf(String(other.id)), now) as JsonObject).allowed, false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("R3 is never rememberable and R2 requires an expiry within 24 hours", async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    assert.throws(() => f.service.approvalGrantCreate(base(f.workspaceId, now, { risk_level: "R3" })), /never be remembered/);
    assert.throws(() => f.service.approvalGrantCreate(base(f.workspaceId, now, { expires_at: null })), /expires_at/);
    assert.throws(() => f.service.approvalGrantCreate(base(f.workspaceId, now, { expires_at: new Date(now + 25 * HOUR).toISOString() })), /24 hours/);
    assert.throws(() => f.service.approvalGrantCreate(base(f.workspaceId, now, { expires_at: new Date(now - HOUR).toISOString() })), /future/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("expired grants stop matching, sweep expires them, and revocation is exact", async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    const grant = (f.service.approvalGrantCreate(base(f.workspaceId, now, { risk_level: "R1", expires_at: new Date(now + 1000).toISOString() })) as JsonObject).grant as JsonObject;
    assert.equal((f.service.approvalGrants.check(checkOf(f.workspaceId, { risk_level: "R1" }), now) as JsonObject).allowed, true);
    // Just past expiry the same grant no longer matches.
    const later = now + 2000;
    assert.equal((f.service.approvalGrants.check(checkOf(f.workspaceId, { risk_level: "R1" }), later) as JsonObject).reason, "expired");
    // Revocation is exact and explicit.
    const revoked = f.service.approvalGrantRevoke({ grant_id: String(grant.id), reason: "changed my mind" }) as JsonObject;
    assert.equal((revoked.grant as JsonObject).status, "revoked");
    // A separate expired grant is swept, not revoked.
    f.service.approvalGrantCreate(base(f.workspaceId, now, { action: "sweep-me", action_fingerprint: "sweep", risk_level: "R1", expires_at: new Date(now + 1000).toISOString() }));
    assert.equal((f.service.approvalGrants.sweep(later) as JsonObject).expired, 1);
    // Identical identity is idempotent.
    const again = f.service.approvalGrantCreate(base(f.workspaceId, now)) as JsonObject;
    assert.equal(again.idempotent, false);
    assert.equal((f.service.approvalGrantCreate(base(f.workspaceId, now)) as JsonObject).idempotent, true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("list filters by workspace and status", async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    f.service.approvalGrantCreate(base(f.workspaceId, now, { action: "a1", action_fingerprint: "f1" }));
    f.service.approvalGrantCreate(base(f.workspaceId, now, { action: "a2", action_fingerprint: "f2" }));
    assert.equal(((f.service.approvalGrantList({ workspace_id: f.workspaceId }) as JsonObject).grants as JsonObject[]).length, 2);
    assert.equal(((f.service.approvalGrantList({ status: "active" }) as JsonObject).grants as JsonObject[]).length, 2);
    assert.equal(((f.service.approvalGrantList({ status: "revoked" }) as JsonObject).grants as JsonObject[]).length, 0);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("approval grants reject malformed input and expose an executor template version", async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    assert.throws(() => f.service.approvalGrantCreate(base(f.workspaceId, now, { workspace_id: " " })), /workspace_id/);
    assert.throws(() => f.service.approvalGrantCreate(base(f.workspaceId, now, { expires_at: "not-a-date" })), /ISO timestamp/);
    assert.throws(() => f.service.approvalGrantCreate(base(f.workspaceId, now, { effect: "telepathy" })), /effect/);
    assert.throws(() => f.service.approvalGrantCreate(base(f.workspaceId, now, { risk_level: "R9" })), /risk_level/);
    // An explicit executor template version is stored; an empty one is refused.
    const withVersion = (f.service.approvalGrantCreate(base(f.workspaceId, now, { executor_template_version: "tpl-1" })) as JsonObject).grant as JsonObject;
    assert.equal(withVersion.executor_template_version, "tpl-1");
    assert.throws(() => f.service.approvalGrantCreate(base(f.workspaceId, now, { executor_template_version: " " })), /executor_template_version/);
    // An exact identity that already exists with a different digest is a conflict.
    const grant = (f.service.approvalGrantCreate(base(f.workspaceId, now, { action: "conflict", action_fingerprint: "cf" })) as JsonObject).grant as JsonObject;
    const { id: _id, version: _version, created_at: _c, updated_at: _u, ...rest } = grant;
    f.store.save("approval_grant", String(grant.id), { ...rest, identity_digest: "sha256:other" });
    assert.throws(() => f.service.approvalGrantCreate(base(f.workspaceId, now, { action: "conflict", action_fingerprint: "cf" })), /idempotency conflict/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("an open-ended grant stays valid and revoke defaults its reason", async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    const grant = (f.service.approvalGrantCreate(base(f.workspaceId, now, { risk_level: "R1", expires_at: null })) as JsonObject).grant as JsonObject;
    const check = f.service.approvalGrants.check(checkOf(f.workspaceId, { risk_level: "R1" }), now) as JsonObject;
    assert.equal(check.allowed, true);
    const revoked = f.service.approvalGrantRevoke({ grant_id: String(grant.id) }) as JsonObject;
    assert.equal((revoked.grant as JsonObject).revoked_reason, "revoked_by_human");
    assert.throws(() => f.service.approvalGrantRevoke({ grant_id: String(grant.id) }), /not active/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
test("revoking an approval grant records who did it, without inventing a name", async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    const created = (f.service.approvalGrantCreate(base(f.workspaceId, now, { granted_by: "user:alex" })) as JsonObject).grant as JsonObject;
    const revoked = (f.service.approvalGrantRevoke({ grant_id: String(created.id), reason: "范围扩大需重批", revoked_by: "user:bian" }) as JsonObject).grant as JsonObject;
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.revoked_by, "user:bian");
    assert.equal(revoked.revoked_reason, "范围扩大需重批");
    // Revoking never rewrites who granted the original decision.
    assert.equal(revoked.granted_by, "user:alex");

    const other = (f.service.approvalGrantCreate(base(f.workspaceId, now, { action_fingerprint: "sha256:def" })) as JsonObject).grant as JsonObject;
    const plain = (f.service.approvalGrantRevoke({ grant_id: String(other.id) }) as JsonObject).grant as JsonObject;
    // An absent actor stays absent: the record must not be filled with a placeholder.
    assert.equal(plain.revoked_by, undefined);
    assert.equal(plain.revoked_reason, "revoked_by_human");
    assert.throws(() => f.service.approvalGrantRevoke({ grant_id: String(other.id), revoked_by: "  " }), /revoked_by/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
