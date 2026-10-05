/** Folder identities are opaque strings, never properties on a JavaScript object. */
export function groupByFolder(projects, tasks) {
  const groups = new Map();
  for (const project of projects) {
    const key = String(project.project_id || '');
    if (key && !groups.has(key)) groups.set(key, { key, name: project.name || key, known: true, tasks: [] });
  }
  for (const task of tasks) {
    const key = task.project_id ? String(task.project_id) : '';
    if (!groups.has(key)) groups.set(key, { key, name: key || '默认', known: false, tasks: [] });
    groups.get(key).tasks.push(task);
  }
  return [...groups.values()].sort((a, b) => (a.key === '') - (b.key === ''));
}

/** One immutable selection drives the list and detail requests; no global view state. */
export function createProjectPage(api, taskLimit) {
  return async function load(selected) {
    const [projectResult, taskResult] = await Promise.all([
      api('/api/projects?limit=200').catch(() => ({ projects: [] })),
      api('/api/home?limit=' + taskLimit)
    ]);
    const groups = groupByFolder(projectResult.projects || [], taskResult.tasks || []);
    const selectedGroup = groups.find((group) => group.key === selected) || null;
    const snapshot = selectedGroup && selectedGroup.known
      ? await api('/api/projects/' + encodeURIComponent(selectedGroup.key)) : null;
    return { groups, selectedGroup, snapshot };
  };
}
