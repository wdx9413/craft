import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { detectAgentDesktop, registerAgentDesktopAdapter } from "../core/interfaces/agent-desktop-adapter.ts";

test("Agent Desktop is detected and registered as a command adapter without installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-agent-desktop-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const bin = join(root, "bin");
    await (await import("node:fs/promises")).mkdir(bin, { recursive: true });
    const executable = join(bin, process.platform === "win32" ? "agent-desktop.exe" : "agent-desktop");
    await writeFile(executable, "fixture");
    await chmod(executable, 0o755).catch(() => undefined);
    const env = { ...process.env, PATH: bin, Path: bin, PATHEXT: ".EXE;.CMD" };
    assert.equal(detectAgentDesktop(env).status, "available");
    const result = registerAgentDesktopAdapter(store, env);
    assert.equal(result.registered, true);
    const manifest = store.get("adapter_manifest", "agent-desktop");
    assert.equal(manifest.kind, "command");
    assert.equal(manifest.entry, executable);
    assert.deepEqual(manifest.effects, ["read_only", "local_write"]);
    assert.equal(detectAgentDesktop({ ...process.env, PATH: join(root, "missing"), Path: join(root, "missing") }).status, "not_found");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
