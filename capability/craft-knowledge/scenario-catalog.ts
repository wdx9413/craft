import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { stableDigest } from "../../common/craft-common-base/src/digest.ts";
import { scopeFromKey } from "../../common/craft-common-base/src/scope-policy.ts";

const SCHEMA = "craft.knowledge-scenario-catalog.v1";
const KEY = /^[a-z0-9][a-z0-9._/-]{0,95}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
type ClaimRef = { claim_id: string; source_id: string; evidence_ids: string[]; status: "candidate" | "reviewed" | "inactive" };
type Scenario = JsonObject & { scenario_key: string; tier: "coarse" | "fine"; parent_scenario_key?: string;
  lifecycle: "candidate" | "active" | "conflicted" | "retired"; claim_refs: ClaimRef[]; definition?: ScenarioDefinition };
type ScenarioDefinition = { summary: string; applies_when: string; excludes: string };
type ScenarioTransition = { request_id: string; action: "retire" | "propose_merge" | "propose_split"; scenario_key: string;
  source_keys?: string[]; target_keys?: string[]; proposal_digest?: string; previous_catalog_version: number; catalog_version: number; reason_digest: string };
type MigrationProposal = { request_id: string; mode: "merge" | "split"; source_keys: string[];
  targets: Array<{ scenario_key: string; definition: unknown }>; expected_catalog_version: number; reason: string };

export function validateKnowledgeScenarioDefinition(value: unknown): ScenarioDefinition | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Knowledge scenario definition is invalid");
  const item = value as JsonObject;
  for (const field of ["summary", "applies_when", "excludes"] as const) {
    if (typeof item[field] !== "string" || !String(item[field]).trim() || String(item[field]).length > 500) throw new Error("Knowledge scenario definition is invalid");
  }
  return { summary: String(item.summary).trim(), applies_when: String(item.applies_when).trim(), excludes: String(item.excludes).trim() };
}

/** Canonical project scopes carry their kind in the id (`project:<id>`); catalogs store only the id. */
export function knowledgeScenarioProjectId(value: string): string {
  const projectId = value.startsWith("project:") ? value.slice("project:".length) : value;
  if (!/^[A-Za-z0-9_-]{1,96}$/u.test(projectId)) throw new Error("Knowledge scenario project identity is invalid");
  return projectId;
}

function directory(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Knowledge scenario catalog path must contain regular directories");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(path, { mode: 0o700 });
  }
}

function readProjectCatalog(root: string, projectId: string): { catalog_version: number; scenarios: Scenario[]; transitions: ScenarioTransition[] } {
  let path = root;
  for (const part of ["", "projects", projectId]) {
    if (part) path = join(path, part);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Knowledge scenario catalog path must contain regular directories");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { catalog_version: 0, scenarios: [], transitions: [] };
      throw error;
    }
  }
  return readCatalog(join(path, "knowledge-scenarios.json"));
}

