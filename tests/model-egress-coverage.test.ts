import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditModelEgress } from "../scripts/ci/audit-model-egress.ts";

test("every model send site in the repository has a final egress check", () => {
  const result = auditModelEgress();
  assert.deepEqual(result.violations, [], JSON.stringify(result.violations, null, 2));
  assert.ok(result.sendSites >= 6, `expected the known send sites, saw ${result.sendSites}`);
});

test("the egress audit fails a new send site that skips the check", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-egress-audit-"));
  try {
    await mkdir(join(root, "core"), { recursive: true });
    await writeFile(join(root, "core", "unsafe.ts"),
      "export async function send(transport: any, request: any) { return transport.complete(request.provider, request); }\n");
    const result = auditModelEgress(root);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0]!.file, /core\/unsafe\.ts$/u);

    await writeFile(join(root, "core", "safe.ts"),
      "export async function send(transport: any, request: any) {\n  const outbound = sanitizeModelEgressRequest(request.provider, request);\n  return transport.complete(request.provider, outbound);\n}\n");
    assert.equal(auditModelEgress(root).violations.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
