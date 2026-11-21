import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { digestJson, stableDigest, stableDigestStreaming } from "craft-common-base/digest";
import type { CraftPaths } from "./infrastructure/paths.ts";
import { CodebaseStoragePreflightReader, type CodebaseMigrationEntry } from "./codebase-storage-preflight.ts";

type Payload=Record<string,unknown>;
export type CodebaseHistoryBinding={workspace_ids:string[];checkpoint_ids:string[];project_roots:string[]};
type Checkpoint={id:string;version:number;workspace:string;stateRevision:number;digest:string;files:Map<string,string>;preflight:CodebaseMigrationEntry};
type Parent={binding:CodebaseHistoryBinding;digest:string;storage:string};
export function codebaseGraphMatches(kind:string,storage:string,expected:string,payload:Payload):boolean{
  if(kind === "codebase_index_shard")return Array.isArray(payload.nodes) && Array.isArray(payload.edges) && payload.node_count === payload.nodes.length && payload.edge_count === payload.edges.length
    && payload.graph_digest === expected && (storage === "sharded-v1" ? stableDigest({nodes:payload.nodes,edges:payload.edges}):digestJson({nodes:payload.nodes,edges:payload.edges})) === expected;
  const body={...(payload.index_id === undefined?{}:{index_id:payload.index_id}),bucket:payload.bucket,...(payload.nodes === undefined?{}:{nodes:payload.nodes}),incoming:payload.incoming,outgoing:payload.outgoing,...(payload.locations === undefined?{}:{locations:payload.locations})};
  return payload.route_digest === expected && stableDigestStreaming(body) === expected;
}
/** Historical graph ownership comes from frozen index/checkpoint relations, never from a guessed global scope. */
export class CodebaseHistoryBindings {
  private readonly checkpoints=new Map<string,Checkpoint[]>();
  private readonly parents=new Map<string,Parent[]>();
  private readonly workspaces=new Map<string,Set<string>>();
  private readonly anchors=new Map<string,Set<string>>();
  private readonly paths:CraftPaths;
  constructor(paths:CraftPaths,snapshotFile:string,readPayload:(kind:string,id:string,version:number,payload:string)=>Payload,captureSnapshot:(id:string,version:number,root:string,entries:Payload[])=>void){
    this.paths=paths;
    const statuses=new Map<string,CodebaseMigrationEntry>(),reader=new CodebaseStoragePreflightReader({...paths,databaseFile:snapshotFile},readPayload);
    try{let cursor:string|undefined;do{const page=reader.readPage({max_records:500,...(cursor?{cursor}:{})});for(const entry of page.entries)statuses.set(JSON.stringify([entry.id,entry.version]),entry);cursor=page.next_cursor ?? undefined;}while(cursor);}finally{reader.close();}
    const database=new DatabaseSync(snapshotFile,{readOnly:true});
    try{
      for(const row of database.prepare("SELECT id,version,payload_json FROM records WHERE kind='workspace' ORDER BY id,version").all() as Array<{id:string;version:number;payload_json:string}>){
        const payload=readPayload("workspace",row.id,row.version,row.payload_json),root=payload.canonical_root_path ?? payload.root_path;
        if(typeof root === "string" && isAbsolute(root) && Number.isSafeInteger(payload.state_revision)){let anchor=root;try{anchor=realpathSync(root);}catch{}const key=JSON.stringify([row.id,payload.state_revision]),roots=this.anchors.get(key) ?? new Set<string>();roots.add(anchor);this.anchors.set(key,roots);}
      }
      for(const row of database.prepare("SELECT id,version,payload_json FROM records WHERE kind='workspace_checkpoint' ORDER BY id,version").all() as Array<{id:string;version:number;payload_json:string}>){
        const payload=readPayload("workspace_checkpoint",row.id,row.version,row.payload_json),preflight=statuses.get(JSON.stringify([row.id,row.version]))!;
        const entries=Array.isArray(payload.entries)?payload.entries as Payload[]:[];
        if(["current","legacy_ready"].includes(preflight.status))try{
          captureSnapshot(row.id,row.version,preflight.source_root,entries);
        }catch(error){if((error as {code?:string}).code === "HISTORY_ARCHIVE_SPACE_RESERVE")throw error;preflight.status="missing_snapshot";}
        const item={id:row.id,version:row.version,workspace:String(payload.workspace_id),stateRevision:Number(payload.state_revision),digest:stableDigest(entries.map(entry=>({path:entry.path,digest:entry.digest,size_bytes:entry.size_bytes}))),files:new Map(entries.map(entry=>[String(entry.path),String(entry.digest)])),preflight};
        const versions=this.checkpoints.get(row.id) ?? [];versions.push(item);this.checkpoints.set(row.id,versions);
        if(preflight.project_root && ["current","legacy_ready"].includes(preflight.status)){const roots=this.workspaces.get(item.workspace) ?? new Set<string>();roots.add(preflight.project_root);this.workspaces.set(item.workspace,roots);}
      }
      for(const row of database.prepare("SELECT id,version,payload_json FROM records WHERE kind='codebase_index' ORDER BY id,version").all() as Array<{id:string;version:number;payload_json:string}>){
        const index=readPayload("codebase_index",row.id,row.version,row.payload_json),binding=this.indexBinding(index);
        if(!binding)continue;
        const ids=Array.isArray(index.shard_ids)?index.shard_ids:[],digests=Array.isArray(index.shard_digests)?index.shard_digests:[];
        ids.forEach((id,ordinal)=>this.addParent("codebase_index_shard",String(id),{binding,digest:String(digests[ordinal]),storage:String(index.graph_storage)}));
        for(const ref of Array.isArray(index.edge_route_shards)?index.edge_route_shards as Payload[]:[])this.addParent("codebase_index_edge_route",String(ref.id),{binding,digest:String(ref.digest),storage:String(index.graph_storage)});
      }
    }finally{database.close();}
  }
  private addParent(kind:string,id:string,parent:Parent):void{
    const key=JSON.stringify([kind,id]),parents=this.parents.get(key) ?? [];parents.push(parent);this.parents.set(key,parents);
  }
  private indexBinding(index:Payload):CodebaseHistoryBinding|null{
    const candidates=(this.checkpoints.get(String(index.checkpoint_id)) ?? []).filter(item=>item.workspace === index.workspace_id && (typeof index.snapshot_digest === "string" ? item.digest === index.snapshot_digest : typeof index.input_digest === "string" && typeof index.analyzer === "string" && typeof index.analyzer_version === "string") && item.preflight.project_root && ["current","legacy_ready"].includes(item.preflight.status));
    const roots=[...new Set(candidates.map(item=>item.preflight.project_root!))];
    return roots.length === 1 && new Set(candidates.map(item=>item.digest)).size === 1 ? {workspace_ids:[String(index.workspace_id)],checkpoint_ids:[String(index.checkpoint_id)],project_roots:roots}:null;
  }
  artifactDirectories(index:Payload):string[]{
    const directories=new Set<string>();
    for(const item of this.checkpoints.get(String(index.checkpoint_id)) ?? []){
      if(item.workspace !== index.workspace_id)continue;
      const source=resolve(item.preflight.source_root),directory=resolve(source,"../../../..");
      if(!directory.startsWith(resolve(this.paths.root,"projects")+sep) || source !== join(directory,"codebase","snapshots",item.workspace,item.id))continue;
      try{
        const file=join(directory,"project.json");if(lstatSync(file).isSymbolicLink())continue;
        const marker=JSON.parse(readFileSync(file,"utf8")) as Payload;
        const root=String(marker.canonical_root),hash=createHash("sha256").update(root).digest("hex");
        if(marker.schema_version !== 1 || marker.path_sha256 !== hash || marker.directory_name !== basename(directory) || !this.anchors.get(JSON.stringify([item.workspace,item.stateRevision]))?.has(root))continue;
        directories.add(join(directory,"codebase","indexes",item.workspace,"graph_records"));
      }catch{continue;}
    }
    return [...directories].sort();
  }
  binding(kind:string,id:string,version:number,payload:Payload):CodebaseHistoryBinding|null{
    if(kind === "workspace_checkpoint"){
      const item=this.checkpoints.get(id)?.find(item=>item.version === version);
      return item?.preflight.project_root && ["current","legacy_ready"].includes(item.preflight.status) ? {workspace_ids:[item.workspace],checkpoint_ids:[id],project_roots:[item.preflight.project_root]}:null;
    }
    if(kind === "codebase_index")return this.indexBinding(payload);
    if(kind === "codebase_index_shard" || kind === "codebase_index_edge_route"){
      const valid=(this.parents.get(JSON.stringify([kind,id])) ?? []).filter(parent=>{
        if(kind === "codebase_index_shard"){
          const snapshots=parent.binding.checkpoint_ids.flatMap(id=>this.checkpoints.get(id)!).filter(item=>parent.binding.workspace_ids.includes(item.workspace));
          if(!Array.isArray(payload.nodes) || !snapshots.some(snapshot=>(payload.nodes as Payload[]).every(node=>snapshot.files.get(String(node.path)) === node.source_digest)))return false;
          return codebaseGraphMatches(kind,parent.storage,parent.digest,payload);
        }
        return codebaseGraphMatches(kind,parent.storage,parent.digest,payload);
      });
      return valid.length ? {workspace_ids:[...new Set(valid.flatMap(item=>item.binding.workspace_ids))],checkpoint_ids:[...new Set(valid.flatMap(item=>item.binding.checkpoint_ids))],project_roots:[...new Set(valid.flatMap(item=>item.binding.project_roots))]}:null;
    }
    const workspace=kind === "workspace" ? id : payload.workspace_id;
    const roots=this.workspaces.get(String(workspace));
    return roots?.size === 1 ? {workspace_ids:[String(workspace)],checkpoint_ids:[],project_roots:[...roots]}:null;
  }
}
