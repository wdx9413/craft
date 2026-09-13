import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";

const root = resolve(dirname(import.meta.dirname)); const dist = join(root, "dist");
type Entry = { name: string; data: Buffer };
const dosDate = ((2020 - 1980) << 9) | (1 << 5) | 1;
const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) { let value = index; for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; crcTable[index] = value >>> 0; }
function crc32(data: Buffer): number { let crc = 0xffffffff; for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function archive(entries: Entry[]): Buffer { const local: Buffer[] = []; const central: Buffer[] = []; let offset = 0; for (const entry of entries) { const name = Buffer.from(entry.name); const payload = deflateRawSync(entry.data); const checksum = crc32(entry.data); const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(dosDate, 12); header.writeUInt32LE(checksum, 14); header.writeUInt32LE(payload.length, 18); header.writeUInt32LE(entry.data.length, 22); header.writeUInt16LE(name.length, 26); local.push(header, name, payload); const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x0800, 8); directory.writeUInt16LE(8, 10); directory.writeUInt16LE(dosDate, 14); directory.writeUInt32LE(checksum, 16); directory.writeUInt32LE(payload.length, 20); directory.writeUInt32LE(entry.data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE((0o100644 << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42); central.push(directory, name); offset += header.length + name.length + payload.length; } const index = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...local, index, end]); }
async function collect(rootPath: string, current = rootPath): Promise<string[]> { const found = await readdir(current, { withFileTypes: true }); const files: string[] = []; for (const item of found.sort((a, b) => a.name.localeCompare(b.name))) { const path = join(current, item.name); if (item.isDirectory()) files.push(...await collect(rootPath, path)); else if (item.isFile()) files.push(relative(rootPath, path).replaceAll("\\", "/")); } return files; }
async function entriesFrom(directory: string, prefix: string): Promise<Entry[]> { const files = await collect(directory); return Promise.all(files.map(async (file) => ({ name: `${prefix}/${file}`, data: await readFile(join(directory, file)) }))); }

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
await mkdir(dist, { recursive: true });
const stage = join(dist, `craft-workbench-windows-v${manifest.version}`); await rm(stage, { recursive: true, force: true }); await mkdir(join(stage, "app", "dist"), { recursive: true });
await cp(join(dist, "src"), join(stage, "app", "dist", "src"), { recursive: true }); await cp(join(root, "package.json"), join(stage, "app", "package.json"));
const yaml = await realpath(join(root, "node_modules", "yaml")); await cp(yaml, join(stage, "app", "node_modules", "yaml"), { recursive: true });
await writeFile(join(stage, "craft-workbench.cmd"), "@echo off\nsetlocal\n\"%~dp0node.exe\" \"%~dp0app\\dist\\src\\cli.js\" gui %*\n", "utf8");
await writeFile(join(stage, "craft-workbench.ps1"), "& (Join-Path $PSScriptRoot 'node.exe') (Join-Path $PSScriptRoot 'app/dist/src/cli.js') gui $args\n", "utf8");
await writeFile(join(stage, "README.txt"), `Craft Workbench v${manifest.version}\n\nDouble-click craft-workbench.cmd. It opens the local Workbench in a browser.\nSettings live in %USERPROFILE%\\.craft_data\\settings.json and may relocate dataRoot.\nThis bundle includes the Node runtime and is intended for Windows x64.\n`, "utf8");
if (process.platform === "win32" && existsSync(process.execPath)) await cp(process.execPath, join(stage, "node.exe"));
const windowsEntries = await entriesFrom(stage, `craft-workbench-windows-v${manifest.version}`); await writeFile(join(dist, `craft-workbench-windows-v${manifest.version}.zip`), archive(windowsEntries));

const macStage = join(dist, `craft-workbench-macos-v${manifest.version}.app`); await rm(macStage, { recursive: true, force: true }); await mkdir(join(macStage, "Contents", "MacOS"), { recursive: true }); await mkdir(join(macStage, "Contents", "Resources", "app", "dist"), { recursive: true });
await cp(join(dist, "src"), join(macStage, "Contents", "Resources", "app", "dist", "src"), { recursive: true }); await cp(join(root, "package.json"), join(macStage, "Contents", "Resources", "app", "package.json"));
await writeFile(join(macStage, "Contents", "MacOS", "craft-workbench"), "#!/bin/sh\nROOT=\"$(CDPATH= cd -- \"$(dirname -- \"$0\")/../Resources\" && pwd)\"\nexec \"${CRAFT_NODE:-node}\" \"$ROOT/app/dist/src/cli.js\" gui \"$@\"\n", "utf8");
await writeFile(join(macStage, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleName</key><string>Craft Workbench</string><key>CFBundleIdentifier</key><string>dev.craft.workbench</string><key>CFBundleVersion</key><string>${manifest.version}</string><key>CFBundleExecutable</key><string>craft-workbench</string></dict></plist>`, "utf8");
const hdiutil = process.platform === "darwin" ? spawnSync("hdiutil", ["create", "-volname", "Craft Workbench", "-srcfolder", macStage, "-ov", "-format", "UDZO", join(dist, `craft-workbench-macos-v${manifest.version}.dmg`)], { stdio: "inherit" }) : null;
if (!hdiutil || hdiutil.status !== 0) await writeFile(join(dist, `craft-workbench-macos-v${manifest.version}.dmg.txt`), `A native macOS runner must build the DMG. On macOS run: pnpm run build && pnpm run pack:desktop\nStaging app: ${macStage}\n`, "utf8");
process.stdout.write(`desktop: windows zip and macOS staging prepared for v${manifest.version}\n`);
