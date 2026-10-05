/** Version browsing is diagnostic; restore always follows the owning component's governance. */
export function createAssetRevisionPage({ api, esc, fail }) {
  return async () => ({ html: '<div class="card"><div class="card-body stack"><h2>版本与使用依据</h2><p>查看内容修订和状态变化，比较后可恢复为待审核内容。代码索引按当前代码快照重建。</p><form id="asset-query" class="stack"><label class="field">子能力<select name="member"><option value="knowledge">Knowledge</option><option value="memory">Memory</option><option value="experience">Experience</option><option value="codebase">Codebase</option></select></label><label class="field">范围<input type="text" name="scope" required placeholder="project:/path/to/project 或 workspace:ID"></label><label class="field">对象 ID<input type="text" name="asset_id" required></label><label class="field">对象类型（选填）<input type="text" name="kind" placeholder="例如 knowledge_source"></label><button class="btn primary">查看版本与依据</button></form><div id="asset-results" aria-live="polite"></div></div></div>', aside: '', mounts: [root => {
    let generation = 0;
    root.querySelector('#asset-query').onsubmit = async event => {
      event.preventDefault(); const ticket = ++generation, fields = event.target.elements, target = root.querySelector('#asset-results'); target.textContent = '正在读取…';
      try {
        const at = fields.scope.value.indexOf(':');
        if (at < 1 || !fields.scope.value.slice(at + 1).trim()) throw new Error('请填写明确范围');
        const args = { member: fields.member.value, asset_id: fields.asset_id.value, scope_kind: fields.scope.value.slice(0, at), scope_id: fields.scope.value.slice(at + 1), ...(fields.kind.value.trim() ? { kind: fields.kind.value.trim() } : {}) };
        const inspect = values => api('/api/workbench/component-assets/inspect', { method: 'POST', body: { ...args, ...values } });
        const history = await inspect({ action: 'history' }), explain = await inspect({ action: 'explain' });
        if (ticket !== generation) return;
        const options = history.versions.map(v => '<option value="' + v.record_version + '">v' + v.record_version + ' · ' + esc(v.state) + ' · ' + esc(v.created_at) + '</option>').join('');
        target.innerHTML = '<p>当前 v' + history.current.record_version + '；状态：' + esc(history.current.state) + (history.has_more ? '。仅显示最近版本，完整历史可通过 MCP 翻页。' : '') + '</p><details><summary>使用依据与状态</summary><pre class="out">' + esc(JSON.stringify(explain, null, 2)) + '</pre></details><form id="asset-compare" class="stack"><label class="field">历史版本<select name="version">' + options + '</select></label><button class="btn">比较当前版本</button></form><div id="asset-diff"></div><form id="asset-restore" class="stack"><label class="field">恢复原因<input type="text" name="reason" required></label><button class="btn">按已比较的版本创建恢复候选</button><p id="asset-status" role="status"></p></form>';
        let selected = null, comparison = 0, restoreRequest = null;
        const restoreForm = target.querySelector('#asset-restore'), restoreButton = restoreForm.querySelector('button'); restoreButton.disabled = true;
        target.querySelector('#asset-compare').onsubmit = async compared => {
          compared.preventDefault(); const check = ++comparison; selected = null; restoreRequest = null; restoreButton.disabled = true;
          try {
            const version = Number(compared.target.elements.version.value), diff = await inspect({ action: 'diff', version, target_version: history.current.record_version });
            if (ticket !== generation || check !== comparison) return;
            target.querySelector('#asset-diff').innerHTML = '<pre class="out">' + esc(JSON.stringify(diff.changes, null, 2)) + '</pre>';
            selected = version; restoreButton.disabled = false;
          } catch (error) { if (ticket === generation && check === comparison) fail(error); }
        };
        restoreForm.onsubmit = async restored => {
          restored.preventDefault(); if (selected === null || restoreButton.disabled) return;
          restoreButton.disabled = true; const check = comparison;
          try {
            const reason = restored.target.elements.reason.value;
            if (!restoreRequest || restoreRequest.reason !== reason) restoreRequest = { reason, request_id: crypto.randomUUID() };
            const result = await api('/api/workbench/component-assets/restore', { method: 'POST', body: { ...args, version: selected, expected_version: history.current.record_version, ...restoreRequest } });
            if (ticket !== generation || check !== comparison) return;
            target.querySelector('#asset-status').textContent = '已创建：' + result.restoration.restored_id + '；' + (result.restoration.activation === 'governed_candidate' ? '待审核，尚未生效。' : '已按当前快照重建。');
          } catch (error) { if (ticket === generation && check === comparison) { restoreButton.disabled = false; fail(error); } }
        };
      } catch (error) { if (ticket === generation) { target.textContent = '读取未完成，请检查对象、范围和连接。'; fail(error); } }
    };
  }] });
}
