import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importOwnerHistory } from "../core/owner-history-import.ts";
import type { HistoryArchiveManifest } from "../core/owner-history-archive.ts";
const args = process.argv.slice(2);
if (args.length !== 3 || !args[0]?.startsWith("--archive=") || !args[1]?.startsWith("--manifest=") || !args[2]?.startsWith("--destination=")
  || !args[0].slice(10).trim() || !/^manifest-[a-f0-9]{64}\.json$/u.test(args[1].slice(11)) || !args[2].slice(14).trim()) {
  throw new Error("Usage: owner-history-import.js --archive=<root> --manifest=manifest-<digest>.json --destination=<new-staging-root>");
}
const archive=args[0].slice(10),manifest=JSON.parse(readFileSync(join(archive,args[1].slice(11)),"utf8")) as HistoryArchiveManifest;
const result=await importOwnerHistory(archive,manifest,args[2].slice(14));
process.stdout.write(`${JSON.stringify({mode:"staging-import",...result,source_switched:false})}\n`);
