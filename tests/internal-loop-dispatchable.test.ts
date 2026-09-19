import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InternalHostDriver } from "../src/internal-host-driver.ts";
import { classifyTool } from "../src/internal-tool-authorization.ts";
import { McpServer, TOOLS } from "../src/mcp.ts";
import { defineProvider, type ModelProviderSpec } from "../src/model-gateway.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { summarizeConversation } from "../src/runtime-truth.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";

const loopSpec = (): ModelProviderSpec => defineProvider({ provider: "demo", label: "Demo", protocol: "openai-compatible",
  base_url: "https://example.test/v1", api_key_env: "DEMO_API_KEY",
  models: { small: "demo-small", standard: "demo-std", frontier: "demo-frontier" } });

/**
 * The loop's advertised surface and its answerable surface are the same set.
 *
 * The defect these tests pin down: the loop mounted the tier-filtered catalog
 * (hundreds of tools) while only two dispatch tables could actually answer a
 * call, so a model that used anything else got an unroutable action -- and,
 * because the loop treated an action error as fatal, the run ended. Two names
 * were worse than that: `memory_propose` and `verification_signals_get` were
 * loop-only aliases no catalog tool answers, so even the bounded fallback
 * advertised work it could never route.
 *
 * A test that only counts tools cannot catch this. The invariant is a relation
 * between the two sets, so that is what is asserted: nothing may be offered that
 * cannot be answered.
 */

interface DispatchProbe {
  invokeInternalAction(action: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  dispatchableInternalActions(): ReadonlySet<string>;
}

async function fixture(): Promise<{ store: CraftStore; root: string; service: CraftService }> {
  const root = await mkdtemp(join(tmpdir(), `craft-loop-surface-${process.pid}-`));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, root, service: new CraftService(store) };
}

const advertised = (service: CraftService): string[] =>
  service.internalHost.tools.map((definition) => definition.function.name);

