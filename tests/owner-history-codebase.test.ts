import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensureProjectStorageDirectory } from "craft-common-store-local/paths";
import { digestJson, stableDigest, stableDigestStreaming } from "craft-common-base/digest";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CodebaseHistoryBindings, codebaseGraphMatches } from "../core/owner-history-codebase.ts";
import { archiveOwnerHistory, readArchivedHistory } from "../core/owner-history-archive.ts";

type Payload = Record<string, unknown>;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "craft-codebase-binding-")), repository = join(root, "repository"), paths = craftPaths(join(root, "data"));
  mkdirSync(repository); mkdirSync(dirname(paths.databaseFile), { recursive: true });
  const project = ensureProjectStorageDirectory(paths, repository), database = new DatabaseSync(paths.databaseFile);
  database.exec("CREATE TABLE records(kind TEXT,id TEXT,version INTEGER,payload_json TEXT,created_at TEXT,updated_at TEXT,PRIMARY KEY(kind,id,version))");
  const insert = (kind: string, id: string, payload: Payload, version = 1) => database.prepare("INSERT INTO records VALUES(?,?,?,?,?,?)").run(kind,id,version,JSON.stringify(payload),"created","updated");
  const body = Buffer.from("export const checked = 1;\n"), digest = createHash("sha256").update(body).digest("hex");
  const entries = [{ path: "sample.ts", digest, size_bytes: body.length }], snapshot = join(project,"codebase","snapshots","workspace_fixture","checkpoint_fixture");
  mkdirSync(snapshot,{recursive:true}); writeFileSync(join(snapshot,"sample.ts"),body);
  insert("workspace","workspace_fixture",{ root_path: repository, state_revision: 1 });
  insert("workspace_checkpoint","checkpoint_fixture",{ workspace_id:"workspace_fixture",state_revision:1,snapshot_root:snapshot,entries });
  const index: Payload = { workspace_id:"workspace_fixture", checkpoint_id:"checkpoint_fixture", snapshot_digest:stableDigest(entries), graph_storage:"sharded-v1", shard_ids:["graph"], shard_digests:[] };
  const graph = { nodes:[{path:"sample.ts",source_digest:digest}],edges:[] }, graphDigest = stableDigest(graph);
  index.shard_digests=[graphDigest]; insert("codebase_index","index_fixture",index);
  const capture = (_id: string,_version: number,source: string,files: Payload[]) => {
    assert(lstatSync(source).isDirectory());
    for(const file of files) { const data=readFileSync(join(source,String(file.path)));assert.equal(data.length,file.size_bytes);assert.equal(createHash("sha256").update(data).digest("hex"),file.digest); }
  };
  const bindings = (callback=capture) => new CodebaseHistoryBindings(paths,paths.databaseFile,(_kind,_id,_version,raw)=>JSON.parse(raw),callback);
  return { root,paths,repository,project,snapshot,entries,index,graph,graphDigest,digest,database,insert,capture,bindings,
    close(){database.close();rmSync(root,{recursive:true,force:true});} };
}

test("historical graph hashes bind both graph storage formats and route metadata",()=>{
  const graph={nodes:[{path:"sample.ts",source_digest:"source"}],edges:[]};
  for(const storage of ["sharded-v1","project-sharded-v5"]) {
    const expected=storage==="sharded-v1"?stableDigest(graph):digestJson(graph),payload={...graph,node_count:1,edge_count:0,graph_digest:expected};
    assert.equal(codebaseGraphMatches("codebase_index_shard",storage,expected,payload),true);
    for(const change of [{nodes:null},{edges:null},{node_count:0},{edge_count:1},{graph_digest:"changed"},{nodes:[{path:"other.ts",source_digest:"source"}]}]) assert.equal(codebaseGraphMatches("codebase_index_shard",storage,expected,{...payload,...change}),false);
  }
  for(const body of [{bucket:0,incoming:[],outgoing:[]},{index_id:"index",bucket:1,nodes:["symbol"],incoming:[],outgoing:[],locations:{symbol:"sample.ts"}}]) {
    const expected=stableDigestStreaming(body),payload={...body,route_digest:expected};
    assert.equal(codebaseGraphMatches("codebase_index_edge_route","project-sharded-v5",expected,payload),true);
    assert.equal(codebaseGraphMatches("codebase_index_edge_route","project-sharded-v5",expected,{...payload,route_digest:"changed"}),false);
    assert.equal(codebaseGraphMatches("codebase_index_edge_route","project-sharded-v5",expected,{...payload,bucket:99}),false);
  }
});

