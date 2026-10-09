import assert from "node:assert/strict";
import test from "node:test";
import { fixture, scope } from "./helpers/procedure-invocation-fixture.ts";
import { matchesDecisionGuard } from "../core/application/procedure-decision.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { payload, stableDigest } from "../core/digest.ts";

test("decision guards preserve unknown, compare exact types and reject executable expressions", () => {
  const guard=(op:string,extra:JsonObject={})=>[{field:"a",op,value:1,...extra}];
  for(const invalid of [undefined,[],Array.from({length:101},()=>({}))]) assert.throws(()=>matchesDecisionGuard(invalid,{}),/1..100/);
  assert.throws(()=>matchesDecisionGuard([null],{}),/object/);
  assert.throws(()=>matchesDecisionGuard(guard("eval"),{a:1}),/Unsupported/);
  for(const v of [undefined,null,"1",NaN,Infinity]) assert.equal(matchesDecisionGuard(guard("gte"),{a:v}),null);
  assert.equal(matchesDecisionGuard(guard("gte"),{a:1}),true);assert.equal(matchesDecisionGuard(guard("gte"),{a:0}),false);
  assert.equal(matchesDecisionGuard(guard("gte",{value:"1"}),{a:1}),null);
  assert.equal(matchesDecisionGuard(guard("gte",{value:Infinity}),{a:1}),null);
  assert.equal(matchesDecisionGuard(guard("eq"),{a:1}),true);assert.equal(matchesDecisionGuard(guard("eq"),{a:2}),false);
  for(const v of [undefined,null,"1",NaN,Infinity])assert.equal(matchesDecisionGuard(guard("eq"),{a:v}),null);
  for(const v of [{},null,undefined,NaN,Infinity])assert.equal(matchesDecisionGuard(guard("eq",{value:v}),{a:1}),null);
  assert.equal(matchesDecisionGuard(guard("eq",{value:true}),{a:true}),true);
  assert.equal(matchesDecisionGuard(guard("eq",{value:"simple"}),{a:"simple"}),true);
  assert.equal(matchesDecisionGuard(guard("eq_field",{value_field:"b"}),{a:10,b:10}),true);
  assert.equal(matchesDecisionGuard(guard("eq_field",{value_field:"b"}),{a:10}),null);
  assert.equal(matchesDecisionGuard([{field:"covered",op:"eq_field",value_field:"total"},{field:"verified",op:"eq",value:true}],{covered:99,total:100,verified:true}),false);
  assert.equal(matchesDecisionGuard([{field:"covered",op:"eq_field",value_field:"total"},{field:"verified",op:"eq",value:true}],{covered:100,total:100}),null);
  assert.equal(matchesDecisionGuard([{field:"outcome",op:"eq",value:"fixable_failure"},{field:"within_scope",op:"eq",value:true}],{outcome:"passed"}),false);
});

