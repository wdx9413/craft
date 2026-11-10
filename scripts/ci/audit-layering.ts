import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { auditLayerGraph } from "./layer-graph.ts";

const root = resolve(import.meta.dirname, "../..");
const sources: Record<string, string> = {};
function walk(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", "target", "resources", "gen"].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile() && /\.(?:ts|js|mjs)$/u.test(entry.name)) {
      sources[relative(root, path).split("\\").join("/")] = readFileSync(path, "utf8");
    }
  }
}
for (const directory of ["common", "core", "capability", "adapters", "bin", "scripts/release"]) walk(resolve(root, directory));
const packageExports: Record<string, string> = {};
for (const directory of ["common", "capability"]) {
  for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("craft-")) continue;
    const manifestPath = resolve(root, directory, entry.name, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name: string; exports?: Record<string, { default?: string } | string>;
    };
    for (const [subpath, value] of Object.entries(manifest.exports ?? {})) {
      const destination = typeof value === "string" ? value : value.default;
      if (!destination?.startsWith("./dist/") || !destination.endsWith(".js")) continue;
      const source = `${directory}/${entry.name}/src/${destination.slice("./dist/".length, -".js".length)}.ts`;
      const capabilitySource = `${directory}/${entry.name}/${destination.slice("./dist/".length, -".js".length)}.ts`;
      const target = source in sources ? source : capabilitySource;
      if (!(target in sources)) throw new Error(`Package export has no source: ${manifest.name}${subpath}`);
      packageExports[subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`] = target;
    }
  }
}
const findings = auditLayerGraph(sources, packageExports);
for (const finding of findings) console.error(`layer audit: ${finding.kind}: ${finding.path.join(" -> ")}`);
console.log(`layer audit: ${Object.keys(sources).length} modules, ${findings.length} violation(s), no import exemptions`);
if (findings.length) process.exitCode = 1;