test("legacy workspace aliases bind exact snapshot bytes and reject graph or route drift",()=>{
  const f=fixture();
  try {
    f.insert("workspace","workspace_fixture",{canonical_root_path:realpathSync(f.repository),root_path:f.repository,state_revision:1},2);
    const body={index_id:"index_fixture",bucket:0,incoming:[],outgoing:[]},routeDigest=stableDigestStreaming(body);
    f.insert("codebase_index","second-parent",{...f.index,edge_route_shards:[{id:"route",digest:routeDigest}]});
    f.insert("codebase_index","empty-arrays",{workspace_id:"workspace_fixture",checkpoint_id:"checkpoint_fixture",snapshot_digest:f.index.snapshot_digest});
    const bindings=f.bindings(),binding={workspace_ids:["workspace_fixture"],checkpoint_ids:["checkpoint_fixture"],project_roots:[realpathSync(f.repository)]};
    assert.deepEqual(bindings.binding("workspace_checkpoint","checkpoint_fixture",1,{}),binding);
    assert.deepEqual(bindings.binding("codebase_index","index_fixture",1,f.index),binding);
    const graph={...f.graph,node_count:1,edge_count:0,graph_digest:f.graphDigest};
    assert.deepEqual(bindings.binding("codebase_index_shard","graph",1,graph),binding);
    assert.equal(bindings.binding("codebase_index_shard","missing",1,graph),null);
    assert.equal(bindings.binding("codebase_index_shard","graph",1,{...graph,nodes:null}),null);
    assert.equal(bindings.binding("codebase_index_shard","graph",1,{...graph,nodes:[{path:"sample.ts",source_digest:"changed"}]}),null);
    assert.equal(bindings.binding("codebase_index_shard","graph",1,{...graph,graph_digest:"changed"}),null);
    assert.deepEqual(bindings.binding("codebase_index_edge_route","route",1,{...body,route_digest:routeDigest}),binding);
    assert.equal(bindings.binding("codebase_index_edge_route","route",1,{...body,route_digest:"changed"}),null);
    assert.equal(bindings.binding("codebase_index_edge_route","missing",1,{}),null);
    assert.deepEqual(bindings.binding("workspace","workspace_fixture",1,{}),{...binding,checkpoint_ids:[]});
    assert.deepEqual(bindings.binding("workspace_probe","probe",1,{workspace_id:"workspace_fixture"}),{...binding,checkpoint_ids:[]});
    assert.equal(bindings.binding("workspace","missing",1,{}),null);
    assert.equal(bindings.binding("workspace_checkpoint","checkpoint_fixture",99,{}),null);
    assert.equal(bindings.binding("codebase_index","invalid",1,{...f.index,checkpoint_id:"missing"}),null);
    assert.equal(bindings.binding("codebase_index","invalid",1,{...f.index,snapshot_digest:"changed"}),null);
    const {snapshot_digest:_,...legacy}=f.index;
    assert.deepEqual(bindings.binding("codebase_index","legacy",1,{...legacy,input_digest:"legacy",analyzer:"typescript",analyzer_version:"1"}),binding);
    for(const partial of [{},{input_digest:"legacy"},{input_digest:"legacy",analyzer:"typescript"}]) assert.equal(bindings.binding("codebase_index","invalid",1,{...legacy,...partial}),null);
  } finally {f.close();}
});

