import { randomUUID } from "node:crypto";
import type { JsonObject } from "./infrastructure/store.ts";
import { CraftStore } from "./infrastructure/store.ts";
import { text, object } from "./validation.ts";
import { digestJson, payload } from "./digest.ts";


/** Small domain evaluator registry; actual domain scoring remains user-owned. */
export class DomainEvaluatorKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  save(args: JsonObject): JsonObject {
    const evaluatorId = String(args.evaluator_id ?? `domain_evaluator_${randomUUID().replaceAll("-", "")}`); const domain = text(args.domain, "domain"); const name = text(args.name, "name");
    const criteria = object(args.rules ?? args.criteria, "rules"); const record = { domain, name, criteria, description_digest: digestJson(args.description ?? ""), status: "active" };
    const existing = this.store.find("domain_evaluator", evaluatorId); if (existing) return { evaluator: this.store.save("domain_evaluator", evaluatorId, { ...payload(existing), ...record }), idempotent: false };
    return { evaluator: this.store.create("domain_evaluator", evaluatorId, record), idempotent: false };
  }

  evaluate(args: JsonObject): JsonObject {
    const evaluator = this.store.get("domain_evaluator", text(args.evaluator_id, "evaluator_id")); const metrics = object(args.metrics, "metrics"); const criteria = evaluator.criteria as JsonObject;
    const checks = Object.entries(criteria).map(([key, rule]) => { const value = Number(metrics[key]); const expected = Number(rule); return { key, value, expected, passed: Number.isFinite(value) && Number.isFinite(expected) && value >= expected }; });
    const passed = checks.length > 0 && checks.every((check) => check.passed);
    return { evaluator, checks, verdict: passed ? "passed" : "failed", evidence_digest: digestJson({ evaluator_id: evaluator.id, metrics, checks }) };
  }
}
