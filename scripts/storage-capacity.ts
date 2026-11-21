import { measureStorageCapacity } from "../core/storage-capacity.ts";
const args = process.argv.slice(2);
if (args.length !== 1 || !args[0]?.startsWith("--root=") || !args[0].slice(7).trim()) throw new Error("Usage: storage-capacity.js --root=<active|archive|backup directory>");
process.stdout.write(JSON.stringify(measureStorageCapacity(args[0].slice(7)), null, 2) + "\n");
