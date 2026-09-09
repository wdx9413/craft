import { createHash } from "node:crypto";
import type { JsonObject } from "./store.ts";
import { SecurityBrokerKernel } from "./security.ts";

const MAX_CONTENT_BYTES = 1024 * 1024;

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value;
}

function requiredObject(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}

function jsonPointer(root: unknown, pointer: string): unknown {
  if (!pointer.startsWith("/")) throw new Error("JSON selectors must be RFC 6901 pointers beginning with /");
  let value = root;
  for (const encoded of pointer.slice(1).split("/")) {
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (["__proto__", "prototype", "constructor"].includes(segment)) throw new Error("Unsafe JSON selector segment");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, segment)) throw new Error(`JSON selector not found: ${pointer}`);
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function textLine(raw: string, selector: string): string {
  const match = /^line:([1-9][0-9]*)$/u.exec(selector);
  if (!match) throw new Error("Text selectors must use line:N with a one-based line number");
  const line = raw.split(/\r?\n/u)[Number(match[1]) - 1];
  if (line === undefined) throw new Error(`Text selector not found: ${selector}`);
  return line.trim();
}

const SIGNAL_RULES: Array<[string, RegExp]> = [
    ["instruction_override", /(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions?|prompts?)/iu],
    ["prompt_boundary_impersonation", /(?:system|developer)\s+(?:prompt|message|instruction)/iu],
    ["secret_exfiltration_request", /(?:reveal|send|print|exfiltrate)\s+(?:the\s+)?(?:secret|token|password|api[_ -]?key)/iu],
    ["tool_execution_request", /(?:call|execute|run)\s+(?:the\s+)?(?:tool|command|shell)/iu],
    ["instruction_override_zh", /忽略.{0,12}(?:之前|以上|原有).{0,8}指令/u],
    ["secret_exfiltration_request_zh", /(?:泄露|发送|输出).{0,12}(?:密钥|密码|令牌)/u],
];
function instructionSignals(raw: string): string[] {
  return SIGNAL_RULES.filter(([, rule]) => rule.test(raw)).map(([name]) => name);
}

function extractFields(raw: string, format: string, selectors: JsonObject): JsonObject {
  let parsed: unknown = raw;
  if (format === "json") {
    try { parsed = JSON.parse(raw) as unknown; } catch { throw new Error("raw_content is not valid JSON"); }
  }
  const structuredData: JsonObject = {};
  for (const [field, selectorValue] of Object.entries(selectors)) {
    if (!/^[a-zA-Z0-9_-]+$/u.test(field)) throw new Error("selector field names may contain only letters, numbers, _ or -");
    const selector = requiredText(selectorValue, `selectors.${field}`).trim();
    structuredData[field] = format === "json" ? jsonPointer(parsed, selector) : textLine(raw, selector);
  }
  return structuredData;
}

export function analyzeUntrustedContent(raw: string, requestedFormat: unknown, requestedSelectors: unknown): JsonObject {
  const parserFormat = format(requestedFormat); const parserSelectors = selectors(requestedSelectors);
  return { format: parserFormat, selectors: parserSelectors,
    structured_data: extractFields(raw, parserFormat, parserSelectors), detected_instructions: instructionSignals(raw) };
}

function format(value: unknown): string {
  const result = requiredText(value, "format").trim();
  if (!new Set(["json", "text"]).has(result)) throw new Error("format must be json or text");
  return result;
}

function selectors(value: unknown): JsonObject {
  const result = requiredObject(value, "selectors");
  if (!Object.keys(result).length) throw new Error("selectors must not be empty");
  return result;
}

export class DataOnlyParserAdapter {
  readonly security: SecurityBrokerKernel;
  constructor(security: SecurityBrokerKernel) { this.security = security; }

