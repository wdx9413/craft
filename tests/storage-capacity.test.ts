import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { measureStorageCapacity } from "../core/storage-capacity.ts";

test("capacity separates payload, table/index pages, sidecars and file formats without following links", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-capacity-"));
  const db = new DatabaseSync(join(root, "publication.db"));
  db.exec("CREATE TABLE records(kind TEXT,payload_json TEXT); CREATE INDEX record_kind ON records(kind); CREATE TABLE events(payload_json TEXT)");
  db.prepare("INSERT INTO records VALUES(?,?)").run("fixture",JSON.stringify({ _record_file: { bytes: 42 } }));
  db.prepare("INSERT INTO events VALUES(?)").run("invalid legacy JSON"); db.close();
  const empty = new DatabaseSync(join(root,"empty.sqlite")); empty.exec("CREATE TABLE unrelated(id TEXT)"); empty.close();
  try {
    writeFileSync(join(root,"body.md"),"正文");linkSync(join(root,"body.md"),join(root,"body-copy.md"));
    mkdirSync(join(root,"knowledge","records","cold"),{recursive:true});writeFileSync(join(root,"knowledge","records","cold","part.jsonl"),"{}\n");
    writeFileSync(join(root,"events.jsonl"),"{}\n");writeFileSync(join(root,"metadata.json"),"{}");writeFileSync(join(root,"misc.txt"),"data");
    writeFileSync(join(root,"fixture.db-wal"),"wal");symlinkSync("missing",join(root,"ignored-link"));
    const result = measureStorageCapacity(root);
    assert.equal(result.status,"partial");assert.equal(result.symbolic_links_not_followed,1);
    assert.equal(result.categories.markdown?.files,2);assert.equal(result.categories.markdown?.bytes,12);
    assert.equal(result.categories.cold_records?.files,1);assert.equal(result.categories.event_files?.files,1);
    assert.equal(result.categories.sqlite_sidecars?.bytes,3);
    const stats = result.databases.find(row=>row.file === "publication.db")!;
    assert.equal(stats.records,2);assert.equal(stats.referenced_record_range_bytes,42);
    assert.equal(stats.status,"measured");assert(Number(stats.index_pages)>0);assert(Number(stats.table_pages)>0);
    const before = process.env.PATH;process.env.PATH="/not-installed-capacity-tools";
    try {assert.equal(measureStorageCapacity(root).databases[0]?.status,"page_breakdown_unavailable");}
    finally {process.env.PATH=before;}
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("capacity reports measured empty roots, rejects special files and the CLI validates its root", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-capacity-empty-"));
  try {
    assert.equal(measureStorageCapacity(root).status, "measured");
    const fifo = join(root, "special.fifo");
    const created = spawnSync("mkfifo", [fifo]);
    assert.equal(created.status, 0, created.stderr.toString());
    assert.throws(() => measureStorageCapacity(root), /regular files/u);
    unlinkSync(fifo);
    const cli = join(import.meta.dirname, "../scripts/storage-capacity.ts");
    const valid = spawnSync(process.execPath, ["--experimental-strip-types", cli, `--root=${root}`], { encoding: "utf8" });
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(JSON.parse(valid.stdout).status, "measured");
    for (const args of [[], ["--root="], ["--other=x"]]) {
      const invalid = spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args], { encoding: "utf8" });
      assert.notEqual(invalid.status, 0);
      assert.match(invalid.stderr, /Usage: storage-capacity/u);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
