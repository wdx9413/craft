/**
 * Coordinator: turn one user intent into a concrete working directory.
 *
 * The Navigator (领航) is a "只说目标" surface: the user never picks a folder,
 * so the Coordinator has to. NEEDREAD.md puts the same three duties in one
 * place — parse the intent, match an engineering directory, and check for
 * conflicting historical tasks — and this module owns the two that are
 * decidable without a model.
 *
 * Matching is deterministic on purpose. A wrong directory silently executes
 * code in the wrong project, so a candidate is only auto-bound when the
 * evidence is explicit (a path, a directory name) or unambiguous (a stored
 * semantic description). Otherwise the Coordinator reports the candidates and
 * lets the person choose.
 */

/** A working directory the Coordinator may bind a task to. */
export interface CoordinatorDirectory {
  /** The registered workspace, when this directory is already a known workspace. */
  workspace_id: string | null;
  name: string;
  root_path: string;
  /** A human description of what lives here, from the `craft-file-dir-desc` registry. */
  description: string | null;
}

export interface CoordinatorDirectoryScore {
  workspace_id: string | null;
  name: string;
  root_path: string;
  score: number;
  reason: string;
}

export interface CoordinatorDirectoryResolution {
  /** The directory to bind, or null when nothing is conclusive enough to bind. */
  root_path: string | null;
  workspace_id: string | null;
  confidence: number;
  reason: string;
  /** True when two candidates are equally good, so a person must choose. */
  ambiguous: boolean;
  candidates: CoordinatorDirectoryScore[];
}

/** Minimum score before a directory is bound without asking. */
export const COORDINATOR_DIRECTORY_THRESHOLD = 55;

/** Minimum similarity before a historical task counts as a conflict. */
export const COORDINATOR_CONFLICT_SIMILARITY = 0.4;

export interface CoordinatorTaskConflict {
  task_id: string;
  title: string;
  goal: string;
  status: string;
  similarity: number;
}

const TASK_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "closed", "abandoned"]);

function normalized(value: string): string {
  return value.toLowerCase().replace(/\\/gu, "/").replace(/\s+/gu, " ").trim();
}

function basenameOf(rootPath: string): string {
  const parts = normalized(rootPath).split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : "";
}

/**
 * Split text into comparison tokens: Latin words plus CJK bigrams, so a
 * Chinese intent still compares against a Chinese description.
 */
export function coordinatorTokens(value: string): Set<string> {
  const text = value.toLowerCase();
  const tokens = new Set<string>();
  for (const match of text.matchAll(/[a-z0-9_]+/gu)) {
    if (match[0].length >= 2) tokens.add(match[0]);
  }
  for (const match of text.matchAll(/[\u3400-\u9fff]+/gu)) {
    const run = match[0];
    if (run.length === 1) { tokens.add(run); continue; }
    for (let index = 0; index + 1 < run.length; index += 1) tokens.add(run.slice(index, index + 2));
  }
  return tokens;
}

