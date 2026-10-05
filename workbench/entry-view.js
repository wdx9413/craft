const escapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeEntry = value => String(value).replace(/[&<>"']/g, char => escapes[char]);
const button = (action, text, extra = '') => `<button type="button" data-entry-action="${action}" ${extra}>${text}</button>`;

/** All supplied content is text, including model output and filenames. No model HTML. */
export function entryView(state) {
  const { current, mode, busy, tasks, models, model, uncertain, error } = state;
  const e = escapeEntry;
  const disabled = busy ? 'disabled' : '';
  const title = current.task ? current.task.title : '从一件事开始';
  const materials = current.materials.map((item, index) => `<div class="entry-material"><span>${e(item.name)}</span>${button('remove', '移除', `data-index="${index}" ${disabled} aria-label="移除 ${e(item.name)}"`)}</div>`).join('');
  const sources = `<section class="entry-sources" aria-label="选定材料"><h2>资料与上下文 <small>${current.materials.length}</small></h2>
    <p class="entry-note">选择只在本页暂存。点击发送后，材料会交给所选模型并进入任务历史；移除不会删除已发送的历史。</p>
    <div class="entry-materials">${materials}</div><label class="entry-file">添加材料<input data-entry-field="files" type="file" accept=".md,.txt,.csv,.json" multiple ${disabled}></label>
    <p class="entry-note">最多 5 份文本材料 · 合计 32 KiB。不会读取其他窗口。</p>
    ${current.materials.map(item => `<details open><summary>${e(item.name)}</summary><pre>${e(item.content)}</pre></details>`).join('')}</section>`;
  const editor = `<section class="entry-document" aria-label="成果草稿"><div class="entry-document-meta">${current.edited ? '本页编辑 · 关闭前请下载' : '模型草稿 · 尚未验收'}${button('download', '下载草稿', !current.draft || busy ? 'disabled' : '')}</div>
    <h1>${e(title)}</h1><label class="entry-label" for="entry-draft">可编辑草稿</label>
    <textarea id="entry-draft" data-entry-field="draft" ${disabled} placeholder="模型回复会显示在这里。你可以直接修改；这不代表文件已写入或任务已验收。">${e(current.draft)}</textarea>
    <p class="entry-note" id="entry-draft-state">${current.edited ? '修改仅保留在当前窗口，请下载保存。' : '可直接修改；手动修改不会自动回写原文件。'}</p>
    ${current.detail ? `<details><summary>已有交付引用 · ${(current.detail.artifacts || []).length}</summary>${(current.detail.artifacts || []).map(item => `<p>${e(item.uri || item.id)}</p>`).join('')}<p class="entry-note">引用不等于已验收成果；到任务详情查看 Evidence 与 Outcome。</p></details>` : ''}</section>`;
  return `<header class="entry-header"><button class="entry-brand" type="button" data-entry-action="launcher">Craft</button>
    ${button('launcher', '想做什么，或继续一件事…', 'class="entry-command" title="Ctrl / Cmd + K"')}
    <nav aria-label="工作视图">${button('companion', '并肩协作', `aria-pressed="${mode === 'companion'}"`)}${button('workspace', '成果桌面', `aria-pressed="${mode === 'workspace'}"`)}${button('legacy', '能力与设置')}</nav></header>
    <div class="entry-layout"><aside class="entry-rail"><h2>正在推进</h2>${button('fresh', '新建任务', disabled)}
    <div class="entry-task-list">${tasks.map(task => button('task', e(task.title), `data-task="${e(task.id)}" ${disabled} aria-current="${Boolean(current.task && current.task.id === task.id)}"`)).join('') || '<p class="entry-note">暂无任务。从一句意图开始。</p>'}</div>
    <p class="entry-note">显示最近 50 个任务</p><div class="entry-rail-foot">${button('approvals', '需要你确认')}${button('legacy', '能力与设置')}${button('detail', '任务详情', current.task ? '' : 'disabled')}</div></aside>
    <main class="entry-main"><div class="entry-status" role="status" aria-live="polite">${busy ? '正在处理，请勿重复提交…' : '同一任务 · 三种视图 · 权限不随视图变化'}</div>
    <div class="entry-error" role="alert">${e(error)}${uncertain ? '<p>提交结果未知，已停止重发。刷新不能确认该次操作是否结束；请到任务详情人工核对，不要重复提交同一请求。</p>' : ''}</div>
    <div class="entry-panels">${mode === 'launcher' ? `<section class="entry-launch"><p class="entry-eyebrow">CRAFT / 统一入口</p><h1>把这件事，往前推进。</h1><p class="entry-note">从明确的材料开始，在协作和成果之间自由切换。</p>${sources}<section class="entry-recent"><h2>继续最近的任务</h2>${tasks.slice(0, 3).map(task => button('task', e(task.title), `data-task="${e(task.id)}" ${disabled}`)).join('') || '<p class="entry-note">还没有任务，可以先写下你的目标。</p>'}</section></section>` : (mode === 'companion' ? sources : '') + editor}</div>
    <form class="entry-compose" novalidate><label for="entry-intent">${current.task ? '继续当前任务' : '你想完成什么？'}</label><textarea id="entry-intent" data-entry-field="input" ${disabled} placeholder="例如：比较资料中的差异，整理成一页简报">${e(current.input)}</textarea>
    <div class="entry-compose-foot"><label for="entry-model">接收模型</label><select id="entry-model" data-entry-field="model" ${busy || current.task ? 'disabled' : ''}><option value="">请选择模型</option>${models.map(item => `<option value="${e(item.id)}" ${(current.task ? current.task.model_id : model) === item.id ? 'selected' : ''}>${e(item.name || item.id)}</option>`).join('')}</select>
    ${button('refresh', '刷新任务', disabled)}<button class="entry-primary" type="submit" ${busy || uncertain || !models.length ? 'disabled' : ''}>${current.task ? '继续整理' : '开始整理'}</button></div>
    <p class="entry-note">${models.length ? '本次为模型对话，不执行文件或外部操作。调用可能产生模型费用。' : '尚无可用模型。请到「能力与设置」配置；不会自动选择付费服务。'}</p></form></main></div>`;
}
