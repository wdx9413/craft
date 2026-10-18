/** Verify the concrete declaration spelling used by one indexed symbol. */
export function sourceContainsSymbolName(name: string, source: string): boolean {
  if (source.includes(name)) return true;
  const goMethod = /^\(\*?([A-Za-z_]\w*)\)\.([A-Za-z_]\w*)$/u.exec(name);
  if (!goMethod) return false;
  const [, receiver, method] = goMethod;
  return new RegExp(String.raw`\bfunc\s*\(\s*[A-Za-z_]\w*\s+\*?${receiver}\s*\)\s*${method}\s*\(`, "u").test(source);
}
