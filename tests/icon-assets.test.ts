import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

function iconFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return ["node_modules", "dist", ".git"].includes(entry.name) ? [] : iconFiles(full);
    return entry.name === "craft-icon.svg" ? [full] : [];
  });
}

test("所有 craft-icon.svg 都是纯 SVG 有界回路，不再有大写 C 圆弧或内嵌位图", () => {
  const files = iconFiles(root);
  assert.ok(files.length >= 5, `expected multiple icon copies, found ${files.length}`);
  for (const file of files) {
    const svg = readFileSync(file, "utf8");
    assert.match(svg, /有界回路/u, file);
    assert.match(svg, /viewBox="0 0 256 256"/u, file);
    assert.doesNotMatch(svg, /M194 72c-17|M174 65a78|base64|<image/u, `${file} 仍是旧 C 图标`);
    assert.ok(statSync(file).size < 2_000, `${file} 不应是内嵌位图`);
  }
  const hashes = new Set(files.map((file) => readFileSync(file, "utf8")));
  assert.equal(hashes.size, 1, "所有插件图标应完全一致");
});
