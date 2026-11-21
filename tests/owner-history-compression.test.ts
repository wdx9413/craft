import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import fs,{copyFileSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,lstatSync,truncateSync} from "node:fs";
import {dirname,join} from "node:path";
import {tmpdir} from "node:os";
import {DatabaseSync} from "node:sqlite";
import zlib,{gzipSync} from "node:zlib";
import {syncBuiltinESMExports} from "node:module";
import test,{mock} from "node:test";
import {spawnSync} from "node:child_process";
import {craftPaths} from "../core/infrastructure/paths.ts";
import {archiveOwnerHistory,compressHistoryArchive,readArchivedHistory,MAX_HISTORY_DECODED_BLOCK_BYTES,type HistoryArchiveManifest} from "../core/owner-history-archive.ts";
import {importOwnerHistory} from "../core/owner-history-import.ts";
const sha=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
function resign(manifest:HistoryArchiveManifest,changes:Record<string,unknown>={}):HistoryArchiveManifest {const {digest:ignored,...body}=manifest;const next={...body,...changes};return {...next,digest:sha(JSON.stringify(next))};}
function fixture(root:string,count=1){const paths=craftPaths(root);mkdirSync(dirname(paths.databaseFile),{recursive:true});const db=new DatabaseSync(paths.databaseFile);db.exec("CREATE TABLE records(kind TEXT,id TEXT,version INTEGER,payload_json TEXT,created_at TEXT,updated_at TEXT,PRIMARY KEY(kind,id,version));BEGIN");const insert=db.prepare("INSERT INTO records VALUES(?,?,?,?,?,?)");for(let version=1;version<=count;version++)insert.run("trace","trace_gzip_fixture",version,JSON.stringify({schema:"craft.trace.v1",schema_revision:1,task_id:"synthetic-task",telemetry_only:true,status:"open",event_count:0,next_sequence:1,metadata_counter:version,metadata_hint:"合成结构 synthetic repeated structure ".repeat(30)}),"created","updated");db.exec("COMMIT");db.close();return paths;}

test("portable gzip blocks keep exact ranges with a two-block cache and normal Runtime MCP after offline conversion",async t=>{
 const temp=mkdtempSync(join(tmpdir(),"craft-history-gzip-")),source=join(temp,"source"),archive=join(temp,"gzip"),plainRoot=join(temp,"plain"),target=join(temp,"target");
 try{
  const paths=fixture(source,3001),manifest=await archiveOwnerHistory(paths,archive,{compressHistory:true});assert.equal(manifest.record_count,3001);assert(manifest.entries.every(entry=>entry.encoding==="gzip"));const distinct=[...new Map(manifest.entries.map(entry=>[entry.file,entry])).values()];assert.equal(distinct.length,4);
  const decoded=distinct.reduce((n,e)=>n+e.decoded_bytes!,0),compressed=distinct.reduce((n,e)=>n+lstatSync(join(archive,e.file)).size,0);assert(compressed<decoded/4);t.diagnostic(JSON.stringify({records:3001,decoded_kib:Math.round(decoded/1024),gzip_kib:Math.round(compressed/1024),ratio:Number((compressed/decoded).toFixed(4))}));
  let inflations=0;const original=zlib.gunzipSync,spy=mock.method(zlib,"gunzipSync",(...args:Parameters<typeof zlib.gunzipSync>)=>{inflations++;return original(...args);});syncBuiltinESMExports();
  try{for(const index of [0,0,1,2,0])readArchivedHistory(archive,distinct[index]!);assert.equal(inflations,4);}finally{spy.mock.restore();syncBuiltinESMExports();}
  const plain=await archiveOwnerHistory(paths,plainRoot);assert(plain.entries.every(entry=>entry.encoding===undefined));rmSync(source,{recursive:true});
  const converted=compressHistoryArchive(plainRoot,plain);assert(converted.entries.every(entry=>entry.encoding==="gzip"));assert.equal(compressHistoryArchive(plainRoot,converted).digest,converted.digest);assert.equal(converted.record_count,plain.record_count);
  const row=readArchivedHistory(plainRoot,converted.entries[1500]!);assert(row.payload && typeof row.payload==="object" && "metadata_counter" in row.payload);assert.equal(row.payload.metadata_counter,1501);
  assert.equal((await importOwnerHistory(plainRoot,converted,target)).imported,3001);
  const input=JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"craft_trace_get",arguments:{trace_id:"trace_gzip_fixture"}}})+"\n";
  const child=spawnSync(process.execPath,["--experimental-strip-types",join(import.meta.dirname,"../bin/craft-mcp.ts"),"--product","runtime"],{input,encoding:"utf8",timeout:30000,env:{...process.env,CRAFT_DATA_DIR:target,CRAFT_STORAGE_OWNER:"runtime",CRAFT_CONTINUOUS_LEARNING:"0"}});assert.equal(child.status,0,child.stderr);const reply=JSON.parse(child.stdout.trim());assert.equal(reply.result.isError,false,JSON.stringify(reply));assert.equal(reply.result.structuredContent.trace.metadata_counter,3001);
 }finally{mock.restoreAll();syncBuiltinESMExports();rmSync(temp,{recursive:true,force:true});}
});

