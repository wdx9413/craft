import {createHash} from "node:crypto";
import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, {mock} from "node:test";
import {syncBuiltinESMExports} from "node:module";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { archiveOwnerHistory, readArchivedHistory } from "../core/owner-history-archive.ts";
function database(file:string):DatabaseSync {
  mkdirSync(join(file,".."),{recursive:true});
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE records(kind TEXT,id TEXT,version INTEGER,payload_json TEXT,created_at TEXT,updated_at TEXT)");
  return db;
}
function row(db:DatabaseSync,kind:string,id:string,version:number,payload:unknown):void {
  db.prepare("INSERT INTO records VALUES (?,?,?,?,?,?)").run(kind,id,version,JSON.stringify(payload),"original-created","original-updated");
}
test("copy-only history archive preserves every version, staged rows and owner boundaries",async()=>{
  const temp=mkdtempSync(join(tmpdir(),"craft-history-")), paths=craftPaths(join(temp,"source")), target=join(temp,"archive");
  const db=database(paths.databaseFile), partition=join(paths.root,"partitions","memory.db"), memory=database(partition);
  try {
    for (const kind of ["knowledge_claim","experience_procedure","craft_note","eval_contract","workspace_checkpoint","context_resume_snapshot","trace_event","unrecognized"]) {
      row(db,kind,kind,1,{status:"revoked",scope:{kind:"project",id:"missing-root"},definition:{nested:["original"]}});
      row(db,kind,kind,2,{status:"published",scope:{kind:"project",id:"missing-root"}});
    }
    row(db,"memory_ledger","memory",1,{_memory_partition:{file:partition,scope:{kind:"session",id:"session"}}});
    row(memory,"memory_ledger","memory",1,{scope:{kind:"session",id:"session"},status:"revoked",text:"synthetic retained history"});
    row(memory,"memory_candidate","staged",1,{scope:{kind:"session",id:"session"},status:"candidate"});
    const shards=database(join(paths.root,"trace","v1","01.db"));row(shards,"codex_hook_turn","turn",1,{status:"recorded"});shards.close();
    const before=readFileSync(paths.databaseFile);
    const first=await archiveOwnerHistory(paths,target);
    assert.deepEqual(readFileSync(paths.databaseFile),before);
    assert.equal(first.entries.length,19);
    assert.equal(first.entries.filter(item=>item.state === "staged").length,1);
    assert.equal(first.entries.find(item=>item.id === "memory")!.owner,"memory");
    const frozen=first.entries.find(item=>item.kind === "eval_contract" && item.version === 1)!;
    assert.equal((readArchivedHistory(target,frozen).payload as Record<string,unknown>).status,"revoked");
    assert.deepEqual(await archiveOwnerHistory(paths,target),first);
    assert.throws(()=>readArchivedHistory(target,{...frozen,file:"../outside"}),/escapes/u);
    assert.throws(()=>readArchivedHistory(target,{...frozen,version:99}),/identity/u);
    writeFileSync(join(target,frozen.file),"changed");
    assert.throws(()=>readArchivedHistory(target,frozen),/digest|range/u);
    await assert.rejects(archiveOwnerHistory(paths,target),/destination conflict/u);
    await assert.rejects(archiveOwnerHistory(paths,paths.root),/contains/u);
  } finally {db.close();memory.close();rmSync(temp,{recursive:true,force:true});}
});
test("missing published partition versions and unsafe sources are never called migrated",async()=>{
  const temp=mkdtempSync(join(tmpdir(),"craft-history-failure-")),paths=craftPaths(join(temp,"source"));
  const db=database(paths.databaseFile),partition=join(paths.root,"partition.db"),memory=database(partition);
  try {
    row(db,"memory_ledger","missing",1,{_memory_partition:{file:partition}});
    const incomplete=await archiveOwnerHistory(paths,join(temp,"archive"));assert.equal(incomplete.unavailable_count,1);assert.equal(incomplete.entries[0]!.unresolved,true);
    db.exec("DELETE FROM records");row(db,"memory_ledger","invalid",1,{_memory_partition:{file:"relative"}});
    const invalid=await archiveOwnerHistory(paths,join(temp,"archive"));assert.equal(invalid.unavailable_count,1);assert.equal(invalid.unavailable_sources[0]!.code,"invalid_partition_pointer");
    db.exec("DELETE FROM records");row(db,"fixture","safe",1,{});
    const archive=await archiveOwnerHistory(paths,join(temp,"archive"));
    const entry=archive.entries[0]!;
    rmSync(join(temp,"archive",entry.file));symlinkSync(paths.databaseFile,join(temp,"archive",entry.file));
    assert.throws(()=>readArchivedHistory(join(temp,"archive"),entry),/symbolic/u);
    db.exec("CREATE TABLE meta(key TEXT,value TEXT);INSERT INTO meta VALUES('record_files','unsupported')");
    await assert.rejects(archiveOwnerHistory(paths,join(temp,"unsupported")),/Unsupported historical/u);
  } finally {db.close();memory.close();rmSync(temp,{recursive:true,force:true});}
});

