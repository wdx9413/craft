import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftService } from "../core/service.ts";
import { TravelAdapter } from "@craft/capability-context";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-travel-adapter-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot);
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  store.create("scope_alias", "project-travel-trip-tokyo", { scope: { kind: "project", id: "travel:trip-tokyo" },
    alias_kind: "path", alias: projectRoot, status: "active" });
  const adapter = new TravelAdapter({ memory: service, store });
  return { root, projectRoot, store, service, adapter };
}

function remember(service: CraftService, projectRoot: string, args: JsonObject): JsonObject {
  service.knowledgeMemoryInstallBuiltins();
  const evidence = service.evidenceRecord({ source_type: "travel-test", confidence: "confirmed",
    claim: String(args.content), locator: "travel-adapter-test" }) as JsonObject;
    return service.memoryLedgerRemember({ source_id: "builtin.evidence-wiki", kind: "episodic", project_root: projectRoot,
    scope_kind: "project", scope_id: "travel:trip-tokyo", content: String(args.content),
    evidence_ids: [evidence.id], valid_until: args.valid_until, concept_kind: "fact",
    topic: args.topic ?? "travel:plan" }).memory as JsonObject;
}

test("travel adapter extracts typed preferences and temporal-bound plan facts", () => {
  const extracted = TravelAdapter.extract("我偏好靠窗座位；预算不超过 8000 元；10 月 1 日至 10 月 7 日在东京；航班 MU523；入住新宿酒店");
  assert.deepEqual(extracted.preferences.map((item) => item.travel_kind).filter((kind, index, all) => all.indexOf(kind) === index), ["transport", "budget", "location"]);
  assert.equal(extracted.plans.length, 5);
  const timeWindow = extracted.plans.find((plan) => plan.kind === "time_window");
  assert.equal(timeWindow?.end, "2026-10-07T23:59:59.000Z");
  assert.deepEqual(extracted.booking_ids, ["MU523"]);
  assert.deepEqual(TravelAdapter.extract("普通聊天").kinds(), []);
  assert.equal(TravelAdapter.extract("api_key=secret-token-123").decision, "ignore");
});