  parse(args: JsonObject): JsonObject {
    const contentId = requiredText(args.content_id, "content_id").trim();
    const raw = requiredText(args.raw_content, "raw_content");
    if (Buffer.byteLength(raw, "utf8") > MAX_CONTENT_BYTES) throw new Error("raw_content exceeds the 1 MiB parser limit");
    const analysis = analyzeUntrustedContent(raw, args.format, args.selectors);
    const parserFormat = String(analysis.format); const parserSelectors = analysis.selectors as JsonObject;
    const content = this.security.store.get("untrusted_content", contentId);
    const actualDigest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
    if (content.content_digest !== actualDigest) throw new Error("raw_content digest does not match the registered content envelope");
    const structuredData = analysis.structured_data as JsonObject; const fieldSources: JsonObject = {};
    for (const [field, selectorValue] of Object.entries(parserSelectors)) {
      const selector = String(selectorValue).trim();
      fieldSources[field] = { selector, citations: [`content:${contentId}${selector}`] };
    }
    return this.security.extractionRecord({ content_id: contentId, extraction_id: args.extraction_id,
      extractor: `craft-data-only-${parserFormat}-v1`, schema_id: requiredText(args.schema_id, "schema_id").trim(),
      structured_data: structuredData, field_sources: fieldSources, detected_instructions: analysis.detected_instructions,
      citations: [`content:${contentId}`] });
  }

  evaluate(args: JsonObject): JsonObject {
    const cases = args.cases;
    if (!Array.isArray(cases) || !cases.length || cases.length > 100) throw new Error("cases must contain between 1 and 100 cases");
    let truePositive = 0; let falsePositive = 0; let falseNegative = 0; let extractionPassed = 0;
    const results = cases.map((rawCase, index) => {
      const item = requiredObject(rawCase, `cases[${index}]`); const caseId = requiredText(item.case_id, `cases[${index}].case_id`).trim();
      const raw = requiredText(item.raw_content, `cases[${index}].raw_content`);
      if (Buffer.byteLength(raw, "utf8") > MAX_CONTENT_BYTES) throw new Error(`cases[${index}].raw_content exceeds the 1 MiB parser limit`);
      const expected = item.expected_signals;
      if (!Array.isArray(expected) || expected.some((signal) => typeof signal !== "string")) throw new Error(`cases[${index}].expected_signals must be a string array`);
      const expectedSet = new Set(expected as string[]); const actual = instructionSignals(raw); const actualSet = new Set(actual);
      if (expectedSet.size !== expected.length || [...expectedSet].some((signal) => !SIGNAL_RULES.some(([name]) => name === signal))) {
        throw new Error(`cases[${index}].expected_signals must contain unique supported signal names`);
      }
      truePositive += actual.filter((signal) => expectedSet.has(signal)).length;
      falsePositive += actual.filter((signal) => !expectedSet.has(signal)).length;
      falseNegative += [...expectedSet].filter((signal) => !actualSet.has(signal)).length;
      const extracted = extractFields(raw, format(item.format), selectors(item.selectors));
      const expectedData = requiredObject(item.expected_data, `cases[${index}].expected_data`);
      const extractionMatch = JSON.stringify(extracted) === JSON.stringify(expectedData);
      if (extractionMatch) extractionPassed += 1;
      return { case_id: caseId, content_digest: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
        actual_signals: actual, expected_signals: [...expectedSet], extraction_match: extractionMatch };
    });
    if (new Set(results.map((result) => result.case_id)).size !== results.length) throw new Error("case_id values must be unique");
    const precision = truePositive + falsePositive === 0 ? 1 : truePositive / (truePositive + falsePositive);
    const recall = truePositive + falseNegative === 0 ? 1 : truePositive / (truePositive + falseNegative);
    const suiteDigest = createHash("sha256").update(JSON.stringify(cases)).digest("hex");
    const suiteVersion = Number(args.suite_version);
    if (!Number.isInteger(suiteVersion) || suiteVersion < 1) throw new Error("suite_version must be a positive integer");
    const evaluation = this.security.store.create("parser_security_evaluation",
      requiredText(args.evaluation_id, "evaluation_id").trim(), { suite_id: requiredText(args.suite_id, "suite_id").trim(),
        suite_version: suiteVersion, suite_digest: suiteDigest, parser_version: "craft-data-only-v1",
        total: results.length, verdict: falsePositive === 0 && falseNegative === 0 && extractionPassed === results.length ? "passed" : "failed",
        metrics: { signal_precision: precision, signal_recall: recall, extraction_accuracy: extractionPassed / results.length,
          true_positive: truePositive, false_positive: falsePositive, false_negative: falseNegative }, results });
    return { evaluation };
  }
}