test("file-backed payloads and Markdown bytes remain authoritative in archives",async()=>{
  const { RecordFileStore } = await import("craft-common-store-local/record-files");
  const { MarkdownContentStore } = await import("craft-common-store-local/content-store");
  const temp=mkdtempSync(join(tmpdir(),"craft-history-files-")),paths=craftPaths(join(temp,"source")), target=join(temp,"archive");
  const db=database(paths.databaseFile),partition=join(paths.root,"memory","partition.db"),memory=database(partition);
  try {
    db.exec("CREATE TABLE meta(key TEXT,value TEXT);INSERT INTO meta VALUES('record_files','v1')");

    const ref=new MarkdownContentStore(paths).writeSync({kind:"knowledge",record_id:"doc",version:1,scope:"global",status:"published",sensitivity:"internal",source_id:"fixture",title:"Synthetic title",body:"Synthetic historical body"});
    const files=new RecordFileStore(paths.root,join(paths.databaseFile,".."));
    row(db,"scope_alias","old-alias",1,files.write("scope_alias","old-alias",1,{status:"revoked",scope:{kind:"global",id:"global"}},"created","updated"));
    row(db,"knowledge_claim","doc",1,files.write("knowledge_claim","doc",1,{metadata:{capability_owner:"knowledge"},scope:"global",content_ref:ref,steps:["original signed step"]},"original-created","original-updated"));
    row(db,"knowledge_memory_fixture","memory",1,{_memory_partition:{file:partition}});
    row(memory,"knowledge_memory_fixture","memory",1,new RecordFileStore(paths.root,join(paths.databaseFile,"..")).write("knowledge_memory_fixture","memory",1,{scope:"global",steps:["immutable"]},"original-created","original-updated"));
    const shard=database(join(paths.root,"codebase","legacy-graph-v1","01.db"));
    shard.exec("CREATE TABLE record_file_mode(version TEXT)");
    row(shard,"codebase_index_shard","shard",1,files.write("codebase_index_shard","shard",1,{scope:"global",definitions:["synthetic graph"]},"created","updated"));
    shard.close();
    const manifest=await archiveOwnerHistory(paths,target),entry=manifest.entries.find(e=>e.kind === "knowledge_claim")!;
    const archived=readArchivedHistory(target,entry);
    assert.deepEqual((archived.payload as any).steps,["original signed step"]);
    const attachment=(archived.attachments as any[])[0];
    assert.deepEqual(readFileSync(join(target,attachment.file)),readFileSync(ref.path));
    writeFileSync(join(target,attachment.file),"drift");
    assert.throws(()=>readArchivedHistory(target,entry),/attachment digest/u);
    db.exec("UPDATE records SET payload_json='{}' WHERE kind='knowledge_claim'");
    const output=await archiveOwnerHistory(paths,join(temp,"second"));
    assert.equal(output.entries.length,4);
  } finally {db.close();memory.close();rmSync(temp,{recursive:true,force:true});}
});