test("travel write and recall keep preferences in memory and plans temporal-bound", async () => {
  const f = await fixture();
  try {
  const written = f.adapter.capture({ statement: "我偏好高铁靠窗座位；预算不超过 8000 元；10 月 1 日至 10 月 7 日在东京；航班 MU523",
      scope: { scope_kind: "project", scope_id: "travel:trip-tokyo" }, project_root: f.projectRoot, max_items: 5, now: "2026-09-01T00:00:00.000Z" }) as unknown as { preferences: JsonObject[]; plans: JsonObject[] };
    assert.equal(written.preferences.length, 3);
    assert.equal(written.plans.length, 2);
    const preferences = written.preferences;
    assert.equal(preferences[0]?.kind, "preference");
    assert.equal(preferences[0]?.topic, "preference:travel:transport");
    assert.ok((preferences as JsonObject[]).some((preference) => String(preference.content).includes("8000")));
    const plans = written.plans as JsonObject[];
    assert.equal(plans[0]?.status, "active");
    assert.ok((plans as JsonObject[]).some((plan) => plan.valid_until === "2026-10-07T23:59:59.000Z"));

    const recalled = f.adapter.recall({ scope: { scope_kind: "project", scope_id: "travel:trip-tokyo" },
      now: "2026-09-02T00:00:00.000Z" }) as JsonObject;
    assert.equal((recalled.items as JsonObject[]).some((item) => String(item.content).includes("东京")), true);
    const blocked = f.adapter.recall({ scope: { scope_kind: "project", scope_id: "travel:osaka" }, query: "东京" }) as JsonObject;
    assert.deepEqual(blocked.items, []);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("new plans supersede old ones and retain an audit record outside strong context", async () => {
  const f = await fixture();
  try {
    const original = remember(f.service, f.projectRoot, { content: "Tokyo trip: flight MU523", topic: "travel:plan" });
    const replacement = remember(f.service, f.projectRoot, { content: "Tokyo trip: flight CA929", topic: "travel:plan" });
    const superseded = f.adapter.supersede({ scope: { scope_kind: "project", scope_id: "travel:trip-tokyo" },
      previous_id: original.id, replacement_id: replacement.id, reason: "flight changed" }) as JsonObject;
    assert.equal((superseded.memory as JsonObject).status, "superseded");
    const audit = f.adapter.audit({ scope: { scope_kind: "project", scope_id: "travel:trip-tokyo" } }) as JsonObject;
    assert.equal((audit.items as JsonObject[]).length, 1);
    const recalled = f.adapter.recall({ scope: { scope_kind: "project", scope_id: "travel:trip-tokyo" },
      query: "flight", topic: "travel:plan", superseded_by: String(replacement.id) }) as JsonObject;
    assert.deepEqual(recalled.items, []);
    const withHistory = f.adapter.audit({ scope: { scope_kind: "project", scope_id: "travel:trip-tokyo" } }) as JsonObject;
    assert.equal((withHistory.items as JsonObject[]).some((item) => item.status === "superseded"), true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("stale plans are hidden by default and carry an advisory with include_stale", async () => {
  const f = await fixture();
  try {
    remember(f.service, f.projectRoot, { content: "Tokyo trip: stay in Shinjuku", valid_until: "2026-10-01T00:00:00.000Z" });
    const scope = { scope_kind: "project", scope_id: "travel:trip-tokyo" };
    const current = f.adapter.recall({ scope, query: "Shinjuku", now: "2026-09-30T00:00:00.000Z" }) as JsonObject;
    assert.equal((current.items as JsonObject[]).length, 1);
    const defaultStale = f.adapter.recall({ scope, query: "Shinjuku", now: "2026-10-02T00:00:00.000Z" }) as JsonObject;
    assert.deepEqual(defaultStale.items, []);
    assert.deepEqual((defaultStale.excluded as JsonObject[]).map((item) => item.reason), ["stale"]);
    const withStale = f.adapter.recall({ scope, query: "Shinjuku", now: "2026-10-02T00:00:00.000Z", include_stale: true }) as JsonObject;
    const stale = (withStale.items as JsonObject[])[0]!;
    assert.equal(stale.status, "stale");
    assert.equal(stale.advisory, "stale travel plan: do not treat as current fact");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("travel apply and forget stay inside the travel domain", async () => {
  const f = await fixture();
  try {
    const scope = { scope_kind: "project", scope_id: "travel:trip-tokyo" };
    const memory = remember(f.service, f.projectRoot, { content: "Tokyo trip: avoid night trains" });
    const applied = f.adapter.apply({ memory_id: memory.id, scope });
    assert.equal(applied.status, "applied");
    assert.equal(applied.domain, "travel");
    assert.equal((applied.memory as JsonObject).content, "Tokyo trip: avoid night trains");
    const neighbor = { kind: "project", id: "travel:neighbour" };
    assert.throws(() => f.adapter.apply({ memory_id: memory.id, scope: neighbor }), /not in scope/u);
    assert.throws(() => f.adapter.forget({ memory_id: memory.id, scope: neighbor }), /not in scope/u);
    const forgotten = f.adapter.forget({ scope, memory_id: memory.id }) as JsonObject;
    assert.equal((forgotten.memory as JsonObject).status, "revoked");
    assert.throws(() => f.adapter.apply({ scope, memory_id: memory.id }), /unavailable/u);
    const recalled = f.adapter.recall({ scope: { scope_kind: "project", scope_id: "travel:trip-tokyo" }, query: "night trains" }) as JsonObject;
    assert.deepEqual(recalled.items, []);
    const otherDomain = f.adapter.apply({ statement: "先打开文件，再选择模板", domain: "office",
      scope: { scope_kind: "project", scope_id: "travel:trip-tokyo" }, verification: "passed", evidence_ids: ["doc-1"] }) as JsonObject;
    assert.equal(otherDomain.status, "denied");
    assert.equal(otherDomain.reason, "domain isolation");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
