/** Local text rules. These are heuristics, not a classifier or a binary-file scanner. */
export interface Rule { name: string; pattern: string; flags?: string; group?: number; enabled?: boolean }
export const DEFAULT_RULES: readonly Rule[] = [
  { name: "phone", pattern: String.raw`(?<!\d)(?:\+?86[ -]?)?1[3-9](?:[ -]?\d){9}(?!\d)` },
  { name: "identity", pattern: String.raw`(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)` },
  { name: "email", pattern: String.raw`[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}`, flags: "i" },
  { name: "ipv4", pattern: String.raw`(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(?![\d.])` },
  { name: "bank", pattern: String.raw`(?<!\d)(?:62|4|5[1-5])\d{14,17}(?!\d)` },
  { name: "api_key", pattern: String.raw`\b(?:api[_-]?(?:key|secret)|access[_-]?token|secret[_-]?key|authorization)\b["']?\s*[:=]\s*["']?(?:Bearer\s+)?([A-Z0-9_./+=~-]{8,})`, flags: "i", group: 1 },
  { name: "password", pattern: String.raw`\b(?:password|passwd|pwd)\b["']?\s*[:=]\s*["']?([^\s"'\x60,;}{]{4,})`, flags: "i", group: 1 },
  { name: "jwt", pattern: String.raw`\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}` },
  { name: "private_key", pattern: String.raw`-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----` },
  { name: "chinese_name", pattern: String.raw`姓名["'\s:：]+([\p{Script=Han}]{2,4})`, flags: "u", group: 1, enabled: false },
];

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export class Sanitizer {
  private readonly rules: Array<{ name: string; regex: RegExp; group: number }>;
  private readonly token: (name: string, value: string) => string;
  count = 0;
  constructor(rules: readonly Rule[], token: (name: string, value: string) => string) {
    this.token = token;
    this.rules = rules.filter(rule => rule.enabled !== false).map(rule => {
      const group = rule.group ?? 0;
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(rule.name) || !rule.pattern || !Number.isInteger(group) || group < 0) throw new Error("Invalid rule");
      return { name: rule.name, regex: new RegExp(rule.pattern, [...new Set(`gd${rule.flags ?? ""}`)].join("")), group };
    });
    if (!this.rules.length) throw new Error("No rules enabled");
  }
  text(text: string): string {
    const protectedRanges = [...text.matchAll(/\[CRAFT_DATASEC_[a-z0-9_]+_[a-f0-9]{32}\]/g)].map(match => [match.index, match.index + match[0].length]);
    const matches: Array<{ start: number; end: number; name: string }> = [];
    for (const rule of this.rules) {
      for (const match of text.matchAll(rule.regex)) {
        const range = match.indices![rule.group];
        if (range && range[0] < range[1]) matches.push({ start: range[0], end: range[1], name: rule.name });
      }
    }
    matches.sort((a, b) => a.start - b.start || b.end - a.end);
    let end = 0, result = "";
    for (const match of matches) {
      if (match.start < end || protectedRanges.some(([start, stop]) => match.start < stop && match.end > start)) continue;
      const value = text.slice(match.start, match.end);
      if (match.name === "email" && !/^[^@]+@[^@]+$/.test(value)) throw new Error("Invalid email rule match");
      const replacement = match.name === "email"
        ? `${value[0]}*@${value.slice(value.indexOf("@") + 1)}`
        : this.token(match.name, value);
      result += text.slice(end, match.start) + replacement;
      end = match.end;
      this.count++;
    }
    return result + text.slice(end);
  }
  value(value: Json, depth = 0): Json {
    if (depth > 64) throw new Error("Result nesting exceeds text redaction limit");
    if (typeof value === "string") return this.text(value);
    if (typeof value === "number") {
      const safe = this.text(String(value));
      return safe === String(value) ? value : safe;
    }
    if (Array.isArray(value)) return value.map(item => this.value(item, depth + 1));
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.text(key), this.value(item, depth + 1)]));
    return value;
  }
}
