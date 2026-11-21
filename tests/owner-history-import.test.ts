import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, {mock} from "node:test";
import {spawnSync} from "node:child_process";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { archiveOwnerHistory } from "../core/owner-history-archive.ts";
import { importOwnerHistory } from "../core/owner-history-import.ts";
import { ownedCatalogFile } from "../core/infrastructure/owned-catalog.ts";
import { MarkdownContentStore } from "craft-common-store-local/content-store";

test("owner staging import preserves exact versions and lifecycle, retries and normal Store history",async()=>{
 const temp=mkdtempSync(join(tmpdir(),"craft-history-import-")),paths=craftPaths(join(temp,"source")),archive=join(temp,"archive"),target=join(temp,"target");
 mkdirSync(dirname(paths.databaseFile),{recursive:true});const db=new DatabaseSync(paths.databaseFile);
 db.exec("CREATE TABLE records(kind TEXT,id TEXT,version INTEGER,payload_json TEXT,created_at TEXT,updated_at TEXT)");
 try {
  const content=new MarkdownContentStore(paths);
  for(const version of [1,2]) {
   const ref=content.writeSync({kind:"knowledge",record_id:"claim",version,scope:"global",status:version === 1 ? "published":"revoked",sensitivity:"internal",source_id:"fixture",title:"Fixture",body:`Synthetic body ${version}`});
   db.prepare("INSERT INTO records VALUES (?,?,?,?,?,?)").run("knowledge_claim","claim",version,JSON.stringify({scope:"global",source_id:"fixture",status:version === 1 ? "published":"revoked",content_ref:ref}),"created-original","updated-original");
  }
  db.prepare("INSERT INTO records VALUES (?,?,?,?,?,?)").run("knowledge_source","fixture",1,JSON.stringify({scope:"global",status:"active",trust:"trusted",source_type:"fixture"}),"created","updated");
  db.prepare("INSERT INTO records VALUES (?,?,?,?,?,?)").run("unknown_kind","unknown",1,"{}","created","updated");
  const manifest=await archiveOwnerHistory(paths,archive),sourceBytes=readFileSync(paths.databaseFile);
  assert.deepEqual(await importOwnerHistory(archive,manifest,target),{imported:3,already_present:0,quarantined:1});
  const invoke=(args:string[])=>spawnSync(process.execPath,["--experimental-strip-types",join(import.meta.dirname,"../scripts/owner-history-import.ts"),...args],{encoding:"utf8"});
  const cli=invoke([`--archive=${archive}`,`--manifest=manifest-${manifest.digest}.json`,`--destination=${join(temp,"cli-target")}`]);
  assert.equal(cli.status,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).imported,3);
  for(const args of [[],["bad","bad","bad"],["--archive=","--manifest=bad","--destination="],["--archive=ok","bad","bad"],["--archive=ok","--manifest=manifest-"+"a".repeat(64)+".json","bad"],["--archive=ok","--manifest=bad","--destination=ok"],["--archive=ok","--manifest=manifest-"+"a".repeat(64)+".json","--destination="]])assert.notEqual(invoke(args).status,0);

  assert.deepEqual(await importOwnerHistory(archive,manifest,target),{imported:0,already_present:3,quarantined:1});
  assert.deepEqual(readFileSync(paths.databaseFile),sourceBytes);
  const owned={...craftPaths(target),databaseFile:ownedCatalogFile(target,"knowledge"),databaseDir:join(target,"knowledge")};
  const store=await new CraftStore(owned).open({fileRecords:true});
  try {
   assert.equal(store.get("knowledge_claim","claim",1).content,"Synthetic body 1");
   assert.equal(store.get("knowledge_claim","claim").status,"revoked");
   assert.equal(store.get("knowledge_claim","claim",1).created_at,"created-original");
   assert.equal(store.history("knowledge_claim","claim",3,10).length,2);
   const original=JSON.parse(readFileSync(join(archive,manifest.entries.find(e=>e.id === "claim")!.file),"utf8").split("\n")[0]!).attachments[0];
   assert.deepEqual(readFileSync((store.get("knowledge_claim","claim",1).content_ref as any).path),readFileSync(join(archive,original.file)));

  } finally {store.close();}
  const input=JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"craft_knowledge_claim_get",arguments:{claim_id:"claim",version:1,scope_kind:"global",scope_id:"global"}}})+"\n";
  const child=spawnSync(process.execPath,["--experimental-strip-types",join(import.meta.dirname,"../bin/craft-mcp.ts"),"--product","knowledge"],{input,encoding:"utf8",timeout:20000,env:{...process.env,CRAFT_DATA_DIR:target,CRAFT_STORAGE_OWNER:"knowledge",CRAFT_CONTINUOUS_LEARNING:"0"}});
  assert.equal(child.status,0,child.stderr);
  const reply=JSON.parse(child.stdout.trim());
  assert.equal(reply.result.isError,false,JSON.stringify(reply));
  assert.equal(reply.result.structuredContent.claim.content,"Synthetic body 1");
 } finally {db.close();rmSync(temp,{recursive:true,force:true});}
});

