import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, createReadStream, createWriteStream, existsSync, fstatSync, linkSync, lstatSync, openSync, readSync, mkdirSync, readFileSync, readdirSync, renameSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, Writable } from "node:stream";
import { createGzip, createGunzip, gzipSync, gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { RecordFileStore } from "craft-common-store-local/record-files";
import { MarkdownContentStore, contentReference } from "craft-common-store-local/content-store";
import { parseSessionStorageScopeId } from "craft-common-store-local/paths";
import { COGNITIVE_SCOPE_KINDS } from "craft-common-base/scope-policy";
import { stableDigest } from "craft-common-base/digest";
import { projectAliases } from "./storage-migration-preflight.ts";
import type { CraftPaths } from "./infrastructure/paths.ts";
import { codebaseGraphMatches, CodebaseHistoryBindings, type CodebaseHistoryBinding } from "./owner-history-codebase.ts";
import { withStoragePreflightSnapshot } from "./storage-preflight-snapshot.ts";

type ObjectValue = Record<string, unknown>;
type Row = { kind: string; id: string; version: number; payload_json: string; created_at: string; updated_at: string };
type Entry = { encoding?:"gzip";decoded_bytes?:number;owner: string; kind: string; id: string; version: number; digest: string; file: string; offset: number; bytes: number; state: "published" | "staged"; source: string; source_digest: string; unresolved: boolean; availability?:"available"|"unavailable"; native_binding?:{owner:string;record_type:string;data_space_snapshot:string;task_id?:string;trace_id?:string;project_id?:string}; codebase_binding?:CodebaseHistoryBinding };
type IndexFile={file:string;digest:string;count:number};
type SourceDocument={file:string;digest:string};
export type HistoryArchiveManifest = { schema: "craft.owner-history-archive.v1"; source_validation:"current"|"changed"; cutoff:{started_at_utc:string;completed_at_utc:string;primary_snapshot_identity:string}; source_database: string; source_root: string; archive_root:string; record_count:number; published_count:number; staged_count:number; unresolved_count:number; unavailable_count:number; unavailable_sources:Array<{file:string;code:string}>;
  project_roots: Array<{id:string;root:string}>; documents: SourceDocument[]; document_files:IndexFile[]; entries: Entry[]; entry_files:IndexFile[];
  sources: Array<{file:string; database_digest:string; digest:string; backup:string; backup_digest:string; backup_stored_digest:string; backup_encoding?:"gzip"}>; digest: string };

export function procedureDefinitionReference(value:unknown):value is {format:"json";procedure_id:string;procedure_version:number;kind:"workflow"|"graph";scope?:string;path:string;digest:string} {
  const ref=value as ObjectValue|null;
  return Boolean(ref && ref.format === "json" && typeof ref.procedure_id === "string" && Number.isSafeInteger(ref.procedure_version)
    && (ref.kind === "workflow" || ref.kind === "graph") && typeof ref.path === "string" && typeof ref.digest === "string");
}
export function historicalProjectAliases(database:DatabaseSync):Map<string,string[]> {
  const normalized=new Map<string,Set<string>>();
  for (const [id,roots] of projectAliases(database)) {
    const key=id.replace(/^project:/u,"");
    const values=normalized.get(key) ?? new Set<string>();roots.forEach(root=>values.add(root));normalized.set(key,values);
  }
  return new Map([...normalized].map(([id,roots])=>[id,[...roots].sort()]));
}
const domains = ["knowledge", "memory", "experience", "context", "evolution"];
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function regular(file: string): void {
  const absolute = resolve(file);
  let current = absolute;
  while (true) {
    if (lstatSync(current).isSymbolicLink() && current !== "/var" && current !== "/tmp") throw new Error("History archive refuses symbolic links");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!lstatSync(absolute).isFile()) throw new Error("History archive source is not a regular file");
}
function owner(kind: string, payload: ObjectValue): string {
  if (["project_identity","scope_alias","session_storage_identity"].includes(kind)) return "identity";
  const explicit = (payload.metadata as ObjectValue | undefined)?.capability_owner;
  if (["knowledge", "memory", "experience","context","notes","codebase","eval","runtime"].includes(String(explicit))) return String(explicit);
  if(kind === "procedure_configuration")return "experience";
  if(kind.startsWith("legacy_knowledge_migration"))return "knowledge";
  if(["source","artifact","capability","capability_lifecycle","checkpoint","route","route_strategy","project_data_migration","project_registry_migration","maintenance_schedule_receipt"].includes(kind) || kind.startsWith("workflow") && !kind.startsWith("workflow_evolution"))return "runtime";
  if (kind.startsWith("knowledge_memory_")) return "memory";
  if (/^(?:knowledge_|wiki_)/u.test(kind)) return "knowledge";
  if (/^(?:memory_|episodic_memory$|semantic_memory$)/u.test(kind)) return "memory";
  if (/^(?:experience_|workflow_evolution_)/u.test(kind)) return "experience";
  if (/^(?:codebase_|workspace_checkpoint$|workspace$)/u.test(kind)) return "codebase";
  if (/^(?:craft_note|directory_note)/u.test(kind)) return "notes";
  if (/^(?:eval_|evaluation_|benchmark_|simulation_)/u.test(kind)) return "eval";
  if (kind.startsWith("event:")) return "runtime";
  if (/^(?:trace(?:_|$)|telemetry_|task(?:_|$)|run(?:_|$)|work(?:_|$)|host(?:_|$)|runtime_|trial(?:_|$)|outcome(?:_|$)|event(?:_|$)|budget_|audit_)/u.test(kind)) return "runtime";
  if(kind === "maintenance_component")return "runtime";
  if(kind === "activation_proof_receipt")return "context";
  if(kind === "project")return "runtime";
  if(kind === "workbench_evaluation")return "eval";
  if (/^(?:context_|codex_hook_|turn_|evolution_)/u.test(kind)) return "context";
  return "unresolved";
}
function databaseDigest(database:DatabaseSync):string {
  const hash=createHash("sha256");
  const schema=database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  hash.update(JSON.stringify(schema));
  // Virtual tables have no independent persisted rows; their shadow tables and
  // complete schema are sealed below, even when this SQLite lacks their module.
  for (const item of schema) if (item.type === "table" && !/^CREATE\s+VIRTUAL\s+TABLE/iu.test(String(item.sql))) {
    const quoted=`"${String(item.name).replaceAll('"','""')}"`;
    const columns=database.prepare(`PRAGMA table_info(${quoted})`).all();
    const withoutRowid=/WITHOUT\s+ROWID/iu.test(String(item.sql));
    const primary=columns.filter(column=>Number(column.pk)>0).sort((a,b)=>Number(a.pk)-Number(b.pk));
    const keys=withoutRowid ? primary.map(column=>String(column.name)) : ["rowid"];
    const order=keys.map(name=>`"${name.replaceAll('"','""')}"`).join(",");
    let after: Array<string|number|bigint|null>|undefined;
    while(true){
      const clause=after ? ` WHERE (${order}) > (${keys.map(()=>"?").join(",")})` : "";
      const statement=database.prepare(`SELECT rowid AS _craft_archive_rowid,* FROM ${quoted}${clause} ORDER BY ${order} LIMIT 64`.replace("SELECT rowid AS _craft_archive_rowid,*",withoutRowid ? "SELECT *" : "SELECT rowid AS _craft_archive_rowid,*"));
      statement.setReadBigInts(true);
      const rows=statement.all(...(after ?? []));
      if(!rows.length)break;
      for(const row of rows)hash.update(JSON.stringify(row,(_key,value)=>typeof value === "bigint" ? {integer:value.toString()} : value));
      const last=rows[rows.length-1]!;
      after=withoutRowid ? keys.map(name=>last[name] as string|number|bigint|null) : [last._craft_archive_rowid as bigint];
    }
  }
  return hash.digest("hex");
}
type TableSnapshot={rows:()=>Iterable<Row>;fileMode:boolean;databaseDigest:string;database:DatabaseSync};
function readRows(file: string):TableSnapshot {
  regular(file);
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    database.exec("BEGIN");
    const meta = database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='meta'").get();
    const mode = meta ? database.prepare("SELECT value FROM meta WHERE key='record_files'").get() as {value:string} | undefined : undefined;
    const shardMode=database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='record_file_mode'").get();
    if (mode && mode.value !== "v1" && mode.value !== "v2") throw new Error("Unsupported historical record file mode");
    return {rows:function*(){
        let cursor:[string,string,number]|undefined;
        while(true){
          const rows=cursor ? database.prepare("SELECT kind,id,version,payload_json,created_at,updated_at FROM records WHERE (kind,id,version)>(?,?,?) ORDER BY kind,id,version LIMIT 64").all(...cursor) as Row[]
            : database.prepare("SELECT kind,id,version,payload_json,created_at,updated_at FROM records ORDER BY kind,id,version LIMIT 64").all() as Row[];
          if(!rows.length)break;
          yield* rows;
          const last=rows[rows.length-1]!;cursor=[last.kind,last.id,last.version];
        }
      },
      fileMode:mode?.value === "v1" || mode?.value === "v2" || Boolean(shardMode),databaseDigest:databaseDigest(database),database};
  } catch(error) {database.close();throw error;}
}
function rowsDigest(rows: Iterable<Row>): string {
  const hash=createHash("sha256").update("[");let first=true;
  for(const row of rows){if(!first)hash.update(",");hash.update(JSON.stringify(row));first=false;}
  return hash.update("]").digest("hex");
}

