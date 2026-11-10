import assert from "node:assert/strict";
import test from "node:test";
import { workbenchContextAuditRoute } from "../core/interfaces/workbench-context-audit-route.ts";

test("Context audit routes match only the supported method and exact path", () => {
  const id = "a".repeat(64);
  assert.deepEqual(workbenchContextAuditRoute("POST", "/api/workbench/evaluations/context-audit"), { kind: "audit" });
  assert.deepEqual(workbenchContextAuditRoute("GET", `/api/workbench/evaluations/context-audit/${id}/report`), { kind: "report", id });
  assert.equal(workbenchContextAuditRoute("GET", "/api/workbench/evaluations/context-audit"), null);
  assert.equal(workbenchContextAuditRoute("POST", `/api/workbench/evaluations/context-audit/${id}/report`), null);
  assert.equal(workbenchContextAuditRoute("GET", `/api/workbench/evaluations/context-audit/${"g".repeat(64)}/report`), null);
  assert.equal(workbenchContextAuditRoute("GET", `/api/workbench/evaluations/context-audit/${id}/report/extra`), null);
});