test("source increments and Markdown edits during export require a fresh snapshot",async()=>{
  const { MarkdownContentStore } = await import("craft-common-store-local/content-store");
  const temp=mkdtempSync(join(tmpdir(),"craft-history-increment-")),paths=craftPaths(join(temp,"source"));
  const db=database(paths.databaseFile);
  try {
    row(db,"knowledge_claim","first",1,{scope:"global"});
    const write=fs.writeFileSync;
    let changed=false;
    const mutation=mock.method(fs,"writeFileSync",(...args:Parameters<typeof fs.writeFileSync>)=>{
      write(...args);
      if (!changed) {changed=true;row(db,"knowledge_claim","after-snapshot",1,{scope:"global"});}
    });
    syncBuiltinESMExports();
    await assert.rejects(archiveOwnerHistory(paths,join(temp,"archive")),/source changed/u);
    mutation.mock.restore();syncBuiltinESMExports();
    const ref=new MarkdownContentStore(paths).writeSync({kind:"knowledge",record_id:"doc",version:1,scope:"global",status:"published",sensitivity:"internal",source_id:"fixture",title:"Synthetic",body:"Synthetic history"});
    row(db,"knowledge_claim","doc",1,{scope:"global",content_ref:ref});
    let edited=false;
    const mutateDocument=mock.method(fs,"writeFileSync",(...args:Parameters<typeof fs.writeFileSync>)=>{
      write(...args);
      if (!edited && String(args[0]).includes(".md.")) {edited=true;write(ref.path,readFileSync(ref.path,"utf8")+"changed");}
    });
    syncBuiltinESMExports();
    await assert.rejects(archiveOwnerHistory(paths,join(temp,"second")),/Markdown or record file changed/u);
    mutateDocument.mock.restore();syncBuiltinESMExports();
    const drifted=await archiveOwnerHistory(paths,join(temp,"third"));assert.equal(drifted.unavailable_count,1);
  } finally {mock.restoreAll();syncBuiltinESMExports();db.close();rmSync(temp,{recursive:true,force:true});}
});


test("chunk boundaries, invalid ranges and attachment traversal are enforced",async()=>{
  const temp=mkdtempSync("/tmp/craft-history-chunks-"), paths=craftPaths(join(temp,"source")),target=join(temp,"archive");
  const db=database(paths.databaseFile);
  try {
    db.exec("BEGIN");
    for(let n=0;n<1001;n++)row(db,"craft_note",`note-${n}`,1,{text:"合成历史"});
    row(db,"craft_note","large",1,{text:"x".repeat(8*1024*1024)});
    db.exec("COMMIT");
    const manifest=await archiveOwnerHistory(paths,target);
    assert(new Set(manifest.entries.map(e=>e.file)).size >= 2);
    const entry=manifest.entries.find(e=>e.id === "note-10")!;
    assert.equal((readArchivedHistory(target,entry).payload as any).text,"合成历史");
    assert.throws(()=>readArchivedHistory(target,{...entry,offset:-1}),/range invalid/u);
    assert.throws(()=>readArchivedHistory(target,{...entry,file:"notes"}),/regular file/u);
    const fake=readArchivedHistory(target,entry);
    fake.attachments=[{file:"../outside",digest:"unused"}];
    const content=JSON.stringify(fake);
    writeFileSync(join(target,"fake.jsonl"),content);
    assert.throws(()=>readArchivedHistory(target,{...entry,file:"fake.jsonl",offset:0,bytes:Buffer.byteLength(content),digest:createHash("sha256").update(content).digest("hex")}),/attachment escapes/u);
    mkdirSync(join(temp,"outside"));symlinkSync(join(temp,"outside"),join(temp,"linked"));
    await assert.rejects(archiveOwnerHistory(paths,join(temp,"linked")),/destination directory is unsafe/u);
  } finally {db.close();rmSync(temp,{recursive:true,force:true});}
});

test("archive CLI is explicit, copy only and rejects malformed arguments",async()=>{
  const {spawnSync}=await import("node:child_process");
  const temp=mkdtempSync(join(tmpdir(),"craft-history-cli-")),paths=craftPaths(join(temp,"source"));
  const db=database(paths.databaseFile);
  try {
    row(db,"craft_note","cli",1,{status:"revoked"});
    const invoke=(args:string[])=>spawnSync(process.execPath,["--experimental-strip-types",join(import.meta.dirname,"../scripts/owner-history-archive.ts"),...args],{encoding:"utf8"});
    const valid=invoke([`--data-root=${paths.root}`,`--destination=${join(temp,"archive")}`]);
    assert.equal(valid.status,0,valid.stderr);
    assert.deepEqual(JSON.parse(valid.stdout).source_switched,false);
    for(const args of [[],["bad","bad"],["--data-root=","--destination="],["--data-root=ok","bad"],["--data-root=ok","--destination="]])assert.notEqual(invoke(args).status,0);
  } finally {db.close();rmSync(temp,{recursive:true,force:true});}
});

