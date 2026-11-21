import { existsSync, lstatSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RecordFileStore } from "craft-common-store-local/record-files";
import { contentReference } from "craft-common-store-local/content-store";
import { procedureDefinitionReference } from "./owner-history-archive.ts";
import { catalogOwner, ownedCatalogFile, STORAGE_OWNERS } from "./infrastructure/owned-catalog.ts";

type Ref={owner:string;kind:string;id:string;version:number};
/** Rebase only machine locators. Per-owner metadata makes interrupted rebases reversible. */
export function rebaseImportedHistory(staging:string, finalRoot:string):{changed:number;revalidation_required:Ref[]} {
  const root=resolve(staging),target=resolve(finalRoot),marker=join(root,".craft-history-import");
  if (!existsSync(marker) || lstatSync(marker).isSymbolicLink()) throw new Error("History rebase requires an imported staging directory");
  return rebaseOwnedHistory(root,target);
}
/** Restore seam for independently owned catalogs; callers supply the original logical root when no import metadata exists. */
export function rebaseOwnedHistory(staging:string,finalRoot:string,previousRoot?:string):{changed:number;revalidation_required:Ref[]} {
  const root=resolve(staging),target=resolve(finalRoot);
  const changed:Ref[]=[];const seen=new Set<string>();let changedCount=0;
  const revalidate=(ref:Ref)=>{const key=JSON.stringify(ref);if(!seen.has(key)){seen.add(key);changed.push(ref);}};
  for (const owner of STORAGE_OWNERS) {
    const file=ownedCatalogFile(root,owner);
    if (!existsSync(file)) continue;
    if (catalogOwner(join(root,owner)) !== owner) throw new Error("History rebase requires a matching catalog owner");
    if (lstatSync(file).isSymbolicLink()) throw new Error("History rebase catalog is unsafe");
    const catalogs=[file];
    for(const relativeDirectory of [["trace","v1"],["codebase","legacy-graph-v1"]]){
      const directory=join(root,owner,...relativeDirectory);
      if(!existsSync(directory))continue;
      if(lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())throw new Error("History rebase shard directory is unsafe");
      for(const name of readdirSync(directory).sort())if(/^[a-f0-9]{2}\.db$/u.test(name))catalogs.push(join(directory,name));
    }
    for(const catalog of catalogs){
      if(lstatSync(catalog).isSymbolicLink())throw new Error("History rebase catalog is unsafe");
      const database=new DatabaseSync(catalog),files=new RecordFileStore(root,dirname(file));
      try {
        database.exec("BEGIN IMMEDIATE");
        const primary=catalog === file;
        if(!primary)database.exec("CREATE TABLE IF NOT EXISTS history_rebase_location(value TEXT NOT NULL)");
        const location=database.prepare(primary ? "SELECT value FROM meta WHERE key='history_location'" : "SELECT value FROM history_rebase_location LIMIT 1").get() as {value:string}|undefined;
        const previous=previousRoot === undefined ? location?.value ?? root : resolve(previousRoot);
        type Pending={row:{kind:string;id:string;version:number;created_at:string;updated_at:string};collection:"records"|"events";payload:Record<string,unknown>};
        const pending:Pending[]=[];let pendingBytes=0;
        const flush=()=>{
          if(!pending.length)return;
          const projections=files.writeColdBatch(pending.map(({row,payload})=>({...row,payload})));
          for(let index=0;index<pending.length;index++){
            const {row,collection}=pending[index]!,projection=projections[index]!;
            if(collection === "events")database.prepare("UPDATE events SET payload_json=? WHERE stream=? AND sequence=?").run(JSON.stringify(projection),row.id,row.version);
            else database.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=? AND version=?").run(JSON.stringify(projection),row.kind,row.id,row.version);
            changedCount++;revalidate({owner,kind:row.kind,id:row.id,version:row.version});
          }
          pending.length=0;pendingBytes=0;
        };
        for(const collection of ["records","events"] as const){
          if(!database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(collection))continue;
          let cursor:Array<string|number>|undefined;
          while(true){
            const keys=collection === "records" ? "kind,id,version" : "stream,sequence";
            const fields=collection === "records" ? "kind,id,version,payload_json,created_at,updated_at" : "'event:'||event_type AS kind,stream AS id,sequence AS version,payload_json,created_at,created_at AS updated_at";
            const clause=cursor ? ` WHERE (${keys}) > (${cursor.map(()=>"?").join(",")})` : "";
            const rows=database.prepare(`SELECT ${fields} FROM ${collection}${clause} ORDER BY ${keys} LIMIT 64`).all(...(cursor ?? [])) as Array<{kind:string;id:string;version:number;payload_json:string;created_at:string;updated_at:string}>;
            if(!rows.length)break;
            for(const row of rows){
              let modified=false,external=false;
              const visit=(value:unknown):unknown=>{
                if(contentReference(value) || procedureDefinitionReference(value)){
                  if(contentReference(value) ? value.kind !== owner : owner !== "experience"){external=true;return value;}
                  if(value.path.startsWith(previous+sep) && previous !== target){modified=true;return {...value,path:join(target,relative(previous,value.path))};}
                  return value;
                }
                if(Array.isArray(value))return value.map(visit);
                if(value && typeof value === "object")return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,visit(item)]));
                return value;
              };
              const payload=visit(files.payload(row.kind,row.id,row.version,JSON.parse(row.payload_json))) as Record<string,unknown>;
              if(row.kind === "workspace_checkpoint" && typeof payload.snapshot_root === "string" && payload.snapshot_root.startsWith(join(previous,"projects")+sep) && relative(previous,payload.snapshot_root).split(sep).slice(2,4).join("/") === "codebase/snapshots" && previous !== target){payload.snapshot_root=join(target,relative(previous,payload.snapshot_root));modified=true;}
              if(owner === "eval" && row.kind === "workbench_evaluation")for(const key of ["report_root","run_directory"]){
                const value=payload[key];
                if(typeof value === "string" && value.startsWith(join(previous,"evaluations")+sep) && previous !== target){payload[key]=join(target,relative(previous,value));modified=true;}
              }
              if(external)revalidate({owner,kind:row.kind,id:row.id,version:row.version});
              if(!modified)continue;
              if(row.kind === "wiki_page" && contentReference(payload.content_ref))payload.file_path=payload.content_ref.path;
              const bytes=Buffer.byteLength(JSON.stringify(payload))+Buffer.byteLength(row.kind)+Buffer.byteLength(row.id)+512;
              if(pending.length && (pending.length >= 1000 || pendingBytes+bytes > 8*1024*1024))flush();
              pending.push({row,collection,payload});pendingBytes+=bytes;
              if(pending.length >= 1000 || pendingBytes >= 8*1024*1024)flush();
            }
            const last=rows[rows.length-1]!;cursor=collection === "records" ? [last.kind,last.id,last.version] : [last.id,last.version];
          }
        }
        flush();
        if(primary)database.prepare("INSERT INTO meta(key,value) VALUES('history_location',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(target);
        else {database.exec("DELETE FROM history_rebase_location");database.prepare("INSERT INTO history_rebase_location(value) VALUES(?)").run(target);}
        database.exec("COMMIT");
      }catch(error){database.exec("ROLLBACK");throw error;}
      finally{database.close();}
    }
  }
  // Stable reference digests that included a physical path must be rechecked by
  // their owner. Returning this list does not promote or silently re-sign them.
  return {changed:changedCount,revalidation_required:changed};
}
