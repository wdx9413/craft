/** One transport contract for bundled Desktop and browser-hosted Workbench. */
export function createRuntimeClient({ invoke, fetch, token }) {
  function decode(text, status) {
    let data = {};
    if (text) { try { data = JSON.parse(text); } catch { data = { error: text }; } }
    if (status >= 400) throw new Error(data.error || ('HTTP ' + status));
    return data;
  }
  return async function request(path, init = {}) {
    const method = init.method || 'GET';
    if (invoke) {
      const response = await invoke('workbench_request', { method, path, body: init.body === undefined ? '' : JSON.stringify(init.body) });
      return decode(response.body, response.status);
    }
    const headers = { authorization: 'Bearer ' + token() };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(path, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    return decode(await response.text(), response.status);
  };
}
