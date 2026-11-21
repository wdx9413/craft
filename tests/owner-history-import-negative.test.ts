import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { stableDigest } from "craft-common-base/digest";
import { MarkdownContentStore } from "craft-common-store-local/content-store";
import { ensureProjectStorageDirectory } from "craft-common-store-local/paths";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { ownedCatalogFile, type StorageOwner } from "../core/infrastructure/owned-catalog.ts";
import { archiveOwnerHistory, historyArchiveEntries, readArchivedHistory, type HistoryArchiveManifest } from "../core/owner-history-archive.ts";
import { importOwnerHistory } from "../core/owner-history-import.ts";

type Payload=Record<string,unknown>;
type Attachment={source:string;file:string;digest:string;purpose?:string;relative_path?:string};
const sha=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
function fixture(){
 const root=mkdtempSync(join(tmpdir(),"craft-import-negative-")),paths=craftPaths(join(root,"source")),archive=join(root,"archive"),target=join(root,"target");
 mkdirSync(dirname(paths.databaseFile),{recursive:true});const db=new DatabaseSync(paths.databaseFile);
 db.exec("CREATE TABLE records(kind TEXT,id TEXT,version INTEGER,payload_json TEXT,created_at TEXT,updated_at TEXT,PRIMARY KEY(kind,id,version));CREATE TABLE events(stream TEXT,sequence INTEGER,event_type TEXT,payload_json TEXT,created_at TEXT,PRIMARY KEY(stream,sequence))");
 const insert=(kind:string,id:string,payload:Payload)=>db.prepare("INSERT INTO records VALUES(?,?,?,?,?,?)").run(kind,id,1,JSON.stringify(payload),"created","updated");
 return {root,paths,archive,target,db,insert,export:()=>archiveOwnerHistory(paths,archive),close(){db.close();rmSync(root,{recursive:true,force:true});}};
}
function definition(f:ReturnType<typeof fixture>){
 const value={schema_version:"craft.procedure.v1",procedure_id:"definition_fixture",procedure_version:1,kind:"workflow",scope:"global",trigger:"Synthetic",preconditions:[],allowed_effects:[],acceptance_ref:"synthetic",failure_disposition:"stop",scenario_signature:{key:"synthetic"},evidence_ids:[],proposal_ref:{id:"proposal",version:1},definition:{steps:["immutable"]}};
 const path=join(f.paths.experienceDir,"graph","definition_fixture","versions","000001.json");mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value));
 return {value,ref:{format:"json",procedure_id:value.procedure_id,procedure_version:1,kind:"workflow",scope:"global",path,digest:stableDigest(value)}};
}
function forge(f:ReturnType<typeof fixture>,manifest:HistoryArchiveManifest,kind:string,id:string,mutate:(record:Payload)=>void):HistoryArchiveManifest{
 const entries=[...historyArchiveEntries(f.archive,manifest)].map(entry=>{
  if(entry.kind!==kind||entry.id!==id)return entry;
  const record=readArchivedHistory(f.archive,entry);mutate(record);const text=JSON.stringify(record),file=`forged-${sha(text)}.jsonl`;writeFileSync(join(f.archive,file),text);
  const {encoding:_,decoded_bytes:__,...plain}=entry;return {...plain,file,offset:0,bytes:Buffer.byteLength(text),digest:sha(text)};
 });
 const {digest:_,...body}=manifest;const next={...body,entries,entry_files:[]};return {...next,digest:sha(JSON.stringify(next))};
}
async function owned(f:ReturnType<typeof fixture>,owner:StorageOwner){return new CraftStore({...craftPaths(f.target),databaseFile:ownedCatalogFile(f.target,owner),databaseDir:join(f.target,owner)}).open({fileRecords:true});}

