import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const CLI = resolve(import.meta.dirname, "..", "core", "cli.ts");

async function craftNotesLocations(args: string[], dataDir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, "notes", "locations", ...args], {
      timeout: 30_000,
      env: { ...process.env, CRAFT_DATA_DIR: dataDir, CRAFT_HOOK_MODE: "0" },
    });
    return { code: 0, stdout, stderr };
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("craft notes locations records, promotes, resolves and lists directory descriptions", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "craft-notes-cli-"));
  try {
    // First touch only observes (below promotion threshold).
    const r1 = await craftNotesLocations(["record", "C:\\projects\\billing", "billing service root"], dataDir);
    assert.match(r1.stdout, /"status": ?"observed"/u);
    // Repeat until promoted.
    await craftNotesLocations(["record", "C:\\projects\\billing", "billing service root"], dataDir);
    const r3 = await craftNotesLocations(["record", "C:\\projects\\billing", "billing service root"], dataDir);
    assert.match(r3.stdout, /"status": ?"promoted"/u);

    // Description -> path resolve only matches promoted entries.
    const resolved = await craftNotesLocations(["resolve", "--by-desc", "billing service"], dataDir);
    assert.match(resolved.stdout, /projects\\+billing/u);

    // Path -> description lookup.
    const byPath = await craftNotesLocations(["resolve", "--by-path", "C:\\projects\\billing"], dataDir);
    assert.match(byPath.stdout, /billing service root/u);

    // List them.
    const listed = await craftNotesLocations(["list", "--status", "promoted"], dataDir);
    assert.match(listed.stdout, /projects\\+billing/u);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("craft notes locations rejects relative paths with a clear error", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "craft-notes-cli-"));
  try {
    const result = await craftNotesLocations(["record", "relative/path", "x"], dataDir);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /absolute path/u);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("craft inbox poll ingests a local drop message once and dedups on re-poll", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "craft-poll-cli-"));
  const dropDir = await mkdtemp(join(tmpdir(), "craft-poll-drop-"));
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dropDir, "m.json"), JSON.stringify({ source: "email", from: "boss", subject: "weekly", summary: "status" }), "utf8");
    const first = await run(process.execPath, [CLI, "inbox", "poll", dropDir], { timeout: 30_000, env: { ...process.env, CRAFT_DATA_DIR: dataDir, CRAFT_HOOK_MODE: "0" } });
    assert.match(first.stdout, /"ingested": ?1/u);
    // Re-poll the same content: dedup via persistent message_seen ids yields 0.
    const second = await run(process.execPath, [CLI, "inbox", "poll", dropDir], { timeout: 30_000, env: { ...process.env, CRAFT_DATA_DIR: dataDir, CRAFT_HOOK_MODE: "0" } });
    assert.match(second.stdout, /"ingested": ?0/u);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(dropDir, { recursive: true, force: true });
  }
});
