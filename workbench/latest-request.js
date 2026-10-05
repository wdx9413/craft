/** One render generation covers its page, project and task, including repeated refreshes. */
export function createLatestRequest() {
  let generation = 0;
  return async function run(load, commit, fail) {
    const revision = ++generation;
    const ticket = { current: () => revision === generation };
    try {
      const result = await load(ticket);
      if (ticket.current()) commit(result);
    } catch (error) {
      if (ticket.current()) fail(error);
    }
  };
}
