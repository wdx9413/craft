import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fixture, scope } from "./helpers/procedure-invocation-fixture.ts";
import { procedureHostControl } from "../core/application/procedure-host-control.ts";
import { McpServer } from "../core/mcp.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { stableDigest } from "../core/digest.ts";

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

test("Host next asks the graph transition tool when no work item is ready", () => {
  const service = (graph?: JsonObject) => ({
    procedureInvocationGet() {
      return { invocation: { id: "graph-invocation", lifecycle: "active", ...(graph ? { graph } : {}), version: 3 },
        dispatches: [], receipts: [], work_items: [], loop: { lifecycle: "active" } };
    },
  }) as never;
  const result = procedureHostControl(service({ id: "graph" }), { action: "next", invocation_id: "graph-invocation", input: {} });
  assert.equal(result.next_tool, "craft_procedure_invocation_transition");
  assert.deepEqual(result.ready_item_keys, []);
  assert.equal(procedureHostControl(service(), { action: "next", invocation_id: "graph-invocation", input: {} }).next_tool,
    "craft_procedure_invocation_resume");
});

test("Evolution Cycle start fails closed when the Host Session lacks a valid start Trace", () => {
  const serviceFor = (events: JsonObject[]) => ({
    procedureInvocationGet: () => ({ invocation: { id: "invoke", workspace_id: "workspace", task_id: "task", host_id: "codex", procedure_id: "procedure", procedure_version: 1 } }),
    store: {
      get: (kind: string) => kind === "procedure_invocation_dispatch" ? { id: "dispatch", invocation_id: "invoke", dispatch_digest: "digest", version: 1 } : { id: "task", version: 1 },
      find: () => ({ id: "workspace", latest_checkpoint_id: "checkpoint", root_path: "/project" }),
    },
    hostSessionOpen: () => ({ session: { id: "host-session" } }),
    hostSessionGet: () => ({ events }),
    scopeIdentityResolveProject: () => ({ identity: { canonical_scope: { id: "project:test" } } }),
  }) as never;
  const args = { action: "session_open", invocation_id: "invoke", scope: "project:test", input: { dispatch_id: "dispatch", environment_fingerprint: "env", policy_fingerprint: "policy" } };
  for (const events of [[], [{ kind: "session.started", trace_event_id: 1, trace_event_version: 1, version: 1 }],
    [{ kind: "session.started", trace_event_id: "trace-event", trace_event_version: 0, version: 1 }],
    [{ kind: "session.started", trace_event_id: "trace-event", trace_event_version: 1, version: 0 }]])
    assert.throws(() => procedureHostControl(serviceFor(events as JsonObject[]), args), /Host Session start Trace/u);
});

