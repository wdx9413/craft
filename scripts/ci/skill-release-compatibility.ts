/** An unchanged Skill may retain its own version when the Runtime advances. */
export function skillVersionNotAhead(skill: string, runtime: string): boolean {
  const parse = (value: string): number[] | null => /^\d+\.\d+\.\d+$/u.test(value) ? value.split(".").map(Number) : null;
  const a = parse(skill), b = parse(runtime);
  if (!a || !b || a.some(value => !Number.isSafeInteger(value)) || b.some(value => !Number.isSafeInteger(value))) return false;
  if (a[0] !== b[0]) return false;
  return a[1]! < b[1]! || a[1] === b[1] && a[2]! <= b[2]!;
}