test("artifact directories require a managed snapshot and matching non-linked project identity",()=>{
  const f=fixture();
  try {
    const bindings=f.bindings(),expected=[join(f.project,"codebase","indexes","workspace_fixture","graph_records")];
    assert.deepEqual(bindings.artifactDirectories(f.index),expected);
    assert.deepEqual(bindings.artifactDirectories({...f.index,workspace_id:"foreign"}),[]);
    assert.deepEqual(bindings.artifactDirectories({...f.index,checkpoint_id:"missing"}),[]);
    const marker=join(f.project,"project.json"),original=readFileSync(marker),identity=JSON.parse(original.toString());
    for(const patch of [{schema_version:2},{path_sha256:"changed"},{directory_name:"changed"},{canonical_root:join(f.root,"foreign"),path_sha256:createHash("sha256").update(join(f.root,"foreign")).digest("hex")}]) {
      writeFileSync(marker,JSON.stringify({...identity,...patch}));assert.deepEqual(bindings.artifactDirectories(f.index),[]);
    }
    writeFileSync(marker,"not-json");assert.deepEqual(bindings.artifactDirectories(f.index),[]);
    unlinkSync(marker);assert.deepEqual(bindings.artifactDirectories(f.index),[]);
    const held=join(f.root,"project-marker.json");writeFileSync(held,original);symlinkSync(held,marker);assert.deepEqual(bindings.artifactDirectories(f.index),[]);unlinkSync(marker);writeFileSync(marker,original);
    const nested=join(f.snapshot,"extra");mkdirSync(nested);
    f.insert("workspace_checkpoint","checkpoint_nested",{workspace_id:"workspace_fixture",state_revision:1,snapshot_root:nested,entries:[]});
    f.insert("workspace_checkpoint","checkpoint_outside",{workspace_id:"workspace_fixture",state_revision:1,snapshot_root:join(f.root,"outside"),entries:[]});
    const other=f.bindings();
    assert.deepEqual(other.artifactDirectories({...f.index,checkpoint_id:"checkpoint_nested"}),[]);
    assert.deepEqual(other.artifactDirectories({...f.index,checkpoint_id:"checkpoint_outside"}),[]);
    f.insert("workspace","missing_anchor",{root_path:f.repository,canonical_root_path:join(f.root,"not-present"),state_revision:1});
    f.insert("workspace_checkpoint","checkpoint_unanchored",{workspace_id:"missing_anchor",state_revision:1,snapshot_root:join(f.project,"codebase","snapshots","missing_anchor","checkpoint_unanchored"),entries:[]});
    mkdirSync(join(f.project,"codebase","snapshots","missing_anchor","checkpoint_unanchored"),{recursive:true});
    const unanchored=f.bindings();assert.deepEqual(unanchored.artifactDirectories({workspace_id:"missing_anchor",checkpoint_id:"checkpoint_unanchored"}),[]);
  } finally {f.close();}
});