test("external procedure references remain external while own definitions reject absent or conflicting attachments",async()=>{
 const f=fixture();
 try{
  const d=definition(f);f.insert("experience_procedure","definition_fixture",{scope:"global",status:"published",definition_ref:d.ref});
  f.insert("knowledge_claim","external_reference",{scope:"global",status:"candidate",related:[d.ref]});
  const manifest=await f.export();await importOwnerHistory(f.archive,manifest,f.target);
  const knowledge=await owned(f,"knowledge"),experience=await owned(f,"experience");
  let destination:string;
  try{assert.deepEqual((knowledge.get("knowledge_claim","external_reference").related as unknown[])[0],d.ref);destination=String((experience.get("experience_procedure","definition_fixture").definition_ref as Payload).path);assert.notEqual(destination,d.ref.path);assert.deepEqual(readFileSync(destination),readFileSync(d.ref.path));}
  finally{knowledge.close();experience.close();}
  const original=readFileSync(destination!);writeFileSync(destination!,"conflicting definition");
  await assert.rejects(importOwnerHistory(f.archive,manifest,f.target),/procedure destination conflicts/);writeFileSync(destination!,original);
  const held=join(f.root,"held-definition.json");writeFileSync(held,original);unlinkSync(destination!);symlinkSync(held,destination!);
  await assert.rejects(importOwnerHistory(f.archive,manifest,f.target),/procedure destination conflicts/);unlinkSync(destination!);writeFileSync(destination!,original);
  const missing=forge(f,manifest,"experience_procedure","definition_fixture",record=>{record.attachments=[];});
  await assert.rejects(importOwnerHistory(f.archive,missing,join(f.root,"missing-json")),/procedure attachment missing/);
 }finally{f.close();}
});

for(const ambiguous of [false,true])test(`project-scoped definition and Markdown imports require one registered root (${ambiguous?"ambiguous":"missing"})`,async()=>{
 const f=fixture();
 try{
  if(ambiguous)for(const name of ["project-one","project-two"]){const root=join(f.root,name);mkdirSync(root);f.insert("scope_alias",name,{status:"active",alias_kind:"path",alias:root,alias_digest:stableDigest(root),scope:{kind:"project",id:"project:fixture"}});}
  const d=definition(f);f.insert("experience_procedure","definition_fixture",{scope:"global",status:"published",definition_ref:d.ref});
  const content=new MarkdownContentStore(f.paths),ref=content.writeSync({kind:"knowledge",record_id:"claim",version:1,scope:"project:fixture",status:"candidate",sensitivity:"internal",source_id:"fixture",title:"Synthetic scoped body",body:"Synthetic body requires its registered project"});
  f.insert("knowledge_claim","claim",{scope:"global",status:"candidate",content_ref:ref});
  const manifest=await f.export();
  await assert.rejects(importOwnerHistory(f.archive,manifest,join(f.root,"missing-md-root")),/project root is unavailable or ambiguous/);
  const changed=forge(f,manifest,"experience_procedure","definition_fixture",record=>{
   const payload=record.payload as Payload,ref={...(payload.definition_ref as Payload)},attachments=record.attachments as Attachment[];
   const value={...d.value,scope:"project:fixture"},bytes=JSON.stringify(value),file="definition-project.json";writeFileSync(join(f.archive,file),bytes);
   record.attachments=attachments.map(a=>a.source===ref.path?{...a,file,digest:sha(bytes)}:a);payload.definition_ref={...ref,scope:value.scope,digest:stableDigest(value)};
  });
  // Keep the unrelated Knowledge row quarantined so this attempt reaches the JSON owner resolver.
  const {digest:_,...body}=changed;const onlyJson={...body,entries:changed.entries.map(entry=>entry.kind==="knowledge_claim"?{...entry,unresolved:true}:entry)};
  await assert.rejects(importOwnerHistory(f.archive,{...onlyJson,digest:sha(JSON.stringify(onlyJson))},join(f.root,"missing-definition-root")),/project root is unavailable or ambiguous/);
 }finally{f.close();}
});

test("ordinary event replay rejects changes to type, timestamp and exact payload",async()=>{
 const f=fixture();
 try{
  f.db.prepare("INSERT INTO events VALUES(?,?,?,?,?)").run("fixture-audit",1,"synthetic",JSON.stringify({text:"Synthetic immutable event"}),"original-time");
  const manifest=await f.export();await importOwnerHistory(f.archive,manifest,f.target);
  for(const column of ["event_type","created_at","payload_json"]){
   const catalog=new DatabaseSync(ownedCatalogFile(f.target,"runtime"));const original=catalog.prepare(`SELECT ${column} AS value FROM events WHERE stream=? AND sequence=?`).get("fixture-audit",1)!.value;
   catalog.prepare(`UPDATE events SET ${column}=? WHERE stream=? AND sequence=?`).run(column==="payload_json"?"{}":"conflicting","fixture-audit",1);catalog.close();
   await assert.rejects(importOwnerHistory(f.archive,manifest,f.target),/event sequence conflicts/);
   const repair=new DatabaseSync(ownedCatalogFile(f.target,"runtime"));repair.prepare(`UPDATE events SET ${column}=? WHERE stream=? AND sequence=?`).run(original,"fixture-audit",1);repair.close();
  }
  assert.equal((await importOwnerHistory(f.archive,manifest,f.target)).already_present,1);
 }finally{f.close();}
});

