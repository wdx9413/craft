import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { coverageInventory } from "./coverage-inventory.ts";

const root = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
if (args.some(arg => arg !== "--check")) throw new Error("Usage: audit:coverage-inventory [--check]");
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
const manifest = JSON.parse(readFileSync(resolve(root, "tests/coverage-gates.json"), "utf8"));
const baseline = JSON.parse(readFileSync(resolve(root, "tests/coverage-inventory-baseline.json"), "utf8")) as string[];
const typeOnlySources = Object.fromEntries((manifest.type_only ?? []).map((path: string) => [path, readFileSync(resolve(root, path), "utf8")]));
const result = coverageInventory(files, manifest.groups, baseline, typeOnlySources);
if (args.includes("--check")) {
  process.stdout.write(`${JSON.stringify({ status: result.status, managed: result.managed.length, type_only: result.type_only, invalid_type_only: result.invalid_type_only, baseline_debt: result.baseline_missing.length, new_missing: result.new_missing })}\n`);
  if (result.new_missing.length || result.invalid_type_only.length) process.exitCode = 1;
} else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
