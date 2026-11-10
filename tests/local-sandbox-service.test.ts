import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftService } from "../core/service.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { localProcessRequestDigest } from "../core/local-process-sandbox.ts";

const capabilities = {
  filesystem: "workspace_overlay", network: "unrestricted", network_allowlist: [],
  features: ["process_isolation", "cancel"], limits: { timeout_ms: 10_000, output_limit: 65_536 },
};

test("local process sandbox runs a ticket through profile, conformance and a real receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-local-sandbox-service-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const service = new CraftService(store);
    const profile = service.sandboxProfileSave({
      profile_id: "local", name: "Local process", backend: "local_process", adapter_id: "local-process", capabilities,
    }) as { id: string; version: number };

    const probed = await service.localSandboxProbe({ profile_id: profile.id, profile_version: profile.version });
    assert.equal((probed.probe as { status: string }).status, "passed");
    assert.equal((probed.probe as { os_sandbox_guaranteed: boolean }).os_sandbox_guaranteed, false);

    const conformed = await service.localSandboxConformance({ profile_id: profile.id, profile_version: profile.version });
    assert.equal(conformed.verified, true);
    const verifiedProfile = conformed.profile as { lifecycle: string; version: number };
    assert.equal(verifiedProfile.lifecycle, "verified");

    const task = service.taskOpen({ title: "sandbox run", goal: "write a file" }).task as { id: string };
    const command = [process.execPath, "-e", "require('node:fs').writeFileSync('out.txt','ok')"];
    const workspace = join(store.paths.runtimeDir, "ticket-1");
    const planned = service.sandboxPlan({
      task_id: task.id, ticket_id: "ticket-1", profile_id: profile.id, profile_version: verifiedProfile.version,
      requirements: { filesystem: "workspace_overlay", network: "unrestricted", features: ["process_isolation", "cancel"], limits: {} },
      request_digest: localProcessRequestDigest(command, workspace),
    });
    assert.equal(planned.compatible, true);

    const executed = await service.localSandboxExecute({ ticket_id: "ticket-1", argv: command, receipt_id: "receipt-1" });
    assert.equal((executed.result as { status: string }).status, "passed");
    assert.equal((executed.result as { os_sandbox_guaranteed: boolean }).os_sandbox_guaranteed, false);
    assert.equal(existsSync(join(workspace, "out.txt")), true);
    assert.equal((executed.receipt as { status: string }).status, "passed");
    assert.equal((executed.receipt as { adapter_id: string }).adapter_id, "local-process");
    assert.equal((executed.receipt as { boundary_matches: boolean }).boundary_matches, true);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the local sandbox refuses a ticket belonging to the container backend", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-local-sandbox-backend-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const service = new CraftService(store);
    const profile = service.sandboxProfileSave({
      profile_id: "container", name: "Container", backend: "container", adapter_id: "docker", capabilities,
    }) as { id: string; version: number };
    const task = service.taskOpen({ title: "t", goal: "g" }).task as { id: string };
    // The guard is on the ticket's assigned backend, so issue the ticket
    // directly instead of requiring the container profile to be verified.
    store.create("sandbox_ticket", "ticket-container", {
      task_id: task.id, profile_id: profile.id, profile_version: profile.version,
      profile_digest: "sha256:container", request_digest: "sha256:x", status: "issued",
      requirements: { filesystem: "workspace_overlay", network: "unrestricted", features: ["process_isolation", "cancel"], limits: {} },
    });
    await assert.rejects(() => service.localSandboxExecute({ ticket_id: "ticket-container", argv: [process.execPath, "-e", ""], receipt_id: "r" }),
      /not assigned to the local process backend/u);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