test("snapshot capture failures quarantine only that binding and reserve failures remain fatal",()=>{
  const f=fixture();
  try {
    const failed=f.bindings(()=>{throw new Error("snapshot content unavailable");});
    assert.equal(failed.binding("workspace_checkpoint","checkpoint_fixture",1,{}),null);
    assert.equal(failed.binding("codebase_index","index_fixture",1,f.index),null);
    assert.throws(()=>f.bindings(()=>{throw Object.assign(new Error("reserve exhausted"),{code:"HISTORY_ARCHIVE_SPACE_RESERVE"});}),/reserve exhausted/);
    assert.throws(()=>new CodebaseHistoryBindings(f.paths,f.paths.databaseFile,()=>{throw new Error("payload read unavailable");},f.capture),/payload read unavailable/);
    f.insert("workspace_checkpoint","checkpoint_invalid",{workspace_id:"workspace_fixture",state_revision:1,snapshot_root:f.snapshot});
    f.insert("workspace","workspace_invalid",{root_path:17,state_revision:"invalid"});
    const invalid=f.bindings();assert.equal(invalid.binding("workspace_checkpoint","checkpoint_invalid",1,{}),null);
    assert.equal(invalid.binding("workspace","workspace_invalid",1,{}),null);
    // Two valid historical entry sets for one root cannot be inferred without a frozen snapshot digest.
    f.insert("workspace_checkpoint","checkpoint_fixture",{workspace_id:"workspace_fixture",state_revision:1,snapshot_root:f.snapshot,entries:[]},2);
    const ambiguous=f.bindings();const {snapshot_digest:_,...legacy}=f.index;
    assert.equal(ambiguous.binding("codebase_index","ambiguous",1,{...legacy,input_digest:"legacy",analyzer:"typescript",analyzer_version:"1"}),null);
    assert.deepEqual(ambiguous.binding("workspace_checkpoint","checkpoint_fixture",2,{}),{workspace_ids:["workspace_fixture"],checkpoint_ids:["checkpoint_fixture"],project_roots:[realpathSync(f.repository)]});
  } finally {f.close();}
});

