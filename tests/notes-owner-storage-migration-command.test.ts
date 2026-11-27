import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { CraftStore } from "../../craft-common/packages/craft-common-store-local/src/store.ts";
import { craftPaths } from "../../craft-common/packages/craft-common-store-local/src/paths.ts";
import { stableDigest } from "craft-common-base/digest";
import { initializeOwnedCatalog, ownedCatalogFile } from "../core/infrastructure/owned-catalog.ts";

test("Notes owner migration CLI previews Context aliases and moves legacy project records", async () => {
  const root = mkdtempSync(join(tmpdir(), "notes-owner-command-")), project = join(root, "project");
  mkdirSync(project);
  const paths = craftPaths(root), scopeId = `project:${"e".repeat(64)}`;
  const contextDir = join(root, "context"), experienceDir = join(root, "notes");
  try {
    initializeOwnedCatalog(root, "context"); initializeOwnedCatalog(root, "notes");
    const context = await new CraftStore({ ...paths, databaseDir: contextDir, databaseFile: ownedCatalogFile(root, "context") }).open({ ownerRecords: true, skipLegacyPartitionMigration: true });
    context.create("scope_alias", "project-alias", { status: "active", alias_kind: "path", alias: project, alias_digest: stableDigest(project), scope: { kind: "project", id: scopeId } });
    context.close();
    const store = await new CraftStore({ ...paths, databaseDir: experienceDir, databaseFile: ownedCatalogFile(root, "notes") }).open({ ownerRecords: true, skipLegacyPartitionMigration: true });
    store.create("craft_note", "legacy-note", { project_id: scopeId, device_id: "local", subject_type: "directory", subject_key: `local:${project}`, text: "retained", status: "candidate" });
    store.close();
    const script = join(process.cwd(), "scripts/notes-storage-migration.ts"), loader = join(process.cwd(), "tests/helpers/notes-source-loader.mjs");
    const run = (args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", "--import", loader, script, `--data-root=${root}`, ...args], { encoding: "utf8" });
    for (const args of [["--unknown"], ["--apply"], ["--digest=sha256:invalid"], ["--apply", "--digest=sha256:invalid"]]) {
      assert.notEqual(run(args).status, 0);
    }
    const previewResult = run([]); assert.equal(previewResult.status, 0, previewResult.stderr);
    const preview = JSON.parse(previewResult.stdout); assert.equal(preview.eligible.length, 1);
    for (const owner of ["context", "notes"] as const) {
      const competing = new DatabaseSync(ownedCatalogFile(root, owner));
      try {
        competing.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
        assert.notEqual(run([]).status, 0, `${owner} writer must block preflight`);
        assert.notEqual(run(["--apply", `--digest=${preview.digest}`]).status, 0, `${owner} writer must block migration`);
      } finally { competing.exec("ROLLBACK"); competing.close(); }
    }
    const before = await new CraftStore({ ...paths, databaseDir: experienceDir, databaseFile: ownedCatalogFile(root, "notes") }).open({ ownerRecords: true, skipLegacyPartitionMigration: true });
    try { assert.equal(before.get("craft_note", "legacy-note").text, "retained"); }
    finally { before.close(); }
    const applied = run(["--apply", `--digest=${preview.digest}`]); assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).migrated, 1);
    const retry = run(["--apply", `--digest=${preview.digest}`]); assert.equal(retry.status, 0, retry.stderr);
    assert.equal(JSON.parse(retry.stdout).already_current, 1);
    const recheck = run([]); assert.equal(recheck.status, 0, recheck.stderr); assert.equal(JSON.parse(recheck.stdout).eligible.length, 0);
    const direct = spawnSync(process.execPath, ["--experimental-strip-types", "--import", loader, join(process.cwd(), "scripts/notes-owner-storage-migration.ts"), `--data-root=${root}`, "--unknown"], { encoding: "utf8" });
    assert.notEqual(direct.status, 0); assert.match(direct.stderr, /Usage/u);
    const noteRecords = join(experienceDir, "records");
    renameSync(noteRecords, `${noteRecords}-saved`);
    assert.equal(run([]).status, 0);
    renameSync(`${noteRecords}-saved`, noteRecords);
    for (const [name, fragment] of [["notes", "/notes/publication.db"], ["snapshot-context", "craft-notes-owner-preflight-"]] as const) {
      const inject = join(root, `${name}-inject.mjs`);
      writeFileSync(inject, `import fs from "node:fs"; import {syncBuiltinESMExports} from "node:module"; const original=fs.lstatSync; let count=0; fs.lstatSync=function(path,...rest){const result=original.call(this,path,...rest); if(String(path).includes(${JSON.stringify(fragment)}) && String(path).endsWith("publication.db") && ++count===2) return Object.assign(result,{ino:Number(result.ino)+1}); return result}; syncBuiltinESMExports();`);
      const failed = spawnSync(process.execPath, ["--experimental-strip-types", "--import", loader, "--import", inject, script, `--data-root=${root}`], { encoding: "utf8" });
      assert.notEqual(failed.status, 0); assert.match(failed.stderr, /database changed during open/u);
    }
    const statInject = join(root, "record-stat-inject.mjs");
    writeFileSync(statInject, 'import fs from "node:fs"; import {syncBuiltinESMExports} from "node:module"; const original=fs.fstatSync; fs.fstatSync=function(...args){const result=original.apply(this,args);return Object.assign(result,{ino:Number(result.ino)+1})}; syncBuiltinESMExports();');
    const changedRecord = spawnSync(process.execPath, ["--experimental-strip-types", "--import", loader, "--import", statInject, script, `--data-root=${root}`], { encoding: "utf8" });
    assert.notEqual(changedRecord.status, 0); assert.match(changedRecord.stderr, /record changed during inspection/u);
    const shim = join(root, "fs-promises-shim.mjs"), inject = join(root, "copy-inject.mjs");
    writeFileSync(shim, 'export * from "node:fs/promises"; import {cp as copy,rm} from "node:fs/promises"; export async function cp(source,destination,options){await copy(source,destination,options);if(String(destination).endsWith("/records"))await rm(destination,{recursive:true,force:true})}');
    writeFileSync(inject, `import {registerHooks} from "node:module"; registerHooks({resolve(specifier,context,next){if(specifier==="node:fs/promises" && context.parentURL?.endsWith("notes-owner-storage-migration.ts"))return {url:${JSON.stringify(pathToFileURL(shim).href)},shortCircuit:true};return next(specifier,context)}});`);
    const missingCopy = spawnSync(process.execPath, ["--experimental-strip-types", "--import", loader, "--import", inject, script, `--data-root=${root}`], { encoding: "utf8" });
    assert.notEqual(missingCopy.status, 0); assert.match(missingCopy.stderr, /snapshot changed during copying/u);
    const reopened = await new CraftStore({ ...paths, databaseDir: experienceDir, databaseFile: ownedCatalogFile(root, "notes") }).open({ ownerRecords: true, skipLegacyPartitionMigration: true });
    const aliases = await new CraftStore({ ...paths, databaseDir: contextDir, databaseFile: ownedCatalogFile(root, "context") }).open({ ownerRecords: true, skipLegacyPartitionMigration: true });
    try { reopened.setProjectAliasSource(aliases); assert.equal(reopened.get("craft_note", "legacy-note").text, "retained"); }
    finally { aliases.close(); reopened.close(); }
    renameSync(contextDir, `${contextDir}-offline`);
    const withoutContext = run([]); assert.equal(withoutContext.status, 0, withoutContext.stderr);
    const emptyDigest = JSON.parse(withoutContext.stdout).digest;
    assert.equal(run(["--apply", `--digest=${emptyDigest}`]).status, 0);
    renameSync(`${contextDir}-offline`, contextDir);
    const contextMarker = join(contextDir, ".craft-storage-owner");
    writeFileSync(contextMarker, "v1:memory\n");
    assert.notEqual(run([]).status, 0); assert.notEqual(run(["--apply", `--digest=${emptyDigest}`]).status, 0);
    writeFileSync(contextMarker, "v1:context\n");
    const contextRecords = join(contextDir, "records"), outside = join(root, "outside");
    writeFileSync(outside, "unrelated");
    symlinkSync(outside, join(contextRecords, "unsafe-link"));
    assert.notEqual(run([]).status, 0);
    unlinkSync(join(contextRecords, "unsafe-link"));
    renameSync(contextRecords, `${contextRecords}-saved`); writeFileSync(contextRecords, "not a directory");
    assert.notEqual(run([]).status, 0);
    unlinkSync(contextRecords); renameSync(`${contextRecords}-saved`, contextRecords);
    const contextDatabase = ownedCatalogFile(root, "context");
    renameSync(contextDatabase, `${contextDatabase}.missing`);
    assert.equal(run(["--apply", `--digest=${emptyDigest}`]).status, 0);
    renameSync(`${contextDatabase}.missing`, contextDatabase);
    renameSync(contextDatabase, `${contextDatabase}.saved`); symlinkSync(`${contextDatabase}.saved`, contextDatabase);
    assert.notEqual(run([]).status, 0); assert.notEqual(run(["--apply", `--digest=${emptyDigest}`]).status, 0);
    rmSync(contextDatabase); renameSync(`${contextDatabase}.saved`, contextDatabase);
    renameSync(contextDir, `${contextDir}-unsafe`); symlinkSync(`${contextDir}-unsafe`, contextDir);
    assert.notEqual(run([]).status, 0); assert.notEqual(run(["--apply", `--digest=${emptyDigest}`]).status, 0);
    unlinkSync(contextDir); renameSync(`${contextDir}-unsafe`, contextDir);
    renameSync(join(experienceDir, ".craft-storage-owner"), join(root, ".craft-storage-owner"));
    assert.equal(run([]).status, 0);
    writeFileSync(join(root, ".craft-storage-owner"), "v1:memory\n");
    assert.notEqual(run([]).status, 0);
    writeFileSync(join(root, ".craft-storage-owner"), "v1:notes\n");
    const database = ownedCatalogFile(root, "notes");
    renameSync(database, `${database}.saved`); symlinkSync(`${database}.saved`, database);
    assert.notEqual(run([]).status, 0);
    rmSync(database); renameSync(`${database}.saved`, database);
    renameSync(experienceDir, `${experienceDir}-unsafe`); symlinkSync(`${experienceDir}-unsafe`, experienceDir);
    assert.notEqual(run([]).status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a competing owner writer cannot publish record files while the catalog is fenced", async () => {
  const root = mkdtempSync(join(tmpdir(), "notes-owner-fence-")), paths = craftPaths(root), directory = join(root, "notes");
  try {
    initializeOwnedCatalog(root, "notes");
    const dbPath = ownedCatalogFile(root, "notes");
    const owner = await new CraftStore({ ...paths, databaseDir: directory, databaseFile: dbPath }).open({ ownerRecords: true, skipLegacyPartitionMigration: true });
    owner.create("craft_note", "seed", { status: "pending" }); owner.close();
    const pathsUrl = new URL("../../craft-common/packages/craft-common-store-local/src/paths.ts", import.meta.url).href;
    const storeUrl = new URL("../../craft-common/packages/craft-common-store-local/src/store.ts", import.meta.url).href;
    const code = `const {CraftStore}=await import(${JSON.stringify(storeUrl)});const {craftPaths}=await import(${JSON.stringify(pathsUrl)});const root=process.argv[1], paths=craftPaths(root),store=await new CraftStore({...paths,databaseDir:root+"/notes",databaseFile:root+"/notes/publication.db"}).open({ownerRecords:true,skipLegacyPartitionMigration:true});console.log("READY");process.stdin.once("data",()=>{try{store.create("craft_note","new-note",{status:"pending"});console.log("WRITTEN")}catch{console.log("BLOCKED")}finally{store.close()}});`;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code, root], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += String(chunk); });
    while (!output.includes("READY")) await once(child.stdout, "data");
    const list = (directoryPath: string): string[] => readdirSync(directoryPath, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? list(join(directoryPath, entry.name)) : [join(directoryPath, entry.name)]);
    const records = join(directory, "records"), before = list(records).sort();
    const lock = new DatabaseSync(dbPath);
    try {
      lock.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); child.stdin.end("go");
      const [exit] = await once(child, "exit");
      assert.equal(exit, 0); assert.match(output, /BLOCKED/u); assert.deepEqual(list(records).sort(), before);
    } finally { lock.exec("ROLLBACK"); lock.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