test("staging importer fails closed on marker, version, attachment and manifest conflicts",async()=>{
 const {writeFileSync,symlinkSync}=await import("node:fs");
 const {createHash}=await import("node:crypto");
 const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
 const temp=mkdtempSync(join(tmpdir(),"craft-import-conflicts-")),paths=craftPaths(join(temp,"source")),archive=join(temp,"archive"),target=join(temp,"target");
 mkdirSync(dirname(paths.databaseFile),{recursive:true});const db=new DatabaseSync(paths.databaseFile);
 db.exec("CREATE TABLE records(kind TEXT,id TEXT,version INTEGER,payload_json TEXT,created_at TEXT,updated_at TEXT)");
 try {
  const content=new MarkdownContentStore(paths),ref=content.writeSync({kind:"knowledge",record_id:"claim",version:1,scope:"global",status:"published",sensitivity:"internal",source_id:"fixture",title:"Fixture",body:"Synthetic body"});
  writeFileSync(ref.path,readFileSync(ref.path,"utf8").replace(/^title:.*\n/mu,""));
  db.prepare("INSERT INTO records VALUES (?,?,?,?,?,?)").run("knowledge_claim","claim",1,JSON.stringify({scope:"global",content_ref:ref,tags:["synthetic"],enabled:true}),"created","updated");
  const manifest=await archiveOwnerHistory(paths,archive);
  await assert.rejects(importOwnerHistory(archive,{...manifest,schema:"bad" as "craft.owner-history-archive.v1"},target),/Unsupported/u);
  await assert.rejects(importOwnerHistory(archive,manifest,join(archive,"nested")),/separate staging/u);
  await assert.rejects(importOwnerHistory(archive,manifest,join(paths.root,"nested")),/separate staging/u);
  await assert.rejects(importOwnerHistory(archive,{...manifest,digest:"bad"},target),/manifest digest/u);
  await assert.rejects(importOwnerHistory(archive,manifest,archive),/separate staging/u);
  mkdirSync(join(temp,"occupied"));writeFileSync(join(temp,"occupied","file"),"existing");
  await assert.rejects(importOwnerHistory(archive,manifest,join(temp,"occupied")),/nonempty/u);
  mkdirSync(join(temp,"real"));symlinkSync(join(temp,"real"),join(temp,"linked"));
  await assert.rejects(importOwnerHistory(archive,manifest,join(temp,"linked")),/unsafe/u);
  await importOwnerHistory(archive,manifest,target);
  writeFileSync(join(target,".craft-history-import"),"different");
  await assert.rejects(importOwnerHistory(archive,manifest,target),/marker conflicts/u);
  writeFileSync(join(target,".craft-history-import"),manifest.digest);
  writeFileSync(join(target,"knowledge",".craft-storage-owner"),"v1:memory\n");
  await assert.rejects(importOwnerHistory(archive,manifest,target),/owner marker/u);
  writeFileSync(join(target,"knowledge",".craft-storage-owner"),"v1:knowledge\n");
  const catalog=new DatabaseSync(ownedCatalogFile(target,"knowledge"));
  const projection=JSON.parse(String(catalog.prepare("SELECT payload_json FROM records").get()!.payload_json));
  const stored=JSON.parse(readFileSync(join(target,projection._record_file.path),"utf8"));
  const md=stored.payload.content_ref.path,original=readFileSync(md);
  writeFileSync(md,"changed");
  await assert.rejects(importOwnerHistory(archive,manifest,target),/Markdown destination conflicts/u);
  writeFileSync(md,original);
  catalog.exec("UPDATE records SET payload_json='{}'");catalog.close();
  await assert.rejects(importOwnerHistory(archive,manifest,target),/existing version conflicts/u);
  const entry=manifest.entries[0]!,record=JSON.parse(readFileSync(join(archive,entry.file),"utf8"));
  record.attachments=[];const bytes=JSON.stringify(record);writeFileSync(join(archive,"missing.jsonl"),bytes);
  const {digest:ignored,...body}=manifest;
  const changed={...body,entries:[{...entry,file:"missing.jsonl",offset:0,bytes:Buffer.byteLength(bytes),digest:sha(bytes)}]};
  await assert.rejects(importOwnerHistory(archive,{...changed,digest:sha(JSON.stringify(changed))},join(temp,"missing")),/attachment missing/u);
 } finally {db.close();rmSync(temp,{recursive:true,force:true});}
});

