import { createHash } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CraftStore, type JsonObject } from "craft-common-store-local/store";
import { TRACE_KINDS, TraceShardStore, type TraceRecordRow, type TraceEventRow } from "craft-common-store-local/trace-shards";
import { CODEBASE_GRAPH_KINDS, CodebaseShardStore } from "craft-common-store-local/codebase-shards";
import { RecordFileStore } from "craft-common-store-local/record-files";
import { MarkdownContentStore, contentReference } from "craft-common-store-local/content-store";
import { ensureProjectStorageDirectory, sessionStorageDirectoryForScopeId } from "craft-common-store-local/paths";
import { craftPaths } from "./infrastructure/paths.ts";
import { catalogOwner, initializeOwnedCatalog, ownedCatalogFile, STORAGE_OWNERS } from "./infrastructure/owned-catalog.ts";
import { experienceGraphDirectory } from "@craft/capability-experience/procedure-definition";
import { historyArchiveEntries, historicalProjectAliases, procedureDefinitionReference, readArchivedHistory, type HistoryArchiveManifest } from "./owner-history-archive.ts";

/** Populate a new staging data space. Switching an installation is deliberately separate. */
export async function importOwnerHistory(archive:string, manifest:HistoryArchiveManifest, destination:string):Promise<{imported:number;already_present:number;quarantined:number}> {
  const {digest,...body}=manifest;
  if (manifest.schema !== "craft.owner-history-archive.v1") throw new Error("Unsupported history manifest");
  if (createHash("sha256").update(JSON.stringify(body)).digest("hex") !== digest) throw new Error("History manifest digest mismatch");
  const root=resolve(destination), source=resolve(archive);
  if (root === source || root.startsWith(source+sep) || root === resolve(manifest.source_root) || root.startsWith(resolve(manifest.source_root)+sep)) throw new Error("History import requires a separate staging directory");
  const marker=join(root,".craft-history-import");
  if (existsSync(root) && !existsSync(marker) && readdirSync(root).length) throw new Error("History import refuses an unmarked nonempty destination");
  mkdirSync(root,{recursive:true,mode:0o700});
  if (lstatSync(root).isSymbolicLink()) throw new Error("History import destination is unsafe");
  if (existsSync(marker)) {
    if (!lstatSync(marker).isFile() || lstatSync(marker).isSymbolicLink() || readFileSync(marker,"utf8") !== digest) throw new Error("History import marker conflicts");
  } else writeFileSync(marker,digest,{flag:"wx",mode:0o600});
  const identityEntries:HistoryArchiveManifest["entries"] = [];
  for (const entry of historyArchiveEntries(archive,manifest)) {
    readArchivedHistory(archive,entry);
    if(entry.owner === "identity" && entry.state === "published" && !entry.unresolved && entry.availability !== "unavailable")identityEntries.push(entry);
  }
  const registry=new DatabaseSync(":memory:");
  let aliases:Map<string,string[]>;
  try {
    registry.exec("CREATE TABLE records(kind TEXT,id TEXT,version INTEGER,payload_json TEXT)");
    for (const entry of identityEntries) registry.prepare("INSERT INTO records VALUES(?,?,?,?)").run(entry.kind,entry.id,entry.version,JSON.stringify(readArchivedHistory(archive,entry).payload));
    aliases=historicalProjectAliases(registry);
  } finally {registry.close();}
  let imported=0,alreadyPresent=0,quarantined=0;
  for (const owner of STORAGE_OWNERS) {
    let hasOwned=false;
    for(const entry of historyArchiveEntries(archive,manifest))if(entry.owner === owner && entry.state === "published" && !entry.unresolved){hasOwned=true;break;}
    if (!hasOwned) continue;
    const entries=function*(){
      for(const entry of historyArchiveEntries(archive,manifest))if(entry.owner === owner && entry.state === "published" && !entry.unresolved)yield entry;
      yield* identityEntries;
    };
    const paths={...craftPaths(root),databaseFile:ownedCatalogFile(root,owner),databaseDir:join(root,owner)};
    const existingOwner=catalogOwner(join(root,owner));
    if (existingOwner && existingOwner !== owner) throw new Error("History import owner marker conflicts");
    if (!existingOwner) initializeOwnedCatalog(root,owner);
    const store=await new CraftStore(paths).open({fileRecords:true,ownerRecords:true,skipLegacyPartitionMigration:true});
    store.close();
    const database=new DatabaseSync(paths.databaseFile),files=new RecordFileStore(root,dirname(paths.databaseFile)),content=new MarkdownContentStore(paths);
    const trace=new TraceShardStore(root),codebase=new CodebaseShardStore(root);
    trace.configureRecordFiles(files,true);codebase.configureRecordFiles(files,true);
    for (const domain of ["knowledge","memory","experience"] as const) {
      const resolver=(scope:string)=>{
        const roots=aliases.get(scope.slice("project:".length));
        if (roots?.length !== 1) throw new Error("History import project root is unavailable or ambiguous");
        return join(ensureProjectStorageDirectory(paths,roots[0]!),domain,"md");
      };
      if (domain === "knowledge") content.setProjectKnowledgeDirectoryResolver(resolver);
      else if (domain === "memory") content.setProjectMemoryDirectoryResolver(resolver);
      else content.setProjectExperienceDirectoryResolver(resolver);
    }
    content.setSessionMemoryDirectoryResolver(id=>join(sessionStorageDirectoryForScopeId(paths,id),"memory","md"));
    type Pending={entry:HistoryArchiveManifest["entries"][number];record:Record<string,unknown>;payload:JsonObject};
    const pending:Pending[]=[];let pendingBytes=0;
    const traceBatches=new Map<string,{records:TraceRecordRow[];events:TraceEventRow[]}>();
    const traceBatch=(id:string)=>{let batch=traceBatches.get(id);if(!batch){batch={records:[],events:[]};traceBatches.set(id,batch);}return batch;};
    const publish=(item:Pending,projection:Record<string,unknown>)=>{
      const {entry,record,payload}=item;
        if(entry.kind.startsWith("event:")){
          const eventType=entry.kind.slice("event:".length);
          if(entry.id.startsWith("trace:")){
            const id=entry.id.slice("trace:".length),existing=trace.hasEvent(id,entry.version);
            traceBatch(id).events.push({stream:entry.id,sequence:entry.version,event_type:eventType,payload_json:JSON.stringify(projection),created_at:String(record.created_at)});
            if(existing)alreadyPresent++;else imported++;
            return;
          }
          const existing=database.prepare("SELECT event_type,payload_json,created_at FROM events WHERE stream=? AND sequence=?").get(entry.id,entry.version) as {event_type:string;payload_json:string;created_at:string}|undefined;
          if(existing){
            if(existing.event_type !== eventType || existing.created_at !== record.created_at || JSON.stringify(files.payload(entry.kind,entry.id,entry.version,JSON.parse(existing.payload_json))) !== JSON.stringify(payload))throw new Error("History import event sequence conflicts");
            alreadyPresent++;return;
          }
          database.prepare("INSERT INTO events(stream,sequence,event_type,payload_json,created_at) VALUES(?,?,?,?,?)").run(entry.id,entry.version,eventType,JSON.stringify(projection),String(record.created_at));
          imported++;return;
        }
        if(TRACE_KINDS.has(entry.kind)){
          const id=entry.kind === "trace" || entry.kind === "trace_archive" ? entry.id : String(payload.trace_id);
          const existing=trace.find(entry.kind,entry.id,entry.version,id);
          traceBatch(id).records.push({kind:entry.kind,id:entry.id,version:entry.version,payload_json:JSON.stringify(projection),created_at:String(record.created_at),updated_at:String(record.updated_at)});
          if(existing)alreadyPresent++;else imported++;
          return;
        }
        if(CODEBASE_GRAPH_KINDS.has(entry.kind)){
          const existing=codebase.raw(entry.kind,entry.id,entry.version);
          codebase.importLegacy(entry.id,[{kind:entry.kind,id:entry.id,version:entry.version,payload_json:JSON.stringify(projection),created_at:String(record.created_at),updated_at:String(record.updated_at)}]);
          if(existing)alreadyPresent++;else imported++;
          return;
        }
        const existing=database.prepare("SELECT payload_json,created_at,updated_at FROM records WHERE kind=? AND id=? AND version=?").get(entry.kind,entry.id,entry.version) as {payload_json:string;created_at:string;updated_at:string}|undefined;
        if (existing) {
          if (JSON.stringify(files.payload(entry.kind,entry.id,entry.version,JSON.parse(existing.payload_json))) !== JSON.stringify(payload)
            || existing.created_at !== record.created_at || existing.updated_at !== record.updated_at) throw new Error("History import existing version conflicts");
          alreadyPresent++; return;
        }
        database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
          .run(entry.kind,entry.id,entry.version,JSON.stringify(projection),String(record.created_at),String(record.updated_at));
        imported++;
    };
    const flush=()=>{
      if(!pending.length)return;
      const projections=files.writeColdBatch(pending.map(({entry,record,payload})=>({kind:entry.kind,id:entry.id,version:entry.version,payload,created_at:String(record.created_at),updated_at:String(record.updated_at)})));
      for(let index=0;index<pending.length;index++)publish(pending[index]!,projections[index]!);
      for(const [id,batch] of traceBatches)trace.importLegacy(id,batch.records,batch.events);
      traceBatches.clear();pending.length=0;pendingBytes=0;
    };
    const enqueue=(item:Pending)=>{
      const bytes=Buffer.byteLength(JSON.stringify(item.payload))+Buffer.byteLength(item.entry.kind)+Buffer.byteLength(item.entry.id)+512;
      if(pending.length && (pending.length >= 1000 || pendingBytes+bytes > 8*1024*1024))flush();
      pending.push(item);pendingBytes+=bytes;
      if(pending.length >= 1000 || pendingBytes >= 8*1024*1024)flush();
    };
    try {
      database.exec("BEGIN IMMEDIATE");
      for (const entry of entries()) {
        const record=readArchivedHistory(archive,entry);
        const remap=(value:unknown):unknown=>{
          if (procedureDefinitionReference(value)) {
            if(owner !== "experience")return value;
            const attachment=(record.attachments as Array<{source:string;file:string}>).find(item=>item.source === value.path);
            if (!attachment) throw new Error("History import procedure attachment missing");
            const bytes=readFileSync(join(archive,attachment.file)),definition=JSON.parse(bytes.toString("utf8")) as {scope:string};
            let base=paths.experienceDir;
            if (definition.scope.startsWith("project:")) {
              const roots=aliases.get(definition.scope.slice("project:".length));
              if (roots?.length !== 1) throw new Error("History import project root is unavailable or ambiguous");
              base=join(ensureProjectStorageDirectory(paths,roots[0]!),"experience");
            }
            const path=join(experienceGraphDirectory(paths,value.procedure_id,false,base),"versions",`${String(value.procedure_version).padStart(6,"0")}.json`);
            mkdirSync(dirname(path),{recursive:true,mode:0o700});
            if (existsSync(path)) {
              if (lstatSync(path).isSymbolicLink() || !readFileSync(path).equals(bytes)) throw new Error("History import procedure destination conflicts");
            } else writeFileSync(path,bytes,{flag:"wx",mode:0o600});
            return {...value,path};
          }
          if (contentReference(value)) {
            if(value.kind !== owner)return value;
            const attachment=(record.attachments as Array<{source:string;file:string}>).find(item=>item.source === value.path);
            if (!attachment) throw new Error("History import Markdown attachment missing");
            const document=content.readUncheckedSync(join(archive,attachment.file));
            const path=content.namedPathFor(value.kind,value.record_id,value.version,String(document.manifest.title ?? value.title),undefined,document.manifest.scope);
            mkdirSync(dirname(path),{recursive:true,mode:0o700});
            const bytes=readFileSync(join(archive,attachment.file));
            if (existsSync(path)) {
              if (lstatSync(path).isSymbolicLink() || !readFileSync(path).equals(bytes)) throw new Error("History import Markdown destination conflicts");
            } else writeFileSync(path,bytes,{flag:"wx",mode:0o600});
            const next={...value,path};
            content.readSync(next);
            return next;
          }
          if (Array.isArray(value)) return value.map(remap);
          if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,remap(item)]));
          return value;
        };
        const payload=remap(record.payload) as JsonObject;
        if(["knowledge_claim","wiki_page","memory_ledger","episodic_memory","semantic_memory"].includes(entry.kind) && !contentReference(payload.content_ref)) {
          let body=typeof payload.content === "string" ? payload.content : undefined;
          if(body === undefined && entry.kind === "wiki_page" && typeof payload.file_path === "string") {
            const attachment=(record.attachments as Array<{source:string;file:string}>).find(item=>item.source === payload.file_path);
            if(!attachment)throw new Error("History import Wiki attachment missing");
            const file=join(archive,attachment.file);
            try{body=content.readUncheckedSync(file).body;}catch(error){if(!(error instanceof Error) || !/frontmatter/iu.test(error.message))throw error;body=readFileSync(file,"utf8");}
          }
          if(body !== undefined) {
            const scope=payload.scope ?? (payload.metadata as JsonObject|undefined)?.scope;
            const scopeKey=typeof scope === "string" ? scope : (scope as JsonObject).kind === "global" ? "global" : `${String((scope as JsonObject).kind)}:${String((scope as JsonObject).id)}`;
            const ref=content.writeSync({kind:entry.kind === "knowledge_claim" || entry.kind === "wiki_page" ? "knowledge" : "memory",record_id:entry.id,version:entry.version,
              scope:scopeKey,status:typeof payload.status === "string" ? payload.status : "legacy-unreviewed",sensitivity:typeof payload.sensitivity === "string" ? payload.sensitivity : "internal",
              source_id:typeof payload.source_id === "string" ? payload.source_id : "legacy-import",title:typeof payload.title === "string" ? payload.title : entry.id,body});
            payload.content_ref=ref;payload.content_digest=ref.digest;payload.content_storage="markdown";delete payload.content;
          }
        }
        if(entry.kind === "wiki_page" && contentReference(payload.content_ref))payload.file_path=payload.content_ref.path;
        if(entry.kind === "workspace_checkpoint" && entry.codebase_binding){
          const root=entry.codebase_binding.project_roots[0]!;
          const snapshot=join(ensureProjectStorageDirectory(paths,root),"codebase","snapshots",String(payload.workspace_id),entry.id);
          for(const attachment of record.attachments as Array<{file:string;purpose?:string;relative_path?:string}>){
            if(attachment.purpose !== "codebase_snapshot")continue;
            const path=resolve(snapshot,String(attachment.relative_path));
            if(!path.startsWith(resolve(snapshot)+sep))throw new Error("History import snapshot entry escapes root");
            mkdirSync(dirname(path),{recursive:true,mode:0o700});const bytes=readFileSync(join(archive,attachment.file));
            const hash=createHash("sha256").update(bytes).digest("hex"),blob=join(paths.root,"codebase","snapshot-blobs",`${hash}.blob`);
            mkdirSync(dirname(blob),{recursive:true,mode:0o700});
            if(existsSync(blob)){if(lstatSync(blob).isSymbolicLink() || !readFileSync(blob).equals(bytes))throw new Error("History import snapshot body conflicts");}
            else writeFileSync(blob,bytes,{flag:"wx",mode:0o600});
            if(existsSync(path)){if(lstatSync(path).isSymbolicLink() || !readFileSync(path).equals(bytes))throw new Error("History import snapshot destination conflicts");}
            else linkSync(blob,path);
          }
          payload.snapshot_root=snapshot;
        }
        for(const attachment of record.attachments as Array<{file:string;purpose?:string;record_kind?:string;record_id?:string;record_version?:number;created_at?:string;updated_at?:string}>){
          if(attachment.purpose !== "codebase_graph")continue;
          const graph=JSON.parse(readFileSync(join(archive,attachment.file),"utf8")) as JsonObject;
          const {id:ignoredId,version:ignoredVersion,created_at:ignoredCreated,updated_at:ignoredUpdated,...graphPayload}=graph;
          const graphEntry={...entry,kind:attachment.record_kind!,id:attachment.record_id!,version:attachment.record_version!};
          enqueue({entry:graphEntry,record:{created_at:attachment.created_at!,updated_at:attachment.updated_at!},payload:graphPayload});
        }
        enqueue({entry,record,payload});
      }
      flush();
      database.exec("COMMIT");
    } catch(error) {database.exec("ROLLBACK");throw error;}
    finally {database.close();trace.close();codebase.close();}
  }
  for(const entry of historyArchiveEntries(archive,manifest))if(entry.state !== "published" || entry.unresolved || entry.owner !== "identity" && !STORAGE_OWNERS.some(owner=>owner === entry.owner))quarantined++;
  return {imported,already_present:alreadyPresent,quarantined};
}