async function ready(type="condition",initialValues:JsonObject={approved:true},change:(g:JsonObject)=>void=()=>{}) {
  const f=await fixture();
  const g={nodes:[
    {id:"choice",type,side_effect:"read_only",requires:["request"],provides:["report"],acceptance_ref:"choice",decision_rules:{approved:[{field:"approved",op:"eq",value:true}],repair:[{field:"approved",op:"eq",value:false}]}},
    {id:"repair",type:"action",side_effect:"read_only",requires:["report"],provides:[],acceptance_ref:"repair"},
    {id:"end",type:"action",side_effect:"read_only",requires:["report"],provides:[],acceptance_ref:"end"}],
    edges:[{id:"approved",from:"choice",to:"end",kind:type==="human_gate"?"human_resume":"condition",predicate_ref:"approved",max_traversals:3},{id:"repair",from:"choice",to:"repair",kind:type==="human_gate"?"human_resume":"condition",predicate_ref:"repair",max_traversals:3},{id:"finish",from:"repair",to:"end",kind:"success",max_traversals:3}],
    graph_control:{scenario_id:"engineering",title:"Engineering",entries:[{id:"start",node_id:"choice",required_inputs:["request"],preconditions:[]}],exits:[{id:"done",node_id:"end",required_outputs:["report"],acceptance_ref:"end"}],subscenarios:[{id:"change",title:"Change",entry_id:"start",exit_id:"done",allowed_nodes:["choice","repair","end"],allowed_edges:["approved","repair","finish"],allowed_effects:["read_only"],max_visits:4,max_transitions:10}]}};
  change(g);
  const p=f.service.procedureConfigurationSave({procedure_id:"decide",scope,title:"Engineering",procedure_kind:"graph",definition:g}).procedure as JsonObject;
  f.service.procedureInvocationBind({...f.args(p),release_channel:"test",subscenario_id:"change",entry_id:"start",exit_id:"done",input_refs:{request:"artifact:request"},allowed_effects:["read_only"]});
  const prepared=f.dispatch(),proof=f.proof(prepared);
  const factRef=`artifact:${stableDigest(initialValues)}`;proof.output_refs={report:factRef};
  const original=f.store.get("evidence",(proof.acceptance_evidence_ids as string[])[0]!);
  f.store.save("evidence",String(original.id),{...payload(original),metadata:{...original.metadata as JsonObject,output_digest:stableDigest(proof.output_refs),fact_values:initialValues,fact_values_ref:factRef}});
  f.service.procedureInvocationReport(proof);
  const e=f.store.get("evidence",(proof.acceptance_evidence_ids as string[])[0]!);
  function facts(values:JsonObject,extra:JsonObject={}){f.store.save("evidence",String(e.id),{...payload(e),metadata:{...e.metadata as JsonObject,fact_values:values,...extra}});}
  function args(extra:JsonObject={}){const run=f.store.get("procedure_invocation","invoke");return {...f.params(),decision_id:"decision",receipt_id:run.last_receipt_id,snapshot_id:"before",fact_evidence_id:e.id,...extra};}
  return {...f,g,e,facts,decisionArgs:args};
}

test("missing decision facts block without changing the graph",async()=>{
  const f=await ready("condition",{});try{assert.equal(f.service.procedureDecisionEvaluate(f.decisionArgs()).status,"blocked");}finally{await f.close();}
});
test("current program facts advance one declared edge; retries are idempotent and raw self-reported percentages cannot replace facts",async()=>{
  const f=await ready();try{
    f.facts({approved:true});const args=f.decisionArgs({values:{approved:false}});
    const result=f.service.procedureDecisionEvaluate(args);assert.equal((result.decision as JsonObject).edge_id,"approved");
    assert.equal(f.service.procedureDecisionEvaluate(args).idempotent,true);
    assert.throws(()=>f.service.procedureDecisionEvaluate({...args,fact_evidence_id:"other"}),/idempotency/);
    assert.throws(()=>f.service.procedureDecisionEvaluate({...args,scope:"project:other"}),/scope denied/);
  }finally{await f.close();}
});
test("a modified fact value cannot reuse an earlier accepted artifact digest",async()=>{
 const f=await ready();try{
  f.facts({approved:false});assert.throws(()=>f.service.procedureDecisionEvaluate(f.decisionArgs()),/changed after/);
 }finally{await f.close();}
});

test("stale, unrelated and non-confirmed decision evidence fails closed",async()=>{
 const f=await ready();try{
  f.facts({approved:true});const args=f.decisionArgs();
  assert.throws(()=>f.service.procedureDecisionEvaluate({...args,expected_version:1}),/current active/);
  assert.throws(()=>f.service.procedureDecisionEvaluate({...args,receipt_id:"missing"}),/Unknown/);
  f.store.create("state_snapshot","foreign",{workspace_id:"other",snapshot_digest:"other"});
  assert.throws(()=>f.service.procedureDecisionEvaluate({...args,snapshot_id:"foreign"}),/not current/);
  f.store.save("evidence",String(f.e.id),{...payload(f.e),confidence:"bounded",metadata:{...f.e.metadata as JsonObject,fact_values:{approved:true}}});
  assert.throws(()=>f.service.procedureDecisionEvaluate(args),/unverified/);
  f.facts({approved:true},{dispatch_digest:"wrong"});assert.throws(()=>f.service.procedureDecisionEvaluate(args),/unverified/);
 }finally{await f.close();}
});

