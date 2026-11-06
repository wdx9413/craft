export type WorkbenchContextAuditRoute =
  | { kind: "audit" }
  | { kind: "report"; id: string }
  | null;

/** Match the two local Context audit routes before dispatching their payloads. */
export function workbenchContextAuditRoute(method: string, path: string): WorkbenchContextAuditRoute {
  if (method === "POST" && path === "/api/workbench/evaluations/context-audit") return { kind: "audit" };
  const report = /^\/api\/workbench\/evaluations\/context-audit\/([a-f0-9]{64})\/report$/u.exec(path);
  if (method === "GET" && report) return { kind: "report", id: report[1]! };
  return null;
}