test("verified project roots and identity lifecycle migrate to standalone normal reads",async()=>{
 const {stableDigest}=await import("craft-common-base/digest");
 const {sessionStorageScopeId}=await import("craft-common-store-local/paths");
 const temp=mkdtempSync(join(tmpdir(),"craft-import-project-")),project=join(temp,"project"),paths=craftPaths(join(temp,"source")),archive=join(temp,"archive"),target=join(temp,"target");
 mkdirSync(project);mkdirSync(dirname(paths.databaseFile),{recursive:true});const db=new DatabaseSync(paths.databaseFile);
 db.exec("CREATE TABLE records(kind TEXT,id TEXT,version INTEGER,payload_json TEXT,created_at TEXT,updated_at TEXT)");
 const insert=(kind:string,id:string,payload:unknown,version=1)=>db.prepare("INSERT INTO records VALUES(?,?,?,?,?,?)").run(kind,id,version,JSON.stringify(payload),"created","updated");
 try {
  insert("scope_alias","project-path",{status:"active",alias_kind:"path",alias:project,alias_digest:stableDigest(project),scope:{kind:"project",id:"project-fixture"}});
  insert("scope_alias","project-path-prefixed",{status:"active",alias_kind:"path",alias:project,alias_digest:stableDigest(project),scope:{kind:"project",id:"project:project-fixture"}});
  insert("scope_alias","revoked-path",{status:"revoked",alias_kind:"path",alias:join(temp,"missing"),alias_digest:stableDigest(join(temp,"missing")),scope:{kind:"project",id:"missing"}});
  const content=new MarkdownContentStore(paths);
  content.setSessionMemoryDirectoryResolver(id=>join(paths.root,"sessions",id,"memory","md"));
  for(const [kind,id,scope] of [["knowledge","claim","project:project-fixture"],["memory","memory","project:project-fixture"],["experience","procedure","project:project-fixture"],["memory","session",`session:${sessionStorageScopeId("codex","fixture-session")}`]] as const){
   const ref=content.writeSync({kind,record_id:id,version:1,scope,status:"published",sensitivity:"internal",source_id:"fixture",title:"Synthetic project",body:`Synthetic ${id}`});
   insert(kind === "knowledge" ? "knowledge_claim" : kind === "memory" ? "memory_ledger" : "experience_procedure",id,{scope,content_ref:ref,status:"published",source_id:"fixture"});
  }
  const definition={schema_version:"craft.procedure.v1",procedure_id:"project-definition",procedure_version:1,kind:"graph",scope:"project:project-fixture",trigger:"synthetic",preconditions:[],allowed_effects:[],acceptance_ref:"synthetic",failure_disposition:"stop",scenario_signature:{key:"synthetic"},evidence_ids:[],proposal_ref:{id:"proposal",version:1},definition:{graph_control:{}}};
  const definitionPath=join(paths.root,"definition.json");(await import("node:fs")).writeFileSync(definitionPath,JSON.stringify(definition));
  insert("experience_procedure","project-definition",{scope:definition.scope,status:"published",definition_ref:{format:"json",procedure_id:definition.procedure_id,procedure_version:1,kind:"graph",scope:definition.scope,path:definitionPath,digest:stableDigest(definition)}});
  insert("knowledge_claim","missing",{scope:"project:missing",status:"published"});
  insert("knowledge_source","fixture",{scope:"global",status:"active",trust:"trusted",source_type:"fixture"});
  const manifest=await archiveOwnerHistory(paths,archive);
  assert.equal(manifest.entries.find(entry=>entry.id === "missing")!.unresolved,true);
  assert.equal(manifest.entries.find(entry=>entry.id === "claim")!.unresolved,false);
  const result=await importOwnerHistory(archive,manifest,target);
  assert.equal(result.quarantined,1);
  await importOwnerHistory(archive,manifest,target);
  const request=JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"craft_knowledge_claim_get",arguments:{claim_id:"claim",version:1,scope_kind:"project",scope_id:"project-fixture"}}})+"\n";
  const child=spawnSync(process.execPath,["--experimental-strip-types",join(import.meta.dirname,"../bin/craft-mcp.ts"),"--product","knowledge"],{input:request,encoding:"utf8",timeout:20000,env:{...process.env,CRAFT_DATA_DIR:target,CRAFT_STORAGE_OWNER:"knowledge",CRAFT_CONTINUOUS_LEARNING:"0"}});
  assert.equal(child.status,0,child.stderr);const reply=JSON.parse(child.stdout.trim());assert.equal(reply.result.isError,false,JSON.stringify(reply));assert.equal(reply.result.structuredContent.claim.content,"Synthetic claim");

  for(const [owner,kind,id] of [["knowledge","knowledge_claim","claim"],["memory","memory_ledger","memory"],["experience","experience_procedure","procedure"],["memory","memory_ledger","session"]] as const){
   const owned={...craftPaths(target),databaseFile:ownedCatalogFile(target,owner),databaseDir:join(target,owner)};
   const store=await new CraftStore(owned).open({fileRecords:true});
   try {assert.equal(kind === "experience_procedure" ? store.contentStore.readSync(store.get(kind,id).content_ref as any).body : store.get(kind,id).content,`Synthetic ${id}`);assert.equal(store.get("scope_alias","revoked-path").status,"revoked");}
   finally{store.close();}
  }
 } finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test("staging machine locators rebase for atomic rename and recover before a failed switch",async()=>{
 const {renameSync}=await import("node:fs");
 const {rebaseImportedHistory}=await import("../core/owner-history-rebase.ts");
 const temp=mkdtempSync(join(tmpdir(),"craft-history-rebase-")),paths=craftPaths(join(temp,"source")),archive=join(temp,"archive"),staging=join(temp,"staging"),final=join(temp,"final");
 mkdirSync(dirname(paths.databaseFile),{recursive:true});const db=new DatabaseSync(paths.databaseFile);
 db.exec("CREATE TABLE records(kind TEXT,id TEXT,version INTEGER,payload_json TEXT,created_at TEXT,updated_at TEXT)");
 try {
  const ref=new MarkdownContentStore(paths).writeSync({kind:"knowledge",record_id:"claim",version:1,scope:"global",status:"published",sensitivity:"internal",source_id:"fixture",title:"Synthetic",body:"Synthetic immutable body"});
  db.prepare("INSERT INTO records VALUES(?,?,?,?,?,?)").run("knowledge_claim","claim",1,JSON.stringify({scope:"global",content_ref:ref,status:"published",tags:["synthetic"],signed_material:{signature:"original-signature",value:"frozen"}}),"created","updated");
  const manifest=await archiveOwnerHistory(paths,archive);await importOwnerHistory(archive,manifest,staging);
  const first=rebaseImportedHistory(staging,final);assert.equal(first.changed,1);assert.equal(first.revalidation_required[0]!.id,"claim");
  assert.equal(rebaseImportedHistory(staging,final).changed,0);
  assert.equal(rebaseImportedHistory(staging,staging).changed,1);
  rebaseImportedHistory(staging,final);renameSync(staging,final);
  const owned={...craftPaths(final),databaseFile:ownedCatalogFile(final,"knowledge"),databaseDir:join(final,"knowledge")};
  const store=await new CraftStore(owned).open({fileRecords:true});
  try {const saved=store.get("knowledge_claim","claim");assert.equal(saved.content,"Synthetic immutable body");assert.deepEqual(saved.signed_material,{signature:"original-signature",value:"frozen"});assert.equal(saved.status,"published");}
  finally{store.close();}
 } finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test("legacy JSON procedures and special shard histories survive independent import",async()=>{
 const {stableDigest}=await import("craft-common-base/digest");
 const {ProcedureDefinitionStore}=await import("@craft/capability-experience/procedure-definition");
 const {writeFileSync}=await import("node:fs");
 const temp=mkdtempSync(join(tmpdir(),"craft-import-definitions-")),paths=craftPaths(join(temp,"source")),archive=join(temp,"archive"),target=join(temp,"target");
 mkdirSync(dirname(paths.databaseFile),{recursive:true});const db=new DatabaseSync(paths.databaseFile);
 db.exec("CREATE TABLE records(kind TEXT,id TEXT,version INTEGER,payload_json TEXT,created_at TEXT,updated_at TEXT)");
 try {
  const definition={schema_version:"craft.procedure.v1",procedure_id:"workflow-fixture",procedure_version:1,kind:"workflow",scope:"global",trigger:"synthetic",preconditions:[],allowed_effects:[],acceptance_ref:"synthetic",failure_disposition:"stop",scenario_signature:{key:"synthetic"},evidence_ids:[],proposal_ref:{id:"proposal",version:1},definition:{steps:["immutable"]}};
  const path=join(paths.experienceDir,"graph","workflow-fixture","versions","000001.json");mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(definition,null,2)+"\n");
  const ref={format:"json",procedure_id:definition.procedure_id,procedure_version:1,kind:"workflow",scope:"global",path,digest:stableDigest(definition)};
  db.prepare("INSERT INTO records VALUES(?,?,?,?,?,?)").run("experience_procedure","workflow-fixture",1,JSON.stringify({scope:"global",definition_ref:ref,status:"published"}),"created","updated");
  const shardFile=join(paths.root,"codebase","legacy-graph-v1","01.db");mkdirSync(dirname(shardFile),{recursive:true});const shard=new DatabaseSync(shardFile);
  shard.exec("CREATE TABLE records(kind TEXT,id TEXT,version INTEGER,payload_json TEXT,created_at TEXT,updated_at TEXT)");
  for(const version of [1,2])shard.prepare("INSERT INTO records VALUES(?,?,?,?,?,?)").run("codebase_index_shard","graph",version,JSON.stringify({scope:"global",symbols:[`symbol-${version}`]}),"created","updated");shard.close();
  const manifest=await archiveOwnerHistory(paths,archive);
  await importOwnerHistory(archive,manifest,target);await importOwnerHistory(archive,manifest,target);
  const {rebaseImportedHistory}=await import("../core/owner-history-rebase.ts");rebaseImportedHistory(target,join(temp,"rebased"));rebaseImportedHistory(target,target);
  for(const owner of ["experience","codebase"] as const){
   const owned={...craftPaths(target),databaseFile:ownedCatalogFile(target,owner),databaseDir:join(target,owner)};
   const store=await new CraftStore(owned).open({fileRecords:true});
   try{
    if(owner === "experience") {const saved=store.get("experience_procedure","workflow-fixture");assert.deepEqual(new ProcedureDefinitionStore(store).read(saved.definition_ref as any),definition);assert.deepEqual(readFileSync((saved.definition_ref as any).path),readFileSync(path));}
    else{assert.deepEqual(store.get("codebase_index_shard","graph",1).symbols,["symbol-1"]);assert.equal(store.list("codebase_index_shard",10).length,1);assert.equal(store.history("codebase_index_shard","graph",3,10).length,2);}
   }finally{store.close();}
  }
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test("legacy inline knowledge and memory prose migrates to Markdown without changing archived history",async()=>{
 const {writeFileSync}=await import("node:fs");
 const temp=mkdtempSync(join(tmpdir(),"craft-import-prose-")),paths=craftPaths(join(temp,"source")),archive=join(temp,"archive"),target=join(temp,"target");
 mkdirSync(dirname(paths.databaseFile),{recursive:true});const db=new DatabaseSync(paths.databaseFile);
 db.exec("CREATE TABLE records(kind TEXT,id TEXT,version INTEGER,payload_json TEXT,created_at TEXT,updated_at TEXT)");
 try{
  for(const kind of ["knowledge_claim","memory_ledger","episodic_memory","semantic_memory"]){
   const scope=kind === "memory_ledger" ? {kind:"global",id:"global"} : kind === "episodic_memory" ? {kind:"user",id:"fixture"} : "global";
   db.prepare("INSERT INTO records VALUES(?,?,?,?,?,?)").run(kind,kind,1,JSON.stringify({scope,content:`Synthetic inline ${kind}`,status:"candidate",title:"Synthetic",source_id:"fixture",sensitivity:"internal"}),"created","updated");
  }
  const wiki=join(temp,"legacy-wiki.md");writeFileSync(wiki,"Synthetic legacy wiki");
  db.prepare("INSERT INTO records VALUES(?,?,?,?,?,?)").run("wiki_page","wiki",1,JSON.stringify({scope:"global",file_path:wiki}),"created","updated");
  const manifest=await archiveOwnerHistory(paths,archive);await importOwnerHistory(archive,manifest,target);await importOwnerHistory(archive,manifest,target);
  for(const owner of ["knowledge","memory"] as const){
   const owned={...craftPaths(target),databaseFile:ownedCatalogFile(target,owner),databaseDir:join(target,owner)},store=await new CraftStore(owned).open({fileRecords:true});
   try{
    for(const kind of owner === "knowledge" ? ["knowledge_claim"] : ["memory_ledger","episodic_memory","semantic_memory"]){
     const record=store.get(kind,kind);assert.equal(record.content,`Synthetic inline ${kind}`);assert.equal(record.status,"candidate");
     const raw=store.rawRecords(kind)[0]!.payload;assert.equal(raw.content,undefined);assert.equal(raw.content_storage,"markdown");
    }
    if(owner === "knowledge"){const page=store.get("wiki_page","wiki");assert.equal(store.contentStore.readSync(page.content_ref as any).body,"Synthetic legacy wiki");assert.equal(page.file_path,(page.content_ref as any).path);}
   }finally{store.close();}
  }
  const {rebaseImportedHistory}=await import("../core/owner-history-rebase.ts");
  rebaseImportedHistory(target,join(temp,"new-location"));rebaseImportedHistory(target,target);
  const {readArchivedHistory}=await import("../core/owner-history-archive.ts");
  const original=manifest.entries.find(entry=>entry.kind === "knowledge_claim")!;assert.equal((readArchivedHistory(archive,original).payload as any).content,"Synthetic inline knowledge_claim");
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test("rebase rejects foreign markers and rolls back interrupted locator updates",async()=>{
 const {writeFileSync,unlinkSync,symlinkSync,renameSync}=await import("node:fs");
 const {mock}=await import("node:test");
 const {RecordFileStore}=await import("craft-common-store-local/record-files");
 const {rebaseImportedHistory,rebaseOwnedHistory}=await import("../core/owner-history-rebase.ts");
 const temp=mkdtempSync(join(tmpdir(),"craft-rebase-errors-")),paths=craftPaths(join(temp,"source")),archive=join(temp,"archive"),target=join(temp,"target");
 mkdirSync(dirname(paths.databaseFile),{recursive:true});const db=new DatabaseSync(paths.databaseFile);db.exec("CREATE TABLE records(kind TEXT,id TEXT,version INTEGER,payload_json TEXT,created_at TEXT,updated_at TEXT)");
 try{
  assert.throws(()=>rebaseImportedHistory(target,target),/imported staging/u);
  db.prepare("INSERT INTO records VALUES(?,?,?,?,?,?)").run("knowledge_claim","claim",1,JSON.stringify({scope:"global",content:"Synthetic rebase body"}),"created","updated");
  const manifest=await archiveOwnerHistory(paths,archive);await importOwnerHistory(archive,manifest,target);
  const failure=mock.method(RecordFileStore.prototype,"writeColdBatch",()=>{throw new Error("synthetic rebase disk failure");});
  assert.throws(()=>rebaseImportedHistory(target,join(temp,"next")),/rebase disk/u);failure.mock.restore();
  assert.equal(rebaseOwnedHistory(target,join(temp,"next"),target).changed,1);rebaseImportedHistory(target,target);
  const marker=join(target,"knowledge",".craft-storage-owner");writeFileSync(marker,"v1:memory\n");assert.throws(()=>rebaseOwnedHistory(target,target),/matching catalog owner/u);writeFileSync(marker,"v1:knowledge\n");
  const catalog=ownedCatalogFile(target,"knowledge"),held=join(temp,"catalog-held.db");renameSync(catalog,held);symlinkSync(held,catalog);assert.throws(()=>rebaseOwnedHistory(target,target),/catalog is unsafe/u);unlinkSync(catalog);renameSync(held,catalog);
  unlinkSync(join(target,".craft-history-import"));symlinkSync(marker,join(target,".craft-history-import"));assert.throws(()=>rebaseImportedHistory(target,target),/imported staging/u);
 }finally{mock.restoreAll();db.close();rmSync(temp,{recursive:true,force:true});}
});

test("runtime event journals use exact sequence JSONL and real owner Trace shards",async()=>{
 const {rebaseImportedHistory}=await import("../core/owner-history-rebase.ts");
 const temp=mkdtempSync(join(tmpdir(),"craft-import-events-")),paths=craftPaths(join(temp,"source")),archive=join(temp,"archive"),target=join(temp,"target");
 mkdirSync(dirname(paths.databaseFile),{recursive:true});const db=new DatabaseSync(paths.databaseFile);
 db.exec("CREATE TABLE records(kind TEXT,id TEXT,version INTEGER,payload_json TEXT,created_at TEXT,updated_at TEXT);CREATE TABLE events(stream TEXT,sequence INTEGER,event_type TEXT,payload_json TEXT,created_at TEXT,PRIMARY KEY(stream,sequence))");
 try{
  const ref=new MarkdownContentStore(paths).writeSync({kind:"memory",record_id:"event-body",version:1,scope:"global",status:"recorded",sensitivity:"internal",source_id:"fixture",title:"Synthetic",body:"Synthetic immutable event"});
  for(const stream of ["audit:fixture","trace:fixture"]){for(const sequence of [1,2])db.prepare("INSERT INTO events VALUES(?,?,?,?,?)").run(stream,sequence,"synthetic",JSON.stringify({content_ref:ref,sequence,text:"synthetic"}),"event-created");}
  db.prepare("INSERT INTO records VALUES(?,?,?,?,?,?)").run("trace","fixture",1,JSON.stringify({scope:"global",status:"recorded"}),"created","updated");
  const manifest=await archiveOwnerHistory(paths,archive);assert.equal(manifest.entries.filter(entry=>entry.kind === "event:synthetic").length,4);
  const first=await importOwnerHistory(archive,manifest,target);assert.equal(first.imported,5);assert.equal((await importOwnerHistory(archive,manifest,target)).already_present,5);
  rebaseImportedHistory(target,join(temp,"next"));rebaseImportedHistory(target,target);
  const owned={...craftPaths(target),databaseFile:ownedCatalogFile(target,"runtime"),databaseDir:join(target,"runtime")},store=await new CraftStore(owned).open({fileRecords:true});
  try{
   for(const stream of ["audit:fixture","trace:fixture"]){const events=store.events(stream);assert.deepEqual(events.map(event=>event.sequence),[1,2]);assert.equal((events[0]!.payload as any).content_ref.path,ref.path);assert.equal(store.appendEvent(stream,"synthetic-next",{text:"synthetic next"}).sequence,3);}
   assert.equal(store.get("trace","fixture").status,"recorded");assert.equal(store.list("trace",10).length,1);assert.equal(store.history("trace","fixture",2,10).length,1);
  }finally{store.close();}
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test("real Codebase model binds unscoped workspace/checkpoint/index and queries cold graphs through MCP",async()=>{
 const {writeFileSync}=await import("node:fs");
 const {execFileSync}=await import("node:child_process");
 const temp=mkdtempSync(join(tmpdir(),"craft-codebase-history-")),repository=join(temp,"repository"),source=join(temp,"source"),archive=join(temp,"archive"),target=join(temp,"target");
 mkdirSync(repository);execFileSync("git",["init","-q",repository]);writeFileSync(join(repository,"sample.ts"),"export function sample(x: number): number { return x + 1; }\n");execFileSync("git",["-C",repository,"add","--","sample.ts"]);
 const call=(root:string,owner:string|undefined,name:string,args:Record<string,unknown>)=>{
  const input=JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})+"\n";
  const child=spawnSync(process.execPath,["--experimental-strip-types",join(import.meta.dirname,"../bin/craft-mcp.ts"),"--product","codebase"],{input,encoding:"utf8",timeout:30000,env:{...process.env,CRAFT_DATA_DIR:root,CRAFT_STORAGE_OWNER:owner,CRAFT_CONTINUOUS_LEARNING:"0"}});
  assert.equal(child.status,0,child.stderr);const reply=JSON.parse(child.stdout.trim());assert.equal(reply.error,undefined,JSON.stringify(reply));assert.equal(reply.result.isError,false,JSON.stringify(reply));return reply.result.structuredContent;
 };
 try{
  const {openMcpRuntime}=await import("../core/interfaces/mcp/runtime.ts");
  const initial=await new CraftStore(craftPaths(source)).open();initial.close();
  const legacy=await openMcpRuntime("component-codebase",{CRAFT_DATA_DIR:source,CRAFT_CONTINUOUS_LEARNING:"0"});
  let indexed:any;
  try{const reply=await legacy.server.handle({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"craft_codebase_repository_ensure",arguments:{project_root:repository}}}) as any;assert.equal(reply.result.isError,false,JSON.stringify(reply));indexed=reply.result.structuredContent;assert.equal(indexed.status,"ready");}finally{legacy.close();}
  const manifest=await archiveOwnerHistory(craftPaths(source),archive);
  assert(manifest.entries.some(entry=>entry.kind === "workspace_checkpoint" && !entry.unresolved && entry.codebase_binding));
  const indexEntry=manifest.entries.find(entry=>entry.kind === "codebase_index" && entry.id === indexed.index_id)!;
  assert.equal(indexEntry.unresolved,false,JSON.stringify(indexEntry));
  const {CodebaseHistoryBindings}=await import("../core/owner-history-codebase.ts"),{readArchivedHistory}=await import("../core/owner-history-archive.ts");
  const bindings=new CodebaseHistoryBindings(craftPaths(source),craftPaths(source).databaseFile,(_kind,_id,_version,raw)=>JSON.parse(raw),()=>{});
  for(const attachment of readArchivedHistory(archive,indexEntry).attachments as Array<{purpose?:string;file:string;record_kind:string;record_id:string}>){
   if(attachment.purpose!=="codebase_graph")continue;
   const graph=JSON.parse(readFileSync(join(archive,attachment.file),"utf8"));
   assert(bindings.binding(attachment.record_kind,attachment.record_id,1,graph));
   assert.equal(bindings.binding(attachment.record_kind,"missing_graph",1,graph),null);
   if(attachment.record_kind==="codebase_index_shard"){
    assert.equal(bindings.binding(attachment.record_kind,attachment.record_id,1,{...graph,nodes:null}),null);
    assert.equal(bindings.binding(attachment.record_kind,attachment.record_id,1,{...graph,nodes:[{path:"sample.ts",source_digest:"changed"}]}),null);
   }else assert.equal(bindings.binding(attachment.record_kind,attachment.record_id,1,{...graph,route_digest:"changed"}),null);
  }
  await importOwnerHistory(archive,manifest,target);
  const targetRuntime=await openMcpRuntime("component-codebase",{CRAFT_DATA_DIR:target,CRAFT_STORAGE_OWNER:"codebase",CRAFT_CONTINUOUS_LEARNING:"0"});targetRuntime.close();
  const found=call(target,"codebase","craft_codebase_symbol_find",{index_id:indexed.index_id,workspace_id:indexed.workspace_id,query:"sample"});
  assert(JSON.stringify(found).includes("sample"));
  const symbol=found.symbols.find((item:any)=>item.name === "sample");assert(symbol);
  const context=call(target,"codebase","craft_codebase_context_slice",{index_id:indexed.index_id,workspace_id:indexed.workspace_id,node_ids:[symbol.id]});assert.equal(context.references[0].name,"sample");
  const impact=call(target,"codebase","craft_codebase_impact_query",{index_id:indexed.index_id,workspace_id:indexed.workspace_id,node_id:symbol.id,max_depth:1});assert(impact.receipt);
  const read=call(target,"codebase","craft_codebase_symbol_read",{index_id:indexed.index_id,workspace_id:indexed.workspace_id,node_id:symbol.id});assert(JSON.stringify(read).includes("return x + 1"));
 }finally{rmSync(temp,{recursive:true,force:true});}
});

test("10001 native Trace versions import into eleven cold chunks and read through normal Runtime MCP",async()=>{
 const {readdirSync}=await import("node:fs");
 const temp=mkdtempSync(join(tmpdir(),"craft-cold-scale-")),paths=craftPaths(join(temp,"source")),archive=join(temp,"archive"),target=join(temp,"target");
 mkdirSync(dirname(paths.databaseFile),{recursive:true});const db=new DatabaseSync(paths.databaseFile);db.exec("CREATE TABLE records(kind TEXT,id TEXT,version INTEGER,payload_json TEXT,created_at TEXT,updated_at TEXT,PRIMARY KEY(kind,id,version))");
 try{
  db.exec("BEGIN");const insert=db.prepare("INSERT INTO records VALUES(?,?,?,?,?,?)");for(let version=1;version<=10001;version++)insert.run("trace","trace_cold_fixture",version,JSON.stringify({schema:"craft.trace.v1",schema_revision:1,task_id:"synthetic-telemetry-task",telemetry_only:true,status:"open",event_count:0,next_sequence:1,metadata_counter:version}),"created","updated");db.exec("COMMIT");
  const manifest=await archiveOwnerHistory(paths,archive);assert.equal(manifest.entries.length,0);assert.equal(manifest.record_count,10001);
  const result=await importOwnerHistory(archive,manifest,target);assert.equal(result.imported,10001);assert.equal(result.quarantined,0);
  assert.equal(readdirSync(join(target,"runtime","records","cold")).length,11);
  const input=JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"craft_trace_get",arguments:{trace_id:"trace_cold_fixture"}}})+"\n";
  const child=spawnSync(process.execPath,["--experimental-strip-types",join(import.meta.dirname,"../bin/craft-mcp.ts"),"--product","runtime"],{input,encoding:"utf8",timeout:30000,env:{...process.env,CRAFT_DATA_DIR:target,CRAFT_STORAGE_OWNER:"runtime",CRAFT_CONTINUOUS_LEARNING:"0"}});
  assert.equal(child.status,0,child.stderr);const reply=JSON.parse(child.stdout.trim());assert.equal(reply.result.isError,false,JSON.stringify(reply));assert.equal(reply.result.structuredContent.trace.version,10001);assert.equal(reply.result.structuredContent.trace.metadata_counter,10001);
  const owned={...craftPaths(target),databaseFile:ownedCatalogFile(target,"runtime"),databaseDir:join(target,"runtime")},store=await new CraftStore(owned).open({fileRecords:true});try{assert.equal(store.get("trace","trace_cold_fixture",5001).metadata_counter,5001);}finally{store.close();}
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test("historical checkpoint paths share content-addressed inodes without losing exact paths",async()=>{
 const {writeFileSync,lstatSync,realpathSync,linkSync}=await import("node:fs");
 const {ensureProjectStorageDirectory}=await import("craft-common-store-local/paths");
 const temp=mkdtempSync(join(tmpdir(),"craft-snapshot-hardlinks-")),paths=craftPaths(join(temp,"source")),repository=join(temp,"repository"),archive=join(temp,"archive"),target=join(temp,"target");
 mkdirSync(repository);mkdirSync(dirname(paths.databaseFile),{recursive:true});const db=new DatabaseSync(paths.databaseFile);db.exec("CREATE TABLE records(kind TEXT,id TEXT,version INTEGER,payload_json TEXT,created_at TEXT,updated_at TEXT,PRIMARY KEY(kind,id,version))");
 try{
  const body=Buffer.from("export const fixed = 1;\n"),digest=(await import("node:crypto")).createHash("sha256").update(body).digest("hex"),project=ensureProjectStorageDirectory(paths,repository);
  const insert=db.prepare("INSERT INTO records VALUES(?,?,?,?,?,?)");insert.run("workspace","workspace_fixture",1,JSON.stringify({root_path:realpathSync(repository),canonical_root_path:realpathSync(repository),state_revision:1,snapshot_storage:"project_codebase",latest_checkpoint_id:"cp_b",include_paths:["*"]}),"created","updated");
  for(const id of ["cp_a","cp_b"]){const root=join(project,"codebase","snapshots","workspace_fixture",id);mkdirSync(root,{recursive:true});writeFileSync(join(root,"fixed.ts"),body);const entries=[{path:"fixed.ts",digest,size_bytes:body.length}];if(id==="cp_a")for(let n=0;n<1000;n++){const path=`fixed_${n}.ts`;linkSync(join(root,"fixed.ts"),join(root,path));entries.push({path,digest,size_bytes:body.length});}insert.run("workspace_checkpoint",id,1,JSON.stringify({workspace_id:"workspace_fixture",state_revision:1,snapshot_root:root,entries}),"created","updated");}
  const progress:Array<{phase:string;items:number}>=[];const manifest=await archiveOwnerHistory(paths,archive,{onProgress:item=>progress.push(item)});assert(progress.some(item=>item.phase==="snapshot_capture" && item.items===1000));await importOwnerHistory(archive,manifest,target);
  const owned={...craftPaths(target),databaseFile:ownedCatalogFile(target,"codebase"),databaseDir:join(target,"codebase")},store=await new CraftStore(owned).open({fileRecords:true});
  try{const first=join(String(store.get("workspace_checkpoint","cp_a").snapshot_root),"fixed.ts"),second=join(String(store.get("workspace_checkpoint","cp_b").snapshot_root),"fixed.ts");assert.deepEqual(readFileSync(first),body);assert.deepEqual(readFileSync(second),body);assert.equal(lstatSync(first).ino,lstatSync(second).ino);assert.equal(lstatSync(first).ino,lstatSync(join(target,"codebase","snapshot-blobs",`${digest}.blob`)).ino);}
  finally{store.close();}
  await importOwnerHistory(archive,manifest,target);
  const targetBlob=join(target,"codebase","snapshot-blobs",`${digest}.blob`);writeFileSync(targetBlob,"synthetic target conflict");await assert.rejects(importOwnerHistory(archive,manifest,target),/snapshot body conflicts/u);writeFileSync(targetBlob,body);
  const targetSource=join(ensureProjectStorageDirectory(craftPaths(target),repository),"codebase","snapshots","workspace_fixture","cp_a","fixed.ts");const {unlinkSync,symlinkSync}=await import("node:fs");unlinkSync(targetSource);symlinkSync(targetBlob,targetSource);await assert.rejects(importOwnerHistory(archive,manifest,target),/snapshot destination conflicts/u);unlinkSync(targetSource);linkSync(targetBlob,targetSource);
  const fs=(await import("node:fs")).default,{syncBuiltinESMExports}=await import("node:module"),original=fs.readFileSync;
  const noDuplicateSourceRead=mock.method(fs,"readFileSync",(...args:Parameters<typeof fs.readFileSync>)=>{if(String(args[0]).includes("snapshots/workspace_fixture/"))throw new Error("unexpected repeated source body read");return original(...args);});syncBuiltinESMExports();
  try{
   assert.equal((await archiveOwnerHistory(paths,archive)).digest,manifest.digest);
   insert.run("craft_note","unrelated_runtime_write",1,JSON.stringify({text:"synthetic unrelated write"}),"created","updated");
   const later=await archiveOwnerHistory(paths,archive);assert.equal(later.record_count,manifest.record_count+1);
  }finally{noDuplicateSourceRead.mock.restore();syncBuiltinESMExports();}
  const sourceBody=join(project,"codebase","snapshots","workspace_fixture","cp_a","fixed.ts");let changed=false;
  await assert.rejects(archiveOwnerHistory(paths,archive,{onProgress:progress=>{if(progress.phase==="source_verify" && !changed){changed=true;writeFileSync(sourceBody,"synthetic changed");}}}),/Markdown or record file changed/u);
  writeFileSync(sourceBody,body);await archiveOwnerHistory(paths,archive);
  const blob=join(archive,"codebase","content",`${digest}.blob`);writeFileSync(blob,"synthetic corrupt blob");
  await assert.rejects(archiveOwnerHistory(paths,archive),/destination conflict/u);
 }finally{mock.restoreAll();(await import("node:module")).syncBuiltinESMExports();db.close();rmSync(temp,{recursive:true,force:true});}
});

test("rebase handles large cold batches and owned event references while rejecting special-shard symlinks",async()=>{
 const {initializeOwnedCatalog}=await import("../core/infrastructure/owned-catalog.ts"),{rebaseOwnedHistory}=await import("../core/owner-history-rebase.ts");
 const {symlinkSync,unlinkSync}=await import("node:fs");
 const temp=mkdtempSync(join(tmpdir(),"craft-rebase-capacity-")),root=join(temp,"source"),next=join(temp,"next");
 initializeOwnedCatalog(root,"knowledge");const paths={...craftPaths(root),databaseFile:ownedCatalogFile(root,"knowledge"),databaseDir:join(root,"knowledge")};
 const store=await new CraftStore(paths).open({fileRecords:true,ownerRecords:true});
 const ref=new MarkdownContentStore(paths).writeSync({kind:"knowledge",record_id:"body",version:1,scope:"global",status:"published",sensitivity:"internal",source_id:"fixture",title:"Synthetic",body:"Synthetic rebase body"});
 store.appendEvent("audit:fixture","synthetic",{content_ref:ref});store.traceShards.importLegacy("fixture",[],[{stream:"trace:fixture",sequence:1,event_type:"synthetic",payload_json:JSON.stringify({content_ref:ref}),created_at:"created"}]);store.close();
 try{
  const database=new DatabaseSync(paths.databaseFile);database.exec("BEGIN");const insert=database.prepare("INSERT INTO records VALUES(?,?,?,?,?,?)");
  for(let n=0;n<1004;n++)insert.run("knowledge_claim",`fixture_${String(n).padStart(4,"0")}`,1,JSON.stringify({scope:"global",content_ref:ref,...(n<3?{binary_fixture:"x".repeat(4*1024*1024)}:{})}),"created","updated");database.exec("COMMIT");database.close();
  assert.equal(rebaseOwnedHistory(root,next).changed,1006);assert.equal(rebaseOwnedHistory(root,root).changed,1006);
  const referencePath=(value:unknown)=>{assert(value && typeof value==="object" && "content_ref" in value);const reference=value.content_ref;assert(reference && typeof reference==="object" && "path" in reference);return reference.path;};
  const reopened=await new CraftStore(paths).open({fileRecords:true,ownerRecords:true});try{assert.equal(referencePath(reopened.events("audit:fixture")[0]!.payload),ref.path);assert.equal(referencePath(reopened.events("trace:fixture")[0]!.payload),ref.path);assert.equal(referencePath(reopened.get("knowledge_claim","fixture_1003")),ref.path);}finally{reopened.close();}
  const directory=join(root,"knowledge","codebase","legacy-graph-v1");mkdirSync(dirname(directory),{recursive:true});symlinkSync(join(root,"knowledge"),directory);assert.throws(()=>rebaseOwnedHistory(root,next),/shard directory is unsafe/u);unlinkSync(directory);
  mkdirSync(directory);symlinkSync(paths.databaseFile,join(directory,"ff.db"));assert.throws(()=>rebaseOwnedHistory(root,next),/catalog is unsafe/u);
 }finally{rmSync(temp,{recursive:true,force:true});}
});

test("owner import preserves count and byte batch boundaries including one oversized historical record",async()=>{
 const temp=mkdtempSync(join(tmpdir(),"craft-import-batch-")),paths=craftPaths(join(temp,"source")),archive=join(temp,"archive"),target=join(temp,"target");mkdirSync(dirname(paths.databaseFile),{recursive:true});const db=new DatabaseSync(paths.databaseFile);db.exec("CREATE TABLE records(kind TEXT,id TEXT,version INTEGER,payload_json TEXT,created_at TEXT,updated_at TEXT,PRIMARY KEY(kind,id,version))");
 try{
  db.exec("BEGIN");const insert=db.prepare("INSERT INTO records VALUES(?,?,?,?,?,?)");for(let n=0;n<1000;n++)insert.run("craft_note",`fixture_${n}`,1,JSON.stringify({value:n}),"created","updated");for(let n=0;n<4;n++)insert.run("craft_note",`large_${n}`,1,JSON.stringify({binary_fixture:"x".repeat((n===3?9:4)*1024*1024)}),"created","updated");db.exec("COMMIT");
  const manifest=await archiveOwnerHistory(paths,archive);assert.equal((await importOwnerHistory(archive,manifest,target)).imported,1004);assert.equal((await importOwnerHistory(archive,manifest,target)).already_present,1004);
  const owned={...craftPaths(target),databaseFile:ownedCatalogFile(target,"notes"),databaseDir:join(target,"notes")},store=await new CraftStore(owned).open({fileRecords:true});try{assert.equal(store.get("craft_note","fixture_500").value,500);assert.equal(String(store.get("craft_note","large_3").binary_fixture).length,9*1024*1024);}finally{store.close();}
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test("Codebase historical bindings page checkpoints and reject broken metadata relationships",async()=>{
 const {CodebaseHistoryBindings}=await import("../core/owner-history-codebase.ts"),{ensureProjectStorageDirectory}=await import("craft-common-store-local/paths"),{stableDigest,digestJson}=await import("craft-common-base/digest");
 const {writeFileSync,symlinkSync,unlinkSync}=await import("node:fs");const temp=mkdtempSync(join(tmpdir(),"craft-binding-pages-")),paths=craftPaths(join(temp,"source")),repository=join(temp,"repository");mkdirSync(repository);mkdirSync(dirname(paths.databaseFile),{recursive:true});const project=ensureProjectStorageDirectory(paths,repository),db=new DatabaseSync(paths.databaseFile);db.exec("CREATE TABLE records(kind TEXT,id TEXT,version INTEGER,payload_json TEXT,created_at TEXT,updated_at TEXT,PRIMARY KEY(kind,id,version))");const insert=(kind:string,id:string,payload:unknown)=>db.prepare("INSERT INTO records VALUES(?,?,?,?,?,?)").run(kind,id,1,JSON.stringify(payload),"created","updated");
 try{
  insert("workspace","workspace_fixture",{root_path:repository,state_revision:1});for(let n=0;n<501;n++){const id=`checkpoint_${n}`,root=join(project,"codebase","snapshots","workspace_fixture",id);mkdirSync(root,{recursive:true});insert("workspace_checkpoint",id,{workspace_id:"workspace_fixture",state_revision:1,snapshot_root:root,entries:[]});}
  const graph={nodes:[],edges:[]},hash=digestJson(graph),index={workspace_id:"workspace_fixture",checkpoint_id:"checkpoint_0",snapshot_digest:stableDigest([]),graph_storage:"project-sharded-v5",shard_ids:["codebase_shard_fixture"],shard_digests:[hash]};
  insert("codebase_index","index_fixture",index);insert("codebase_index","missing_checkpoint",{...index,checkpoint_id:"missing"});insert("codebase_index","empty_descriptors",{workspace_id:index.workspace_id,checkpoint_id:index.checkpoint_id,snapshot_digest:index.snapshot_digest});
  const bindings=new CodebaseHistoryBindings(paths,paths.databaseFile,(_kind,_id,_version,raw)=>JSON.parse(raw),()=>{});
  assert(bindings.binding("workspace_checkpoint","checkpoint_500",1,{}));assert.equal(bindings.binding("workspace_checkpoint","missing",1,{}),null);assert.equal(bindings.binding("codebase_index","fixture",1,{...index,snapshot_digest:"changed"}),null);assert.equal(bindings.binding("codebase_index","fixture",1,{...index,workspace_id:"changed"}),null);
  assert.deepEqual(bindings.artifactDirectories(index),[join(project,"codebase","indexes","workspace_fixture","graph_records")]);assert.deepEqual(bindings.artifactDirectories({...index,workspace_id:"changed"}),[]);assert.deepEqual(bindings.artifactDirectories({...index,checkpoint_id:"missing"}),[]);
  const marker=join(project,"project.json"),original=readFileSync(marker);writeFileSync(marker,"{}");assert.deepEqual(bindings.artifactDirectories(index),[]);writeFileSync(marker,original);const moved=join(temp,"marker.json");writeFileSync(moved,original);unlinkSync(marker);symlinkSync(moved,marker);assert.deepEqual(bindings.artifactDirectories(index),[]);unlinkSync(marker);assert.deepEqual(bindings.artifactDirectories(index),[]);writeFileSync(marker,original);
  insert("workspace_checkpoint","outside_checkpoint",{workspace_id:"workspace_fixture",state_revision:1,snapshot_root:join(temp,"outside"),entries:[]});const outside=new CodebaseHistoryBindings(paths,paths.databaseFile,(_kind,_id,_version,raw)=>JSON.parse(raw),()=>{});assert.deepEqual(outside.artifactDirectories({...index,checkpoint_id:"outside_checkpoint"}),[]);
  assert.throws(()=>new CodebaseHistoryBindings(paths,paths.databaseFile,(_kind,_id,_version,raw)=>JSON.parse(raw),()=>{throw Object.assign(new Error("synthetic reserve"),{code:"HISTORY_ARCHIVE_SPACE_RESERVE"});}),/synthetic reserve/u);
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});