test("compressed cold reads reject forged codecs, lengths, bombs, names, digests and tampered cached files",async()=>{
 const temp=mkdtempSync(join(tmpdir(),"craft-history-gzip-negative-")),archive=join(temp,"archive");
 try{
  const manifest=await archiveOwnerHistory(fixture(join(temp,"source")),archive,{compressHistory:true}),entry=manifest.entries[0]!,file=join(archive,entry.file),original=readFileSync(file);
  readArchivedHistory(archive,entry);
  for(const value of [undefined,null,0,-1,1.5,"10",MAX_HISTORY_DECODED_BLOCK_BYTES+1])assert.throws(()=>readArchivedHistory(archive,JSON.parse(JSON.stringify({...entry,decoded_bytes:value}))),/decoded block length/u);
  for(const value of ["zip",null])assert.throws(()=>readArchivedHistory(archive,JSON.parse(JSON.stringify({...entry,encoding:value}))),/codec/u);
  assert.throws(()=>readArchivedHistory(archive,{...entry,encoding:undefined}),/codec declaration/u);assert.throws(()=>readArchivedHistory(archive,{...entry,decoded_bytes:entry.decoded_bytes!+1}),/length mismatch/u);assert.throws(()=>readArchivedHistory(archive,{...entry,offset:entry.decoded_bytes!}),/range/u);
  const uncached=join(temp,"uncached");mkdirSync(join(uncached,dirname(entry.file)),{recursive:true});copyFileSync(file,join(uncached,entry.file));assert.throws(()=>readArchivedHistory(uncached,{...entry,decoded_bytes:entry.decoded_bytes!+1}),/length mismatch/u);
  writeFileSync(file,"synthetic corruption");assert.throws(()=>readArchivedHistory(archive,entry),/compressed block digest/u);writeFileSync(file,original);
  const badName=join(archive,"bad.jsonl.gz");writeFileSync(badName,original);assert.throws(()=>readArchivedHistory(archive,{...entry,file:"bad.jsonl.gz"}),/block name/u);
  const put=(bytes:Buffer)=>{const name=`${sha(bytes)}.jsonl.gz`;writeFileSync(join(archive,name),bytes);return name;};
  assert.throws(()=>readArchivedHistory(archive,{...entry,file:put(Buffer.from("synthetic non-gzip"))}),/gzip codec/u);
  const bomb=gzipSync(Buffer.alloc(2*1024*1024,120));assert.throws(()=>readArchivedHistory(archive,{...entry,file:put(bomb),decoded_bytes:1024}),/decoded length/u);
  const huge=`${"a".repeat(64)}.jsonl.gz`;writeFileSync(join(archive,huge),"");truncateSync(join(archive,huge),MAX_HISTORY_DECODED_BLOCK_BYTES+1024*1024+1);assert.throws(()=>readArchivedHistory(archive,{...entry,file:huge}),/compressed block exceeds/u);
 }finally{rmSync(temp,{recursive:true,force:true});}
});

