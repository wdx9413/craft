import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { applySessionEvidencePage } from "../capability/craft-knowledge/session-evidence-repair.ts";
import { preflightSessionEvidencePage } from "../core/session-evidence-repair-preflight.ts";

const args = process.argv.slice(2);
const cursorArgs = args.filter(arg => arg.startsWith("--cursor="));
const limitArgs = args.filter(arg => arg.startsWith("--limit="));
const rootArgs = args.filter(arg => arg.startsWith("--data-root="));
if (args.filter(arg => arg === "--apply").length > 1
  || cursorArgs.length > 1 || limitArgs.length > 1 || rootArgs.length > 1
  || args.some(arg => arg !== "--apply" && !arg.startsWith("--cursor=") && !arg.startsWith("--limit=") && !arg.startsWith("--data-root="))) {
  throw new Error("Usage: session-evidence-repair.ts [--apply] [--data-root=path] [--cursor=id] [--limit=1..1000]");
}
const cursor = cursorArgs[0]?.slice("--cursor=".length) ?? "";
const limit = Number(limitArgs[0]?.slice("--limit=".length) ?? 100);
const root = rootArgs[0]?.slice("--data-root=".length);
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || rootArgs.length && !root || cursor.length > 1024) throw new Error("Invalid repair bounds");
const paths = craftPaths(root);
const inventory = preflightSessionEvidencePage(paths, { cursor, limit });
if (!args.includes("--apply") || inventory.blocked) {
  process.stdout.write(`${JSON.stringify({ status: inventory.blocked ? "blocked" : "preflight", preflight: inventory })}\n`);
  if (inventory.blocked) process.exitCode = 2;
} else {
const store = await new CraftStore(paths).open({ skipLegacyPartitionMigration: true });
try {
  const result = applySessionEvidencePage(store, { cursor, limit });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = ({ completed: 0, blocked: 2 } as Record<string, number>)[String(result.status)];
} finally { store.close(); }
}