function readCatalog(path: string): { catalog_version: number; scenarios: Scenario[]; transitions: ScenarioTransition[] } {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { catalog_version: 0, scenarios: [], transitions: [] };
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 65_536) throw new Error("Knowledge scenario catalog is linked, non-regular, or oversized");
  const raw = JSON.parse(readFileSync(path, "utf8")) as JsonObject;
  if (raw.schema !== SCHEMA || !Array.isArray(raw.scenarios) || raw.scenarios.length > 64) throw new Error("Knowledge scenario catalog is invalid");
  if (raw.catalog_version !== undefined && (!Number.isSafeInteger(raw.catalog_version) || Number(raw.catalog_version) < 0)) throw new Error("Knowledge scenario catalog version is invalid");
  const scenarios: Scenario[] = [], seen = new Set<string>();
  for (const value of raw.scenarios) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Knowledge scenario entry is invalid");
    const item = value as JsonObject;
    if (typeof item.scenario_key !== "string" || !KEY.test(item.scenario_key) || seen.has(item.scenario_key)) throw new Error("Knowledge scenario key is invalid or duplicated");
    seen.add(item.scenario_key);
    const tier = item.tier === "coarse" ? "coarse" : item.tier === undefined || item.tier === "fine" ? "fine" : null;
    const parent = item.parent_scenario_key;
    if (!tier || (parent !== undefined && (typeof parent !== "string" || !KEY.test(parent) || parent === item.scenario_key))) throw new Error("Knowledge scenario hierarchy is invalid");
    const lifecycle = item.lifecycle === undefined || item.lifecycle === "active" ? "active" : item.lifecycle === "candidate" || item.lifecycle === "conflicted" || item.lifecycle === "retired" ? item.lifecycle : null;
    if (!lifecycle || !Array.isArray(item.claim_refs) || item.claim_refs.length > 2_000 || tier === "coarse" && parent !== undefined) throw new Error("Knowledge scenario lifecycle or references are invalid");
    const definition = validateKnowledgeScenarioDefinition(item.definition);
    const refs = item.claim_refs.map(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Knowledge scenario claim reference is invalid");
      const ref = value as JsonObject;
      if (typeof ref.claim_id !== "string" || !ref.claim_id || ref.claim_id.length > 200 || typeof ref.source_id !== "string" || !ref.source_id || ref.source_id.length > 200
        || !Array.isArray(ref.evidence_ids) || ref.evidence_ids.length > 100 || ref.evidence_ids.some(id => typeof id !== "string" || id.length > 200)
        || !["candidate", "reviewed", "inactive"].includes(String(ref.status))) throw new Error("Knowledge scenario claim reference is invalid");
      return ref as unknown as ClaimRef;
    });
    scenarios.push({ ...item, scenario_key: item.scenario_key, tier, ...(parent ? { parent_scenario_key: parent } : {}), ...(definition ? { definition } : {}), lifecycle, claim_refs: refs });
  }
  for (const item of scenarios) if (item.tier === "fine" && item.parent_scenario_key !== undefined
    && scenarios.find(parent => parent.scenario_key === item.parent_scenario_key)?.tier !== "coarse") throw new Error("Knowledge scenario parent must reference a coarse scene");
  const transitions = raw.transitions === undefined ? [] : raw.transitions;
  if (!Array.isArray(transitions) || transitions.length > 256 || transitions.some(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return true;
    const item = value as JsonObject;
    const migration = item.action === "propose_merge" || item.action === "propose_split";
    return typeof item.request_id !== "string" || !item.request_id || item.request_id.length > 200
      || (!migration && item.action !== "retire") || typeof item.scenario_key !== "string" || !KEY.test(item.scenario_key)
      || !Number.isSafeInteger(item.previous_catalog_version) || !Number.isSafeInteger(item.catalog_version)
      || typeof item.reason_digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(item.reason_digest)
      || migration && (!Array.isArray(item.source_keys) || item.source_keys.length < 1 || item.source_keys.length > 8
        || item.source_keys.some(key => typeof key !== "string" || !KEY.test(key))
        || !Array.isArray(item.target_keys) || item.target_keys.length < 1 || item.target_keys.length > 8
        || item.target_keys.some(key => typeof key !== "string" || !KEY.test(key))
        || typeof item.proposal_digest !== "string" || !DIGEST.test(item.proposal_digest));
  })) throw new Error("Knowledge scenario transitions are invalid");
  return { catalog_version: Number(raw.catalog_version ?? 0), scenarios, transitions: transitions as ScenarioTransition[] };
}

function upsert(scenarios: Scenario[], key: string, tier: "coarse" | "fine", parent: string | null): Scenario {
  const prior = scenarios.find(item => item.scenario_key === key);
  if (prior) {
    const existingParent = prior.parent_scenario_key ?? null;
    if (prior.tier !== tier || (existingParent !== null && parent !== null && existingParent !== parent)) prior.lifecycle = "conflicted";
    else if (existingParent === null && parent !== null) prior.parent_scenario_key = parent;
    return prior;
  }
  if (scenarios.length >= 64) throw new Error("Knowledge scenario catalog may contain at most 64 entries");
  const created: Scenario = { scenario_key: key, tier, ...(parent ? { parent_scenario_key: parent } : {}), lifecycle: "candidate", claim_refs: [] };
  scenarios.push(created);
  return created;
}