test("history archive freezes checkpoint snapshots and records out-of-scope or drifting entries", async () => {
  const f=fixture();
  try {
    const graph={nodes:[{path:"sample.ts",source_digest:f.digest}],edges:[]},graphDigest=digestJson(graph);
    const routeBody={index_id:"project-index",bucket:0,incoming:[],outgoing:[]},routeDigest=stableDigestStreaming(routeBody);
    f.insert("codebase_index","project-index",{...f.index,graph_storage:"project-sharded-v5",shard_ids:["project-graph"],shard_digests:[graphDigest],edge_route_shards:[{id:"route-fixture",digest:routeDigest}]});
    const artifacts=join(f.project,"codebase","indexes","workspace_fixture","graph_records");mkdirSync(artifacts,{recursive:true});
    writeFileSync(join(artifacts,"codebase_project-graph.json"),JSON.stringify({id:"project-graph",version:1,created_at:"created",updated_at:"updated",...graph,node_count:graph.nodes.length,edge_count:graph.edges.length,graph_digest:graphDigest}));
    writeFileSync(join(artifacts,"codebase_route-fixture.json"),JSON.stringify({id:"route-fixture",version:1,created_at:"created",updated_at:"updated",...routeBody,route_digest:routeDigest}));
    f.insert("codebase_index_shard","project-graph",{...graph,node_count:graph.nodes.length,edge_count:graph.edges.length,graph_digest:graphDigest});
    f.insert("codebase_index_edge_route","route-fixture",{...routeBody,route_digest:routeDigest});
    f.insert("workspace_checkpoint","checkpoint_unbound",{workspace_id:"missing-workspace",state_revision:1,snapshot_root:f.snapshot,entries:f.entries});
    const definition={procedure_id:"procedure-fixture",procedure_version:1,kind:"workflow",steps:[]},definitionFile=join(f.root,"definition.json");writeFileSync(definitionFile,JSON.stringify(definition));
    f.insert("experience_procedure","procedure-valid",{definition_ref:{format:"json",procedure_id:definition.procedure_id,procedure_version:1,kind:definition.kind,path:definitionFile,digest:stableDigest(definition)}});
    f.insert("experience_procedure","procedure-drifted",{definition_ref:{format:"json",procedure_id:definition.procedure_id,procedure_version:1,kind:definition.kind,path:definitionFile,digest:"changed"}});
    const archive=join(f.root,"archive"),manifest=await archiveOwnerHistory(f.paths,archive);
    const checkpoint=manifest.entries.find(entry=>entry.kind==="workspace_checkpoint" && entry.id==="checkpoint_fixture")!;
    assert(checkpoint.codebase_binding);
    assert((readArchivedHistory(archive,checkpoint).attachments as Array<{purpose?:string}>).some(item=>item.purpose==="codebase_snapshot"));
    const conflictRoot=join(f.root,"archive-cache-conflict"),cacheRoot=join(conflictRoot,"snapshot-capture"),cacheIdentity=createHash("sha256").update(JSON.stringify({id:"checkpoint_fixture",version:1,root:f.snapshot,items:f.entries})).digest("hex");
    mkdirSync(cacheRoot,{recursive:true});writeFileSync(join(cacheRoot,`${cacheIdentity}.json`),JSON.stringify({identity:"wrong",files:[]}));
    const conflicted=await archiveOwnerHistory(f.paths,conflictRoot);assert.equal(conflicted.entries.find(entry=>entry.id==="checkpoint_fixture")!.unresolved,true);
    const badBlobRoot=join(f.root,"archive-cache-blob"),badBlobCache=join(badBlobRoot,"snapshot-capture"),source=join(f.snapshot,"sample.ts"),stat=lstatSync(source,{bigint:true});
    mkdirSync(badBlobCache,{recursive:true});writeFileSync(join(badBlobCache,`${cacheIdentity}.json`),JSON.stringify({identity:cacheIdentity,files:[{source,file:"../unsafe.blob",digest:f.digest,bytes:Number(stat.size),signature:[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(":")}]}));
    const badBlob=await archiveOwnerHistory(f.paths,badBlobRoot);assert.equal(badBlob.entries.find(entry=>entry.id==="checkpoint_fixture")!.unresolved,true);
    for (const [id,path] of [["checkpoint_escaping","../outside"],["checkpoint_dot","."],["checkpoint_empty",""],["checkpoint_absolute",join(f.snapshot,"sample.ts")]] as const) {
      const snapshot=join(f.project,"codebase","snapshots","workspace_fixture",id);mkdirSync(snapshot,{recursive:true});writeFileSync(join(snapshot,"sample.ts"),"export const checked = 1;\n");
      f.insert("workspace_checkpoint",id,{workspace_id:"workspace_fixture",state_revision:1,snapshot_root:snapshot,entries:[{path,digest:f.digest,size_bytes:1}]});
    }
    const escaping=await archiveOwnerHistory(f.paths,join(f.root,"archive-escaping"));
    const escapingEntry=escaping.entries.find(entry=>entry.id==="checkpoint_escaping")!;
    assert.equal(escapingEntry.unresolved,true);
    for (const id of ["checkpoint_dot","checkpoint_empty","checkpoint_absolute"]) assert.equal(escaping.entries.find(entry=>entry.id===id)!.unresolved,true);
    let mutated=false;
    const drifted=await archiveOwnerHistory(f.paths,join(f.root,"archive-drifted"),{onProgress:progress=>{
      if(!mutated && progress.phase==="snapshot_capture_complete") {mutated=true;writeFileSync(join(f.snapshot,"sample.ts"),"changed after capture");}
    }});
    assert(mutated);
    assert.equal(drifted.entries.find(entry=>entry.id==="checkpoint_fixture")!.unresolved,true);
  } finally {f.close();}
});

test("checkpoint inventory crosses its 500-row cursor without dropping a historical binding",()=>{
  const f=fixture();
  try {
    f.database.exec("BEGIN");
    for(let n=0;n<501;n++){const id=`checkpoint_page_${n}`,source=join(f.project,"codebase","snapshots","workspace_fixture",id);mkdirSync(source,{recursive:true});f.insert("workspace_checkpoint",id,{workspace_id:"workspace_fixture",state_revision:1,snapshot_root:source,entries:[]});}
    f.database.exec("COMMIT");const bindings=f.bindings();
    assert.deepEqual(bindings.binding("workspace_checkpoint","checkpoint_page_500",1,{}),{workspace_ids:["workspace_fixture"],checkpoint_ids:["checkpoint_page_500"],project_roots:[realpathSync(f.repository)]});
  } finally {f.close();}
});
