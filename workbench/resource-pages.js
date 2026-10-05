/** Resource pages own rendering and DOM actions; shell owns navigation and editors. */
export function createResourcePages({ api, presentation, editors, refresh, notify, fail }) {
  const { icon, esc, head, emptyState, asideBlock, catalogRows, countChip, label, STATUS_LABELS, shortTime } = presentation;
  const { memory: openMemoryEditor, workflow: openWorkflowEditor } = editors;
  const paint = refresh, toast = notify;
  function viewMemory() {
    return api('/api/workbench/resources?kind=memory&limit=100').then(function (result) {
      var items = result.items || [];
      var rows = items.length ? '<div class="rows">' + items.map(function (item) { return '<div class="row"><span class="row-lead muted">' + icon('db') + '</span><div class="row-main"><span class="row-title">' + esc(item.content || item.id) + '</span><span class="row-sub">' + esc([item.kind, item.scope, item.source].filter(Boolean).join(' · ')) + '</span></div><div class="row-actions"><button class="btn sm" data-memory-edit="' + esc(item.id) + '">编辑</button><button class="btn sm danger" data-memory-retire="' + esc(item.id) + '">停用</button></div></div>'; }).join('') + '</div>' : '';
      return {
        html: '<div class="stack"><div class="card">' + head('记忆', '这是 Craft 已保存且仍有效的本地记忆；可由你手动维护', '<button class="btn primary" id="memory-add" type="button">' + icon('plus') + '添加记忆</button>') +
          '<div class="card-body">' + (rows || emptyState('还没有可展示的记忆', '任务运行并显式保存记忆后，它会以结构化记录出现在这里。', 'db')) + '</div></div></div>',
        aside: asideBlock('记忆范围', '', '<div class="aside-note">编辑不会原地篡改旧记录：Craft 会写入替代版本并保留人工来源。任务页只展示任务自身的短期记忆。</div>'),
        mounts: [function (root) { var add = root.querySelector('#memory-add'); if (add) add.onclick = function () { openMemoryEditor(); }; root.querySelectorAll('[data-memory-edit]').forEach(function (button) { button.onclick = function () { var item = items.filter(function (entry) { return entry.id === button.getAttribute('data-memory-edit'); })[0]; if (item) openMemoryEditor(item); }; }); root.querySelectorAll('[data-memory-retire]').forEach(function (button) { button.onclick = function () { api('/api/workbench/memory/' + encodeURIComponent(button.getAttribute('data-memory-retire')) + '/retire', { method: 'POST', body: {} }).then(function () { toast('记忆已停用'); paint('memory'); }).catch(fail); }; }); }]
      };
    });
  }

  function viewWorkflows() {
    return api('/api/workbench/resources?kind=workflows&limit=100').then(function (result) {
      var workflows = result.workflows || [], runs = result.runs || [];
      var workflowRows = workflows.length ? '<div class="rows">' + workflows.map(function (item) { return '<div class="row"><span class="row-lead muted">' + icon('refresh') + '</span><div class="row-main"><span class="row-title">' + esc(item.name || item.id) + '</span><span class="row-sub">' + esc(item.description || '没有说明') + '</span></div><button class="btn sm" data-workflow-edit="' + esc(item.id) + '">编辑</button></div>'; }).join('') + '</div>' : '';
      return {
        html: '<div class="stack"><div class="card">' + head('工作流', '可复用的步骤编排；可手动编辑为草稿', '<button class="btn primary" id="workflow-add">' + icon('plus') + '新建工作流</button>') + '<div class="card-body">' +
          (workflowRows || emptyState('还没有工作流', '新建一个工作流草稿，或后续从插件导入。', 'refresh')) + '</div></div>' +
          '<div class="card">' + head('工作流运行', '实际运行过的记录', countChip(runs.length)) + '<div class="card-body">' +
          (catalogRows(runs, 'play', function (item) { return item.workflow_id || item.id; }, function (item) { return [label(STATUS_LABELS, item.status, item.status), shortTime(item.updated_at)].filter(Boolean).join(' · '); }) || emptyState('还没有工作流运行', '没有执行记录时不会填充示例数据。', 'play')) + '</div></div></div>',
        aside: asideBlock('运行记录', '', '<div class="aside-note">保存只会生成或更新草稿；运行仍要经过任务权限、审批与观测链路。打开任务可查看相关流程记录。</div>'),
        mounts: [function (root) { var add = root.querySelector('#workflow-add'); if (add) add.onclick = function () { openWorkflowEditor(); }; root.querySelectorAll('[data-workflow-edit]').forEach(function (button) { button.onclick = function () { var workflow = workflows.filter(function (entry) { return entry.id === button.getAttribute('data-workflow-edit'); })[0]; if (workflow) openWorkflowEditor(workflow); }; }); }]
      };
    });
  }

  return { memory: viewMemory, workflows: viewWorkflows };
}
