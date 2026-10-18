/** Evaluation call graphs exclude test, script, and plugin entry points. */
export function isEvaluationNonProductionPath(path: string): boolean {
  if (/^(?:tests|scripts|plugins)\//u.test(path)) return true;
  const fileName = path.slice(path.lastIndexOf("/") + 1);
  return /(?:^|[._-])(?:test|spec)(?:[._-]|$)/u.test(fileName);
}
