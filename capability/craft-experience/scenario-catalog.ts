import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { stableDigest } from "../../common/craft-common-base/src/digest.ts";

const SCHEMA = "craft.experience-scenario-catalog.v1";
const KEY = /^[a-z0-9][a-z0-9._/-]{0,95}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu;
type ScenarioNode = JsonObject & { scenario_key: string; tier: "coarse" | "fine"; verification_commands: string[]; verification_digests: string[]; observation_refs: string[]; verified_task_digests: string[]; lifecycle: "candidate" | "active" | "conflicted" | "retired" };
type ScenarioDefinition = { summary: string; applies_when: string; excludes: string };
type ScenarioTransition = { request_id: string; action: "retire" | "propose_merge" | "propose_split"; scenario_key: string;
  source_keys?: string[]; target_keys?: string[]; proposal_digest?: string; previous_catalog_version: number; catalog_version: number; reason_digest: string };
type MigrationProposal = { request_id: string; mode: "merge" | "split"; source_keys: string[];
  targets: Array<{ scenario_key: string; definition: unknown }>; expected_catalog_version: number; reason: string };

export function validateExperienceScenarioDefinition(value: unknown): ScenarioDefinition | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Experience scenario definition is invalid");
  const item = value as JsonObject;
  for (const field of ["summary", "applies_when", "excludes"] as const) {
    if (typeof item[field] !== "string" || !String(item[field]).trim() || String(item[field]).length > 500 || SECRET.test(String(item[field]))) throw new Error("Experience scenario definition is invalid");
  }
  return { summary: String(item.summary).trim(), applies_when: String(item.applies_when).trim(), excludes: String(item.excludes).trim() };
}

function directory(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Experience scenario catalog path must contain regular directories");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(path, { mode: 0o700 });
  }
}

function readCatalog(path: string): { catalog_version: number; scenarios: ScenarioNode[]; transitions: ScenarioTransition[] } {
  if (!existsSync(path)) return { catalog_version: 0, scenarios: [], transitions: [] };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16_384) throw new Error("Experience scenario catalog is linked, non-regular, or oversized");
  const raw = JSON.parse(readFileSync(path, "utf8")) as JsonObject;
  if (raw.schema !== SCHEMA || !Array.isArray(raw.scenarios) || raw.scenarios.length > 64) throw new Error("Experience scenario catalog is invalid");
  if (raw.catalog_version !== undefined && (!Number.isSafeInteger(raw.catalog_version) || Number(raw.catalog_version) < 0)) throw new Error("Experience scenario catalog version is invalid");
  const scenarios: ScenarioNode[] = [];
  const seen = new Set<string>();
  for (const value of raw.scenarios) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Experience scenario catalog entry is invalid");
    const node = value as JsonObject;
    if (typeof node.scenario_key !== "string" || !KEY.test(node.scenario_key)) throw new Error("Experience scenario key is invalid");
    if (seen.has(node.scenario_key)) throw new Error("Experience scenario catalog contains duplicate keys");
    seen.add(node.scenario_key);
    const tier = node.tier === undefined || node.tier === "fine" ? "fine" : node.tier === "coarse" ? "coarse" : null;
    if (!tier) throw new Error("Experience scenario tier is invalid");
    const parent = node.parent_scenario_key === undefined ? null : node.parent_scenario_key;
    if (parent !== null && (typeof parent !== "string" || !KEY.test(parent) || parent === node.scenario_key)) throw new Error("Experience scenario parent is invalid");
    const commands = node.verification_commands === undefined ? [] : node.verification_commands;
    if (!Array.isArray(commands) || commands.length > 32 || commands.some(item => typeof item !== "string" || item.length > 500)) throw new Error("Experience scenario verifier commands are invalid");
    const digests = node.verification_digests === undefined ? [] : node.verification_digests;
    if (!Array.isArray(digests) || digests.length > 32 || digests.some(item => typeof item !== "string" || !DIGEST.test(item))) throw new Error("Experience scenario verifier digests are invalid");
    const refs = node.observation_refs === undefined ? [] : node.observation_refs;
    if (!Array.isArray(refs) || refs.length > 1_000 || refs.some(item => typeof item !== "string" || item.length > 200)) throw new Error("Experience scenario observation refs are invalid");
    const taskDigests = node.verified_task_digests === undefined ? [] : node.verified_task_digests;
    if (!Array.isArray(taskDigests) || taskDigests.length > 2 || taskDigests.some(item => typeof item !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(item))) throw new Error("Experience scenario verified task references are invalid");
    const lifecycle = node.lifecycle === undefined || node.lifecycle === "active" ? "active"
      : node.lifecycle === "candidate" || node.lifecycle === "conflicted" || node.lifecycle === "retired" ? node.lifecycle : null;
    if (!lifecycle || tier === "coarse" && (parent !== null || commands.length > 0 || node.evaluation !== undefined)) throw new Error("Experience scenario entry is invalid");
    const definition = validateExperienceScenarioDefinition(node.definition);
    scenarios.push({ ...node, tier, scenario_key: node.scenario_key, verification_commands: commands,
      ...(definition ? { definition } : {}), verification_digests: digests, observation_refs: [...new Set(refs as string[])],
      verified_task_digests: [...new Set(taskDigests as string[])], lifecycle });
  }
  for (const node of scenarios) if (node.tier === "fine" && node.parent_scenario_key !== undefined
    && scenarios.find(parent => parent.scenario_key === node.parent_scenario_key)?.tier !== "coarse") throw new Error("Experience scenario parent must reference one coarse scene");
  const transitions = raw.transitions === undefined ? [] : raw.transitions;
  if (!Array.isArray(transitions) || transitions.length > 256 || transitions.some(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return true;
    const item = value as JsonObject;
    const migration = item.action === "propose_merge" || item.action === "propose_split";
    return typeof item.request_id !== "string" || !item.request_id || item.request_id.length > 200
      || (!migration && item.action !== "retire") || typeof item.scenario_key !== "string" || !KEY.test(item.scenario_key)
      || !Number.isSafeInteger(item.previous_catalog_version) || !Number.isSafeInteger(item.catalog_version)
      || typeof item.reason_digest !== "string" || !DIGEST.test(item.reason_digest)
      || migration && (!Array.isArray(item.source_keys) || item.source_keys.length < 1 || item.source_keys.length > 8
        || item.source_keys.some(key => typeof key !== "string" || !KEY.test(key))
        || !Array.isArray(item.target_keys) || item.target_keys.length < 1 || item.target_keys.length > 8
        || item.target_keys.some(key => typeof key !== "string" || !KEY.test(key))
        || typeof item.proposal_digest !== "string" || !DIGEST.test(item.proposal_digest));
  })) throw new Error("Experience scenario transitions are invalid");
  return { catalog_version: Number(raw.catalog_version ?? 0), scenarios, transitions: transitions as ScenarioTransition[] };
}

