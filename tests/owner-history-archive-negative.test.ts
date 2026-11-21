import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import fs,{mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,symlinkSync,lstatSync,readdirSync} from "node:fs";
import {dirname,join} from "node:path";
import {tmpdir} from "node:os";
import {DatabaseSync} from "node:sqlite";
import test,{mock} from "node:test";
import {syncBuiltinESMExports} from "node:module";
import {gzipSync} from "node:zlib";
import {stableDigest} from "craft-common-base/digest";
import {craftPaths} from "../core/infrastructure/paths.ts";
import {archiveOwnerHistory,readArchivedHistory} from "../core/owner-history-archive.ts";
function database(file:string){mkdirSync(dirname(file),{recursive:true});const db=new DatabaseSync(file);db.exec("CREATE TABLE records(kind TEXT,id TEXT,version INTEGER,payload_json TEXT,created_at TEXT,updated_at TEXT,PRIMARY KEY(kind,id,version))");return db;}
function row(db:DatabaseSync,kind:string,id:string,payload:unknown,created="created",updated="updated"){db.prepare("INSERT INTO records VALUES(?,?,?,?,?,?)").run(kind,id,1,JSON.stringify(payload),created,updated);}

test("source classification preserves unsafe, unreadable and broken file-backed authorities as unavailable",async()=>{
 const temp=mkdtempSync(join(tmpdir(),"craft-history-bad-sources-")),paths=craftPaths(join(temp,"source")),db=database(paths.databaseFile),target=join(temp,"archive");
 try{
  const invalid=join(temp,"invalid.db"),linked=join(temp,"linked.db");writeFileSync(invalid,"synthetic invalid SQLite");symlinkSync(invalid,linked);
  row(db,"knowledge_claim","invalid",{scope:"global",_knowledge_partition:{file:invalid}});row(db,"knowledge_claim","unsafe",{scope:"global",_knowledge_partition:{file:linked}});
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);INSERT INTO meta VALUES('record_files','v2')");row(db,"workspace","broken_file",{_record_file:{path:"missing.json",digest:"synthetic"}});row(db,"scope_alias","broken_identity",{_record_file:{path:"missing-identity.json",digest:"synthetic"},scope:{kind:"project",id:"missing"}});row(db,"scope_alias","malformed_identity_ref",{_record_file:{path:17,digest:"synthetic"},scope:{kind:"project",id:"missing"}});
  mkdirSync(join(paths.root,"trace","v1"),{recursive:true});writeFileSync(join(paths.root,"trace","v1","ff.db"),"synthetic invalid shard database");
  const manifest=await archiveOwnerHistory(paths,target);assert(manifest.unavailable_sources.some(source=>source.code==="unsafe_source"));assert(manifest.unavailable_sources.some(source=>source.code==="unreadable_source"));assert(manifest.entries.every(entry=>entry.unresolved));assert.equal(manifest.record_count,5);for(const entry of manifest.entries)assert(readArchivedHistory(target,entry).payload_json);
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test("exact duplicate domain rows are counted once while payload and timestamp conflicts stay staged",async()=>{
 const temp=mkdtempSync(join(tmpdir(),"craft-history-domain-duplicates-")),paths=craftPaths(join(temp,"source")),db=database(paths.databaseFile),domainFile=join(paths.root,"domain.db"),domain=database(domainFile);
 try{
  row(db,"knowledge_claim","pointer",{_knowledge_partition:{file:domainFile},scope:"global"});row(domain,"knowledge_claim","pointer",{scope:"global",content:"synthetic domain"});
  for(const id of ["same","created","updated","payload"]){row(db,"craft_note",id,{value:"original"});row(domain,"craft_note",id,{value:id==="payload"?"shadow":"original"},id==="created"?"different":"created",id==="updated"?"different":"updated");}
  row(db,"task","task_fixture",{project_id:"project_fixture"});row(db,"trace","trace_fixture",{task_id:"task_fixture"});row(db,"telemetry_event","event_fixture",{trace_id:"trace_fixture"});
  const manifest=await archiveOwnerHistory(paths,join(temp,"archive"));assert.equal(manifest.entries.filter(entry=>entry.id==="same").length,1);for(const id of ["created","updated","payload"])assert.equal(manifest.entries.filter(entry=>entry.id===id && entry.state==="staged").length,1);
  for(const id of ["trace_fixture","event_fixture"])assert.equal(manifest.entries.find(entry=>entry.id===id)!.native_binding!.project_id,"project_fixture");
 }finally{domain.close();db.close();rmSync(temp,{recursive:true,force:true});}
});

test("cutoff identity conflicts and a project root becoming a file never publish a new manifest",async()=>{
 const temp=mkdtempSync(join(tmpdir(),"craft-history-cutoff-negative-")),paths=craftPaths(join(temp,"source")),db=database(paths.databaseFile),target=join(temp,"archive"),project=join(temp,"project");mkdirSync(project);
 try{
  row(db,"scope_alias","alias_fixture",{status:"active",alias_kind:"path",alias:project,alias_digest:stableDigest(project),scope:{kind:"project",id:"fixture"}});row(db,"knowledge_claim","claim",{scope:"project:fixture",content:"synthetic"});
  const first=await archiveOwnerHistory(paths,target),cutoff=join(target,"snapshots",`${first.cutoff.primary_snapshot_identity}.json`),original=readFileSync(cutoff);writeFileSync(cutoff,JSON.stringify({...first.cutoff,primary_snapshot_identity:"changed"}));await assert.rejects(archiveOwnerHistory(paths,target),/cutoff identity/u);writeFileSync(cutoff,original);
  await assert.rejects(archiveOwnerHistory(paths,join(temp,"changed-root"),{onProgress:progress=>{if(progress.phase==="source_verify"){rmSync(project,{recursive:true});writeFileSync(project,"synthetic non-directory");}}}),/Historical project root is unavailable/u);
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test("SQLite backup publication supports cross-filesystem copying and rejects other link failures",async()=>{
 const temp=mkdtempSync(join(tmpdir(),"craft-history-backup-link-")),paths=craftPaths(join(temp,"source")),db=database(paths.databaseFile);row(db,"craft_note","fixture",{value:"synthetic"});const original=fs.linkSync;
 try{
  const cross=mock.method(fs,"linkSync",(...args:Parameters<typeof fs.linkSync>)=>{if(String(args[1]).includes("/backups/"))throw Object.assign(new Error("synthetic cross-device"),{code:"EXDEV"});return original(...args);});syncBuiltinESMExports();const manifest=await archiveOwnerHistory(paths,join(temp,"cross"));assert.equal(lstatSync(join(temp,"cross",manifest.sources[0]!.backup)).mode&0o777,0o600);cross.mock.restore();syncBuiltinESMExports();
  const fail=mock.method(fs,"linkSync",(...args:Parameters<typeof fs.linkSync>)=>{if(String(args[1]).includes("/backups/"))throw Object.assign(new Error("synthetic backup IO"),{code:"EIO"});return original(...args);});syncBuiltinESMExports();await assert.rejects(archiveOwnerHistory(paths,join(temp,"failure")),/synthetic backup IO/u);fail.mock.restore();syncBuiltinESMExports();
  const gzip=await archiveOwnerHistory(paths,join(temp,"gzip"),{compressBackups:true});writeFileSync(join(temp,"gzip",gzip.sources[0]!.backup),gzipSync("synthetic wrong database"));await assert.rejects(archiveOwnerHistory(paths,join(temp,"gzip"),{compressBackups:true}),/backup conflict/u);
 }finally{mock.restoreAll();syncBuiltinESMExports();db.close();rmSync(temp,{recursive:true,force:true});}
});

test("gzip backup checks the disk reserve again during a large compressed stream and removes partial output",async()=>{
 const temp=mkdtempSync(join(tmpdir(),"craft-history-stream-reserve-")),paths=craftPaths(join(temp,"source")),db=database(paths.databaseFile);row(db,"craft_note","fixture",{binary_fixture:randomBytes(9*1024*1024).toString("hex")});const target=join(temp,"archive"),originalStream=fs.createWriteStream,originalStat=fs.statfsSync;let streaming=false;
 try{
  mock.method(fs,"createWriteStream",(...args:Parameters<typeof fs.createWriteStream>)=>{if(String(args[0]).includes("/backups/"))streaming=true;return originalStream(...args);});mock.method(fs,"statfsSync",(...args:Parameters<typeof fs.statfsSync>)=>{const result=originalStat(...args);return streaming?{...result,bavail:0}:result;});syncBuiltinESMExports();
  await assert.rejects(archiveOwnerHistory(paths,target,{compressBackups:true,minimumFreeBytes:1}),/free-space reserve/u);assert(streaming);assert(readdirSync(join(target,"backups")).every(name=>!name.endsWith(".tmp")));
 }finally{mock.restoreAll();syncBuiltinESMExports();db.close();rmSync(temp,{recursive:true,force:true});}
});