test("existing plain archives convert without original sources and reject malformed conversion references",async()=>{
 const temp=mkdtempSync(join(tmpdir(),"craft-history-convert-negative-")),archive=join(temp,"archive");
 try{
  const manifest=await archiveOwnerHistory(fixture(join(temp,"source")),archive),entry=manifest.entries[0]!,row=readArchivedHistory(archive,entry);
  assert.throws(()=>compressHistoryArchive(archive,{...manifest,digest:"bad"}),/manifest digest/u);
  for(const changed of [{file:"../outside"},{offset:-1},{bytes:0},{digest:"bad"},{decoded_bytes:10},{encoding:"zip"}])assert.throws(()=>compressHistoryArchive(archive,resign(manifest,{entries:[{...entry,...changed}]})),/escapes|range|digest|codec/u);
  assert.throws(()=>compressHistoryArchive(archive,resign(manifest,{record_count:2})),/record count/u);
  const file=join(archive,entry.file),original=readFileSync(file);writeFileSync(file,"synthetic changed block");assert.throws(()=>compressHistoryArchive(archive,manifest),/plain block digest/u);writeFileSync(file,original);
  const converted=compressHistoryArchive(archive,manifest);assert.deepEqual(readArchivedHistory(archive,converted.entries[0]!),row);
  const bad=resign(converted,{entries:[{...converted.entries[0]!,offset:-1}]});assert.throws(()=>compressHistoryArchive(archive,bad),/range or digest/u);
  const large="oversized.jsonl";writeFileSync(join(archive,large),original);truncateSync(join(archive,large),MAX_HISTORY_DECODED_BLOCK_BYTES+1);const oversized=resign(manifest,{entries:[{...entry,file:large}]});const retained=compressHistoryArchive(archive,oversized);assert.equal(retained.entries[0]!.encoding,undefined);assert.deepEqual(readArchivedHistory(archive,retained.entries[0]!),row);
 }finally{rmSync(temp,{recursive:true,force:true});}
});

test("history gzip archive and post-export conversion CLIs expose explicit copy-only results",async()=>{
 const temp=mkdtempSync(join(tmpdir(),"craft-history-gzip-cli-")),source=join(temp,"source"),archive=join(temp,"archive");
 try{
  fixture(source,1001);const child=spawnSync(process.execPath,["--experimental-strip-types",join(import.meta.dirname,"../scripts/owner-history-archive.ts"),`--data-root=${source}`,`--destination=${archive}`,"--compress-history","--compress-backups","--allow-source-drift","--reserve-5gib"],{encoding:"utf8"});assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout.trim()),manifest=join(archive,`manifest-${result.digest}.json`);
  const convert=spawnSync(process.execPath,["--experimental-strip-types",join(import.meta.dirname,"../scripts/owner-history-compress.ts"),`--archive=${archive}`,`--manifest=${manifest}`],{encoding:"utf8"});assert.equal(convert.status,0,convert.stderr);assert.equal(JSON.parse(convert.stdout.trim()).original_sources_read,false);assert.match(convert.stderr,/"items":1000/u);
  for(const args of [[],["--archive="],["--bad=a","--manifest=b"],["--archive=a","--bad=b"],["--archive=","--manifest=b"],[`--archive=${archive}`,"--manifest="]]){const invalid=spawnSync(process.execPath,["--experimental-strip-types",join(import.meta.dirname,"../scripts/owner-history-compress.ts"),...args],{encoding:"utf8"});assert.notEqual(invalid.status,0);assert.match(invalid.stderr,/Usage/u);}
 }finally{rmSync(temp,{recursive:true,force:true});}
});