function key(row: Pick<Row,"kind"|"id"|"version">): string { return JSON.stringify([row.kind,row.id,row.version]); }
const spaceReserves=new Map<string,number>();
function assertArchiveSpace(root:string,bytes=0):void{
  const absolute=resolve(root);
  for(const [target,reserve] of spaceReserves)if(absolute === target || absolute.startsWith(target+sep)){
    let directory=absolute;while(!existsSync(directory))directory=dirname(directory);
    const stat=statfsSync(directory);
    if(Number(stat.bavail)*Number(stat.bsize) < reserve+bytes)throw Object.assign(new Error("History archive free-space reserve would be exceeded"),{code:"HISTORY_ARCHIVE_SPACE_RESERVE"});
  }
}
function writeImmutable(file: string, content: string | Buffer): void {
  let current = dirname(file);
  while (dirname(current) !== current) {
    if (lstatSync(current, {throwIfNoEntry:false})?.isSymbolicLink() && current !== "/var" && current !== "/tmp") throw new Error("History archive destination directory is unsafe");
    current = dirname(current);
  }
  mkdirSync(dirname(file), {recursive:true,mode:0o700});
  if (existsSync(file)) {
    regular(file);
    if (!readFileSync(file).equals(Buffer.from(content))) throw new Error("History archive destination conflict");
    return;
  }
  assertArchiveSpace(file,Buffer.byteLength(content));
  const temporary=`${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary,content,{flag:"wx",mode:0o600});
    try{linkSync(temporary,file);}catch(error){if((error as NodeJS.ErrnoException).code !== "EEXIST")throw error;writeImmutable(file,content);}
  } finally{if(existsSync(temporary))unlinkSync(temporary);}
}
function fileDigest(file:string):string {
  regular(file);const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW),hash=createHash("sha256"),buffer=Buffer.alloc(1024*1024);
  try{let count:number;while((count=readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,count));return hash.digest("hex");}finally{closeSync(fd);}
}
async function retainSnapshot(source:string,target:string,compress=false):Promise<{backup:string;backup_digest:string;backup_stored_digest:string;backup_encoding?:"gzip"}>{
  const hash=fileDigest(source),backup=join("backups",`${hash}.db${compress?".gz":""}`),file=join(target,backup);
  mkdirSync(dirname(file),{recursive:true,mode:0o700});
  if(existsSync(file)){
    let actual:string;
    if(compress){const verifier=createHash("sha256");await pipeline(createReadStream(file),createGunzip(),new Writable({write(chunk:Buffer,_encoding,callback){verifier.update(chunk);callback();}}));actual=verifier.digest("hex");}else actual=fileDigest(file);
    if(actual !== hash)throw new Error("History archive backup conflict");
    return {backup,backup_digest:hash,backup_stored_digest:fileDigest(file),...(compress?{backup_encoding:"gzip" as const}:{})};
  }
  assertArchiveSpace(file,compress?0:lstatSync(source).size);
  if(compress){
    const temporary=`${file}.${randomUUID()}.tmp`;let bytes=0;
    try{
      await pipeline(createReadStream(source),createGzip({level:1}),new Transform({transform(chunk:Buffer,_encoding,callback){bytes+=chunk.length;if(bytes>=8*1024*1024){try{assertArchiveSpace(file);bytes=0;}catch(error){callback(error as Error);return;}}callback(null,chunk);}}),createWriteStream(temporary,{flags:"wx",mode:0o600}));
      linkSync(temporary,file);
    }finally{if(existsSync(temporary))unlinkSync(temporary);}
    return {backup,backup_digest:hash,backup_stored_digest:fileDigest(file),backup_encoding:"gzip"};
  }
  chmodSync(source,0o600);
  try{linkSync(source,file);}catch(error){if((error as NodeJS.ErrnoException).code !== "EXDEV")throw error;copyFileSync(source,file,constants.COPYFILE_EXCL);chmodSync(file,0o600);}
  return {backup,backup_digest:hash,backup_stored_digest:hash};
}

class ArchiveIndex<T> {
  readonly values:T[]=[];
  readonly files:IndexFile[]=[];
  private pending:T[]=[];
  count=0;
  private readonly root:string;private readonly name:string;
  constructor(root:string,name:string){this.root=root;this.name=name;}
  append(value:T):void {
    this.count++;
    if(this.count <= 10000)this.values.push(value);else this.values.length=0;
    this.pending.push(value);
    if(this.pending.length === 1000)this.flush();
  }
  private flush():void {
    if(!this.pending.length)return;
    const content=this.pending.map(value=>JSON.stringify(value)).join("\n")+"\n",hash=digest(content),file=join(this.name,`${hash}.jsonl`);
    writeImmutable(join(this.root,file),content);this.files.push({file,digest:hash,count:this.pending.length});this.pending=[];
  }
  finish():void{this.flush();}
}
function* indexValues<T>(root:string,inline:T[],files:IndexFile[]):Iterable<T>{
  if(inline.length){yield* inline;return;}
  for(const index of files){
    const file=resolve(root,index.file);
    if(!file.startsWith(resolve(root)+sep))throw new Error("History archive index escapes root");
    regular(file);const bytes=readFileSync(file);
    if(digest(bytes) !== index.digest)throw new Error("History archive index digest mismatch");
    const lines=bytes.toString("utf8").trimEnd().split("\n");
    if(lines.length !== index.count)throw new Error("History archive index count mismatch");
    for(const line of lines)yield JSON.parse(line) as T;
  }
}
export function historyArchiveEntries(root:string,manifest:HistoryArchiveManifest):Iterable<Entry>{return indexValues(root,manifest.entries,manifest.entry_files);}
/** Export only. No source writes, ownership switch, trust promotion or history deletion. */
export async function archiveOwnerHistory(paths: CraftPaths, destination: string,options:{allowSourceDrift?:boolean;compressBackups?:boolean;compressHistory?:boolean;minimumFreeBytes?:number;onProgress?:(progress:{phase:string;items:number;bytes:number;free_bytes:number})=>void}={}): Promise<HistoryArchiveManifest> {
  const startedAt=new Date().toISOString();
  const target = resolve(destination);
  const sourceRoot = resolve(paths.root);
  const progress=(phase:string,items=0,bytes=0)=>{let directory=target;while(!existsSync(directory))directory=dirname(directory);const stat=statfsSync(directory);options.onProgress?.({phase,items,bytes,free_bytes:Number(stat.bavail)*Number(stat.bsize)});};
  progress("snapshot_start");
  if (target === sourceRoot || relative(target, sourceRoot).split(sep)[0] !== ".." || relative(sourceRoot, target).split(sep)[0] !== "..") throw new Error("History archive target contains the live source");
  if(options.minimumFreeBytes !== undefined){if(!Number.isSafeInteger(options.minimumFreeBytes) || options.minimumFreeBytes<0)throw new Error("History archive free-space reserve is invalid");spaceReserves.set(target,options.minimumFreeBytes);}
  try{
  assertArchiveSpace(target,lstatSync(paths.databaseFile).size);
  return await withStoragePreflightSnapshot(paths, async snapshot => {
    const primary = readRows(snapshot.databaseFile);progress("primary_snapshot_sealed");
    let cutoff:HistoryArchiveManifest["cutoff"];
    try{
      const cutoffFile=join(target,"snapshots",`${primary.databaseDigest}.json`);
      cutoff=existsSync(cutoffFile) ? JSON.parse(readFileSync(cutoffFile,"utf8")) as HistoryArchiveManifest["cutoff"] : {started_at_utc:startedAt,completed_at_utc:new Date().toISOString(),primary_snapshot_identity:primary.databaseDigest};
      if(cutoff.primary_snapshot_identity !== primary.databaseDigest)throw new Error("History archive cutoff identity conflicts");
      writeImmutable(cutoffFile,JSON.stringify(cutoff));
    }catch(error){primary.database.close();throw error;}
    const unavailableSources=new Map<string,string>();
    const sourceError=(error:unknown)=> (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing_file" : error instanceof Error && /symbolic|unsafe|regular/iu.test(error.message) ? "unsafe_source" : error instanceof Error && /digest|drift/iu.test(error.message) ? "digest_mismatch" : "unreadable_source";
    const tables = new Map<string, ReturnType<typeof readRows>>([[paths.databaseFile,primary]]);
    const shardDirectories=[...new Set([join(paths.root,"trace","v1"),join(paths.root,"codebase","legacy-graph-v1"),join(dirname(paths.databaseFile),"trace","v1"),join(dirname(paths.databaseFile),"codebase","legacy-graph-v1")])];
    const isShard=(file:string)=>shardDirectories.some(directory=>file.startsWith(directory+sep));
    const fileReader = (file:string) => new RecordFileStore(paths.root,isShard(file) || !tables.get(file)!.fileMode ? dirname(paths.databaseFile) : dirname(file));
    const hydrate=(source:string,table:TableSnapshot,row:Row)=>{
      const indexed=JSON.parse(row.payload_json) as ObjectValue;
      if(!primary.fileMode && !table.fileMode)return {payload:indexed,diagnostics:[] as Array<{file:string;code:string}>};
      try{return {payload:fileReader(source).payload(row.kind,row.id,row.version,indexed),diagnostics:[] as Array<{file:string;code:string}>};}
      catch(error){const ref=indexed._record_file as {path?:unknown}|undefined;return {payload:indexed,diagnostics:[{file:typeof ref?.path === "string"?join(paths.root,ref.path):source,code:sourceError(error)}]};}
    };
    try {
    const identities=primary.database.prepare("SELECT kind,id,version,payload_json,created_at,updated_at FROM records WHERE kind IN ('project_identity','scope_alias','session_storage_identity') ORDER BY kind,id,version").all() as Row[];
    const aliasesDatabase=new DatabaseSync(":memory:");
    let aliases:Map<string,string[]>;
    try {
      aliasesDatabase.exec("CREATE TABLE records(kind TEXT,id TEXT,version INTEGER,payload_json TEXT)");
      for (const row of identities) {
        const decoded=hydrate(paths.databaseFile,primary,row);if(decoded.diagnostics.length)continue;const payload=decoded.payload;
        aliasesDatabase.prepare("INSERT INTO records VALUES(?,?,?,?)").run(row.kind,row.id,row.version,JSON.stringify(payload));
      }
      aliases=historicalProjectAliases(aliasesDatabase);
    } finally {aliasesDatabase.close();}
    let inventoryRows=0;
    for (const row of primary.rows()) {
      inventoryRows++;if(inventoryRows%1000===0)progress("source_inventory_records",inventoryRows);
      const payload = JSON.parse(row.payload_json) as ObjectValue;
      for (const domain of domains) {
        const pointer = payload[`_${domain}_partition`] as {file?:unknown} | undefined;
        if (pointer) {
          if (typeof pointer.file !== "string" || !isAbsolute(pointer.file)){unavailableSources.set(String(pointer.file),"invalid_partition_pointer");continue;}
          if (!tables.has(pointer.file) && !unavailableSources.has(pointer.file))try{tables.set(pointer.file,readRows(pointer.file));}catch(error){unavailableSources.set(pointer.file,sourceError(error));}
        }
      }
    }
    for (const directory of shardDirectories) {
      if (!existsSync(directory)) continue;
      for (const name of readdirSync(directory).sort()) if (/^[a-f0-9]{2}\.db$/u.test(name)) {
        const file = join(directory,name);
        if (!tables.has(file))try{tables.set(file,readRows(file));}catch(error){unavailableSources.set(file,sourceError(error));}
      }
    }
    type Captured={source:string;file:string;digest:string;bytes:number;signature:string};
    const checkpointCaptures=new Map<string,string>(),verifiedBlobs=new Set<string>();let capturedCount=0,capturedBytes=0;
    const signature=(file:string)=>{const stat=lstatSync(file,{bigint:true});return [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(":");};
    const verifiedBlob=(item:Captured)=>{if(!/^[a-f0-9]{64}$/u.test(item.digest) || item.file!==join("codebase","content",`${item.digest}.blob`))throw new Error("Snapshot archive blob path is unsafe");const file=join(target,item.file);if(!verifiedBlobs.has(file)){regular(file);if(fileDigest(file)!==item.digest)throw new Error("Snapshot archive blob digest mismatch");verifiedBlobs.add(file);}};
    const captureSnapshot=(id:string,version:number,root:string,items:ObjectValue[])=>{
      const identity=digest(JSON.stringify({id,version,root,items})),cache=join(target,"snapshot-capture",`${identity}.json`);
      let previous:Captured[]=[];
      if(existsSync(cache)){regular(cache);const body=JSON.parse(readFileSync(cache,"utf8")) as {identity:string;files:Captured[]};if(body.identity!==identity || !Array.isArray(body.files))throw new Error("Snapshot capture identity conflict");previous=body.files;}
      const previousBySource=new Map(previous.map(item=>[item.source,item])),files:Captured[]=[];
      for(const entry of items){
        if(typeof entry.path!=="string" || isAbsolute(entry.path) || entry.path.split(/[\\/]/u).some(part=>!part || part==="." || part===".."))throw new Error("unsafe snapshot entry");
        const source=resolve(root,entry.path);if(!source.startsWith(resolve(root)+sep))throw new Error("unsafe snapshot source");regular(source);
        const current=signature(source),prior=previousBySource.get(source);let item:Captured;
        if(prior && prior.signature===current && prior.digest===entry.digest && prior.bytes===entry.size_bytes){verifiedBlob(prior);item=prior;}
        else{
          const bytes=readFileSync(source),hash=digest(bytes);if(bytes.length!==entry.size_bytes || hash!==entry.digest || signature(source)!==current)throw new Error("snapshot content drifted");
          const file=join("codebase","content",`${hash}.blob`);item={source,file,digest:hash,bytes:bytes.length,signature:current};
          if(!verifiedBlobs.has(join(target,file))){writeImmutable(join(target,file),bytes);verifiedBlobs.add(join(target,file));}
        }
        files.push(item);capturedCount++;capturedBytes+=item.bytes;if(capturedCount%1000===0)progress("snapshot_capture",capturedCount,capturedBytes);
      }
      const content=JSON.stringify({identity,files});
      if(existsSync(cache)){if(readFileSync(cache,"utf8")!==content){const temporary=`${cache}.${randomUUID()}.tmp`;writeFileSync(temporary,content,{flag:"wx",mode:0o600});renameSync(temporary,cache);}}else writeImmutable(cache,content);
      checkpointCaptures.set(JSON.stringify([id,version]),cache);
    };
    progress("source_inventory_complete",tables.size);
    const codebase=new CodebaseHistoryBindings(paths,snapshot.databaseFile,(kind,id,version,raw)=>{const decoded=hydrate(paths.databaseFile,primary,{kind,id,version,payload_json:raw,created_at:"",updated_at:""});return decoded.diagnostics.length ? {} : decoded.payload;},captureSnapshot);
    progress("snapshot_capture_complete",capturedCount,capturedBytes);
    const codebaseRoots=new Set<string>();
    const taskProjects=new Map<string,Set<string>>(),traceProjects=new Map<string,Set<string>>();
    for(const row of primary.database.prepare("SELECT kind,id,version,payload_json,created_at,updated_at FROM records WHERE kind='task' ORDER BY id,version").all() as Row[]){
      const decoded=hydrate(paths.databaseFile,primary,row);
      if(!decoded.diagnostics.length && typeof decoded.payload.project_id === "string"){const values=taskProjects.get(row.id) ?? new Set<string>();values.add(decoded.payload.project_id);taskProjects.set(row.id,values);}
    }
    const evidenceOwners=new Map<string,Set<string>>();
    let ownershipRows=0;
    for (const [source,table] of tables) for (const row of table.rows()) {
      ownershipRows++;if(ownershipRows%1000===0)progress("ownership_inventory",ownershipRows);
      const decoded=hydrate(source,table,row),payload=decoded.payload;
      if(decoded.diagnostics.length)continue;
      if(row.kind === "trace")for(const project of taskProjects.get(String(payload.task_id)) ?? []){const values=traceProjects.get(row.id) ?? new Set<string>();values.add(project);traceProjects.set(row.id,values);}
      const member=owner(row.kind,payload);
      if (member === "unresolved" || member === "identity") continue;
      const refs=Array.isArray(payload.evidence_ids) ? payload.evidence_ids : [];
      for (const id of refs) if (typeof id === "string") {
        const members=evidenceOwners.get(id) ?? new Set<string>();members.add(member);evidenceOwners.set(id,members);
      }
    }
    const entries=new ArchiveIndex<Entry>(target,"record-index");
    const documents=new ArchiveIndex<SourceDocument>(target,"source-index");
    const authorityDigests=new Map<string,string>();
    let publishedCount=0,stagedCount=0,unresolvedCount=0,unavailableCount=0;
    const published = new Set<string>();
    const blocks = new Map<string,{content:string;entries:Entry[]}>();
    const flushBlock = (name:string) => {
      const block = blocks.get(name)!;
      const raw=Buffer.from(block.content),compressed=Boolean(options.compressHistory && raw.length<=MAX_HISTORY_DECODED_BLOCK_BYTES);
      const bytes=compressed ? gzipSync(raw,{level:1}) : raw,file=join(name,"history",`${digest(bytes)}.jsonl${compressed?".gz":""}`);
      writeImmutable(join(target,file),bytes);
      for (const entry of block.entries) {entry.file=file;if(compressed){entry.encoding="gzip";entry.decoded_bytes=raw.length;}entries.append(entry);}
      blocks.delete(name);
    };
    const archiveRow = (row:Row, payload:ObjectValue, source:string, state:"published"|"staged",initialDiagnostics:Array<{file:string;code:string}>=[]) => {
      const inferred=owner(row.kind,payload);
      const members=evidenceOwners.get(row.id);
      const ownerName = row.kind === "evidence" && inferred === "unresolved" && members?.size === 1 ? [...members][0]! : inferred;
      const codebaseBinding=ownerName === "codebase" ? codebase.binding(row.kind,row.id,row.version,payload) : null;
      for(const root of codebaseBinding?.project_roots ?? [])codebaseRoots.add(root);
      const nativeBinding=ownerName === "runtime" || ownerName === "notes" || ownerName === "eval" || ownerName === "context" && (row.kind.endsWith("_receipt") || row.kind === "activation_proof_receipt" || row.kind.startsWith("codex_hook_"))
        ? {owner:ownerName,record_type:row.kind,data_space_snapshot:primary.databaseDigest,...Object.fromEntries(["task_id","trace_id","project_id"].filter(key=>typeof payload[key] === "string").map(key=>[key,payload[key] as string]))}:undefined;
      if(nativeBinding && nativeBinding.owner === "runtime" && typeof payload.project_id !== "string"){
        const projects=typeof payload.trace_id === "string" ? traceProjects.get(payload.trace_id) : row.kind === "trace" ? traceProjects.get(row.id) : taskProjects.get(String(payload.task_id));
        if(projects?.size === 1)Object.assign(nativeBinding,{project_id:[...projects][0]!});
      }
      const scope = payload.scope ?? (payload.metadata as ObjectValue | undefined)?.scope;
      const kind=typeof scope === "string" ? scope.split(":")[0] : (scope as ObjectValue | undefined)?.kind;
      const id=typeof scope === "string" ? scope.slice(String(kind).length+1) : (scope as ObjectValue | undefined)?.id;
      let unresolved = ownerName !== "identity" && !row.kind.startsWith("event:") && !codebaseBinding && !nativeBinding && (ownerName === "unresolved" || scope === undefined || !COGNITIVE_SCOPE_KINDS.some(allowed=>allowed === kind)
        || kind === "project" && aliases.get(String(id))?.length !== 1
        || kind === "session" && !parseSessionStorageScopeId(String(id)));
      const attachments: Array<{source:string;file:string;digest:string;purpose?:string;relative_path?:string;record_kind?:string;record_id?:string;record_version?:number;created_at?:string;updated_at?:string}> = [];
      const diagnostics:Array<{file:string;code:string}>=[...initialDiagnostics];
      if(diagnostics.length)unresolved=true;
      const indexedAuthority=JSON.parse(row.payload_json) as ObjectValue;
      if(indexedAuthority._record_file && !diagnostics.length && (primary.fileMode || tables.get(source)?.fileMode)){
        for(const reference of fileReader(source).referencedFiles(row.kind,row.id,row.version,indexedAuthority)){
          const file=join(paths.root,reference.path);
          if(!authorityDigests.has(file)){const hash=fileDigest(file);if(reference.digest && reference.digest !== hash)throw new Error("Source record authority digest drifted");authorityDigests.set(file,hash);documents.append({file,digest:hash});if(authorityDigests.size>16)authorityDigests.delete(authorityDigests.keys().next().value!);}
        }
      }
      const retain=(source:string,extension:string,verify?:(bytes:Buffer)=>void,extra:Partial<typeof attachments[number]>={})=>{
        let bytes:Buffer|undefined;
        try{regular(source);bytes=readFileSync(source);verify?.(bytes);}catch(error){unresolved=true;diagnostics.push({file:source,code:sourceError(error)});}
        if(bytes){const hash=digest(bytes),file=join(ownerName,"content",`${hash}.${extension}`);writeImmutable(join(target,file),bytes);attachments.push({source,file,digest:hash,...extra});documents.append({file:source,digest:hash});}
      };
      const visit = (value:unknown):void => {
        if (procedureDefinitionReference(value)) {
          retain(value.path,"json",bytes=>{
            const definition=JSON.parse(bytes.toString("utf8")) as ObjectValue;
            if(stableDigest(definition) !== value.digest || definition.procedure_id !== value.procedure_id || definition.procedure_version !== value.procedure_version || definition.kind !== value.kind)throw new Error("Historical procedure definition drifted");
          });return;
        }
        if (contentReference(value)) {
          retain(value.path,"md",()=>{
            const document=new MarkdownContentStore(paths).readUncheckedSync(value.path);
            if(document.manifest.record_id !== value.record_id || document.manifest.record_version !== value.version || document.manifest.record_kind !== value.kind || document.manifest.body_digest !== value.digest || `sha256:${digest(document.body)}` !== value.digest)throw new Error("Historical Markdown reference drifted");
          });return;
        }
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") Object.values(value).forEach(visit);
      };
      visit(payload);
      if(row.kind === "wiki_page" && !contentReference(payload.content_ref) && typeof payload.file_path === "string")retain(payload.file_path,"md");
      const capture=checkpointCaptures.get(JSON.stringify([row.id,row.version]));
      const frozenFiles=capture ? new Map((JSON.parse(readFileSync(capture,"utf8")) as {files:Captured[]}).files.map(file=>[file.source,file])) : undefined;
      if(row.kind === "workspace_checkpoint" && Array.isArray(payload.entries) && typeof payload.snapshot_root === "string" && (codebaseBinding || payload.snapshot_root.startsWith(join(paths.root,"projects")+sep) || payload.snapshot_root.startsWith(join(paths.runtimeDir,"workspaces")+sep)))for(const item of payload.entries as ObjectValue[]){
        const source=resolve(String(payload.snapshot_root),String(item.path));
        if(!source.startsWith(resolve(String(payload.snapshot_root))+sep)){unresolved=true;diagnostics.push({file:source,code:"snapshot_out_of_scope"});continue;}
        const frozen=frozenFiles?.get(source);
        if(frozen){
          try{regular(source);if(signature(source)!==frozen.signature)throw new Error("snapshot content drifted");verifiedBlob(frozen);attachments.push({source,file:frozen.file,digest:frozen.digest,purpose:"codebase_snapshot",relative_path:String(item.path)});documents.append({file:source,digest:frozen.digest});}
          catch(error){unresolved=true;diagnostics.push({file:source,code:sourceError(error)});}
        }else retain(source,"blob",bytes=>{if(bytes.length !== item.size_bytes || digest(bytes) !== item.digest)throw new Error("snapshot digest mismatch");},{purpose:"codebase_snapshot",relative_path:String(item.path)});
      }
      if(row.kind === "codebase_index" && payload.graph_storage === "project-sharded-v5"){
        const directories=codebase.artifactDirectories(payload);
        const refs=[...(Array.isArray(payload.shard_ids)?payload.shard_ids.map((id,ordinal)=>({kind:"codebase_index_shard",id:String(id),digest:String((payload.shard_digests as unknown[])[ordinal])})):[]),...(Array.isArray(payload.edge_route_shards)?(payload.edge_route_shards as ObjectValue[]).map(ref=>({kind:"codebase_index_edge_route",id:String(ref.id),digest:String(ref.digest)})):[])];
        if(!directories.length){unresolved=true;diagnostics.push({file:String(payload.workspace_id),code:"graph_directory_unresolved"});}
        for(const directory of directories)for(const ref of refs){
          if(!/^codebase_(?:shard|edge_route)_[A-Za-z0-9_-]{1,128}$/u.test(ref.id)){unresolved=true;diagnostics.push({file:ref.id,code:"invalid_graph_reference"});continue;}
          const source=join(directory,`${ref.id}.json`),extra:Partial<typeof attachments[number]>={purpose:"codebase_graph",record_kind:ref.kind,record_id:ref.id};
          retain(source,"json",bytes=>{
            const value=JSON.parse(bytes.toString("utf8")) as ObjectValue;
            const {id:ignoredId,version:ignoredVersion,created_at:ignoredCreated,updated_at:ignoredUpdated,...body}=value;
            if(value.id !== ref.id || !Number.isSafeInteger(value.version) || !codebaseGraphMatches(ref.kind,String(payload.graph_storage),ref.digest,body))throw new Error("graph digest mismatch");
            let times:{created_at:string;updated_at:string}|undefined;
            for(const table of tables.values()){times=table.database.prepare("SELECT created_at,updated_at FROM records WHERE kind=? AND id=? AND version=?").get(ref.kind,ref.id,Number(value.version)) as typeof times;if(times)break;}
            extra.record_version=Number(value.version);extra.created_at=times?.created_at ?? "";extra.updated_at=times?.updated_at ?? "";
          },extra);
        }
      }
      const indexed=JSON.parse(row.payload_json) as ObjectValue;
      const record = JSON.stringify({...row,payload:indexed._record_file !== undefined && payload._record_file === undefined ? payload : undefined,attachments,...(diagnostics.length?{diagnostics}:{})});
      const hash = digest(record);
      const block = blocks.get(ownerName) ?? {content:"",entries:[]};
      if((publishedCount+stagedCount)%1000===0)progress("record_archive",publishedCount+stagedCount);
      const entry:Entry = {owner:ownerName,kind:row.kind,id:row.id,version:row.version,digest:hash,file:"",offset:Buffer.byteLength(block.content),bytes:Buffer.byteLength(record),state,source,source_digest:digest(row.payload_json),unresolved,availability:diagnostics.length?"unavailable":"available",...(nativeBinding?{native_binding:nativeBinding}:{}),...(codebaseBinding?{codebase_binding:codebaseBinding}:{})};
      block.content += record + "\n";
      block.entries.push(entry);blocks.set(ownerName,block);
      if(state === "published")publishedCount++;else stagedCount++;
      if(unresolved)unresolvedCount++;
      if(diagnostics.length)unavailableCount++;
      if (block.entries.length >= 1000 || Buffer.byteLength(block.content) >= 8 * 1024 * 1024) flushBlock(ownerName);
    };
    for (const [source,table] of tables) for (const row of table.rows()) {
      if (source === paths.databaseFile) continue;
      const decoded=hydrate(source,table,row),payload=decoded.payload;
      const central = primary.database.prepare("SELECT payload_json,created_at,updated_at FROM records WHERE kind=? AND id=? AND version=?").get(row.kind,row.id,row.version) as {payload_json:string;created_at:string;updated_at:string}|undefined;
      const header = central ? JSON.parse(central.payload_json) as ObjectValue : undefined;
      const matched = header && domains.some(domain=>(header[`_${domain}_partition`] as {file?:unknown;record_id?:unknown} | undefined)?.file === source);
      const shard = isShard(source);
      if(!matched && central && central.payload_json === row.payload_json && central.created_at === row.created_at && central.updated_at === row.updated_at)continue;
      const state = matched || shard && !central ? "published" : "staged";
      archiveRow(row,payload,source,state,decoded.diagnostics);
      if (matched) published.add(key(row));
    }
    for (const row of primary.rows()) {
      const header = JSON.parse(row.payload_json) as ObjectValue;
      if (domains.some(domain=>header[`_${domain}_partition`] !== undefined)) {
        if (!published.has(key(row))){
          const pointer=domains.map(domain=>header[`_${domain}_partition`] as {file?:unknown}|undefined).find(value=>value !== undefined)!;
          const file=String(pointer?.file);
          archiveRow(row,header,paths.databaseFile,"published",[{file,code:unavailableSources.get(file) ?? "missing_partition_version"}]);
        }
        continue;
      }
      const decoded=hydrate(paths.databaseFile,primary,row);
      archiveRow(row,decoded.payload,paths.databaseFile,"published",decoded.diagnostics);
    }
    for (const [source,table] of tables) {
      const columns=table.database.prepare("PRAGMA table_info(events)").all().map(column=>String(column.name));
      if(!["stream","sequence","event_type","payload_json","created_at"].every(name=>columns.includes(name)))continue;
      let cursor:[string,number]|undefined;
      while(true){
        const events=cursor ? table.database.prepare("SELECT stream,sequence,event_type,payload_json,created_at FROM events WHERE (stream,sequence)>(?,?) ORDER BY stream,sequence LIMIT 64").all(...cursor)
          : table.database.prepare("SELECT stream,sequence,event_type,payload_json,created_at FROM events ORDER BY stream,sequence LIMIT 64").all();
        if(!events.length)break;
        for(const event of events){
          const row:Row={kind:`event:${event.event_type}`,id:String(event.stream),version:Number(event.sequence),payload_json:String(event.payload_json),created_at:String(event.created_at),updated_at:String(event.created_at)};
          const decoded=hydrate(source,table,row);archiveRow(row,decoded.payload,source,"published",decoded.diagnostics);
        }
        const last=events[events.length-1]!;cursor=[String(last.stream),Number(last.sequence)];
      }
    }
    for (const name of blocks.keys()) flushBlock(name);

    const sources: HistoryArchiveManifest["sources"] = [];
    for (const [file,table] of tables) {
      const retain=async(copy:{databaseFile:string})=>{const backup=await retainSnapshot(copy.databaseFile,target,options.compressBackups);sources.push({file,database_digest:table.databaseDigest,digest:rowsDigest(table.rows()),...backup});progress("source_backup",sources.length);};
      if(file === paths.databaseFile)await retain(snapshot);
      else {assertArchiveSpace(target,lstatSync(file).size);await withStoragePreflightSnapshot({...paths,databaseFile:file},async copy=>{await retain(copy);});}
    }
    progress("backups_complete",sources.length);
    sources.sort((a,b)=>a.file.localeCompare(b.file));
    // A primary snapshot does not freeze domain files. Every source is rechecked
    // before publication; a concurrent change requires a new export.
    entries.finish();documents.finish();
    const body = {schema:"craft.owner-history-archive.v1" as const,source_validation:"current" as "current"|"changed",cutoff,source_database:paths.databaseFile,source_root:paths.root,archive_root:target,
      record_count:entries.count,published_count:publishedCount,staged_count:stagedCount,unresolved_count:unresolvedCount,unavailable_count:unavailableCount,unavailable_sources:[...unavailableSources].map(([file,code])=>({file,code})),
      project_roots:[...[...aliases].filter(([,roots])=>roots.length === 1).map(([id,roots])=>({id,root:roots[0]!})),...[...codebaseRoots].map(root=>({id:"codebase-root",root}))],
      documents:documents.values,document_files:documents.files,entries:entries.values,entry_files:entries.files,sources};
    let manifest = {...body,digest:digest(JSON.stringify(body))};
    progress("source_verify");
    try{verifyHistoryArchiveSources(manifest,(phase,items)=>progress(phase,items));}catch(error){
      if(!options.allowSourceDrift || (error as {code?:string}).code !== "SOURCE_DATABASE_CHANGED")throw error;
      body.source_validation="changed";manifest={...body,digest:digest(JSON.stringify(body))};
    }
    writeImmutable(join(target,`manifest-${manifest.digest}.json`),JSON.stringify(manifest));
    return manifest;
    } finally {for(const table of tables.values())table.database.close();}
  });
  }finally{spaceReserves.delete(target);}
}
/** Compressed archive blocks are bounded independently of untrusted manifest metadata. */
export const MAX_HISTORY_DECODED_BLOCK_BYTES=64*1024*1024;
const decodedHistoryBlocks=new Map<string,{signature:string;bytes:Buffer}>();
function decodedHistoryBlock(file:string,expected:unknown):Buffer {
  if(!Number.isSafeInteger(expected) || Number(expected)<1 || Number(expected)>MAX_HISTORY_DECODED_BLOCK_BYTES)throw new Error("History archive decoded block length is invalid");
  const name=basename(file);if(!/^[a-f0-9]{64}\.jsonl\.gz$/u.test(name))throw new Error("History archive gzip block name is invalid");
  const stat=lstatSync(file,{bigint:true}),signature=[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(":");
  const cached=decodedHistoryBlocks.get(file);
  if(cached?.signature===signature){if(cached.bytes.length!==expected)throw new Error("History archive decoded block length mismatch");decodedHistoryBlocks.delete(file);decodedHistoryBlocks.set(file,cached);return cached.bytes;}
  if(stat.size>BigInt(MAX_HISTORY_DECODED_BLOCK_BYTES+1024*1024))throw new Error("History archive compressed block exceeds its bound");
  const compressed=readFileSync(file);if(digest(compressed)!==name.slice(0,64))throw new Error("History archive compressed block digest mismatch");
  let bytes:Buffer;
  try{bytes=gunzipSync(compressed,{maxOutputLength:Number(expected)});}catch(error){throw new Error("History archive gzip codec or decoded length is invalid",{cause:error});}
  if(bytes.length!==expected)throw new Error("History archive decoded block length mismatch");
  decodedHistoryBlocks.set(file,{signature,bytes});while(decodedHistoryBlocks.size>2)decodedHistoryBlocks.delete(decodedHistoryBlocks.keys().next().value!);
  return bytes;
}
/** Exact cold read validates identity and bytes; it never grants current eligibility. */
export function readArchivedHistory(root:string, entry:Entry): ObjectValue {
  const file = resolve(root,entry.file);
  if (!file.startsWith(resolve(root)+sep)) throw new Error("History archive reference escapes root");
  regular(file);
  if (!Number.isSafeInteger(entry.offset) || entry.offset < 0 || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1) throw new Error("History archive range invalid");
  let content:string;
  if(entry.encoding!==undefined){
    if(entry.encoding!=="gzip")throw new Error("Unsupported history archive block codec");
    const bytes=decodedHistoryBlock(file,entry.decoded_bytes);
    if(entry.offset+entry.bytes>bytes.length)throw new Error("History archive range invalid");
    content=bytes.subarray(entry.offset,entry.offset+entry.bytes).toString("utf8");
  }else{
    if(entry.decoded_bytes!==undefined || file.endsWith(".gz"))throw new Error("History archive block codec declaration missing");
    const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      if(entry.offset+entry.bytes > fstatSync(fd).size)throw new Error("History archive range invalid");
      const bytes=Buffer.alloc(entry.bytes);let offset=0;
      while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,entry.offset+offset);if(!count)throw new Error("History archive range truncated");offset+=count;}
      content=bytes.toString("utf8");
    } finally{closeSync(fd);}
  }
  if (digest(content) !== entry.digest) throw new Error("History archive digest mismatch");
  const record = JSON.parse(content) as ObjectValue;
  if (record.kind !== entry.kind || record.id !== entry.id || record.version !== entry.version) throw new Error("History archive identity mismatch");
  if(record.payload === undefined)record.payload=JSON.parse(String(record.payload_json));
  for (const attachment of record.attachments as Array<{file:string;digest:string}>) {
    const path = resolve(root,attachment.file);
    if (!path.startsWith(resolve(root)+sep)) throw new Error("History archive attachment escapes root");
    regular(path);
    if (digest(readFileSync(path)) !== attachment.digest) throw new Error("History archive attachment digest mismatch");
  }
  return record;
}


/** Re-encode an existing copy without re-reading or modifying its original data sources. */
export function compressHistoryArchive(root:string,manifest:HistoryArchiveManifest,onProgress?:(items:number)=>void):HistoryArchiveManifest {
  const {digest:expected,...body}=manifest;if(manifest.schema!=="craft.owner-history-archive.v1" || digest(JSON.stringify(body))!==expected)throw new Error("History manifest digest mismatch");
  const target=resolve(root),entries=new ArchiveIndex<Entry>(target,"compressed-record-index");
  const append=(entry:Entry)=>{entries.append(entry);if(entries.count%1000===0)onProgress?.(entries.count);};
  let currentFile:string|undefined,currentBytes:Buffer|undefined,currentEncoding:{file:string;encoding:"gzip";decoded_bytes:number}|undefined;
  decodedHistoryBlocks.clear();
  for(const entry of historyArchiveEntries(target,manifest)){
    const file=resolve(target,entry.file);if(!file.startsWith(target+sep))throw new Error("History archive reference escapes root");regular(file);
    if(entry.encoding!==undefined){if(entry.encoding!=="gzip")throw new Error("Unsupported history archive block codec");const bytes=decodedHistoryBlock(file,entry.decoded_bytes);if(entry.offset<0 || entry.bytes<1 || !Number.isSafeInteger(entry.offset) || !Number.isSafeInteger(entry.bytes) || entry.offset+entry.bytes>bytes.length || digest(bytes.subarray(entry.offset,entry.offset+entry.bytes))!==entry.digest)throw new Error("History archive range or digest mismatch");append(entry);continue;}
    if(entry.decoded_bytes!==undefined || file.endsWith(".gz"))throw new Error("History archive block codec declaration missing");
    if(lstatSync(file).size>MAX_HISTORY_DECODED_BLOCK_BYTES){append(entry);continue;}
    if(currentFile!==file){
      decodedHistoryBlocks.clear();currentFile=file;currentBytes=readFileSync(file);
      if(!/^[a-f0-9]{64}\.jsonl$/u.test(basename(file)) || digest(currentBytes)!==basename(file).slice(0,64))throw new Error("History archive plain block digest mismatch");
      const compressed=gzipSync(currentBytes,{level:1}),next=join(dirname(entry.file),`${digest(compressed)}.jsonl.gz`);writeImmutable(join(target,next),compressed);currentEncoding={file:next,encoding:"gzip",decoded_bytes:currentBytes.length};
    }
    if(!Number.isSafeInteger(entry.offset) || !Number.isSafeInteger(entry.bytes) || entry.offset<0 || entry.bytes<1 || entry.offset+entry.bytes>currentBytes!.length || digest(currentBytes!.subarray(entry.offset,entry.offset+entry.bytes))!==entry.digest)throw new Error("History archive range or digest mismatch");
    append({...entry,...currentEncoding!});
  }
  if(entries.count!==manifest.record_count)throw new Error("History archive record count mismatch");
  entries.finish();const nextBody={...body,entries:entries.values,entry_files:entries.files},result={...nextBody,digest:digest(JSON.stringify(nextBody))};writeImmutable(join(target,`manifest-${result.digest}.json`),JSON.stringify(result));return result;
}

/** Re-run after staging import and again inside the stopped-writer cutover window. */
export function verifyHistoryArchiveSources(manifest:HistoryArchiveManifest,onProgress?:(phase:string,items:number)=>void):void {
  const {digest:expected,...body}=manifest;
  if (digest(JSON.stringify(body)) !== expected) throw new Error("History manifest digest mismatch");
  for (const project of manifest.project_roots) if (!lstatSync(project.root).isDirectory()) throw new Error("Historical project root is unavailable");
  let sealedDocuments=0;
  for (const document of indexValues(manifest.archive_root,manifest.documents,manifest.document_files)) {
    sealedDocuments++;if(sealedDocuments%1000===0)onProgress?.("source_document_verify",sealedDocuments);
    if (fileDigest(document.file) !== document.digest) throw new Error("Historical Markdown or record file changed during export");
  }
  let sealedDatabases=0;
  for (const source of manifest.sources) {
    const table=readRows(source.file);sealedDatabases++;onProgress?.("source_database_verify",sealedDatabases);
    try {if (table.databaseDigest !== source.database_digest) throw Object.assign(new Error("History archive source changed; retry from a new snapshot"),{code:"SOURCE_DATABASE_CHANGED"});}
    finally{table.database.close();}
  }
}