function persist(path: string, catalog: { catalog_version: number; scenarios: Scenario[]; transitions?: ScenarioTransition[] }): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    try { writeFileSync(descriptor, `${JSON.stringify({ schema: SCHEMA, ...catalog }, null, 2)}\n`, "utf8"); }
    finally { closeSync(descriptor); descriptor = undefined; }
    renameSync(temporary, path);
  } finally { try { unlinkSync(temporary); } catch { /* rename already consumed it */ } }
}

function withLock<T>(path: string, work: () => T): T {
  const lockPath = `${path}.lock`;
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try { descriptor = openSync(lockPath, "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = lstatSync(lockPath);
        if (!stat.isSymbolicLink() && stat.isFile() && Date.now() - stat.mtimeMs > 60_000) {
          const pid = Number(readFileSync(lockPath, "utf8"));
          let alive = Number.isSafeInteger(pid) && pid > 0;
          if (alive) try { process.kill(pid, 0); } catch (ownerError) { alive = (ownerError as NodeJS.ErrnoException).code !== "ESRCH"; }
          if (!alive) unlinkSync(lockPath);
        }
      } catch { /* A concurrent writer may release the lock while it is inspected. */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  if (descriptor === undefined) throw new Error("Knowledge scenario catalog is busy; retry the update");
  try { writeFileSync(descriptor, `${process.pid}\n`, "utf8"); return work(); }
  finally { closeSync(descriptor); unlinkSync(lockPath); }
}

/** Persist only model-supplied classification and claim/evidence references, never knowledge bodies. */
export function recordKnowledgeScenario(args: { knowledge_dir: string; project_id: string; scenario_key: string; coarse_scenario_key?: string;
  claim_id: string; source_id: string; evidence_ids: string[]; status: "candidate" | "reviewed" | "inactive"; definition?: unknown; coarse_definition?: unknown }): JsonObject {
  const { knowledge_dir: root, scenario_key: fineKey, coarse_scenario_key: coarseKey } = args;
  const projectId = knowledgeScenarioProjectId(args.project_id);
  const definition = validateKnowledgeScenarioDefinition(args.definition);
  const coarseDefinition = validateKnowledgeScenarioDefinition(args.coarse_definition);
  if (!KEY.test(fineKey) || (coarseKey !== undefined && (!KEY.test(coarseKey) || coarseKey === fineKey))
    || !args.claim_id || args.claim_id.length > 200 || !args.source_id || args.source_id.length > 200
    || !Array.isArray(args.evidence_ids) || args.evidence_ids.length > 100 || args.evidence_ids.some(id => typeof id !== "string" || id.length > 200)
    || !["candidate", "reviewed", "inactive"].includes(args.status)) throw new Error("Knowledge scenario classification identity is invalid");
  directory(root);
  const projects = join(root, "projects"); directory(projects);
  const project = join(projects, projectId); directory(project);
  const path = join(project, "knowledge-scenarios.json");
  return withLock(path, () => {
    const catalog = readCatalog(path);
    if (catalog.scenarios.some(item => item.scenario_key === fineKey && item.lifecycle === "retired")
      || coarseKey && catalog.scenarios.some(item => item.scenario_key === coarseKey && item.lifecycle === "retired")) {
      throw new Error("Knowledge scenario is retired and cannot receive new classifications");
    }
    const requestedCoarse = coarseKey ? upsert(catalog.scenarios, coarseKey, "coarse", null) : null;
    if (requestedCoarse && coarseDefinition) {
      if (requestedCoarse.definition && JSON.stringify(requestedCoarse.definition) !== JSON.stringify(coarseDefinition)) requestedCoarse.lifecycle = "conflicted";
      else if (!requestedCoarse.definition) requestedCoarse.definition = coarseDefinition;
    }
    const parent = requestedCoarse?.tier === "coarse" ? requestedCoarse.scenario_key : null;
    const fine = upsert(catalog.scenarios, fineKey, "fine", parent);
    if (definition) {
      if (fine.definition && JSON.stringify(fine.definition) !== JSON.stringify(definition)) fine.lifecycle = "conflicted";
      else if (!fine.definition) fine.definition = definition;
    }
    const coarse = fine.parent_scenario_key ? catalog.scenarios.find(item => item.scenario_key === fine.parent_scenario_key) : undefined;
    if (requestedCoarse?.lifecycle === "conflicted" || coarse?.lifecycle === "conflicted") fine.lifecycle = "conflicted";
    const prior = fine.claim_refs.find(ref => ref.claim_id === args.claim_id);
    const reference: ClaimRef = { claim_id: args.claim_id, source_id: args.source_id, evidence_ids: [...new Set(args.evidence_ids)], status: args.status };
    if (prior) Object.assign(prior, reference); else fine.claim_refs.push(reference);
    fine.claim_refs.sort((left, right) => left.claim_id.localeCompare(right.claim_id));
    const reviewedSources = new Set(fine.claim_refs.filter(ref => ref.status === "reviewed").map(ref => ref.source_id));
    if (fine.lifecycle !== "conflicted") fine.lifecycle = reviewedSources.size >= 2 ? "active" : "candidate";
    if (coarse) {
      const children = catalog.scenarios.filter(item => item.tier === "fine" && item.parent_scenario_key === coarseKey && item.lifecycle === "active");
      if (coarse.lifecycle !== "conflicted") coarse.lifecycle = children.length >= 2 ? "active" : "candidate";
    }
    catalog.scenarios.sort((left, right) => left.scenario_key.localeCompare(right.scenario_key));
    catalog.catalog_version += 1;
    persist(path, catalog);
    return { status: fine.lifecycle, scenario_key: fineKey, coarse_scenario_key: fine.parent_scenario_key ?? null, catalog_version: catalog.catalog_version,
      catalog_path: path, reviewed_source_count: reviewedSources.size, claim_ref_count: fine.claim_refs.length, ...(coarse ? { coarse_lifecycle: coarse.lifecycle } : {}) };
  });
}

/** Retire one project scene without deleting its evidence references or history. */
export function retireKnowledgeScenario(args: { knowledge_dir: string; project_id: string; scenario_key: string;
  expected_catalog_version: number; request_id: string; reason: string }): JsonObject {
  const projectId = knowledgeScenarioProjectId(args.project_id), key = args.scenario_key;
  const reason = args.reason.trim();
  if (!KEY.test(key) || !Number.isSafeInteger(args.expected_catalog_version) || args.expected_catalog_version < 0
    || !args.request_id.trim() || args.request_id.length > 200 || !reason || reason.length > 500) {
    throw new Error("Knowledge scenario retirement request is invalid");
  }
  directory(args.knowledge_dir);
  const projects = join(args.knowledge_dir, "projects"); directory(projects);
  const project = join(projects, projectId); directory(project);
  const path = join(project, "knowledge-scenarios.json");
  return withLock(path, () => {
    const catalog = readCatalog(path), reasonDigest = stableDigest(reason);
    const prior = catalog.transitions.find(item => item.request_id === args.request_id);
    if (prior) {
      if (prior.action !== "retire" || prior.scenario_key !== key || prior.reason_digest !== reasonDigest) throw new Error("Knowledge scenario retirement request id conflicts");
      return { status: "retired", scenario_key: key, catalog_version: prior.catalog_version, transition: prior, idempotent: true };
    }
    if (catalog.catalog_version !== args.expected_catalog_version) throw new Error("Knowledge scenario catalog version changed; reread before retrying");
    const scenario = catalog.scenarios.find(item => item.scenario_key === key);
    if (!scenario) throw new Error("Knowledge scenario does not exist");
    if (scenario.lifecycle === "retired") throw new Error("Knowledge scenario is already retired");
    if (scenario.tier === "coarse" && catalog.scenarios.some(item => item.tier === "fine" && item.parent_scenario_key === key && item.lifecycle !== "retired")) {
      throw new Error("Retire all child Knowledge scenarios before retiring their coarse scene");
    }
    const previous = catalog.catalog_version;
    scenario.lifecycle = "retired";
    if (scenario.tier === "fine" && scenario.parent_scenario_key) {
      const parent = catalog.scenarios.find(item => item.scenario_key === scenario.parent_scenario_key);
      if (parent && parent.lifecycle !== "conflicted" && parent.lifecycle !== "retired") {
        const activeChildren = catalog.scenarios.filter(item => item.tier === "fine" && item.parent_scenario_key === parent.scenario_key && item.lifecycle === "active");
        parent.lifecycle = activeChildren.length >= 2 ? "active" : "candidate";
      }
    }
    catalog.catalog_version += 1;
    const transition: ScenarioTransition = { request_id: args.request_id, action: "retire", scenario_key: key,
      previous_catalog_version: previous, catalog_version: catalog.catalog_version, reason_digest: reasonDigest };
    catalog.transitions.push(transition);
    persist(path, catalog);
    return { status: "retired", scenario_key: key, catalog_version: catalog.catalog_version, transition, idempotent: false };
  });
}

/** Record a model-proposed merge/split as new candidate scenes; source scenes stay live until targets earn evidence. */
export function proposeKnowledgeScenarioMigration(args: MigrationProposal & { knowledge_dir: string; project_id: string }): JsonObject {
  const projectId = knowledgeScenarioProjectId(args.project_id), reason = args.reason.trim();
  if (!Array.isArray(args.source_keys) || !Array.isArray(args.targets)) throw new Error("Knowledge scenario migration proposal is invalid");
  const sources = [...new Set(args.source_keys)], targets = args.targets;
  if ((args.mode !== "merge" && args.mode !== "split") || !Number.isSafeInteger(args.expected_catalog_version) || args.expected_catalog_version < 0
    || !args.request_id.trim() || args.request_id.length > 200 || !reason || reason.length > 500
    || sources.length !== args.source_keys.length || sources.some(key => !KEY.test(key))
    || args.mode === "merge" && (sources.length < 2 || targets.length !== 1)
    || args.mode === "split" && (sources.length !== 1 || targets.length < 2 || targets.length > 8)
    || targets.length > 8) throw new Error("Knowledge scenario migration proposal is invalid");
  const targetKeys = targets.map(target => target.scenario_key);
  if (new Set(targetKeys).size !== targetKeys.length || targetKeys.some(key => !KEY.test(key) || sources.includes(key))) {
    throw new Error("Knowledge scenario migration targets are invalid");
  }
  const definitions = targets.map(target => validateKnowledgeScenarioDefinition(target.definition));
  if (definitions.some(definition => !definition)) throw new Error("Knowledge scenario migration requires a definition for every target");
  directory(args.knowledge_dir);
  const projects = join(args.knowledge_dir, "projects"); directory(projects);
  const project = join(projects, projectId); directory(project);
  const path = join(project, "knowledge-scenarios.json");
  return withLock(path, () => {
    const catalog = readCatalog(path);
    const proposalDigest = stableDigest({ mode: args.mode, source_keys: sources,
      targets: targets.map((target, index) => ({ scenario_key: target.scenario_key, definition: definitions[index] })) });
    const reasonDigest = stableDigest(reason), action: ScenarioTransition["action"] = args.mode === "merge" ? "propose_merge" : "propose_split";
    const prior = catalog.transitions.find(item => item.request_id === args.request_id);
    if (prior) {
      if (prior.action !== action || prior.reason_digest !== reasonDigest || prior.proposal_digest !== proposalDigest) {
        throw new Error("Knowledge scenario migration request id conflicts");
      }
      return { status: "candidate", catalog_version: prior.catalog_version, transition: prior, idempotent: true };
    }
    if (catalog.catalog_version !== args.expected_catalog_version) throw new Error("Knowledge scenario catalog version changed; reread before retrying");
    const sourceNodes = sources.map(key => catalog.scenarios.find(node => node.scenario_key === key));
    if (sourceNodes.some(node => !node || node.tier !== "fine" || node.lifecycle === "retired")) throw new Error("Knowledge migration sources must be existing, live fine scenes");
    if (catalog.scenarios.length + targets.length > 64 || targets.some(target => catalog.scenarios.some(node => node.scenario_key === target.scenario_key))) {
      throw new Error("Knowledge migration targets must be new keys within the catalog limit");
    }
    const previous = catalog.catalog_version;
    for (const [index, target] of targets.entries()) catalog.scenarios.push({ scenario_key: target.scenario_key, tier: "fine",
      lifecycle: "candidate", claim_refs: [], definition: definitions[index]!, proposed_migration: { mode: args.mode, source_keys: sources,
        request_id: args.request_id } });
    catalog.scenarios.sort((left, right) => left.scenario_key.localeCompare(right.scenario_key));
    catalog.catalog_version += 1;
    const transition = { request_id: args.request_id, action, scenario_key: sources[0]!, source_keys: sources,
      target_keys: targetKeys, previous_catalog_version: previous, catalog_version: catalog.catalog_version,
      reason_digest: reasonDigest, proposal_digest: proposalDigest };
    catalog.transitions.push(transition);
    persist(path, catalog);
    return { status: "candidate", catalog_version: catalog.catalog_version, transition, target_keys: targetKeys, idempotent: false };
  });
}

export function knowledgeScenarioCanClassify(knowledgeDir: string, projectId: string, scenarioKey: string): boolean {
  if (!KEY.test(scenarioKey)) return false;
  const normalizedProjectId = knowledgeScenarioProjectId(projectId);
  const entry = readProjectCatalog(knowledgeDir, normalizedProjectId).scenarios.find(item => item.scenario_key === scenarioKey);
  return !entry || entry.lifecycle === "candidate" || entry.lifecycle === "active";
}

export function updateKnowledgeScenarioClaim(knowledgeDir: string, claim: JsonObject, status?: "candidate" | "reviewed" | "inactive"): JsonObject | null {
  if (typeof claim.scenario_key !== "string") return null;
  const scope = scopeFromKey(String(claim.scope ?? "global"));
  if (scope.kind !== "project") return null;
  const evidenceIds = Array.isArray(claim.evidence_ids) ? claim.evidence_ids.map(String) : [];
  return recordKnowledgeScenario({ knowledge_dir: knowledgeDir, project_id: scope.id, scenario_key: claim.scenario_key,
    ...(typeof claim.coarse_scenario_key === "string" ? { coarse_scenario_key: claim.coarse_scenario_key } : {}), claim_id: String(claim.id),
    source_id: String(claim.source_id ?? "unknown"), evidence_ids: evidenceIds, status: status ?? (claim.status === "reviewed" ? "reviewed" : claim.status === "candidate" ? "candidate" : "inactive"),
    ...(claim.scenario_definition !== undefined ? { definition: claim.scenario_definition } : {}),
    ...(claim.coarse_scenario_definition !== undefined ? { coarse_definition: claim.coarse_scenario_definition } : {}) });
}

export function knowledgeScenarioIsActive(knowledgeDir: string, projectId: string, scenarioKey: string): boolean {
  if (!KEY.test(scenarioKey)) return false;
  let normalizedProjectId: string;
  try { normalizedProjectId = knowledgeScenarioProjectId(projectId); } catch { return false; }
  const entry = readProjectCatalog(knowledgeDir, normalizedProjectId).scenarios.find(item => item.scenario_key === scenarioKey);
  return entry?.lifecycle === "active";
}

/** Return the bounded, body-free taxonomy a Host model should consult before classifying a Claim. */
export function listKnowledgeScenarios(knowledgeDir: string, projectId: string): JsonObject {
  const catalog = readProjectCatalog(knowledgeDir, knowledgeScenarioProjectId(projectId));
  return { catalog_version: catalog.catalog_version, scenarios: catalog.scenarios.map(item => ({ scenario_key: item.scenario_key,
    tier: item.tier, ...(item.parent_scenario_key ? { parent_scenario_key: item.parent_scenario_key } : {}), lifecycle: item.lifecycle,
    ...(item.definition ? { definition: item.definition } : {}),
    ...(item.proposed_migration ? { proposed_migration: item.proposed_migration } : {}),
    reviewed_source_count: new Set(item.claim_refs.filter(ref => ref.status === "reviewed").map(ref => ref.source_id)).size,
    claim_ref_count: item.claim_refs.length,
    ...(item.tier === "coarse" ? { active_fine_child_count: catalog.scenarios.filter(child => child.tier === "fine"
      && child.parent_scenario_key === item.scenario_key && child.lifecycle === "active").length } : {}) })),
    ...(catalog.transitions.length ? { transitions: catalog.transitions } : {}) };
}
