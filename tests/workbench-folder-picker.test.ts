import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pickWorkbenchFiles, pickWorkbenchFolder, runWindowsFilesDialog, runWindowsFolderDialog } from "../core/interfaces/workbench-folder-picker.ts";

class DialogStream {
  encoding = "";
  data: Array<(chunk: unknown) => void> = [];
  setEncoding(encoding: BufferEncoding) { this.encoding = encoding; }
  on(event: "data", listener: (chunk: unknown) => void) { if (event === "data") this.data.push(listener); }
  emit(chunk: unknown) { for (const listener of this.data) listener(chunk); }
}

class DialogProcess {
  stdout = new DialogStream();
  stderr = new DialogStream();
  errors: Array<(error: Error) => void> = [];
  exits: Array<(code: number | null) => void> = [];
  kills = 0;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error" | "exit", listener: ((error: Error) => void) | ((code: number | null) => void)) {
    if (event === "error") this.errors.push(listener as (error: Error) => void);
    else this.exits.push(listener as (code: number | null) => void);
  }
  kill() { this.kills += 1; return true; }
  emitError(error: Error) { for (const listener of this.errors) listener(error); }
  emitExit(code: number | null) { for (const listener of this.exits) listener(code); }
}

test("workbench folder picker returns a canonical selected directory", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-folder-picker-")));
  try {
    let initial = "";
    const result = await pickWorkbenchFolder(root, async value => { initial = value; return { path: root }; });
    assert.equal(initial, root);
    assert.deepEqual(result, { path: root });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("workbench folder picker handles cancellation and invalid initial paths", async () => {
  let initial = "";
  const cancelled = await pickWorkbenchFolder("relative/path", async value => { initial = value; return { cancelled: true }; });
  assert.equal(initial, homedir());
  assert.deepEqual(cancelled, { cancelled: true });
});

test("workbench folder picker rejects malformed and non-directory results", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-folder-picker-invalid-")));
  try {
    writeFileSync(join(root, "file.txt"), "not a directory");
    await assert.rejects(pickWorkbenchFolder(null, async () => null), /invalid response/u);
    await assert.rejects(pickWorkbenchFolder(null, async () => []), /invalid response/u);
    await assert.rejects(pickWorkbenchFolder(null, async () => ({ path: "" })), /invalid path/u);
    await assert.rejects(pickWorkbenchFolder(null, async () => ({ path: 1 })), /invalid path/u);
    await assert.rejects(pickWorkbenchFolder(null, async () => ({ path: "bad\0path" })), /invalid path/u);
    await assert.rejects(pickWorkbenchFolder(null, async () => ({ path: join(root, "missing") })), /ENOENT/u);
    await assert.rejects(pickWorkbenchFolder(null, async () => ({ path: join(root, "file.txt") })), /not a folder/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("workbench file picker returns canonical unique selected files", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-file-picker-")));
  try {
    const first = join(root, "first.txt"), second = join(root, "second.txt");
    writeFileSync(first, "first"); writeFileSync(second, "second");
    let initial = "";
    const result = await pickWorkbenchFiles(root, async value => { initial = value; return { paths: [first, second, first] }; });
    assert.equal(initial, root);
    assert.deepEqual(result, { paths: [first, second] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("workbench file picker handles cancellation and rejects malformed selections", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-file-picker-invalid-")));
  try {
    const file = join(root, "file.txt"); writeFileSync(file, "file");
    let initial = "";
    assert.deepEqual(await pickWorkbenchFiles("relative/path", async value => { initial = value; return { cancelled: true }; }), { cancelled: true });
    assert.equal(initial, homedir());
    await assert.rejects(pickWorkbenchFiles(null, async () => null), /invalid response/u);
    await assert.rejects(pickWorkbenchFiles(null, async () => []), /invalid response/u);
    await assert.rejects(pickWorkbenchFiles(null, async () => ({ paths: [] })), /invalid paths/u);
    await assert.rejects(pickWorkbenchFiles(null, async () => ({ paths: Array.from({ length: 21 }, () => file) })), /invalid paths/u);
    await assert.rejects(pickWorkbenchFiles(null, async () => ({ paths: [1] })), /invalid paths/u);
    await assert.rejects(pickWorkbenchFiles(null, async () => ({ paths: ["bad\0path"] })), /invalid paths/u);
    await assert.rejects(pickWorkbenchFiles(null, async () => ({ paths: [join(root, "missing")] })), /ENOENT/u);
    await assert.rejects(pickWorkbenchFiles(null, async () => ({ paths: [root] })), /not a file/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows folder dialog launches PowerShell and parses selected or cancelled results", async () => {
  for (const [stdout, expected] of [
    [String.raw`{"path":"C:\\selected"}`, { path: String.raw`C:\selected` }],
    ['{"cancelled":true}', { cancelled: true }],
  ] as const) {
    const child = new DialogProcess();
    let invocation: { file: string; args: string[]; options: any } | undefined;
    const promise = runWindowsFolderDialog(String.raw`C:\start`, {
      platform: "win32",
      systemRoot: String.raw`C:\Windows`,
      spawnProcess: (file, args, options) => {
        invocation = { file, args, options };
        setImmediate(() => { child.stdout.emit(stdout); child.emitExit(0); });
        return child;
      },
    });
    assert.deepEqual(await promise, expected);
    assert.match(invocation!.file, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/u);
    assert.deepEqual(invocation!.args.slice(0, 4), ["-NoProfile", "-STA", "-NonInteractive", "-WindowStyle"]);
    const script = invocation!.args.at(-1)!;
    assert.match(script, /IFileOpenDialog/u);
    assert.match(script, /FOS_PICKFOLDERS/u);
    assert.doesNotMatch(script, /FolderBrowserDialog/u);
    assert.equal(invocation!.options.env.CRAFT_WORKBENCH_PICKER_INITIAL, String.raw`C:\start`);
    assert.equal(child.stdout.encoding, "utf8");
  }
});

test("Windows files dialog uses multi-select and the system file picker", async () => {
  const child = new DialogProcess();
  let invocation: { args: string[]; options: any } | undefined;
  const result = runWindowsFilesDialog("C:\\start", {
    platform: "win32",
    systemRoot: "C:\\Windows",
    spawnProcess: (_, args, options) => {
      invocation = { args, options };
      setImmediate(() => { child.stdout.emit('{"paths":["C:\\\\one.txt"]}'); child.emitExit(0); });
      return child;
    },
  });
  assert.deepEqual(await result, { paths: ["C:\\one.txt"] });
  assert.equal(invocation!.options.env.CRAFT_WORKBENCH_PICKER_MODE, "files");
  assert.match(invocation!.args.at(-1)!, /OpenFileDialog/u);
  assert.match(invocation!.args.at(-1)!, /Multiselect = \$true/u);
});

test("Windows folder dialog falls back to the standard Windows directory", async () => {
  const previous = process.env.SystemRoot;
  delete process.env.SystemRoot;
  const child = new DialogProcess();
  let file = "";
  try {
    const result = runWindowsFolderDialog("start", {
      platform: "win32",
      spawnProcess: (executable) => {
        file = executable;
        setImmediate(() => { child.stdout.emit('{"cancelled":true}'); child.emitExit(0); });
        return child;
      },
    });
    assert.deepEqual(await result, { cancelled: true });
  } finally {
    if (previous === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previous;
  }
  assert.equal(file, String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
});

test("Windows folder dialog reports spawn, exit and malformed response failures", async () => {
  await assert.rejects(runWindowsFolderDialog("start", { platform: "linux" }), /only available on Windows/u);

  const spawnError = new DialogProcess();
  const failedSpawn = runWindowsFolderDialog("start", {
    platform: "win32",
    spawnProcess: () => { setImmediate(() => spawnError.emitError(new Error("spawn failed"))); return spawnError; },
  });
  await assert.rejects(failedSpawn, /spawn failed/u);

  const failedExit = new DialogProcess();
  const exited = runWindowsFolderDialog("start", {
    platform: "win32",
    spawnProcess: () => { setImmediate(() => { failedExit.stderr.emit("picker failed"); failedExit.emitExit(1); }); return failedExit; },
  });
  await assert.rejects(exited, /picker failed/u);

  const emptyExit = new DialogProcess();
  const empty = runWindowsFolderDialog("start", {
    platform: "win32",
    spawnProcess: () => { setImmediate(() => emptyExit.emitExit(2)); return emptyExit; },
  });
  await assert.rejects(empty, /exited unexpectedly/u);

  const malformed = new DialogProcess();
  const invalid = runWindowsFolderDialog("start", {
    platform: "win32",
    spawnProcess: () => { setImmediate(() => { malformed.stdout.emit("not json"); malformed.emitExit(0); }); return malformed; },
  });
  await assert.rejects(invalid, /invalid response/u);
});

test("Windows folder dialog bounds stdout and stderr", async () => {
  const child = new DialogProcess();
  const result = runWindowsFolderDialog("start", {
    platform: "win32",
    spawnProcess: () => {
      setImmediate(() => {
        child.stdout.emit("x".repeat(64 * 1024 + 1));
        child.stderr.emit("y".repeat(64 * 1024 + 1));
        child.emitExit(1);
      });
      return child;
    },
  });
  await assert.rejects(result);
  assert.equal(child.kills, 2);
});
