import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claudeWorkbenchCommands } from "../core/interfaces/claude-workbench-commands.ts";

test("Claude command discovery reads the CLI catalog and closes the temporary process", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-commands-")); let closed = 0;
  const launch: any = () => ({ supportedCommands: async () => [{ name: "review", description: "review" }, { name: "bad\nname" }, { name: "help", builtin: true }], close: () => closed++ });
  try {
    const result = await claudeWorkbenchCommands(root, launch, () => "/claude");
    assert.deepEqual(result.commands.map(item => item.name), ["review", "help"]); assert.equal(result.commands[1].builtin, true); assert.equal(closed, 1);
    await assert.rejects(claudeWorkbenchCommands("relative", launch, () => "/claude"), /absolute/);
    const invalid: any = () => ({ supportedCommands: async () => null, close: () => closed++ });
    await assert.rejects(claudeWorkbenchCommands(root, invalid, () => "/claude"), /Invalid/);
    const timeout: any = (args: any) => { void args.prompt.next(); args.options.stderr('ignored'); return { supportedCommands: () => new Promise(() => {}), close: () => closed++ }; };
    await assert.rejects(claudeWorkbenchCommands(root, timeout, () => "/claude", 5), /timed out/);
    const many: any = () => ({ supportedCommands: async () => Array.from({ length: 201 }, (_, i) => ({ name: String(i) })), close: () => closed++ });
    assert.equal((await claudeWorkbenchCommands(root, many, () => "/claude")).truncated, true);
    const fail: any = () => ({ supportedCommands: async () => { throw new Error('disconnected'); }, close: () => closed++ });
    await assert.rejects(claudeWorkbenchCommands(null, fail, () => "/claude"), /disconnected/); assert.equal(closed, 5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
