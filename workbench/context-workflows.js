/** Scoped receipt browsing and a resumable interview; no model or execution authority. */
export function createContextWorkflowPages({ api, esc, fail }) {
  const frame = (title, body) => '<div class="card"><div class="card-body stack"><h2>' + title + '</h2>' + body + '</div></div>';
  const scopeField = '<div class="field"><label for="context-scope">范围（例如 project:项目路径）</label><input type="text" id="context-scope" name="scope" required placeholder="project:/path/to/project"></div>';
  function usage() {
    return Promise.resolve({ html: frame('上下文使用与依据', '<p class="doc-p">查看指定范围内已提供给 Agent 的上下文。提供记录不代表模型已遵循，也不代表任务成功。</p><form id="usage-query" class="stack">' + scopeField + '<button class="btn primary">查看记录</button></form><div id="usage-results" aria-live="polite"></div>'), aside: '', mounts: [root => {
      let generation = 0;
      root.querySelector('#usage-query').onsubmit = async event => {
        event.preventDefault(); const ticket = ++generation;
        const scope = event.target.elements.scope.value, colon = scope.indexOf(':');
        const target = root.querySelector('#usage-results'); target.textContent = '正在读取…';
        try {
          if (colon < 1 || !scope.slice(colon + 1).trim()) throw new Error('请填写明确范围，如 project:/path/to/project');
          const result = await api('/api/workbench/context-usage?scope_kind=' + encodeURIComponent(scope.slice(0, colon)) + '&scope_id=' + encodeURIComponent(scope.slice(colon + 1)));
          if (ticket !== generation) return;
          const retireTargets = [];
          target.innerHTML = '<p>停用只影响后续召回，已有任务和外部动作不会被撤销。</p><p>' + result.count + ' 条可见记录' + (result.truncated ? '（仅显示前 100 条）' : '') + '</p>' + result.receipts.map(receipt => '<details class="form-block"><summary>' + esc(receipt.created_at) + ' · ' + (receipt.execution_context ? '已提供上下文' : '历史诊断') + '</summary><p>动作遵循：未知；结果验证：' + (receipt.outcome_verified ? '有程序证据' : '尚无证据') + '</p><p>任务：' + esc(receipt.task_ids.join('、') || '未关联') + '；Host：未记录</p>' +
            receipt.references.map(ref => '<p>' + esc(ref.member + ' · ' + ref.id + ' @' + ref.version) + '<br>摘要：' + esc(ref.digest) + '<br>依据：' + esc(ref.reason) + '<br>当前状态：' + esc(ref.current_status) + '；来源：' + esc(ref.source_id || '未记录') + '；作者：' + esc(ref.author) + ((ref.member === 'knowledge' || ref.member === 'memory') && ['active', 'reviewed'].includes(ref.current_status) ? '<button class="btn sm danger" data-retire="' + (retireTargets.push(ref) - 1) + '">停用</button>' : '') + '</p>').join('') +
            (receipt.legacy_references_incomplete ? '<p>旧回执缺少逐条引用，无法还原完整使用记录。</p>' : '') + '<p>预算遗漏：' + esc(receipt.budget.omitted_count ?? '未记录') + '</p><p>回执：' + esc(receipt.id) + '</p></details>').join('');
          target.querySelectorAll('[data-retire]').forEach(button => { button.onclick = async () => {
            const ref = retireTargets[Number(button.getAttribute('data-retire'))]; button.disabled = true;
            try {
              await api('/api/workbench/context-retire', { method: 'POST', body: { member: ref.member, id: ref.id, expected_version: ref.current_version, scope_kind: scope.slice(0, colon), scope_id: scope.slice(colon + 1) } });
              if (ticket === generation) await root.querySelector('#usage-query').onsubmit(event);
            } catch (error) { if (ticket === generation) { button.disabled = false; fail(error); } }
          } });
        } catch (error) { if (ticket === generation) { target.textContent = '读取未完成，请检查范围或连接后重试。'; fail(error); } }
      };
    }] });
  }
  function designs() {
    return Promise.resolve({ html: frame('梳理重复工作', '<p class="doc-p">逐步写清输入、步骤、验证和失败处置。可随时保存，再交给 Agent 实现。</p><form id="design-scope" class="stack">' + scopeField + '<button class="btn">打开此范围</button></form><div id="design-content" class="stack" aria-live="polite"></div>'), aside: '', mounts: [root => {
      let generation = 0;
      root.querySelector('#design-scope').onsubmit = async event => {
        event.preventDefault(); const ticket = ++generation, scope = event.target.elements.scope.value;
        const target = root.querySelector('#design-content'); target.textContent = '正在读取…';
        try {
          const result = await api('/api/workbench/workflow-designs?scope=' + encodeURIComponent(scope));
          if (ticket !== generation) return;
          target.innerHTML = '<button class="btn primary" id="design-new">开始梳理</button>' + (result.truncated ? '<p>仅显示前 100 份草稿。</p>' : '') + result.designs.map((item, index) => '<button class="btn" data-design="' + index + '">' + esc(item.design.name) + ' · 待确认 ' + item.questions.length + '</button>').join('') + '<div id="design-editor"></div>';
          let editorGeneration = 0;
          const edit = item => {
            const editorTicket = ++editorGeneration;
            const design = item ? item.design : { name: '', answers: {} };
            const editor = target.querySelector('#design-editor');
            const unanswered = result.question_catalog.find(q => !design.answers[q.key]?.trim());
            editor.innerHTML = '<form id="design-form" class="stack"><div class="field"><label for="design-name">名称</label><input type="text" id="design-name" name="name" maxlength="200" required value="' + esc(design.name) + '"></div>' + result.question_catalog.map(q => '<details class="form-block"' + (q === unanswered ? ' open' : '') + '><summary>' + esc(q.question) + '</summary><div class="field"><textarea aria-label="' + esc(q.question) + '" maxlength="8000" data-answer="' + q.key + '">' + esc(design.answers[q.key] || '') + '</textarea></div></details>').join('') + '<button class="btn primary" type="submit">保存进度</button><p id="design-status" role="status"></p></form><div id="design-brief"></div>';
            editor.querySelector('#design-form').onsubmit = async saved => {
              saved.preventDefault(); const button = saved.target.querySelector('button'); button.disabled = true;
              const answers = {}; editor.querySelectorAll('[data-answer]').forEach(field => { answers[field.getAttribute('data-answer')] = field.value; });
              try {
                const next = await api('/api/workbench/workflow-designs', { method: 'POST', body: { scope, name: saved.target.elements.name.value, answers, ...(design.id ? { design_id: design.id, expected_version: design.version } : {}) } });
                if (ticket !== generation || editorTicket !== editorGeneration) return;
                result.designs = result.designs.map(item => item.design.id === next.design.id ? next : item);
                edit(next);
                editor.querySelector('#design-status').textContent = next.questions.length ? '已保存。下一步：' + next.next_question.question : '已保存，待人工复核。尚未执行或验证。';
                const brief = editor.querySelector('#design-brief');
                brief.innerHTML = '<details class="form-block"><summary>交接材料（可复制给 Agent）</summary><textarea readonly class="tall" aria-label="工作流交接材料">' + esc(next.markdown) + '</textarea></details>';
              } catch (error) { if (ticket === generation && editorTicket === editorGeneration) { button.disabled = false; fail(error); } }
            };
          };
          target.querySelector('#design-new').onclick = () => edit(null);
          target.querySelectorAll('[data-design]').forEach(button => { button.onclick = () => edit(result.designs[Number(button.getAttribute('data-design'))]); });
        } catch (error) { if (ticket === generation) { target.textContent = '读取未完成，请重试。'; fail(error); } }
      };
    }] });
  }
  return { usage, designs };
}