test("legacy Wiki needs its archived body and propagates non-format storage failures",async t=>{
 const f=fixture();
 try{
  const path=join(f.root,"wiki.md");writeFileSync(path,"Synthetic plain Wiki body");f.insert("wiki_page","wiki",{scope:"global",file_path:path});const manifest=await f.export();
  const missing=forge(f,manifest,"wiki_page","wiki",record=>{record.attachments=[];});
  await assert.rejects(importOwnerHistory(f.archive,missing,join(f.root,"missing-wiki")),/Wiki attachment missing/);
  const failure=t.mock.method(MarkdownContentStore.prototype,"readUncheckedSync",()=>{throw new Error("Synthetic body read unavailable");});
  await assert.rejects(importOwnerHistory(f.archive,manifest,join(f.root,"unavailable-wiki")),/body read unavailable/);failure.mock.restore();
 }finally{f.close();}
});

test("inline legacy prose reads its declared metadata scope instead of inventing project authority",async()=>{
 const f=fixture();
 try{
  f.insert("knowledge_claim","metadata-scope",{metadata:{scope:{kind:"global",id:"global"}},content:"Synthetic metadata-scoped prose"});
  const manifest=await f.export();await importOwnerHistory(f.archive,manifest,f.target);const store=await owned(f,"knowledge");
  try{const record=store.get("knowledge_claim","metadata-scope");assert.equal(record.content,"Synthetic metadata-scoped prose");assert.equal((record.content_ref as Payload).scope,"global");assert.deepEqual(record.metadata,{scope:{kind:"global",id:"global"}});}finally{store.close();}
 }finally{f.close();}
});

test("snapshot attachments ignore unrelated content but cannot escape their managed root",async()=>{
 const f=fixture();
 try{
  const repository=join(f.root,"repository");mkdirSync(repository);const project=ensureProjectStorageDirectory(f.paths,repository),snapshot=join(project,"codebase","snapshots","workspace_fixture","checkpoint_fixture");mkdirSync(snapshot,{recursive:true});
  const bytes=Buffer.from("export const snapshot = true;\n"),path=join(snapshot,"sample.ts");writeFileSync(path,bytes);
  f.insert("workspace","workspace_fixture",{root_path:repository,state_revision:1});f.insert("workspace_checkpoint","checkpoint_fixture",{workspace_id:"workspace_fixture",state_revision:1,snapshot_root:snapshot,entries:[{path:"sample.ts",digest:sha(bytes),size_bytes:bytes.length}]});
  const manifest=await f.export();const extra=forge(f,manifest,"workspace_checkpoint","checkpoint_fixture",record=>{const attachments=record.attachments as Attachment[];record.attachments=[...attachments,{...attachments[0]!,purpose:"unrelated_fixture"}];});
  await importOwnerHistory(f.archive,extra,f.target);const store=await owned(f,"codebase");
  try{assert.deepEqual(readFileSync(join(String(store.get("workspace_checkpoint","checkpoint_fixture").snapshot_root),"sample.ts")),bytes);}finally{store.close();}
  const escaped=join(f.root,"escaped-snapshot.ts");
  for(const relative_path of ["../escape.ts",escaped]){
   const bad=forge(f,manifest,"workspace_checkpoint","checkpoint_fixture",record=>{record.attachments=(record.attachments as Attachment[]).map(a=>a.purpose==="codebase_snapshot"?{...a,relative_path}:a);});
   await assert.rejects(importOwnerHistory(f.archive,bad,join(f.root,`escape-${sha(relative_path).slice(0,8)}`)),/snapshot entry escapes root/);assert.equal(existsSync(escaped),false);
  }
 }finally{f.close();}
});