test("embedded Host receipts stay bound to their dispatch, Task and independent program observation", async () => {
  const f = await fixture();
  try {
    const projectRoot=join(f.root,"project");await mkdir(projectRoot);
    f.service.scopeIdentityResolveProject({project_root:projectRoot});
    f.store.create("workspace","workspace",{root_path:projectRoot,include_paths:["note.txt"],state_revision:1});await writeFile(join(projectRoot,"note.txt"),"before");
    execFileSync("git", ["init", "-q", projectRoot]);
    const p=f.create();f.service.procedureInvocationBind(f.args(p));const prepared=f.dispatch(),dispatch=prepared.dispatch as JsonObject;
    const call=(action:string,input:JsonObject={})=>f.service.procedureHostControl({action,invocation_id:"invoke",scope,input:{dispatch_id:dispatch.id,...input}});
    assert.throws(()=>call("session_open",{dispatch_id:"missing"}),/Unknown/);
    f.store.create("procedure_invocation_dispatch","foreign-dispatch",{invocation_id:"another"});
    assert.throws(()=>call("session_open",{dispatch_id:"foreign-dispatch"}),/another Invocation/);
    const firstOpen=call("session_open",{environment_fingerprint:"env",policy_fingerprint:"policy"});
    assert.equal(((firstOpen.evolution_cycle as JsonObject).status),"unavailable");
    f.service.workspaceCheckpoint({workspace_id:"workspace",checkpoint_id:"host-baseline",label:"Host baseline"});
    const opened=call("session_open",{environment_fingerprint:"env",policy_fingerprint:"policy"});
    const session=opened.session as JsonObject, cycle=opened.evolution_cycle as JsonObject;
    assert.equal((cycle.cycle as JsonObject).stage,"act");
    assert.deepEqual((cycle.events as JsonObject[]).map(event=>(event.payload as JsonObject).stage),["observe","retrieve","act"]);
    const reopened=call("session_open",{environment_fingerprint:"env",policy_fingerprint:"policy"});
    assert.equal((((reopened.evolution_cycle as JsonObject).cycle as JsonObject).id),((cycle.cycle as JsonObject).id));
    assert.equal(session.task_id,"task");assert.equal(session.capability_fingerprint,dispatch.dispatch_digest);
    const snapshot=call("snapshot").snapshot as JsonObject;
    f.store.create("state_snapshot","foreign-snapshot",{workspace_id:"another"});
    assert.throws(()=>call("session_close",{snapshot_id:"foreign-snapshot",kind:"session.completed"}),/another workspace/);
    assert.throws(()=>call("session_close",{snapshot_id:snapshot.id,kind:"session.started"}),/terminal/);
    call("session_close",{snapshot_id:snapshot.id,kind:"session.completed"});
    assert.throws(()=>call("observe",{snapshot_id:snapshot.id,observer_id:"host"}),/executing Host/);
    const item=prepared.work_item as JsonObject;
    const outputs=item.kind==="exit"?dispatch.input_refs as JsonObject:Object.fromEntries(Object.keys(item.output_keys as JsonObject).map(key=>[key,`artifact:${dispatch.id}:${key}`]));
    f.store.create("evidence","program-proof",{source_type:"program",confidence:"confirmed",metadata:{dispatch_digest:dispatch.dispatch_digest,
      acceptance_digest:item.acceptance_digest,output_digest:stableDigest(outputs),state_after_digest:snapshot.snapshot_digest,status:"passed"}});
    const observed=call("observe",{snapshot_id:snapshot.id,observation_id:"procedure_host_observation",observer_id:"verifier",verdict:"passed",evidence_ids:["program-proof"]});
    assert.equal(observed.verification_provenance,"host_attested");assert.equal(observed.promotion_eligible,false);
    const report=f.service.procedureInvocationReport({invocation_id:"invoke",scope,expected_version:f.store.get("procedure_invocation","invoke").version,
      dispatch_id:dispatch.id,host_session_id:session.id,observation_id:"procedure_host_observation",snapshot_id:snapshot.id,output_refs:outputs,acceptance_evidence_ids:["program-proof"]});
    assert.equal(((report.evolution_cycle as JsonObject).status),"recorded");
    assert.equal((((report.evolution_cycle as JsonObject).cycle as JsonObject).outcome),"passed");
    assert.equal((((report.evolution_cycle as JsonObject).cycle as JsonObject).stage),"attribute");
    const failedProcedure=f.create();f.service.procedureInvocationBind(f.args(failedProcedure,"failed-invoke"));
    const failedPrepared=f.dispatch("failed-invoke"),failedDispatch=failedPrepared.dispatch as JsonObject;
    const failedCall=(action:string,input:JsonObject={})=>f.service.procedureHostControl({action,invocation_id:"failed-invoke",scope,input:{dispatch_id:failedDispatch.id,...input}});
    const failedSession=failedCall("session_open",{environment_fingerprint:"env",policy_fingerprint:"policy"}).session as JsonObject;
    const failedSnapshot=failedCall("snapshot").snapshot as JsonObject;
    failedCall("session_close",{snapshot_id:failedSnapshot.id,kind:"session.failed"});
    const failedItem=failedPrepared.work_item as JsonObject;
    const failedOutputs=failedItem.kind==="exit"?failedDispatch.input_refs as JsonObject:Object.fromEntries(Object.keys(failedItem.output_keys as JsonObject).map(key=>[key,`artifact:${failedDispatch.id}:${key}`]));
    f.store.create("evidence","program-failure-proof",{source_type:"program",confidence:"confirmed",metadata:{dispatch_digest:failedDispatch.dispatch_digest,
      acceptance_digest:failedItem.acceptance_digest,output_digest:stableDigest(failedOutputs),state_after_digest:failedSnapshot.snapshot_digest,status:"failed"}});
    failedCall("observe",{snapshot_id:failedSnapshot.id,observation_id:"procedure_host_failure_observation",observer_id:"verifier",verdict:"failed",evidence_ids:["program-failure-proof"]});
    const failedReport=f.service.procedureInvocationReport({invocation_id:"failed-invoke",scope,expected_version:f.store.get("procedure_invocation","failed-invoke").version,
      dispatch_id:failedDispatch.id,host_session_id:failedSession.id,observation_id:"procedure_host_failure_observation",snapshot_id:failedSnapshot.id,output_refs:failedOutputs,acceptance_evidence_ids:["program-failure-proof"]});
    const failedCycle=(failedReport.evolution_cycle as JsonObject).cycle as JsonObject;
    assert.equal((failedReport.evolution_cycle as JsonObject).status,"awaiting_failure_attribution");
    assert.equal(failedCycle.stage,"feedback");assert.equal(failedCycle.outcome,"failed");assert.equal(failedCycle.failure_class,null);
    assert.throws(()=>call("unknown"),/Unsupported/);
    assert.throws(()=>f.service.procedureHostControl({action:"snapshot",invocation_id:"invoke",scope:"project:other",input:{}}),/scope denied/);
  }finally{await f.close();}
});
