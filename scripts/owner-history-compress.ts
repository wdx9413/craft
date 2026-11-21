import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {compressHistoryArchive,type HistoryArchiveManifest} from "../core/owner-history-archive.ts";
const args=process.argv.slice(2);
const [archiveArg="",manifestArg=""]=args;
if(args.length!==2 || !archiveArg.startsWith("--archive=") || !manifestArg.startsWith("--manifest=") || !archiveArg.slice(10).trim() || !manifestArg.slice(11).trim())throw new Error("Usage: owner-history-compress.js --archive=<copy> --manifest=<manifest-file>");
const root=resolve(archiveArg.slice(10)),manifest=JSON.parse(readFileSync(resolve(manifestArg.slice(11)),"utf8")) as HistoryArchiveManifest;
const result=compressHistoryArchive(root,manifest,items=>process.stderr.write(`${JSON.stringify({mode:"history-gzip-conversion",items})}\n`));
process.stdout.write(`${JSON.stringify({mode:"history-gzip-conversion",digest:result.digest,records:result.record_count,original_sources_read:false,source_switched:false})}\n`);
