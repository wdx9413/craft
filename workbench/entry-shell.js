import { createEntrySession } from './entry-session.js';
import { entryView } from './entry-view.js';

/** Thin DOM adapter. UI state never grants Host or Capability authority. */
export function mountEntry({ root, legacy, api, window, navigate, resize }) {
  const session = createEntrySession(api);
  const { state } = session;
  function render() {
    root.dataset.mode = state.mode;
    // entryView escapes every supplied field; never render Host-provided HTML.
    root.innerHTML = entryView(state);
    window.document.title = 'Craft · ' + ({ launcher: '快捷入口', companion: '并肩协作', workspace: '成果桌面' })[state.mode];
  }
  async function perform(operation) {
    state.error = '';
    try { const result = operation(); render(); await result; }
    catch (error) { state.error = String(error.message || error); }
    render();
  }
  async function show(mode) {
    session.mode(mode);
    root.hidden = false;
    legacy.hidden = true;
    render();
    try { await resize(mode); }
    catch (error) { state.error = '窗口调整失败：' + String(error); render(); }
    root.querySelector('#entry-intent').focus();
  }
  function leave(page) {
    root.hidden = true;
    legacy.hidden = false;
    navigate(page, state.current.task);
  }
  function download() {
    const url = window.URL.createObjectURL(new window.Blob([state.current.draft], { type: 'text/markdown;charset=utf-8' }));
    const link = window.document.createElement('a');
    link.href = url;
    link.download = 'craft-draft.md';
    link.click();
    window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
  }
  const actions = {
    launcher: () => show('launcher'), companion: () => show('companion'), workspace: () => show('workspace'),
    fresh: async () => { session.fresh(); await show('launcher'); },
    task: async node => { await session.open(node.dataset.task); await show('workspace'); },
    remove: node => session.remove(Number(node.dataset.index)),
    refresh: async () => { await session.refresh(); if (state.current.task) await session.open(state.current.task.id); },
    download, legacy: () => leave('settings'), approvals: () => leave('approvals'), detail: () => leave('task'),
  };
  root.onclick = event => {
    const node = event.target.closest('[data-entry-action]');
    if (node && !node.disabled && actions[node.dataset.entryAction]) void perform(() => actions[node.dataset.entryAction](node));
  };
  root.oninput = event => {
    const field = event.target.dataset.entryField;
    if (field === 'input') session.input(event.target.value);
    if (field === 'draft') {
      session.draft(event.target.value);
      root.querySelector('#entry-draft-state').textContent = '修改仅保留在当前窗口，请下载保存。';
    }
  };
  root.onchange = event => {
    if (event.target.dataset.entryField === 'model') session.model(event.target.value);
    if (event.target.dataset.entryField === 'files') void perform(() => session.add(Array.from(event.target.files)));
  };
  root.onsubmit = event => {
    event.preventDefault();
    void perform(async () => { await session.send(); await show('workspace'); });
  };
  function shortcut(event) {
    if (event.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault(); event.stopImmediatePropagation(); void show('launcher');
    } else if (event.key === 'Escape' && !root.hidden && state.mode === 'launcher') {
      event.preventDefault(); event.stopImmediatePropagation(); void show('workspace');
    }
  }
  window.document.addEventListener('keydown', shortcut, true);
  window.addEventListener('beforeunload', event => {
    if (session.hasLocalChanges()) { event.preventDefault(); event.returnValue = ''; }
  });
  render();
  return { show, session, ready: perform(() => session.refresh()) };
}
