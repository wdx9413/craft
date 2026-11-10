import assert from "node:assert/strict";
import test from "node:test";
import { EXPERIENCE_COMPONENT, EXPERIENCE_OWNS } from "../capability/craft-experience/ownership.ts";

test("experience ownership claims the conclusion deduplication family", () => {
  for (const owned of [
    "craft_experience_conclusion_record", "craft_experience_conclusion_find", "craft_experience_conclusion_refuted",
  ]) assert(EXPERIENCE_OWNS.test(owned), `${owned} must be owned by experience`);
  assert(EXPERIENCE_COMPONENT.test("craft_experience_conclusion_record"), "the component surface exposes the same family");
  for (const foreign of ["craft_experience_mine", "craft_experience_pattern_list", "craft_experience_capture_decide"]) {
    assert(!EXPERIENCE_OWNS.test(foreign), `${foreign} must not be owned by experience`);
  }
});
