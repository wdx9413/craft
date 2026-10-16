import { readFileSync, writeFileSync } from "node:fs";

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.hostname !== "craft-e2e.invalid") return originalFetch(input, init);
  if (url.pathname !== "/v1/chat/completions" || typeof init?.body !== "string") {
    return new Response(JSON.stringify({ error: "unsupported Craft model fixture request" }), { status: 404, headers: { "content-type": "application/json" } });
  }

  const request = JSON.parse(init.body);
  if (request.model !== "local-e2e-model") return new Response(JSON.stringify({ error: "unexpected model" }), { status: 400, headers: { "content-type": "application/json" } });
  const statePath = process.env.CRAFT_LEARNING_E2E_PROVIDER_STATE;
  const workflows = JSON.parse(process.env.CRAFT_LEARNING_E2E_WORKFLOWS ?? "[]");
  if (!statePath || !Array.isArray(workflows) || workflows.length === 0) {
    return new Response(JSON.stringify({ error: "model fixture is not configured" }), { status: 500, headers: { "content-type": "application/json" } });
  }
  let state = { calls: 0, knowledge_classification_calls: 0 };
  try { state = { ...state, ...JSON.parse(readFileSync(statePath, "utf8")) }; } catch { /* first provider call */ }
  const system = String((request.messages ?? []).find(message => message.role === "system")?.content ?? "");
  const isKnowledgeClassification = system.includes("Classify this evidence-backed Knowledge Claim");
  if (isKnowledgeClassification) {
    state.knowledge_classification_calls = Number(state.knowledge_classification_calls ?? 0) + 1;
    writeFileSync(statePath, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    return new Response(JSON.stringify({ id: `chatcmpl-craft-e2e-knowledge-${state.knowledge_classification_calls}`, model: "local-e2e-model", choices: [{ index: 0, finish_reason: "stop",
      message: { role: "assistant", content: JSON.stringify({ decision: "classified", scenario_key: "project.delivery.verification",
        scenario_definition: { summary: "项目交付验证", applies_when: "任务需要通过项目验收命令验证交付结果", excludes: "仅讨论交付流程但未验证结果" },
        coarse_scenario_key: "project.delivery", coarse_scenario_definition: { summary: "项目交付", applies_when: "任务目标是完成并验收项目变更", excludes: "只读咨询或独立知识整理" } }) } }], usage: { prompt_tokens: 32, completion_tokens: 12, total_tokens: 44 } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }
  state.calls = Number(state.calls ?? 0) + 1;
  writeFileSync(statePath, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
  const workflow = workflows[Math.min(state.calls - 1, workflows.length - 1)];
  return new Response(JSON.stringify({ id: `chatcmpl-craft-e2e-${state.calls}`, model: "local-e2e-model", choices: [{ index: 0, finish_reason: "stop",
    message: { role: "assistant", content: JSON.stringify(workflow) } }], usage: { prompt_tokens: 32, completion_tokens: 24, total_tokens: 56 } }), {
    status: 200, headers: { "content-type": "application/json" },
  });
};
