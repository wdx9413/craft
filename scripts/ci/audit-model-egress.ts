/**
 * Inventory every model-transport send site and require a final egress check.
 *
 * NEEDREAD §12 requires the outbound redaction path to be inventoried, not
 * assumed. `sanitizeModelEgressRequest` is the last check before bytes leave,
 * so each `transport.complete(...)` call must be provably wrapped by it — or
 * appear below with a written reason. This turns that sentence into a check
 * that fails the build when a new send path is added without review.
 *
 *   node --experimental-strip-types scripts/ci/audit-model-egress.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const ROOTS = ["core", "capability"];
const SEND = /(?:this\.transport|transport|codex|api)\.complete\(/gu;
const CHECK = /sanitizeModelEgressRequest\(/u;
const WINDOW = 12;
const WIDE_WINDOW = 80;

/**
 * Call sites that are not a final send. Each entry needs a reason: a delegating
 * transport is not a destination, and tests inject their own transport.
 */
const ALLOWLIST: ReadonlyArray<{ file: string; reason: string }> = [
  { file: "core/codex-cli-model-transport.ts", reason: "delegating transport: it forwards to codex/api complete; callers already sanitize the request they pass in" },
];

function files(dir: string, out: string[] = []): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else if (name.endsWith(".ts")) out.push(path);
  }
  return out;
}

export interface EgressViolation { file: string; line: number; text: string }

export function auditModelEgress(root = ROOT): { scanned: number; sendSites: number; violations: EgressViolation[] } {
  const allow = new Set(ALLOWLIST.map((entry) => entry.file));
  let scanned = 0; let sendSites = 0; const violations: EgressViolation[] = [];
  for (const top of ROOTS) {
    for (const path of files(join(root, top))) {
      const source = readFileSync(path, "utf8");
      if (!source.includes(".complete(")) continue;
      scanned += 1;
      const file = relative(root, path).split(sep).join("/");
      const lines = source.split(/\r?\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        SEND.lastIndex = 0;
        if (!SEND.test(lines[index]!)) continue;
        sendSites += 1;
        if (allow.has(file)) continue;
        const window = lines.slice(Math.max(0, index - WINDOW), index + 1).join("\n");
        if (CHECK.test(window)) continue;
        // The request can also be sanitized into a named variable well above the
        // send. Accept that only when the exact variable is bound to the check.
        const args = /\.complete\([^,]+,\s*([A-Za-z_$][\w$]*)/u.exec(lines[index]!);
        const name = args?.[1];
        const wide = lines.slice(Math.max(0, index - WIDE_WINDOW), index).join("\n");
        const bound = name !== undefined && new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*sanitizeModelEgressRequest\\(`, "u").test(wide);
        if (!bound) violations.push({ file, line: index + 1, text: lines[index]!.trim() });
      }
    }
  }
  return { scanned, sendSites, violations };
}

const result = auditModelEgress();
for (const entry of ALLOWLIST) console.log(`ALLOW ${entry.file} -- ${entry.reason}`);
for (const violation of result.violations) console.log(`VIOLATION ${violation.file}:${violation.line} ${violation.text}`);
console.log(`model egress audit: ${result.sendSites} send site(s) in ${result.scanned} file(s), ${result.violations.length} violation(s)`);
if (result.violations.length) process.exitCode = 1;
