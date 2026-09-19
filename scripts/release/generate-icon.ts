import { writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

const sizes = [16, 32, 48, 64, 128, 256, 512];
const TAU = Math.PI * 2;

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const kind = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0); kind.copy(output, 4); data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([kind, data])), 8 + data.length);
  return output;
}

function rgba(size: number): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const cx = size / 2; const radius = size * 0.305; const stroke = size * 0.12;
  const samples = size < 32 ? 4 : 3;
  const startX = radius * Math.cos(55 * Math.PI / 180); const startY = radius * Math.sin(55 * Math.PI / 180);
  const endX = radius * Math.cos(305 * Math.PI / 180); const endY = radius * Math.sin(305 * Math.PI / 180);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
      let black = 0;
      for (let sy = 0; sy < samples; sy += 1) for (let sx = 0; sx < samples; sx += 1) {
        const px = x + (sx + 0.5) / samples - cx; const py = y + (sy + 0.5) / samples - cx;
        const angle = (Math.atan2(py, px) + TAU) % TAU;
        const onArc = angle >= (55 * Math.PI / 180) && angle <= (305 * Math.PI / 180);
        const cap = Math.min(Math.hypot(px - startX, py - startY), Math.hypot(px - endX, py - endY)) <= stroke / 2;
        if ((onArc && Math.abs(Math.hypot(px, py) - radius) <= stroke / 2) || cap) black += 1;
      }
      const coverage = black / (samples * samples); const offset = (y * size + x) * 4;
      const value = Math.round(255 * (1 - coverage));
      pixels[offset] = value; pixels[offset + 1] = value; pixels[offset + 2] = value; pixels[offset + 3] = 255;
  }
  return pixels;
}

function png(size: number): Buffer {
  const pixels = rgba(size); const rows: Buffer[] = [];
  for (let y = 0; y < size; y += 1) rows.push(Buffer.concat([Buffer.from([0]), pixels.subarray(y * size * 4, (y + 1) * size * 4)]));
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

function dib(size: number): Buffer {
  const pixels = rgba(size); const header = Buffer.alloc(40); header.writeUInt32LE(40, 0); header.writeInt32LE(size, 4); header.writeInt32LE(size * 2, 8); header.writeUInt16LE(1, 12); header.writeUInt16LE(32, 14);
  const bitmap = Buffer.alloc(size * size * 4 + Math.ceil(size / 32) * 4 * size);
  header.writeUInt32LE(size * size * 4, 20);
  let offset = 0;
  for (let y = size - 1; y >= 0; y -= 1) for (let x = 0; x < size; x += 1) {
    const source = (y * size + x) * 4; bitmap[offset++] = pixels[source + 2]!; bitmap[offset++] = pixels[source + 1]!; bitmap[offset++] = pixels[source]!; bitmap[offset++] = pixels[source + 3]!;
  }
  return Buffer.concat([header, bitmap]);
}

const images = new Map(sizes.map((size) => [size, png(size)]));
const icoDirectories: Buffer[] = []; const icoPayloads: Buffer[] = []; const icoHeader = Buffer.alloc(6); icoHeader.writeUInt16LE(0, 0); icoHeader.writeUInt16LE(1, 2); icoHeader.writeUInt16LE(sizes.length - 1, 4);
let offset = 6 + (sizes.length - 1) * 16;
for (const size of sizes.filter((item) => item <= 256)) {
  const data = dib(size); const entry = Buffer.alloc(16); entry[0] = size === 256 ? 0 : size; entry[1] = entry[0]; entry[2] = 0; entry[3] = 0; entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6); entry.writeUInt32LE(data.length, 8); entry.writeUInt32LE(offset, 12); icoDirectories.push(entry); icoPayloads.push(data); offset += data.length;
}
await writeFile("assets/craft.ico", Buffer.concat([icoHeader, ...icoDirectories, ...icoPayloads]));
const icnsParts: Buffer[] = [];
for (const [size, type] of [[512, "ic09"], [256, "ic08"], [128, "ic07"], [64, "icp6"], [32, "icp5"], [16, "icp4"]] as const) {
  const data = images.get(size)!; const part = Buffer.alloc(8 + data.length); part.write(type, 0, 4, "ascii"); part.writeUInt32BE(part.length, 4); data.copy(part, 8); icnsParts.push(part);
}
const icns = Buffer.alloc(8); icns.write("icns", 0, 4, "ascii"); icns.writeUInt32BE(8 + icnsParts.reduce((sum, part) => sum + part.length, 0), 4);
await writeFile("assets/craft.icns", Buffer.concat([icns, ...icnsParts]));
await writeFile("adapters/workbuddy-expert/avatars/craft-work-governance.png", images.get(512)!);
process.stdout.write("generated Craft icon assets\n");