test("business confirmation cannot be replaced with program facts",async()=>{
 const f=await ready("human_gate");try{
  f.facts({approved:true});assert.equal(f.service.procedureDecisionEvaluate(f.decisionArgs()).status,"blocked");
  const run=f.store.get("procedure_invocation","invoke"),snap=f.store.get("state_snapshot","before");
  f.store.create("evidence","human",{source_type:"human",confidence:"confirmed",metadata:{invocation_id:"invoke",receipt_id:run.last_receipt_id,snapshot_digest:snap.snapshot_digest,expires_at:new Date(Date.now()+60000).toISOString(),fact_values:{approved:true}}});
  const result=f.service.procedureDecisionEvaluate(f.decisionArgs({fact_evidence_id:"human"}));assert.equal((result.decision as JsonObject).edge_id,"approved");
 }finally{await f.close();}
});

test("missing rules, no matching branch, ambiguous branches and unsafe rework all block",async()=>{
 const variants:Array<[JsonObject,(g:JsonObject)=>void,string]>=[
  [{approved:true},g=>delete (g.nodes as JsonObject[])[0]!.decision_rules,"decision_inputs_or_evaluator_unavailable"],
  [{approved:true},g=>{((g.nodes as JsonObject[])[0]!.decision_rules as JsonObject).approved= [{field:"other",op:"eq",value:true}];},"decision_inputs_or_evaluator_unavailable"],
  [{approved:true},g=>{((g.nodes as JsonObject[])[0]!.decision_rules as JsonObject).approved=[{field:"approved",op:"eq",value:false}];},"no_unique_matching_edge"],
  [{approved:true},g=>{((g.nodes as JsonObject[])[0]!.decision_rules as JsonObject).repair=[{field:"approved",op:"eq",value:true}];},"no_unique_matching_edge"],
  [{approved:false},g=>{(g.edges as JsonObject[])[1]!.rework=true;},"safe_target_state_not_verified"]
 ];
 for(const [values,change,reason]of variants){const f=await ready("condition",values,change);try{assert.equal(f.service.procedureDecisionEvaluate(f.decisionArgs()).reason,reason);}finally{await f.close();}}
});

test("successful action edges need no condition rule; failure edges do not match a passed node",async()=>{
 const f=await ready("action",{},g=>{const es=g.edges as JsonObject[];es[0]!.kind="success";delete es[0]!.predicate_ref;es[1]!.kind="failure";delete es[1]!.predicate_ref;});try{
  const result=f.service.procedureDecisionEvaluate(f.decisionArgs());assert.equal((result.decision as JsonObject).edge_id,"approved");
  const run=f.store.get("procedure_invocation","invoke");assert.throws(()=>f.service.procedureDecisionEvaluate({...f.decisionArgs(),decision_id:"exit"}),/selected exit/);
 }finally{await f.close();}
});
test("bounded rework uses the accepted safe-target fact rather than mutable metadata",async()=>{
 const f=await ready("condition",{approved:false,safe_to_retry:true},g=>{(g.edges as JsonObject[])[1]!.rework=true;});try{
  const result=f.service.procedureDecisionEvaluate(f.decisionArgs());assert.equal((result.decision as JsonObject).edge_id,"repair");
 }finally{await f.close();}
});

 test("unconditional rework rejects safe-target facts changed after acceptance",async()=>{
 const f=await ready("action",{safe_to_retry:false},g=>{const es=g.edges as JsonObject[];es[0]!.kind="success";es[0]!.rework=true;delete es[0]!.predicate_ref;es[1]!.kind="failure";delete es[1]!.predicate_ref;});try{
 f.facts({safe_to_retry:true});assert.throws(()=>f.service.procedureDecisionEvaluate(f.decisionArgs()),/facts changed after accepted output/);
 }finally{await f.close();}
 });
