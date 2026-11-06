import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const CURRENT_RELEASE_VERSION = (JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")) as { version: string }).version;

export function assertCurrentReleaseVersion(value: unknown): void {
  assert.equal(value, CURRENT_RELEASE_VERSION);
}
