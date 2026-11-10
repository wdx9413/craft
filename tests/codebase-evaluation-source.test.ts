import assert from "node:assert/strict";
import test from "node:test";
import { sourceContainsSymbolName } from "../scripts/eval/codebase-evaluation-source.ts";

test("source verification accepts exact symbols and Go receiver-method declarations", () => {
  assert.equal(sourceContainsSymbolName("analyzeTypeScript", "export function analyzeTypeScript() {}"), true);
  assert.equal(sourceContainsSymbolName("(*VisitCountService).SyncVisitCount",
    "func (v *VisitCountService) SyncVisitCount(ctx context.Context) error { return nil }"), true);
  assert.equal(sourceContainsSymbolName("(VisitCountService).SyncVisitCount",
    "func (v VisitCountService) SyncVisitCount() error { return nil }"), true);
  assert.equal(sourceContainsSymbolName("(*VisitCountService).SyncVisitCount",
    "func (v *OtherService) SyncVisitCount() error { return nil }"), false);
  assert.equal(sourceContainsSymbolName("(*VisitCountService).SyncVisitCount",
    "var SyncVisitCount = func() {}"), false);
  assert.equal(sourceContainsSymbolName("not-a-go-method", "func (v *VisitCountService) SyncVisitCount() {}"), false);
});
