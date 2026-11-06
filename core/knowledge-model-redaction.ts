const SENSITIVE_MODEL_TEXT_PATTERNS = [
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/giu,
  /\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/giu,
  /\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password|passwd|secret|token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16})\b/giu,
  /\bhttps?:\/\/[^\s<>"']+/giu,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu,
  /\b(?:[A-F0-9]{1,4}:){2,7}[A-F0-9]{1,4}\b|\b(?:[A-F0-9]{1,4}:){1,7}:|\B:(?::[A-F0-9]{1,4}){1,7}\b/giu,
  /(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+(?:\/[^\s<>"']*)?/gu,
  /\b[A-Z]:\\Users\\[^\\/\s<>"']+(?:\\[^\s<>"']*)?/giu,
];

/** Redact credentials and common personal identifiers before model dispatch. */
export function redactKnowledgeModelText(value: unknown): unknown {
  if (typeof value === "string") return SENSITIVE_MODEL_TEXT_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), value);
  if (Array.isArray(value)) return value.map(redactKnowledgeModelText);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactKnowledgeModelText(item)]));
  return value;
}
