import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// WorkBuddy resolves ${CODEBUDDY_PLUGIN_ROOT} to the extracted plugin directory,
// so each adapter ships the bundled, dependency-free MCP entry instead of
// depending on a globally installed `craft-mcp` binary being on PATH.
const adapters = [
  { directory: "adapters/workbuddy-expert", config: ".mcp.json", bundle: "dist/plugin/craft-mcp.cjs", entry: "bin/craft-mcp.cjs", artifact: "craft-workbuddy-expert" },
  { directory: "adapters/workbuddy-connector", config: "mcp.json", bundle: "dist/plugin/craft-mcp.cjs", entry: "bin/craft-mcp.cjs", artifact: "craft-workbuddy-connector" },
];

type Entry = { name: string; data: Buffer };

// A fixed DOS timestamp (2020-01-01 00:00) keeps archives byte-identical across runs.
const dosDate = ((2020 - 1980) << 9) | (1 << 5) | 1;

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[index] = value >>> 0;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function archive(entries: Entry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const payload = deflateRawSync(entry.data);
    const checksum = crc32(entry.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0, 10); header.writeUInt16LE(dosDate, 12); header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(payload.length, 18); header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26); header.writeUInt16LE(0, 28);
    local.push(header, name, payload);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(8, 10); directory.writeUInt16LE(0, 12); directory.writeUInt16LE(dosDate, 14); directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(payload.length, 20); directory.writeUInt32LE(entry.data.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt16LE(0, 30); directory.writeUInt16LE(0, 32); directory.writeUInt16LE(0, 34); directory.writeUInt16LE(0, 36);
    directory.writeUInt32LE((0o100644 << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + payload.length;
  }
  const index = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...local, index, end]);
}

async function collect(root: string, current = root): Promise<string[]> {
  const found = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const item of found.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(current, item.name);
    if (item.isDirectory()) files.push(...(await collect(root, path)));
    else if (item.isFile()) files.push(relative(root, path).replaceAll("\\", "/"));
  }
  return files;
}

const manifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as { version: string };
const outputDir = join(projectRoot, "dist");
await mkdir(outputDir, { recursive: true });

for (const adapter of adapters) {
  const root = join(projectRoot, adapter.directory);
  // Fail loudly if the adapter's MCP config points somewhere this script does not package.
  const config = JSON.parse(await readFile(join(root, adapter.config), "utf8")) as { mcpServers: Record<string, { args?: string[] }> };
  const declared = Object.values(config.mcpServers).flatMap((server) => server.args ?? []).filter((arg) => arg.includes("${CODEBUDDY_PLUGIN_ROOT}/"));
  const expected = `\${CODEBUDDY_PLUGIN_ROOT}/${adapter.entry}`;
  if (declared.length !== 1 || declared[0] !== expected) {
    throw new Error(`${adapter.config} must reference exactly ${expected}, found ${JSON.stringify(declared)}`);
  }
  const entries: Entry[] = [];
  for (const name of await collect(root)) entries.push({ name, data: await readFile(join(root, name)) });
  entries.push({ name: adapter.entry, data: await readFile(join(projectRoot, adapter.bundle)) });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const fileName = `${adapter.artifact}-v${manifest.version}.zip`;
  await writeFile(join(outputDir, fileName), archive(entries));
  for (const existing of await readdir(outputDir)) {
    if (existing.startsWith(`${adapter.artifact}-v`) && existing.endsWith(".zip") && existing !== fileName) {
      await rm(join(outputDir, existing), { force: true });
    }
  }
  process.stdout.write(`${adapter.artifact}: ${entries.length} entries -> dist/${fileName}\n`);
}