function upsert(nodes: ScenarioNode[], key: string, tier: "coarse" | "fine", parent: string | null,
  observationId: string, verifierDigest: string | null, verifiedTaskDigest: string | null): ScenarioNode {
  let node = nodes.find(item => item.scenario_key === key);
  if (node) {
    const existingParent = node.parent_scenario_key ?? null;
    if (node.tier !== tier || (existingParent !== null && parent !== null && existingParent !== parent)) {
      node.lifecycle = "conflicted";
      return node;
    }
    if (existingParent === null && parent !== null) node.parent_scenario_key = parent;
  }
  if (!node) {
    if (nodes.length >= 64) throw new Error("Experience scenario catalog may contain at most 64 entries");
    node = { scenario_key: key, tier, ...(parent ? { parent_scenario_key: parent } : {}),
      verification_commands: [], verification_digests: [], observation_refs: [], verified_task_digests: [], lifecycle: "candidate" };
    nodes.push(node);
  }
  if (!node.observation_refs.includes(observationId)) node.observation_refs.push(observationId);
  if (verifierDigest && !node.verification_digests.includes(verifierDigest)) node.verification_digests.push(verifierDigest);
  // Two independently verified tasks are enough to activate a fine scene;
  // retain only the threshold proof so this index stays bounded over time.
  if (verifiedTaskDigest && node.verified_task_digests.length < 2 && !node.verified_task_digests.includes(verifiedTaskDigest)) node.verified_task_digests.push(verifiedTaskDigest);
  return node;
}

function persist(path: string, catalog: { catalog_version: number; scenarios: ScenarioNode[]; transitions?: ScenarioTransition[] }): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    try { writeFileSync(descriptor, `${JSON.stringify({ schema: SCHEMA, ...catalog }, null, 2)}\n`, "utf8"); }
    finally { closeSync(descriptor); descriptor = undefined; }
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* rename already consumed it */ }
  }
}