test("without a mounted server the loop offers exactly the surface it can answer", async () => {
  const f = await fixture();
  try {
    const sent = advertised(f.service);
    const dispatchable = (f.service as unknown as DispatchProbe).dispatchableInternalActions();

    for (const name of sent) {
      assert.ok(dispatchable.has(name), `${name} is advertised but cannot be dispatched`);
    }
    // The bounded fallback is the point: a standalone service must not offer the
    // public catalog it has no server to route.
    assert.ok(sent.length < TOOLS.length, "the standalone surface must stay bounded");
    assert.ok(sent.length < 20, `standalone surface grew to ${sent.length} tools`);
    // The actions the loop is documented to have.
    for (const name of ["capability_search", "knowledge_search", "memory_search", "memory_capture_propose",
      "task_checkpoint", "evidence_record", "artifact_register", "workspace_read", "workspace_write"]) {
      assert.ok(sent.includes(name), `${name} disappeared from the loop surface`);
    }
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("mounting the MCP server widens the loop surface without advertising anything unroutable", async () => {
  const f = await fixture();
  try {
    const before = advertised(f.service);
    // The driver resolves its surface per request, so a server mounted after the
    // service was constructed still contributes its dispatch.
    new McpServer(f.service);
    const after = advertised(f.service);
    const dispatchable = (f.service as unknown as DispatchProbe).dispatchableInternalActions();

    assert.ok(after.length > before.length, "a mounted server did not widen the surface");
    for (const name of after) {
      assert.ok(dispatchable.has(name), `${name} is advertised but cannot be dispatched`);
    }
    for (const name of before) assert.ok(after.includes(name), `${name} was lost when the server mounted`);
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
test("every fallback action names a canonical tool, apart from the loop-only workspace pair", async () => {
  const f = await fixture();
  try {
    const fallback = (f.service as unknown as { internalFallbackActions(): Record<string, unknown> })
      .internalFallbackActions();
    const canonical = new Set(TOOLS.map((tool) => tool.name));
    const loopOnly = new Set(["workspace_read", "workspace_write"]);
    for (const action of Object.keys(fallback)) {
      if (loopOnly.has(action)) {
        // The pair is deliberately outside the public catalog.
        assert.equal(canonical.has(`craft_${action}`), false, `${action} must stay loop-only`);
        continue;
      }
      assert.ok(canonical.has(`craft_${action}`),
        `${action} has no canonical tool, so the loop would offer a call it cannot route`);
    }
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("every action the fallback table names is routed rather than refused as unknown", async () => {
  const f = await fixture();
  const invoke = (f.service as unknown as DispatchProbe).invokeInternalAction.bind(f.service);
  try {
    // Arguments are deliberately minimal: the point is that the call reaches the
    // action instead of failing closed as an unknown operation. An action that
    // validates its own input and throws has still been dispatched.
    const cases: Array<[string, Record<string, unknown>]> = [
      ["memory_search", { query: "port", scope_id: "project-1", scope_kind: "project" }],
      ["memory_capture_propose", {}],
      ["verification_evaluate", { checks: [] }],
      ["verification_capture_signals_get", { checks: [] }],
      ["abstraction_evaluate", { trajectories: [] }],
      ["failure_attribution_get", {}],
      ["consistency_check", { declarations: [], observed: {} }],
      ["governance_pin_check", { constraints: [], rendered: "" }],
    ];
    for (const [action, args] of cases) {
      try {
        const result = await invoke(action, args);
        assert.equal(typeof result, "object", `${action} did not answer with an object`);
      } catch (error) {
        assert.doesNotMatch(String(error), /not a known operation/u,
          `${action} is named by the fallback table but nothing answers it`);
      }
    }
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("the compaction note names what was dropped instead of only hashing it", () => {
  // No user turn: the note must still be produced and honest about the digest.
  assert.match(summarizeConversation([{ role: "assistant", content: "thinking" }]), /Compacted 1 earlier turn/u);
  const dropped: Array<{ role: "user" | "assistant"; content: string; tool_calls?: unknown[] }> = [
    { role: "user", content: "Triage the failing checkout.\nsecond line is dropped from the note" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "memory_search" } }, { function: { name: "capability_search" } }] },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "memory_search" } }] },
    { role: "assistant", content: "no call here" },
  ];
  const note = summarizeConversation(dropped as never);
  assert.match(note, /asked: Triage the failing checkout\./u);
  assert.match(note, /actions: capability_search, memory_search/u);
  assert.match(note, /digest sha256:/u);
  // A tool call without a usable name contributes nothing rather than "undefined".
  assert.doesNotMatch(summarizeConversation([{ role: "assistant", content: "", tool_calls: [{}] }] as never), /undefined/u);
});

test("a long conversation is compacted against the loop's token window and keeps a readable note", async () => {
  const root = await mkdtemp(join(tmpdir(), `craft-compact-${process.pid}-`));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    store.create("task", "t", { title: "t", goal: "g" });
    const prompt = "goal " + "z".repeat(4_000);
    // Capture what the model was actually sent: compaction is observable in the
    // request, not in the final session record (a later, smaller turn records
    // `compacted: false` again, which is correct but hides that it ever happened).
    const sent: Array<Record<string, unknown>> = [];
    const transport = { complete: async (_spec: unknown, request: { body: { messages?: unknown } }) => {
      sent.push(...((request.body.messages as Array<Record<string, unknown>>) ?? []));
      return { text: "answer " + "y".repeat(200), model: "fake", usage: { input_tokens: 1, output_tokens: 1 } };
    } };
    // The window is far below the opening prompt, so the first request must already
    // be governed by the budget rather than by a 32,000-character ceiling.
    const driver = new InternalHostDriver(store, { providers: [loopSpec()], transport: transport as never });
    driver.prepare({ task_id: "t", prompt, dispatch_id: "compact", limits: { max_context_tokens: 256, max_steps: 2 } });
    await driver.execute({ dispatch_id: "compact", prompt });

    const notes = sent.map((message) => String(message.content ?? ""))
      .filter((content) => content.startsWith("Compacted"));
    assert.ok(notes.length > 0, "no request carried a compaction note");
    const note = notes[notes.length - 1]!;
    // The note is actionable: it repeats the goal and carries the exact digest,
    // so the elided turns stay referenceable even though they left the window.
    assert.match(note, /asked: goal/u);
    assert.match(note, /digest sha256:/u);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("first-run readiness reads the real install instead of echoing the caller", async () => {
  const f = await fixture();
  try {
    // A model has to exist in settings for the settings path to be exercised at
    // all: mapping an empty list never invokes the projection.
    f.service.modelAdd({ id: "local", name: "Local", protocol: "anthropic", baseUrl: "https://api.example.test/v1",
      model: "claude-local", apiKeyEnv: "CRAFT_READINESS_KEY", supportsTools: true });
    // No models and no env supplied: the answer must come from this install
    // (settings plus the process environment), not report "nothing configured"
    // merely because the caller passed nothing.
    const fromInstall = f.service.firstRunReadiness({});
    assert.equal(Array.isArray(fromInstall.models), true);
    assert.equal((fromInstall.models as unknown[]).length, 1);
    assert.equal(fromInstall.configured_count, 0);
    // An empty overlay is not an override, so the process environment still counts.
    // The variable is set here rather than read from the ambient environment:
    // Windows spells the same variable differently ("Path"), so asserting on a
    // well-known name would test the platform instead of the fallback.
    process.env.CRAFT_AMBIENT_KEY = "set";
    try {
      const withAmbient = f.service.firstRunReadiness({ models: [{ id: "a", apiKeyEnv: "CRAFT_AMBIENT_KEY" }], env: {} });
      assert.equal(withAmbient.configured_count, 1);
    } finally {
      delete process.env.CRAFT_AMBIENT_KEY;
    }
    // An explicit overlay still wins over the ambient environment.
    const overlaid = f.service.firstRunReadiness({ models: [{ id: "a", apiKeyEnv: "CRAFT_ABSENT_KEY" }],
      env: { CRAFT_ABSENT_KEY: "set" } });
    assert.equal(overlaid.configured_count, 1);
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a governance constraint can be defined as data while the loop can only check one", async () => {
  const f = await fixture();
  try {
    const defined = f.service.governanceConstraintDefine({ id: "never-publish", kind: "prohibited_effect",
      statement: "Never publish a workflow without a signoff.", effect: "deny" });
    assert.equal(defined.id, "never-publish");
    assert.equal(defined.scope, "*");
    // The loop may verify a pin; authoring one stays a governed decision, which is
    // what stops a guard from being redefined by the thing it guards.
    assert.equal(classifyTool("craft_governance_constraint_define"), "governed");
    assert.throws(() => f.service.governanceConstraintDefine({ id: "x", kind: "invented", statement: "s", effect: "e" }),
      /unsupported/u);
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

