import assert from "node:assert/strict";
import test from "node:test";
import { skillVersionNotAhead } from "../scripts/ci/skill-release-compatibility.ts";

test("an unchanged Skill can retain an older version within the same major release", () => {
  for (const [skill, runtime, expected] of [
    ["0.12.118", "0.12.119", true], ["0.12.119", "0.12.119", true], ["0.11.99", "0.12.0", true],
    ["0.12.120", "0.12.119", false], ["0.13.0", "0.12.119", false], ["1.0.0", "0.12.119", false],
    ["bad", "0.12.119", false], ["0.12.118", "bad", false], ["99999999999999999999.1.1", "0.12.119", false],
    ["0.1.0", "99999999999999999999.1.1", false],
  ] as const) assert.equal(skillVersionNotAhead(skill, runtime), expected, `${skill} vs ${runtime}`);
});
