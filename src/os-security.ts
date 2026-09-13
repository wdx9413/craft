import { createHash, randomUUID } from "node:crypto";
import type { JsonObject } from "./store.ts";
import { CraftStore } from "./store.ts";

function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function list(value: unknown, name: string): string[] { if (value === undefined) return []; if (!Array.isArray(value)) throw new Error(`${name} must be an array`); return value.map((item) => text(item, name)); }
const PLATFORMS = new Set(["win32", "darwin", "linux"]);
const NETWORK = new Set(["denied", "allowlist"]);
const FILESYSTEM = new Set(["read_only", "workspace_write"]);

export class OsSecurityKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  plan(args: JsonObject): JsonObject {
    const platform = text(args.platform ?? process.platform, "platform"); if (!PLATFORMS.has(platform)) throw new Error("Unsupported platform");
    const workspace = text(args.workspace, "workspace");
    const network = text(args.network ?? "denied", "network"); if (!NETWORK.has(network)) throw new Error("Unsupported network policy");
    const filesystem = text(args.filesystem ?? "read_only", "filesystem"); if (!FILESYSTEM.has(filesystem)) throw new Error("Unsupported filesystem policy");
    const allowlist = list(args.egress_allowlist, "egress_allowlist");
    const boundary = { platform, workspace, network, filesystem, egress_allowlist: allowlist, process_isolation: platform === "win32" ? "job_object" : platform === "darwin" ? "sandbox_profile" : "landlock_or_namespace", secret_broker: args.secret_broker === true, fail_closed: true };
    const boundaryDigest = digest(boundary); const planId = String(args.plan_id ?? `os_security_${randomUUID().replaceAll("-", "")}`); const existing = this.store.find("os_security_plan", planId);
    if (existing) { if (existing.boundary_digest !== boundaryDigest) throw new Error("OS security plan idempotency conflict"); return { plan: existing, idempotent: true }; }
    return { plan: this.store.create("os_security_plan", planId, { ...boundary, boundary_digest: boundaryDigest, status: "planned" }), idempotent: false };
  }

  verify(args: JsonObject): JsonObject {
    const plan = this.store.get("os_security_plan", text(args.plan_id, "plan_id")); const observed = (args.observed && typeof args.observed === "object" && !Array.isArray(args.observed)) ? args.observed as JsonObject : {};
    const observedDigest = observed.boundary_digest === undefined ? null : text(observed.boundary_digest, "observed.boundary_digest");
    const evidenceIds = list(args.evidence_ids, "evidence_ids"); const compatible = observedDigest === plan.boundary_digest && evidenceIds.length > 0;
    const receiptId = String(args.receipt_id ?? `os_security_receipt_${plan.id}`); const existing = this.store.find("os_security_receipt", receiptId);
    if (existing) return { receipt: existing, compatible: existing.compatible === true, idempotent: true };
    const receipt = this.store.create("os_security_receipt", receiptId, { plan_id: plan.id, observed_digest: observedDigest, evidence_ids: evidenceIds, compatible, fail_closed: true, verified_by: args.verified_by ?? null });
    if (compatible) this.store.save("os_security_plan", String(plan.id), { ...plan, status: "verified", verified_receipt_id: receipt.id });
    return { receipt, compatible, idempotent: false };
  }
}
