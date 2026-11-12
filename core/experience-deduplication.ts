import { createHash } from "node:crypto";
import type { CraftStore, JsonObject } from 'craft-common-store-local/store';
import { stableDigest } from 'craft-common-base/digest';

const VERDICTS = new Set(["accepted", "rejected", "unknown"]);
const REJECTED = ["证伪", "失败", "无改善", "无效", "负贡献", "淘汰", "跑输", "更差", "反而", "不可用", "推翻", "已否决"];
const ACCEPTED = ["有效", "改善", "跑赢", "优于", "显著", "已采纳"];

export function normalizeFactor(name: string): string { return name.trim().toLowerCase(); }

export function factorKey(factors: readonly string[], pool = ""): string {
  const fs = [...new Set(factors.map(normalizeFactor).filter(Boolean))].sort();
  const base = fs.length ? fs.join("+") : "none";
  const scope = pool.trim().toLowerCase();
  return scope ? `${scope}::${base}` : base;
}

export function classifyVerdict(text: string): "accepted" | "rejected" | "unknown" {
  if (REJECTED.some((kw) => text.includes(kw))) return "rejected";
  if (ACCEPTED.some((kw) => text.includes(kw))) return "accepted";
  return "unknown";
}

export interface ExperienceConclusion {
  key: string;
  factors: string[];
  pool: string;
  verdict: "accepted" | "rejected" | "unknown";
  title: string;
  evidence: string;
  source: string;
}

export class ExperienceDeduplicationKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  record(args: JsonObject): JsonObject {
    const factors = Array.isArray(args.factors) ? (args.factors as unknown[]).map(String) : [];
    if (args.pool !== undefined && typeof args.pool !== "string") throw new Error("experience conclusion pool must be a string");
    const pool = typeof args.pool === "string" ? args.pool.trim().toLowerCase() : "";
    const key = factorKey(factors, pool);
    if (!factors.length) throw new Error("experience conclusion requires at least one factor");
    const text = typeof args.title === "string" && args.title.trim() ? args.title : typeof args.evidence === "string" ? args.evidence : "";
    const verdict = args.verdict === undefined ? classifyVerdict(text) : String(args.verdict);
    if (!VERDICTS.has(verdict)) throw new Error("experience conclusion verdict is unsupported");
    const nomFactors = [...new Set(factors.map(normalizeFactor).filter(Boolean))].sort();
    const identity = { factors: nomFactors, pool, verdict };
    const identityDigest = stableDigest(identity);
    const id = `experience_conclusion_${createHash("sha256").update(key).digest("hex").slice(-24)}`;
    const existing = this.store.find("experience_conclusion", id);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Experience conclusion conflicts with an existing record for the same factor combination");
      return { conclusion: existing, idempotent: true };
    }
    return {
      conclusion: this.store.create("experience_conclusion", id, {
        ...identity,
        key,
        title: typeof args.title === "string" ? args.title : "",
        evidence: typeof args.evidence === "string" ? args.evidence : "",
        source: typeof args.source === "string" ? args.source : "",
        identity_digest: identityDigest,
      }),
      idempotent: false,
    };
  }

  findByFactors(factors: readonly string[], pool = ""): ExperienceConclusion[] {
    const key = factorKey(factors, pool);
    return this.store.list("experience_conclusion", 10_000, (item: JsonObject) => item.key === key, false).map((item) => item as unknown as ExperienceConclusion);
  }

  hasRefutedCombination(factors: readonly string[], pool = ""): boolean {
    return this.findByFactors(factors, pool).some((item) => item.verdict === "rejected");
  }
}