/** Jaccard overlap of two token sets; two empty inputs are not similar. */
export function coordinatorSimilarity(left: string, right: string): number {
  const a = coordinatorTokens(left);
  const b = coordinatorTokens(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  const union = a.size + b.size - shared;
  return union ? shared / union : 0;
}

/** The share of the description's terms the intent mentions, and how many. */
function descriptionCoverage(description: string, intent: string): { fraction: number; matched: number } {
  const terms = description.toLowerCase().split(/\s+/u).filter(Boolean);
  if (!terms.length) return { fraction: 0, matched: 0 };
  const haystack = normalized(intent);
  const matched = terms.filter((term) => haystack.includes(term)).length;
  return { fraction: matched / terms.length, matched };
}

/**
 * Score every directory against the intent. The tiers are deliberately
 * separated: a path beats a directory name, and a directory name beats a
 * semantic description, because each is weaker evidence than the one above.
 * Within the name tier a longer name wins, so "craft-workbench" is not
 * confused with the shorter "craft" that happens to sit inside it.
 */
export function scoreCoordinatorDirectories(intent: string, directories: readonly CoordinatorDirectory[]): CoordinatorDirectoryScore[] {
  const text = normalized(intent);
  const scored: CoordinatorDirectoryScore[] = [];
  for (const directory of directories) {
    const root = normalized(directory.root_path);
    let score = 0;
    let reason = "没有提到这个目录";
    if (root && text.includes(root)) {
      score = 100;
      reason = "意图里直接写了目录路径";
    } else {
      const base = basenameOf(directory.root_path);
      if (base.length >= 2 && text.includes(base)) {
        // Longer names are more specific evidence, so they outrank shorter ones.
        score = 70 + Math.min(base.length, 30) / 30 * 10;
        reason = "意图里提到了目录名";
      } else if (directory.name && directory.name !== base && directory.name.length >= 2 && text.includes(normalized(directory.name))) {
        // A registered workspace often has a human name ("billing-service")
        // that differs from its on-disk folder (a temp or hash-like path).
        // People say the project name, not the folder name; without this tier
        // the Navigator would ask them to pick a folder for work it can place.
        score = 72 + Math.min(directory.name.length, 30) / 30 * 8;
        reason = "意图里提到了项目名";
      } else if (directory.description) {
        const coverage = descriptionCoverage(directory.description, intent);
        // A description only counts when most of its terms are present, so one
        // shared generic word cannot point the work at the wrong project.
        if (coverage.matched > 0 && coverage.fraction >= 0.6) {
          score = 50 + coverage.fraction * 10;
          reason = `意图和目录描述吻合（${coverage.matched} 个词命中）`;
        }
      }
    }
    scored.push({ workspace_id: directory.workspace_id, name: directory.name, root_path: directory.root_path, score, reason });
  }
  return scored.sort((left, right) => right.score - left.score || right.root_path.length - left.root_path.length ||
    left.root_path.localeCompare(right.root_path));
}

/**
 * Resolve one directory for an intent, or report that a person must choose.
 *
 * Two candidates of equal score and equal specificity are ambiguous: binding
 * either one would be a guess about where code runs.
 */
export function resolveCoordinatorDirectory(intent: string, directories: readonly CoordinatorDirectory[]): CoordinatorDirectoryResolution {
  const candidates = scoreCoordinatorDirectories(intent, directories);
  const best = candidates[0];
  if (!best || best.score < COORDINATOR_DIRECTORY_THRESHOLD) {
    return { root_path: null, workspace_id: null, confidence: 0,
      reason: best && best.score > 0 ? "没有足够把握的目录，需要你选一个" : "意图里没有提到任何已知目录",
      ambiguous: false, candidates };
  }
  const second = candidates[1];
  const tied = !!second && second.score === best.score && second.root_path.length === best.root_path.length;
  if (tied) {
    return { root_path: null, workspace_id: null, confidence: best.score / 100,
      reason: "有多个同样可能的目录，需要你选一个", ambiguous: true, candidates };
  }
  return { root_path: best.root_path, workspace_id: best.workspace_id, confidence: best.score / 100,
    reason: best.reason, ambiguous: false, candidates };
}

/**
 * Find historical tasks that already cover the same goal.
 *
 * The Navigator is allowed to be wrong about what is new work, but it must not
 * be silent about it: a second copy of a running task wastes a Worker and
 * splits the evidence.
 */
export function detectCoordinatorConflicts(goals: readonly string[], tasks: readonly {
  id: string;
  title: string;
  goal: string;
  status: string;
}[]): CoordinatorTaskConflict[] {
  const conflicts: CoordinatorTaskConflict[] = [];
  for (const goal of goals) {
    if (!goal.trim()) continue;
    for (const task of tasks) {
      if (TASK_TERMINAL_STATUSES.has(task.status)) continue;
      const similarity = coordinatorSimilarity(goal, `${task.title} ${task.goal}`);
      if (similarity < COORDINATOR_CONFLICT_SIMILARITY) continue;
      conflicts.push({ task_id: task.id, title: task.title, goal: task.goal, status: task.status, similarity });
    }
  }
  return conflicts.sort((left, right) => right.similarity - left.similarity || left.task_id.localeCompare(right.task_id));
}
