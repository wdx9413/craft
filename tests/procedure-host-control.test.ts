import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, scope } from "./helpers/procedure-invocation-fixture.ts";
import { McpServer } from "../core/mcp.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";

test("daily Experience exposes the embedded Host control without launching another Host", async () => {
  const f = await fixture();
  try {
    const workspace = join(f.root, "prepared"); await mkdir(workspace); await writeFile(join(workspace,"a.txt"), "current branch\n");
    const server = new McpServer(f.service, "component-experience-daily");
    const tools = (await server.handle({jsonrpc:"2.0",id:1,method:"tools/list"}))!.result as JsonObject;
    assert((tools.tools as JsonObject[]).some(t=>t.name==="craft_procedure_host_control"));
    const result = await f.service.procedureHostControl({action:"prepare",input:{workspace,include_paths:["a.txt"],title:"Current branch",goal:"inspect",host:"codex-cli",prompt:"inspect",sandbox:"read-only"}});
    assert.equal((result.launch as JsonObject).deferred_start,true); assert.equal(f.store.count("host_run"),0);
    assert.equal(result.host_execution_authority,false);
  } finally { await f.close(); }
});

test("embedded Host receipts stay bound to their dispatch, Task and independent program observation", async () => {
  const f = await fixture();
  try {
    f.store.create("workspace","workspace",{root_path:f.root,include_paths:["note.txt"],state_revision:1});await writeFile(join(f.root,"note.txt"),"before");
    const p=f.create();f.service.procedureInvocationBind(f.args(p));const prepared=f.dispatch(),dispatch=prepared.dispatch as JsonObject;
    const call=(action:string,input:JsonObject={})=>f.service.procedureHostControl({action,invocation_id:"invoke",scope,input:{dispatch_id:dispatch.id,...input}});
    assert.throws(()=>call("session_open",{dispatch_id:"missing"}),/Unknown/);
    f.store.create("procedure_invocation_dispatch","foreign-dispatch",{invocation_id:"another"});
    assert.throws(()=>call("session_open",{dispatch_id:"foreign-dispatch"}),/another Invocation/);
    const session=call("session_open",{environment_fingerprint:"env",policy_fingerprint:"policy"}).session as JsonObject;
    assert.equal(session.task_id,"task");assert.equal(session.capability_fingerprint,dispatch.dispatch_digest);
    const snapshot=call("snapshot").snapshot as JsonObject;
    f.store.create("state_snapshot","foreign-snapshot",{workspace_id:"another"});
    assert.throws(()=>call("session_close",{snapshot_id:"foreign-snapshot",kind:"session.completed"}),/another workspace/);
    assert.throws(()=>call("session_close",{snapshot_id:snapshot.id,kind:"session.started"}),/terminal/);
    call("session_close",{snapshot_id:snapshot.id,kind:"session.completed"});
    assert.throws(()=>call("observe",{snapshot_id:snapshot.id,observer_id:"host"}),/executing Host/);
    f.store.create("evidence","program-proof",{source_type:"program",confidence:"confirmed"});
    const observed=call("observe",{snapshot_id:snapshot.id,observer_id:"verifier",verdict:"passed",evidence_ids:["program-proof"]});
    assert.equal(observed.verification_provenance,"host_attested");assert.equal(observed.promotion_eligible,false);
    assert.throws(()=>call("unknown"),/Unsupported/);
    assert.throws(()=>f.service.procedureHostControl({action:"snapshot",invocation_id:"invoke",scope:"project:other",input:{}}),/scope denied/);
  }finally{await f.close();}
});