test("event-only source increments and ambiguous evidence owners cannot bypass preservation",async()=>{
 const {verifyHistoryArchiveSources}=await import("../core/owner-history-archive.ts");
 const temp=mkdtempSync(join(tmpdir(),"craft-archive-events-")),paths=craftPaths(join(temp,"source"));
 const db=database(paths.databaseFile);
 try {
  db.exec("CREATE TABLE events(sequence INTEGER PRIMARY KEY,payload TEXT);INSERT INTO events VALUES(9223372036854775807,'before');CREATE TABLE fixed(a TEXT,b INTEGER,payload TEXT,PRIMARY KEY(a,b)) WITHOUT ROWID;INSERT INTO fixed VALUES('a',1,'synthetic')");
  row(db,"knowledge_claim","one",1,{scope:"global",evidence_ids:["unique","shared",1]});
  row(db,"memory_ledger","two",1,{scope:"global",evidence_ids:["shared"]});
  for(const id of ["unique","shared","orphan"])row(db,"evidence",id,1,{metadata:{scope:"global"}});
  const manifest=await archiveOwnerHistory(paths,join(temp,"archive"));
  assert.equal(manifest.entries.find(e=>e.id === "unique")!.owner,"knowledge");
  assert.equal(manifest.entries.find(e=>e.id === "shared")!.owner,"unresolved");
  assert.equal(manifest.entries.find(e=>e.id === "orphan")!.owner,"unresolved");
  db.exec("UPDATE events SET payload='after'");
  assert.throws(()=>verifyHistoryArchiveSources(manifest),/source changed/u);
  assert.throws(()=>verifyHistoryArchiveSources({...manifest,digest:"bad"}),/manifest digest/u);
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test("large manifests use bounded index blocks instead of a giant entries array",async()=>{
 const {historyArchiveEntries}=await import("../core/owner-history-archive.ts");
 const temp=mkdtempSync(join(tmpdir(),"craft-history-index-")),paths=craftPaths(join(temp,"source")),target=join(temp,"archive");
 const db=database(paths.databaseFile);
 try{
  db.exec("BEGIN");for(let n=0;n<10001;n++)row(db,"craft_note",`note-${String(n).padStart(6,"0")}`,1,{scope:"global",text:"synthetic"});db.exec("COMMIT");
  const manifest=await archiveOwnerHistory(paths,target);
  assert.equal(manifest.entries.length,0);assert.equal(manifest.record_count,10001);assert.equal(manifest.entry_files.length,11);
  let count=0;for(const entry of historyArchiveEntries(target,manifest)){if(count === 10000)assert.equal(readArchivedHistory(target,entry).id,"note-010000");count++;}
  assert.equal(count,10001);
  const first=manifest.entry_files[0]!;
  const original=readFileSync(join(target,first.file));
  assert.throws(()=>[...historyArchiveEntries(target,{...manifest,entry_files:[{...first,file:"../outside"}]})],/index escapes/u);
  assert.throws(()=>[...historyArchiveEntries(target,{...manifest,entry_files:[{...first,count:first.count+1}]})],/index count/u);
  writeFileSync(join(target,first.file),"corrupt");assert.throws(()=>[...historyArchiveEntries(target,manifest)],/index digest/u);
  writeFileSync(join(target,first.file),original);
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test("archive publication retries races and IO failures without exposing partial records",async()=>{
 const temp=mkdtempSync(join(tmpdir(),"craft-archive-io-")),paths=craftPaths(join(temp,"source")),target=join(temp,"archive");const db=database(paths.databaseFile);
 const originalLink=fs.linkSync,originalWrite=fs.writeFileSync;
 try{
  row(db,"craft_note","fixture",1,{scope:"global"});
  let raced=false;
  const race=mock.method(fs,"linkSync",(...args:Parameters<typeof fs.linkSync>)=>{originalLink(...args);if(!raced){raced=true;throw Object.assign(new Error("race"),{code:"EEXIST"});}});syncBuiltinESMExports();
  const manifest=await archiveOwnerHistory(paths,target);race.mock.restore();syncBuiltinESMExports();
  const entry=manifest.entries[0]!;
  const zero=mock.method(fs,"readSync",()=>0);syncBuiltinESMExports();assert.throws(()=>readArchivedHistory(target,entry),/truncated/u);zero.mock.restore();syncBuiltinESMExports();
  const data=readFileSync(join(target,entry.file));data[entry.offset]=data[entry.offset] === 32 ? 33 : 32;writeFileSync(join(target,entry.file),data);assert.throws(()=>readArchivedHistory(target,entry),/digest/u);
  const failure=mock.method(fs,"linkSync",()=>{throw new Error("synthetic IO failure");});syncBuiltinESMExports();
  await assert.rejects(archiveOwnerHistory(paths,join(temp,"failed")),/synthetic IO/u);failure.mock.restore();syncBuiltinESMExports();
  const disk=mock.method(fs,"writeFileSync",(...args:Parameters<typeof fs.writeFileSync>)=>{if(String(args[0]).endsWith(".tmp"))throw new Error("synthetic disk full");return originalWrite(...args);});syncBuiltinESMExports();
  await assert.rejects(archiveOwnerHistory(paths,join(temp,"disk-full")),/disk full/u);disk.mock.restore();syncBuiltinESMExports();
  assert.equal((await archiveOwnerHistory(paths,join(temp,"failed"))).record_count,1);
 }finally{mock.restoreAll();syncBuiltinESMExports();db.close();rmSync(temp,{recursive:true,force:true});}
});

test("unavailable external authority is retained as diagnostics and never imported as fabricated content",async()=>{
 const {importOwnerHistory}=await import("../core/owner-history-import.ts");
 const {MarkdownContentStore}=await import("craft-common-store-local/content-store");
 const temp=mkdtempSync(join(tmpdir(),"craft-history-unavailable-")),paths=craftPaths(join(temp,"source")),archive=join(temp,"archive");const db=database(paths.databaseFile);
 try{
  const missing=join(paths.root,"missing-partition.db");row(db,"memory_ledger","missing-partition",1,{_memory_partition:{file:missing,scope:{kind:"project",id:"unknown"}}});
  const ref=new MarkdownContentStore(paths).writeSync({kind:"knowledge",record_id:"missing-body",version:1,scope:"global",status:"published",sensitivity:"internal",source_id:"fixture",body:"Synthetic body"});
  row(db,"knowledge_claim","missing-body",1,{scope:"global",content_ref:ref,status:"reviewed"});rmSync(ref.path);
  const result=await archiveOwnerHistory(paths,archive);assert.equal(result.unavailable_count,2);assert(result.entries.every(entry=>entry.unresolved && entry.availability === "unavailable"));
  const record=readArchivedHistory(archive,result.entries.find(entry=>entry.id === "missing-partition")!);assert.equal((record.payload as any)._memory_partition.file,missing);assert.equal((record.diagnostics as any[])[0].code,"missing_file");
  assert.deepEqual(await importOwnerHistory(archive,result,join(temp,"staging")),{imported:0,already_present:0,quarantined:2});
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test("copy-only source delta is explicit while strict cutover verification remains blocked",async()=>{
 const {verifyHistoryArchiveSources}=await import("../core/owner-history-archive.ts");
 const temp=mkdtempSync(join(tmpdir(),"craft-history-delta-")),paths=craftPaths(join(temp,"source"));const db=database(paths.databaseFile),write=fs.writeFileSync;
 try{
  row(db,"task","first",1,{project_id:"original-project",status:"open"});let changed=false;
  const mutation=mock.method(fs,"writeFileSync",(...args:Parameters<typeof fs.writeFileSync>)=>{write(...args);if(!changed){changed=true;row(db,"task","after-cutoff",1,{project_id:"original-project",status:"open"});}});syncBuiltinESMExports();
  const result=await archiveOwnerHistory(paths,join(temp,"archive"),{allowSourceDrift:true});mutation.mock.restore();syncBuiltinESMExports();
  assert.equal(result.source_validation,"changed");assert(result.cutoff.primary_snapshot_identity);assert.equal(result.record_count,1);assert.throws(()=>verifyHistoryArchiveSources(result),/source changed/u);
 }finally{mock.restoreAll();syncBuiltinESMExports();db.close();rmSync(temp,{recursive:true,force:true});}
});

test("large database backups support gzip bytes verification and a strict disk reserve",async()=>{
 const {gunzipSync}=await import("node:zlib");
 const temp=mkdtempSync(join(tmpdir(),"craft-history-gzip-")),paths=craftPaths(join(temp,"source")),target=join(temp,"archive");const db=database(paths.databaseFile);
 try{
  row(db,"task","fixture",1,{project_id:"synthetic-project",status:"open"});
  await assert.rejects(archiveOwnerHistory(paths,join(temp,"invalid"),{minimumFreeBytes:-1}),/reserve is invalid/u);
  await assert.rejects(archiveOwnerHistory(paths,join(temp,"insufficient"),{minimumFreeBytes:Number.MAX_SAFE_INTEGER}),/reserve would be exceeded/u);
  const first=await archiveOwnerHistory(paths,target,{compressBackups:true,minimumFreeBytes:1});
  assert.equal(first.sources[0]!.backup_encoding,"gzip");const backup=join(target,first.sources[0]!.backup);assert.equal(gunzipSync(readFileSync(backup)).subarray(0,15).toString(),"SQLite format 3");
  assert.deepEqual(await archiveOwnerHistory(paths,target,{compressBackups:true}),first);
  writeFileSync(backup,"corrupt");await assert.rejects(archiveOwnerHistory(paths,target,{compressBackups:true}));
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test("FTS virtual tables seal persisted shadow rows even without the SQLite extension",async()=>{
 const {execFileSync}=await import("node:child_process");
 const {verifyHistoryArchiveSources}=await import("../core/owner-history-archive.ts");
 const temp=mkdtempSync(join(tmpdir(),"craft-history-fts-")),paths=craftPaths(join(temp,"source")),db=database(paths.databaseFile);
 row(db,"craft_note","fts_fixture",1,{text:"synthetic"});db.close();
 try{
  execFileSync("/usr/bin/sqlite3",[paths.databaseFile,"CREATE VIRTUAL TABLE synthetic_search USING fts5(body); INSERT INTO synthetic_search(body) VALUES('synthetic initial');"]);
  const manifest=await archiveOwnerHistory(paths,join(temp,"archive"));verifyHistoryArchiveSources(manifest);
  execFileSync("/usr/bin/sqlite3",[paths.databaseFile,"INSERT INTO synthetic_search(body) VALUES('synthetic changed');"]);
  assert.throws(()=>verifyHistoryArchiveSources(manifest),/source changed/u);
 }finally{rmSync(temp,{recursive:true,force:true});}
});

test("legacy registry and governance record types retain their exact capability owner",async()=>{
 const temp=mkdtempSync(join(tmpdir(),"craft-history-owner-types-")),paths=craftPaths(join(temp,"source")),db=database(paths.databaseFile);
 try{
  const kinds:Record<string,string>={procedure_configuration:"experience",legacy_knowledge_migration_receipt:"knowledge",source:"runtime",workflow:"runtime",workflow_evolution_trial:"experience",knowledge_memory_link:"memory",maintenance_component:"runtime",activation_proof_receipt:"context",project:"runtime",workbench_evaluation:"eval",custom_fixture:"notes"};
  for(const [kind,expected] of Object.entries(kinds))row(db,kind,kind,1,{scope:"global",...(kind === "custom_fixture"?{metadata:{capability_owner:expected}}:{})});
  const manifest=await archiveOwnerHistory(paths,join(temp,"archive"));
  for(const entry of manifest.entries)assert.equal(entry.owner,kinds[entry.kind]);
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test("legacy graph authority validates both graph formats and optional route members",async()=>{
 const {codebaseGraphMatches}=await import("../core/owner-history-codebase.ts");
 const {stableDigest,stableDigestStreaming,digestJson}=await import("craft-common-base/digest");
 const graph={nodes:[],edges:[]};
 for(const [storage,hash] of [["sharded-v1",stableDigest(graph)],["project-sharded-v5",digestJson(graph)]]){
  const payload={...graph,node_count:0,edge_count:0,graph_digest:hash};assert(codebaseGraphMatches("codebase_index_shard",storage!,hash!,payload));
  for(const invalid of [{...payload,nodes:null},{...payload,edges:null},{...payload,node_count:1},{...payload,edge_count:1},{...payload,graph_digest:"changed"}])assert.equal(codebaseGraphMatches("codebase_index_shard",storage!,hash!,invalid),false);
 }
 for(const body of [{bucket:"synthetic",incoming:[],outgoing:[]},{index_id:"index",bucket:"synthetic",nodes:[],incoming:[],outgoing:[],locations:[]}]){
  const hash=stableDigestStreaming(body);assert(codebaseGraphMatches("codebase_index_edge_route","project-sharded-v5",hash,{...body,route_digest:hash}));assert.equal(codebaseGraphMatches("codebase_index_edge_route","project-sharded-v5",hash,{...body,route_digest:"changed"}),false);
 }
});
