import { craftPaths } from "craft-common-store-local/paths";
import { archiveOwnerHistory } from "../core/owner-history-archive.ts";
const args = process.argv.slice(2);
const [sourceArg="",destinationArg=""]=args;
const flags=new Set(args.slice(2));
if (args.length < 2 || !sourceArg.startsWith("--data-root=") || !destinationArg.startsWith("--destination=")
  || !sourceArg.slice(12).trim() || !destinationArg.slice(14).trim() || flags.size !== args.length-2
  || [...flags].some(flag=>!["--allow-source-drift","--compress-backups","--compress-history","--reserve-5gib"].includes(flag))) {
  throw new Error("Usage: owner-history-archive.js --data-root=<source> --destination=<archive> [--allow-source-drift] [--compress-backups] [--compress-history] [--reserve-5gib]");
}
const manifest = await archiveOwnerHistory(craftPaths(sourceArg.slice(12)),destinationArg.slice(14),{
  onProgress:({bytes,free_bytes,...progress})=>process.stderr.write(`${JSON.stringify({mode:"copy-only-progress",...progress,bytes_mib:Math.round(bytes/1024**2),free_mib:Math.floor(free_bytes/1024**2)})}\n`),
  allowSourceDrift:flags.has("--allow-source-drift"),compressBackups:flags.has("--compress-backups"),compressHistory:flags.has("--compress-history"),
  ...(flags.has("--reserve-5gib")?{minimumFreeBytes:5*1024**3}:{}),
});
process.stdout.write(`${JSON.stringify({mode:"copy-only",digest:manifest.digest,records:manifest.record_count,published:manifest.published_count,staged:manifest.staged_count,
  unresolved:manifest.unresolved_count,unavailable:manifest.unavailable_count,unavailable_source_files:manifest.unavailable_sources.length,source_validation:manifest.source_validation,source_switched:false})}\n`);
