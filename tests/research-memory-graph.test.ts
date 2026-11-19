import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SelfEvolutionKernel } from "@craft/capability-context";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { stableDigest } from "craft-common-base/digest";

async function seedFixture(f: { store: CraftStore }) {
  const projectRoot = join(f.store.paths.root, "project");
  await mkdir(projectRoot, { recursive: true });
  for (const id of ["research-alpha", "research-beta"]) {
    const canonical = { kind: "project", id: `project:${id}` };
    const identity = { canonical_scope: canonical, project_kind: "git", remote_digest: `remote:${id}` };
    f.store.create("project_identity", `project:${id}`, {
      ...identity, local_path_alias: projectRoot,
      identity_digest: stableDigest({ canonical, project_kind: identity.project_kind, remote_digest: identity.remote_digest }),
    });
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-research-memory-"));
  const store = await new CraftStore(craftPaths(root)).open();
  await seedFixture({ store });
  return { root, store, kernel: new SelfEvolutionKernel(store) };
}

const projectScope = { kind: "project", id: "project:research-alpha" };
const otherScope = { kind: "project", id: "project:research-beta" };

function nodeId(record: JsonObject): string {
  return String((record.node as JsonObject).id);
}

test("research adapter captures layered nodes and separates literature, observation and interpretation", async () => {
  const f = await fixture();
  try {
    const literature = f.kernel.captureResearchNode({
      id: "paper-claim", layer: "literature_fact", content: "The paper reports a 12% lift.",
      source_refs: ["doi:10.1/example"], scope: projectScope,
    }) as JsonObject;
    const observation = f.kernel.captureResearchNode({
      id: "experiment-result", layer: "experiment_observation", content: "Our run measured 4%.",
      source_refs: ["run:17"], scope: projectScope,
    }) as JsonObject;
    const interpretation = f.kernel.captureResearchNode({
      id: "reading", layer: "interpretation", content: "The method may not transfer.",
      scope: projectScope,
    }) as JsonObject;

    assert.equal(literature.layer, "literature_fact");
    assert.equal(observation.layer, "experiment_observation");
    assert.equal(interpretation.layer, "interpretation");
    assert.notEqual(nodeId(literature), nodeId(observation));
    assert.notEqual(nodeId(observation), nodeId(interpretation));

    await assert.rejects(
      Promise.resolve().then(() => f.kernel.captureResearchNode({
        id: "bad-layer", layer: "fact", content: "Not a research layer.", scope: projectScope,
      })),
      /layer must be one of/u,
    );
    assert.throws(
      () => f.kernel.captureResearchNode({ id: "paper-claim", layer: "interpretation", content: "Overwrite.", scope: projectScope }),
      /layer or scope mismatch/u,
    );
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("research adapter validates required fields and research layers", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.kernel.captureResearchNode({ layer: "literature_fact", content: "x", scope: projectScope }), /id and content are required/u);
    assert.throws(() => f.kernel.captureResearchNode({ id: "x", layer: "unsupported", content: "x", scope: projectScope }), /layer must be one of/u);
    assert.throws(() => f.kernel.captureResearchNode({ id: "x", layer: "literature_fact", content: "x", scope: {} }), /scope must declare/u);
    assert.throws(() => f.kernel.recallResearch({ scope: {} }), /scope must declare/u);
    assert.throws(() => f.kernel.applyResearchImpact({ scope: projectScope }), /node_id is required/u);
    assert.throws(() => f.kernel.linkResearch({ source_id: "a", target_id: "b", relation: "derives_from", scope: projectScope, layer: "bad" }), /layer must be one of/u);
    const candidate = f.kernel.captureProgramMemory({
      id: "no-evidence", statement: "Reproduce without evidence", domain: "research", scope: projectScope,
    }) as JsonObject;
    assert.throws(() => f.kernel.submitProgramMemory(String(candidate.id)), /threshold/u);
    f.kernel.captureProgramMemory({
      id: "no-evidence", statement: "Reproduce without evidence", domain: "research", scope: projectScope,
    });
    assert.throws(() => f.kernel.submitProgramMemory(String(candidate.id)), /threshold/u);
    assert.equal(((f.kernel.listProgramMemory({ status: "diagnostic" }) as JsonObject).items as JsonObject[]).length > 0, true);
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("legacy research links omit scope and stay diagnostic", async () => {
  const f = await fixture();
  try {
    const link = f.kernel.linkResearch({ source_id: "paper1", target_id: "exp1", relation: "derives_from", layer: "interpretation" }) as JsonObject;
    assert.equal(link.relation, "derives_from");
    assert.equal(link.layer, "interpretation");
    assert.deepEqual(link.scope, {});
    // Five named adapters plus the general fallback domain.
    assert.equal((f.kernel.evalSummary().domains as JsonObject[]).length, 6);
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("research graph applies typed relations and propagates needs_reevaluation from a refutation", async () => {
  const f = await fixture();
  try {
    const premise = f.kernel.captureResearchNode({
      id: "paper-premise", layer: "literature_fact", content: "Published premise.", scope: projectScope,
    }) as JsonObject;
    const hypothesis = f.kernel.captureResearchNode({
      id: "hypothesis", layer: "interpretation", content: "Our hypothesis.", scope: projectScope,
    }) as JsonObject;
    const result = f.kernel.captureResearchNode({
      id: "result", layer: "experiment_observation", content: "Measured result.", scope: projectScope,
    }) as JsonObject;
    f.kernel.linkResearch({
      source_id: nodeId(hypothesis), target_id: nodeId(premise), relation: "derives_from", scope: projectScope,
    });
    f.kernel.linkResearch({
      source_id: nodeId(result), target_id: nodeId(hypothesis), relation: "supports", scope: projectScope,
    });
    const counterexample = f.kernel.captureResearchNode({
      id: "counterexample", layer: "experiment_observation", content: "A conflicting replication.", scope: projectScope,
    }) as JsonObject;
    const contradiction = f.kernel.linkResearch({
      relation_id: "counterexample", source_id: nodeId(counterexample), target_id: nodeId(premise),
      relation: "contradicts", scope: projectScope,
    }) as JsonObject;

    const recalled = f.kernel.recallResearch({ scope: projectScope, query: "premise" }) as JsonObject;
    const items = recalled.items as JsonObject[];
    assert(items.some((item) => nodeId(item) === nodeId(premise)));

    const impact = f.kernel.applyResearchImpact({ node_id: nodeId(premise), scope: projectScope }) as JsonObject;
    assert.equal(impact.root_challenged, true);
    assert.deepEqual(impact.challenge_relation_ids, [String(contradiction.relation_id)]);
    const impacted = impact.impacted as JsonObject[];
    assert.equal(impacted.length, 1);
    assert.equal(String((impacted[0]!.node as JsonObject).id), nodeId(hypothesis));
    assert.equal(impacted[0]!.needs_reevaluation, true);
    assert.equal(impact.needs_reevaluation, true);
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("replication steps become gated procedure candidates but never execute directly", async () => {
  const f = await fixture();
  try {
    f.kernel.captureResearchNode({
      id: "paper-claim", layer: "literature_fact", content: "Published study.", scope: projectScope,
    });
    for (const evidenceId of ["exp-17", "exp-18", "exp-19"]) {
      f.store.create("evidence", evidenceId, { source_type: "experiment", claim: `run ${evidenceId}`, confidence: "bounded" });
    }
    const candidate = f.kernel.proposeReplicationProcedure({
      id: "replication", title: "Reproduce study 17", steps: ["load dataset", "run baseline"],
      source_id: "paper-claim", evidence_ids: ["exp-17"], scope: projectScope,
    }) as JsonObject;
    assert.equal(candidate.status, "diagnostic");
    assert.equal(candidate.domain, "research");
    assert.deepEqual(candidate.steps, ["load dataset", "run baseline"]);
    assert.throws(() => f.kernel.submitProgramMemory(String(candidate.program_memory_id)), /threshold/);

    for (const evidenceId of ["exp-18", "exp-19"]) {
      f.kernel.captureProgramMemory({
        id: "replication", statement: "Reproduce: Reproduce study 17", domain: "research",
        scope: projectScope, evidence_ids: ["exp-17", evidenceId],
      });
    }
    const submitted = f.kernel.submitProgramMemory(String(candidate.program_memory_id)) as JsonObject;
    assert.equal(submitted.status, "submitted");
    assert.equal(f.store.find("procedure_configuration", "replication"), null);
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("research recall never leaks across project scopes", async () => {
  const f = await fixture();
  try {
    f.kernel.captureResearchNode({
      id: "private", layer: "experiment_observation", content: "Confidential measurement.", scope: projectScope,
    });
    const leak = f.kernel.recallResearch({ scope: otherScope, query: "Confidential" }) as JsonObject;
    assert.deepEqual(leak.items, []);
    assert.equal(leak.denied, false);
    assert.throws(
      () => f.kernel.linkResearch({
        source_id: "private", target_id: "public", relation: "supports", scope: otherScope,
      }),
      /not in scope/u,
    );
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("forgetting a research node retracts its live edges without deleting historical records", async () => {
  const f = await fixture();
  try {
    f.kernel.captureResearchNode({
      id: "old-premise", layer: "literature_fact", content: "Old premise.", scope: projectScope,
    });
    f.kernel.captureResearchNode({
      id: "superseding", layer: "experiment_observation", content: "New observation.", scope: projectScope,
    });
    const relation = f.kernel.linkResearch({
      relation_id: "supersede-old", source_id: "superseding", target_id: "old-premise",
      relation: "supersedes", scope: projectScope,
    }) as JsonObject;
    const forgotten = f.kernel.forgetResearchNode({ id: "old-premise", scope: projectScope }) as JsonObject;
    assert.equal(forgotten.status, "forgotten");

    assert.deepEqual((f.kernel.recallResearch({ scope: projectScope, query: "Old premise" }) as JsonObject).items, []);
    const relationId = String(relation.relation_id);
    assert.equal(String(f.store.get("knowledge_relation", relationId).valid_to).length > 0, true);
    assert.equal(f.store.find("knowledge_claim", String((forgotten.node as JsonObject).id)) !== null, true);
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
