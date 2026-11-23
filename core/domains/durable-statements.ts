const SECRET = /(?:api[_-]?key|authorization|cookie|password|passwd|secret|token)\s*[:=]\s*[^\s]{6,}/iu;

/** Extract only short, explicit durable rules, facts and user preferences. */
export function extractDurableStatements(prompt: string): { kind: "rule" | "fact" | "preference"; statement: string }[] {
  const results: { kind: "rule" | "fact" | "preference"; statement: string }[] = [];
  const source = prompt.trim();
  // Reject both inline credentials and placeholder tokens before durable capture.
  if (!source || source.length > 1_000 || SECRET.test(source) || source.includes("{{") || source.includes("}}")) return results;
  const sentences = source.split(/(?<=[。！!？?。]\s*)|(?<=[.!?]\s+)/u).map(item => item.trim()).filter(Boolean);
  for (const sentence of sentences) {
    const pref = /^(?:我偏好|我更喜欢|我长期使用|我习惯|I prefer|I usually use|my default is)\s*[:：,，]?\s*(.+)$/iu.exec(sentence);
    if (pref?.[1] && pref[1].trim().length > 2) { results.push({ kind: "preference", statement: sentence }); continue; }
    const rule = /^(?:(?:本项目|这个项目|该项目)(?:的)?(?:约定|规范|默认规则|标准操作)(?:是)?\s*[:：,，]?\s*|(?:我们约定|项目要求|编码规范是|必须|始终|always|must|never|do not|don't)\s*[:：,，]?\s*|(?:以后|今后)(?:在本项目中)?(?:请)?(?:默认)?(?:使用|采用|遵循|保持|优先|避免|不要|总是)\s*[:：,，]?\s*)(.+)$/iu.exec(sentence);
    if (rule?.[1] && rule[1].trim().length > 2) { results.push({ kind: "rule", statement: sentence }); continue; }
    const fact = /^(?:(?:本项目|这个项目|该项目)(?:目前)?(?:默认)?(?:使用|采用|基于|运行在|部署在)\s*[:：,，]?\s*|(?:the project|this project|we use|it uses|default)\s*[:：,，]?\s*)(.+)$/iu.exec(sentence);
    if (fact?.[1] && fact[1].trim().length > 2) { results.push({ kind: "fact", statement: sentence }); continue; }
  }
  return results;
}