function withCatalogLock<T>(path: string, work: () => T): T {
  const lockPath = `${path}.lock`;
  let lock: number | undefined;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      lock = openSync(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const metadata = lstatSync(lockPath);
        if (!metadata.isSymbolicLink() && metadata.isFile() && Date.now() - metadata.mtimeMs > 60_000) {
          const owner = Number(readFileSync(lockPath, "utf8"));
          let alive = Number.isSafeInteger(owner) && owner > 0;
          if (alive) {
            try { process.kill(owner, 0); } catch (ownerError) {
              alive = (ownerError as NodeJS.ErrnoException).code !== "ESRCH";
            }
          }
          if (!alive) unlinkSync(lockPath);
        }
      } catch { /* Another writer may release the lock after the exclusive-create check. */ }
      const wait = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(wait, 0, 0, 10);
    }
  }
  if (lock === undefined) throw new Error("Experience scenario catalog is busy; retry the observation");
  try {
    writeFileSync(lock, `${process.pid}\n`, "utf8");
    return work();
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

/** Persist a model-supplied fine/coarse classification under the Experience data root. */
export function recordExperienceScenario(args: { experience_dir: string; project_id: string; scenario_key: string; coarse_scenario_key?: string;
  observation_id: string; verified_task_id: string; verifier_digest?: string; definition?: unknown; coarse_definition?: unknown }): JsonObject {
  const { experience_dir: root, project_id: projectId, scenario_key: fineKey, coarse_scenario_key: coarseKey,
    observation_id: observationId, verified_task_id: verifiedTaskId, verifier_digest: verifierDigest } = args;
  if (!/^[A-Za-z0-9_-]{1,96}$/u.test(projectId) || !KEY.test(fineKey) || (coarseKey !== undefined && (!KEY.test(coarseKey) || coarseKey === fineKey))
    || !observationId || observationId.length > 200 || typeof verifiedTaskId !== "string" || !verifiedTaskId.trim() || verifiedTaskId.length > 200
    || (verifierDigest !== undefined && !DIGEST.test(verifierDigest))) throw new Error("Experience scenario classification identity is invalid");
  const definition = validateExperienceScenarioDefinition(args.definition);
  const coarseDefinition = validateExperienceScenarioDefinition(args.coarse_definition);
  directory(root);
  const projects = join(root, "projects"); directory(projects);
  const project = join(projects, projectId); directory(project);
  const path = join(project, "experience-scenarios.json");
  return withCatalogLock(path, () => {
    const catalog = readCatalog(path);
    if (catalog.scenarios.some(item => item.scenario_key === fineKey && item.lifecycle === "retired")
      || coarseKey && catalog.scenarios.some(item => item.scenario_key === coarseKey && item.lifecycle === "retired")) {
      throw new Error("Experience scenario is retired and cannot receive new observations");
    }
    const verifiedTaskDigest = stableDigest({ verified_task_id: verifiedTaskId });
    const requestedCoarse = coarseKey ? upsert(catalog.scenarios, coarseKey, "coarse", null, observationId, null, null) : null;
    if (requestedCoarse && coarseDefinition) {
      if (requestedCoarse.definition && JSON.stringify(requestedCoarse.definition) !== JSON.stringify(coarseDefinition)) requestedCoarse.lifecycle = "conflicted";
      else if (!requestedCoarse.definition) requestedCoarse.definition = coarseDefinition;
    }
    const parentKey = requestedCoarse?.tier === "coarse" ? requestedCoarse.scenario_key : null;
    const fine = upsert(catalog.scenarios, fineKey, "fine", parentKey, observationId, verifierDigest ?? null, verifiedTaskDigest);
    if (definition) {
      if (fine.definition && JSON.stringify(fine.definition) !== JSON.stringify(definition)) fine.lifecycle = "conflicted";
      else if (!fine.definition) fine.definition = definition;
    }
    const coarse = fine.parent_scenario_key ? catalog.scenarios.find(node => node.scenario_key === fine.parent_scenario_key) : undefined;
    fine.lifecycle = fine.lifecycle === "conflicted" || requestedCoarse?.lifecycle === "conflicted" || coarse?.lifecycle === "conflicted" ? "conflicted"
      : fine.lifecycle === "active" || fine.verified_task_digests.length >= 2 ? "active" : "candidate";
    if (coarse) {
      const distinctFineChildren = catalog.scenarios.filter(node => node.tier === "fine" && node.parent_scenario_key === coarseKey
        && node.lifecycle === "active" && node.verified_task_digests.length >= 2);
      coarse.lifecycle = coarse.lifecycle === "conflicted" ? "conflicted" : coarse.lifecycle === "active" || distinctFineChildren.length >= 2 ? "active" : "candidate";
    }
    catalog.scenarios.sort((left, right) => left.scenario_key.localeCompare(right.scenario_key));
    catalog.catalog_version += 1;
    persist(path, catalog);
    return { status: fine.lifecycle, scenario_key: fineKey, coarse_scenario_key: fine.parent_scenario_key ?? null,
      catalog_version: catalog.catalog_version, catalog_path: path, observation_count: fine.observation_refs.length,
      verified_task_count: fine.verified_task_digests.length, verification_digest_recorded: Boolean(verifierDigest), ...(coarse ? { coarse_lifecycle: coarse.lifecycle } : {}) };
  });
}

/** Retire one project scene without deleting its observation or verifier references. */
export function retireExperienceScenario(args: { experience_dir: string; project_id: string; scenario_key: string;
  expected_catalog_version: number; request_id: string; reason: string }): JsonObject {
  const { experience_dir: root, project_id: projectId, scenario_key: key } = args;
  const reason = args.reason.trim();
  if (!/^[A-Za-z0-9_-]{1,96}$/u.test(projectId) || !KEY.test(key) || !Number.isSafeInteger(args.expected_catalog_version)
    || args.expected_catalog_version < 0 || !args.request_id.trim() || args.request_id.length > 200 || !reason || reason.length > 500) {
    throw new Error("Experience scenario retirement request is invalid");
  }
  directory(root);
  const projects = join(root, "projects"); directory(projects);
  const project = join(projects, projectId); directory(project);
  const path = join(project, "experience-scenarios.json");
  return withCatalogLock(path, () => {
    const catalog = readCatalog(path), reasonDigest = stableDigest(reason);
    const prior = catalog.transitions.find(item => item.request_id === args.request_id);
    if (prior) {
      if (prior.action !== "retire" || prior.scenario_key !== key || prior.reason_digest !== reasonDigest) throw new Error("Experience scenario retirement request id conflicts");
      return { status: "retired", scenario_key: key, catalog_version: prior.catalog_version, transition: prior, idempotent: true };
    }
    if (catalog.catalog_version !== args.expected_catalog_version) throw new Error("Experience scenario catalog version changed; reread before retrying");
    const scenario = catalog.scenarios.find(item => item.scenario_key === key);
    if (!scenario) throw new Error("Experience scenario does not exist");
    if (scenario.lifecycle === "retired") throw new Error("Experience scenario is already retired");
    if (scenario.tier === "coarse" && catalog.scenarios.some(item => item.tier === "fine" && item.parent_scenario_key === key && item.lifecycle !== "retired")) {
      throw new Error("Retire all child Experience scenarios before retiring their coarse scene");
    }
    const previous = catalog.catalog_version;
    scenario.lifecycle = "retired";
    if (scenario.tier === "fine" && scenario.parent_scenario_key) {
      const parent = catalog.scenarios.find(item => item.scenario_key === scenario.parent_scenario_key);
      if (parent && parent.lifecycle !== "conflicted" && parent.lifecycle !== "retired") {
        const activeChildren = catalog.scenarios.filter(item => item.tier === "fine" && item.parent_scenario_key === parent.scenario_key
          && item.lifecycle === "active" && item.verified_task_digests.length >= 2);
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

/** Record model-proposed taxonomy changes as new candidate scenes; existing scenes remain usable during reclassification. */
export function proposeExperienceScenarioMigration(args: MigrationProposal & { experience_dir: string; project_id: string }): JsonObject {
  const reason = args.reason.trim(), sources = Array.isArray(args.source_keys) ? [...new Set(args.source_keys)] : [], targets = args.targets;
  if (!/^[A-Za-z0-9_-]{1,96}$/u.test(args.project_id) || !Array.isArray(args.source_keys) || !Array.isArray(targets)
    || (args.mode !== "merge" && args.mode !== "split") || !Number.isSafeInteger(args.expected_catalog_version) || args.expected_catalog_version < 0
    || !args.request_id.trim() || args.request_id.length > 200 || !reason || reason.length > 500
    || sources.length !== args.source_keys.length || sources.some(key => !KEY.test(key))
    || args.mode === "merge" && (sources.length < 2 || targets.length !== 1)
    || args.mode === "split" && (sources.length !== 1 || targets.length < 2 || targets.length > 8) || targets.length > 8) {
    throw new Error("Experience scenario migration proposal is invalid");
  }
  const targetKeys = targets.map(target => target.scenario_key);
  if (new Set(targetKeys).size !== targetKeys.length || targetKeys.some(key => !KEY.test(key) || sources.includes(key))) {
    throw new Error("Experience scenario migration targets are invalid");
  }
  const definitions = targets.map(target => validateExperienceScenarioDefinition(target.definition));
  if (definitions.some(definition => !definition)) throw new Error("Experience scenario migration requires a definition for every target");
  directory(args.experience_dir);
  const projects = join(args.experience_dir, "projects"); directory(projects);
  const project = join(projects, args.project_id); directory(project);
  const path = join(project, "experience-scenarios.json");
  return withCatalogLock(path, () => {
    const catalog = readCatalog(path);
    const proposalDigest = stableDigest({ mode: args.mode, source_keys: sources,
      targets: targets.map((target, index) => ({ scenario_key: target.scenario_key, definition: definitions[index] })) });
    const reasonDigest = stableDigest(reason), action: ScenarioTransition["action"] = args.mode === "merge" ? "propose_merge" : "propose_split";
    const prior = catalog.transitions.find(item => item.request_id === args.request_id);
    if (prior) {
      if (prior.action !== action || prior.reason_digest !== reasonDigest || prior.proposal_digest !== proposalDigest) {
        throw new Error("Experience scenario migration request id conflicts");
      }
      return { status: "candidate", catalog_version: prior.catalog_version, transition: prior, idempotent: true };
    }
    if (catalog.catalog_version !== args.expected_catalog_version) throw new Error("Experience scenario catalog version changed; reread before retrying");
    const sourceNodes = sources.map(key => catalog.scenarios.find(node => node.scenario_key === key));
    if (sourceNodes.some(node => !node || node.tier !== "fine" || node.lifecycle === "retired")) throw new Error("Experience migration sources must be existing, live fine scenes");
    if (catalog.scenarios.length + targets.length > 64 || targets.some(target => catalog.scenarios.some(node => node.scenario_key === target.scenario_key))) {
      throw new Error("Experience migration targets must be new keys within the catalog limit");
    }
    const previous = catalog.catalog_version;
    for (const [index, target] of targets.entries()) catalog.scenarios.push({ scenario_key: target.scenario_key, tier: "fine",
      verification_commands: [], verification_digests: [], observation_refs: [], verified_task_digests: [], lifecycle: "candidate",
      definition: definitions[index]!, proposed_migration: { mode: args.mode, source_keys: sources, request_id: args.request_id } });
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

export function experienceScenarioCanClassify(experienceDir: string, projectId: string, scenarioKey: string): boolean {
  if (!/^[A-Za-z0-9_-]{1,96}$/u.test(projectId) || !KEY.test(scenarioKey)) return false;
  const entry = (listExperienceScenarios(experienceDir, projectId).scenarios as JsonObject[]).find(item => item.scenario_key === scenarioKey);
  return !entry || entry.lifecycle === "candidate" || entry.lifecycle === "active";
}

/** A retired scene remains visible for history but cannot route or qualify a Procedure. */
export function experienceScenarioIsRetired(experienceDir: string, projectId: string, scenarioKey: string): boolean {
  if (!/^[A-Za-z0-9_-]{1,96}$/u.test(projectId) || !KEY.test(scenarioKey)) return false;
  const entry = (listExperienceScenarios(experienceDir, projectId).scenarios as JsonObject[]).find(item => item.scenario_key === scenarioKey);
  return entry?.lifecycle === "retired";
}

/** List one project's body-free scene taxonomy without creating directories or catalog files. */
export function listExperienceScenarios(experienceDir: string, projectId: string): JsonObject {
  if (!/^[A-Za-z0-9_-]{1,96}$/u.test(projectId)) throw new Error("Experience scenario project identity is invalid");
  let current = experienceDir;
  for (const part of ["", "projects", projectId]) {
    if (part) current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Experience scenario catalog path must contain regular directories");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { catalog_version: 0, scenarios: [] };
      throw error;
    }
  }
  const catalog = readCatalog(join(current, "experience-scenarios.json"));
  const scenarios = catalog.scenarios.map(node => ({ scenario_key: node.scenario_key, tier: node.tier,
    ...(node.parent_scenario_key ? { parent_scenario_key: node.parent_scenario_key } : {}), lifecycle: node.lifecycle,
    ...(node.definition ? { definition: node.definition } : {}),
    ...(node.proposed_migration ? { proposed_migration: node.proposed_migration } : {}),
    verification_commands: node.verification_commands, verification_digests: node.verification_digests,
    observation_count: node.observation_refs.length, verified_task_count: node.verified_task_digests.length,
    ...(node.tier === "coarse" ? { active_fine_child_count: catalog.scenarios.filter(child => child.tier === "fine"
      && child.parent_scenario_key === node.scenario_key && child.lifecycle === "active" && child.verified_task_digests.length >= 2).length } : {}) }));
  return { catalog_version: catalog.catalog_version, scenarios, ...(catalog.transitions.length ? { transitions: catalog.transitions } : {}) };
}
