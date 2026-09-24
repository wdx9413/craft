/* Craft Workbench — desktop shell for the Craft runtime.
   Layout borrows from the VS Code family (fixed viewport, activity rail,
   document tabs, context panel, status bar) and from the AI desktop clients
   (Cherry Studio / WorkBuddy) for the information architecture.
   Vanilla JS on purpose: the Workbench server serves this from disk under a
   strict same-origin CSP, so there is no bundler, no CDN and no framework. */
(function () {
  'use strict';

  var THEME_KEY = 'craft.theme';

  var state = {
    page: 'home', token: '',
    selectedProject: null, selectedProvider: null, selectedTier: 'standard',
    selectedTask: null, selectedTaskTitle: '', collapsedFolders: {}, showAllFolders: {}, folderGroups: null,
    counts: {}, settings: null, theme: 'light',
    execution: { mode: '', provider: null, tier: 'standard' },
    pendingSheet: null, modelWizard: null,
    // The rail's task list has two shapes: grouped by folder (the default) or a
    // single flat list ordered by latest update. The rail header carries the
    // switch, so the shape is view state rather than a URL.
    taskView: 'folder',
    // Creating a task is the only moment a folder gets chosen, so the composer
    // owns that choice instead of a modal form that disappears on submit.
    composer: { folder: '', model: '', permission: 'human_approval', caps: [], models: [] },
    // A launch that needs approval can only be approved while its work-loop id
    // is still in hand, so it is parked here for the page that renders it.
    pendingApproval: null,
    // Which object the centre column shows. View state rather than a URL, matching how
    // the other pages keep their selection.
    selectedObject: null,
    asideOpen: {}, capabilitySetupOpen: false
  };

  // ------------------------------------------------------------------ icons

  var ICONS = {
    spark: '<path d="M8 2.6l1.35 3.05L12.4 7l-3.05 1.35L8 11.4 6.65 8.35 3.6 7l3.05-1.35z"/>',
    tasks: '<path d="M2.6 4.6l1.1 1.1 2-2.1"/><path d="M2.6 11.4l1.1 1.1 2-2.1"/><path d="M8.6 4.8h4.8M8.6 11.6h4.8"/>',
    folder: '<path d="M1.9 12.6V3.9h3.4l1.4 1.5h7.4v7.2z"/>',
    alert: '<path d="M8 2.6l5.5 9.6H2.5z"/><path d="M8 6.4v3"/><circle cx="8" cy="11.2" r=".85" fill="currentColor" stroke="none"/>',
    play: '<path d="M5.4 3.4l7 4.6-7 4.6z"/>',
    wallet: '<rect x="1.9" y="4" width="12.2" height="8.6" rx="1.6"/><path d="M1.9 7.1h12.2"/><circle cx="11.5" cy="10" r=".8" fill="currentColor" stroke="none"/>',
    shield: '<path d="M8 2.2l5 1.8v4.2c0 2.7-2.1 4.6-5 5.6-2.9-1-5-2.9-5-5.6V4z"/>',
    plus: '<path d="M8 3.4v9.2M3.4 8h9.2"/>',
    plug: '<path d="M5.6 2.2v2.6M10.4 2.2v2.6"/><path d="M3.6 4.8h8.8v1.9a4.4 4.4 0 0 1-8.8 0z"/><path d="M8 11.1v2.7"/>',
    cpu: '<rect x="4.6" y="4.6" width="6.8" height="6.8" rx="1.4"/><path d="M6.9 2.4v2.2M9.1 2.4v2.2M6.9 11.4v2.2M9.1 11.4v2.2M2.4 6.9h2.2M2.4 9.1h2.2M11.4 6.9h2.2M11.4 9.1h2.2"/>',
    layers: '<path d="M8 2.6l5.4 2.8L8 8.2 2.6 5.4z"/><path d="M2.6 8.9L8 11.7l5.4-2.8"/>',
    check: '<path d="M3 8.4l3.3 3.3L13 4.9"/>',
    refresh: '<path d="M13.2 8a5.2 5.2 0 1 1-1.53-3.68"/><path d="M13.4 2.6v3.4h-3.4"/>',
    inbox: '<path d="M1.9 9.4L4 3.4h8l2.1 6v3.2H1.9z"/><path d="M1.9 9.4h3.3l.7 1.6h4.2l.7-1.6h3.3"/>',
    file: '<path d="M3.4 2.4h5.2l3.9 3.9v7.3H3.4z"/><path d="M8.6 2.4v3.9h3.9"/>',
    settings: '<path d="M3 5.2h10M3 10.8h10"/><circle cx="6.2" cy="5.2" r="1.7"/><circle cx="10" cy="10.8" r="1.7"/>',
    terminal: '<rect x="2.2" y="3" width="11.6" height="10" rx="1.6"/><path d="M5 6.6l1.7 1.7L5 10M8.6 10.2h3"/>',
    arrow: '<path d="M3.2 8h9.2M9 4.6L12.4 8 9 11.4"/>',
    x: '<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>',
    chev: '<path d="M6.4 3.8L10.6 8l-4.2 4.2"/>',
    key: '<circle cx="5.6" cy="8" r="2.6"/><path d="M8.2 8h5.4M11.2 8v2.4M13 8v2"/>',
    server: '<rect x="2.4" y="3" width="11.2" height="4.2" rx="1.3"/><rect x="2.4" y="8.8" width="11.2" height="4.2" rx="1.3"/><path d="M5 5.1h.05M5 10.9h.05"/>',
    db: '<ellipse cx="8" cy="4.4" rx="5" ry="2"/><path d="M3 4.4v7.2c0 1.1 2.24 2 5 2s5-.9 5-2V4.4"/><path d="M3 8c0 1.1 2.24 2 5 2s5-.9 5-2"/>',
    dot: '<circle cx="8" cy="8" r="3.2"/>',
    sun: '<circle cx="8" cy="8" r="3.1"/><path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.15 1.15M11.35 11.35l1.15 1.15M12.5 3.5l-1.15 1.15M4.65 11.35L3.5 12.5"/>',
    moon: '<path d="M13 9.4A5.4 5.4 0 0 1 6.6 3 5.4 5.4 0 1 0 13 9.4z"/>',
    search: '<circle cx="7.2" cy="7.2" r="4.2"/><path d="M10.4 10.4l3 3"/>',
    sliders: '<path d="M3 5.2h10M3 10.8h10"/><circle cx="6.2" cy="5.2" r="1.7"/><circle cx="10" cy="10.8" r="1.7"/>'
  };

  function icon(name, cls) {
    return '<svg class="ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (ICONS[name] || ICONS.dot) + '</svg>';
  }

  // ---------------------------------------------------------------- utilities

  var ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function esc(value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, function (c) { return ESCAPES[c]; });
  }

  function $(id) { return document.getElementById(id); }
  function val(id) { var node = $(id); return node ? String(node.value || '').trim() : ''; }
  function checked(id) { var node = $(id); return node ? node.checked === true : false; }

  function lines(id) {
    var node = $(id);
    if (!node) return [];
    return String(node.value || '').split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean);
  }

  function pill(text, tone) {
    return '<span class="pill' + (tone ? ' ' + tone : '') + '">' + esc(text) + '</span>';
  }

  function shortTime(value) {
    if (!value) return '';
    var parsed = Date.parse(value);
    if (isNaN(parsed)) return esc(value);
    return new Date(parsed).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  var TONE = { completed: 'ok', passed: 'ok', approved: 'ok', active: 'info', issued: 'info', open: 'info',
    awaiting_approval: 'warn', pending: 'warn', needs_replan: 'warn', degraded: 'warn', unknown: '',
    discovered: 'warn', failed: 'danger', denied: 'danger', cancelled: 'danger', unhealthy: 'danger', revoked: 'danger' };

  // The backend speaks in short English enum values. Users should never have to
  // read them, so every enum that reaches the screen is translated here.
  var STATUS_LABELS = {
    completed: '已完成', passed: '通过', active: '进行中', issued: '已发出', open: '待处理',
    awaiting_approval: '等你确认', pending: '等待中', needs_replan: '需要重新规划', degraded: '已降级',
    unknown: '未知', failed: '失败', denied: '已拒绝', cancelled: '已取消', unhealthy: '异常',
    revoked: '已撤回', discovered: '待确认', approved: '可用', ready_for_adapter: '可用',
    not_ready: '未就绪', blocked: '被阻塞'
  };

  var EFFECT_LABELS = {
    read_only: '仅查看', local_write: '可改本机文件', external_write: '会对外发送', destructive: '有破坏性'
  };

  var HEALTH_LABELS = { healthy: '正常', unhealthy: '异常', degraded: '已降级', unknown: '未知' };

  var ASSET_TYPE_LABELS = {
    skill: 'Skill', mcp_server: 'MCP 服务', tool: '工具', workflow: '工作流',
    adapter: '适配器', validator: '校验器', grader: '评分器', eval_suite: '评测集'
  };

  // Task-detail vocabulary. Same rule as above: no raw enum reaches the screen.
  var STAGE_LABELS = {
    baseline: '基线确认', minimal_change: '最小改动', verification: '验证', review: '复查',
    discovery: '现状调研', plan: '方案设计', implementation: '实现', acceptance: '验收'
  };

  var TRACE_LABELS = {
    route_started: '开始执行', route_stage_completed: '完成一个阶段', route_completed: '执行完成',
    route_failed: '执行失败', trial_started: '开始验收', trial_completed: '验收结束',
    task_run_started: '任务开始', task_run_completed: '任务结束', checkpoint_recorded: '记录了一次进度',
    'task.created': '创建任务', 'task.message.user': '发送了一条消息', 'task.message.assistant': '模型已回复',
    'task.message.failed': '模型回复失败', 'host.output': '执行输出', 'host.finished': '执行结束'
  };

  var TASK_PERMISSION_LABELS = {
    human_approval: '手动审批', assisted_approval: '帮我审批', full_access: '完全访问'
  };

  var CONFIDENCE_LABELS = { confirmed: '已确认', high: '高', medium: '中', low: '低' };

  var ARTIFACT_KIND_LABELS = {
    file: '文件', route_receipt: '执行凭证', report: '报告', patch: '代码改动',
    digest: '摘要', link: '链接', dataset: '数据集'
  };

  // Receipt names arrive as `review:git_diff` / `baseline:focused_test`; split the
  // stage off and render both halves in Chinese.
  var RECEIPT_ACTION_LABELS = {
    git_diff: '代码差异', focused_test: '定向测试', coverage: '覆盖率',
    baseline: '基线', verification: '验证', review: '复查', build: '构建'
  };

  function receiptName(name) {
    var parts = String(name || '').split(':');
    if (parts.length < 2) return String(name || '—');
    var stage = label(STAGE_LABELS, parts[0], parts[0]);
    var action = label(RECEIPT_ACTION_LABELS, parts[1], parts[1]);
    // `review:review` collapses to one word instead of「复查 · 复查」.
    return stage === action ? stage : stage + ' · ' + action;
  }

  function label(map, value, fallback) {
    if (value === undefined || value === null || value === '') return fallback === undefined ? '—' : fallback;
    return map[value] || String(value);
  }

  // Reverse of label(): accepts either the raw enum value or the Chinese wording
  // shown in the UI, and falls back when neither matches so the backend never
  // receives a value it cannot validate.
  function fromLabel(map, value, fallback) {
    var raw = String(value === undefined || value === null ? '' : value).trim();
    if (!raw) return fallback;
    if (Object.prototype.hasOwnProperty.call(map, raw)) return raw;
    var hit = Object.keys(map).filter(function (key) { return map[key] === raw; })[0];
    return hit || fallback;
  }

  function statusPill(value) {
    if (!value) return pill('—');
    return pill(label(STATUS_LABELS, value, value), TONE[value] || '');
  }

  function effectPill(effect) {
    var tone = effect === 'destructive' ? 'danger' : (effect === 'read_only' ? 'ok' : 'warn');
    return pill(label(EFFECT_LABELS, effect, effect || '未声明'), tone);
  }

  function settled(promise, fallback) {
    return promise.then(function (value) { return value; }, function () { return fallback; });
  }

  // -------------------------------------------------------------------- theme

  var media = window.matchMedia('(prefers-color-scheme: dark)');

  function resolvedTheme() {
    if (state.theme === 'dark') return 'dark';
    if (state.theme === 'light') return 'light';
    return media.matches ? 'dark' : 'light';       // 'system'
  }

  function applyTheme() {
    var effective = resolvedTheme();
    document.documentElement.setAttribute('data-theme', effective);
    try { localStorage.setItem(THEME_KEY, effective); } catch (_) { /* storage off */ }
    var button = $('theme-toggle');
    if (button) {
      var dark = effective === 'dark';
      button.innerHTML = icon(dark ? 'sun' : 'moon');
      button.title = dark ? '切换到浅色主题' : '切换到深色主题';
      button.setAttribute('aria-label', button.title);
    }
  }

  function saveTheme(next) {
    state.theme = next;
    applyTheme();
    if (state.settings) state.settings.theme = next;
    api('/api/settings', { method: 'PATCH', body: { theme: next } })
      .then(function () { toast(next === 'dark' ? '已切换到深色主题' : next === 'light' ? '已切换到浅色主题' : '已跟随系统主题'); })
      .catch(function () { toast('主题已切换，但写入设置失败', true); });
  }

  function toggleTheme() { saveTheme(resolvedTheme() === 'dark' ? 'light' : 'dark'); }

  var openMenu = null;
  function closeTopMenu() {
    var node = $('top-menu');
    if (node) node.remove();
    document.querySelectorAll('[data-menu]').forEach(function (button) { button.setAttribute('aria-expanded', 'false'); });
    openMenu = null;
  }
  function openTopMenu(name, button) {
    if (openMenu === name) { closeTopMenu(); return; }
    closeTopMenu(); openMenu = name; button.setAttribute('aria-expanded', 'true');
    var commands = {
      file: [['新建任务', openComposer], ['设置', function () { go('settings'); }]],
      edit: [['复制', function () { try { document.execCommand('copy'); } catch (_) { /* browser policy */ } }], ['粘贴', function () { toast('请在输入框中使用 Ctrl+V 粘贴'); }]],
      view: [['收起左侧栏', function () { $('rail-toggle').click(); }], ['收起右侧信息', function () { $('aside-toggle').click(); }], ['在应用内查看网页', openEmbeddedBrowser], ['在受管浏览器中登录', openManagedBrowser], [resolvedTheme() === 'dark' ? '切换浅色主题' : '切换深色主题', toggleTheme]],
      help: [['键盘快捷键', function () { toast('Ctrl/⌘ + Enter 发送对话；Esc 关闭面板。'); }], ['关于 Craft Workbench', function () { toast('Craft Workbench · 本机任务工作台'); }]]
    }[name] || [];
    var menu = document.createElement('div'); menu.id = 'top-menu'; menu.className = 'top-menu'; menu.setAttribute('role', 'menu');
    commands.forEach(function (command) { var item = document.createElement('button'); item.type = 'button'; item.textContent = command[0]; item.onclick = function () { closeTopMenu(); command[1](); }; menu.appendChild(item); });
    document.body.appendChild(menu);
    var rect = button.getBoundingClientRect(); menu.style.left = Math.round(rect.left) + 'px'; menu.style.top = Math.round(rect.bottom + 4) + 'px';
  }

  // ------------------------------------------------------------- view helpers

  function head(title, sub, right) {
    return '<div class="card-head"><div class="head-text"><h2>' + esc(title) + '</h2>' +
      (sub ? '<p>' + sub + '</p>' : '') + '</div>' + (right || '') + '</div>';
  }

  function emptyState(title, hint, iconName) {
    return '<div class="empty">' + icon(iconName || 'inbox', 'empty-ic') +
      '<b>' + esc(title) + '</b>' + (hint ? '<span>' + esc(hint) + '</span>' : '') + '</div>';
  }

  function statTile(label, value, iconName, tone) {
    var empty = value === undefined || value === null || value === '';
    return '<div class="stat"><span class="stat-ic' + (tone ? ' ' + tone : '') + '">' + icon(iconName) + '</span>' +
      '<div class="stat-body"><b>' + esc(empty ? '—' : value) + '</b><span>' + esc(label) + '</span></div></div>';
  }

  function lead(iconName, tone) {
    return '<span class="row-lead' + (tone ? ' ' + tone : '') + '">' + icon(iconName) + '</span>';
  }

  function countChip(value) { return '<span class="count-chip">' + esc(value) + '</span>'; }

  function asideBlock(title, right, bodyHtml) {
    return '<div class="aside-block"><div class="aside-head"><span>' + esc(title) + '</span>' +
      (right ? '<b>' + esc(right) + '</b>' : '') + '</div>' + bodyHtml + '</div>';
  }

  function asideRows(pairs) {
    return '<div class="aside-list">' + pairs.map(function (pair) {
      return '<div class="aside-row"><span class="k">' + esc(pair[0]) + '</span><span class="v">' + esc(pair[1]) + '</span></div>';
    }).join('') + '</div>';
  }

  function toast(message, bad) {
    var host = $('toast-host');
    var node = document.createElement('div');
    node.className = 'toast' + (bad ? ' bad' : '');
    node.innerHTML = icon(bad ? 'alert' : 'check') + '<span>' + esc(message) + '</span>';
    host.appendChild(node);
    setTimeout(function () { node.remove(); }, bad ? 7000 : 3600);
  }

  function fail(error) { toast(error && error.message ? error.message : String(error), true); }

  function skeleton() {
    var tiles = [0, 1, 2, 3, 4, 5].map(function () {
      return '<div class="stat"><div class="sk-bar" style="width:28px;height:28px;border-radius:6px"></div>' +
        '<div class="stat-body"><div class="sk-bar" style="width:52px;height:17px"></div><div class="sk-bar" style="width:70px;height:11px;margin-top:5px"></div></div></div>';
    }).join('');
    return '<div class="stack"><div class="metrics">' + tiles + '</div>' +
      '<div class="grid-2"><div class="sk sk-card"></div><div class="sk sk-card"></div></div></div>';
  }

  // ---------------------------------------------------------------------- api

  function api(path, init) {
    init = init || {};
    var headers = { authorization: 'Bearer ' + state.token };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    return fetch(path, { method: init.method || 'GET', headers: headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) })
      .then(function (response) {
        return response.text().then(function (text) {
          var data = {};
          if (text) { try { data = JSON.parse(text); } catch (_) { data = { error: text }; } }
          if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
          return data;
        });
      });
  }

  function readUpload(input, accepted, callback) {
    var file = input && input.files && input.files[0];
    if (!file) return;
    if (accepted && accepted.indexOf(file.name.split('.').pop().toLowerCase()) < 0) { toast('请选择 .' + accepted.join('、.') + ' 文件', true); input.value = ''; return; }
    if (file.size > 48 * 1024) { toast('上传内容不能超过 48 KiB', true); input.value = ''; return; }
    var reader = new FileReader();
    reader.onload = function () { input.value = ''; callback(String(reader.result || ''), file.name); };
    reader.onerror = function () { input.value = ''; toast('读取文件失败', true); };
    reader.readAsText(file, 'utf-8');
  }

  function call(tool, args) { return api('/api/workbench/call', { method: 'POST', body: { tool: tool, args: args || {} } }); }

  // ------------------------------------------------------------- inline form
  // A desktop workspace should not interrupt with a dialog. Anything a page's
  // action bar opens renders as a card at the top of the MIDDLE column instead:
  // the form sits in the same column as the thing it edits, Esc or 取消 clears
  // it, and switching page drops it (see paint()).
  //
  // The form is state, not a live DOM node we show and hide — the next paint
  // either renders it or does not, which is what keeps it in sync with the page.

  var inlineForm = null;   // { page, options }

  function openInlineOn(page, options) {
    inlineForm = { page: page, options: options };
    paint(page);
  }

  function openInline(options) { openInlineOn(state.page, options); }

  function clearInline() { inlineForm = null; }

  function dismissInline(page) {
    var target = page || (inlineForm && inlineForm.page) || state.page;
    inlineForm = null;
    paint(target);
  }

  function inlineFormHtml() {
    var options = inlineForm.options;
    var actions = (options.actions || []).map(function (action, index) {
      return '<button class="btn' + (action.primary ? ' primary' : '') + (action.danger ? ' danger' : '') +
        '" type="button" data-inline="' + index + '">' +
        (action.icon ? icon(action.icon) : '') + esc(action.label) + '</button>';
    }).join('');
    return '<div class="card inline-form" role="group" aria-label="' + esc(options.title) + '">' +
      head(options.title, options.sub ? esc(options.sub) : '',
        '<button class="icon-btn" type="button" data-inline="close" aria-label="取消">' + icon('x') + '</button>') +
      '<div class="card-body"><div class="stack">' + (options.html || '') + '</div>' +
      '<div class="inline-foot">' + actions + '</div></div></div>';
  }

  function mountInlineForm(root) {
    var card = root.querySelector('.inline-form');
    if (!card) return;
    card.querySelectorAll('[data-inline]').forEach(function (button) {
      button.onclick = function () {
        var key = button.getAttribute('data-inline');
        if (key === 'close') { dismissInline(inlineForm.page); return; }
        var action = (inlineForm.options.actions || [])[Number(key)];
        if (action && action.run) action.run();
      };
    });
    if (inlineForm.options.mount) inlineForm.options.mount(card);
    var first = card.querySelector('input, textarea, select');
    if (first) first.focus();
  }

  // ------------------------------------------------------------------ palette

  var paletteIndex = 0;
  var paletteHits = [];

  function paletteCommands() {
    var commands = [{ label: '任务', kind: '页面', icon: 'tasks', run: function () { go('home'); } }];
    commands = commands.concat(FLAT.map(function (item) {
      return { label: item.title, kind: '页面', icon: item.icon, run: function () { go(item.key); } };
    }));
    commands.push({ label: '新建任务', kind: '操作', icon: 'plus', run: function () { openComposer(); } });
    // 文档 5.3：L3 的唯一合法使命是孵化一个新的工作对象。它刻意只出现在命令面板里，
    // 而不是主界面上最显眼的动作（15.3 把它降级为次要入口）。
    commands.push({ label: '孵化一个新对象', kind: '操作', icon: 'spark', run: openHatch });
    commands.push({ label: resolvedTheme() === 'dark' ? '切换到浅色主题' : '切换到深色主题', kind: '操作', icon: 'sun', run: toggleTheme });
    commands.push({ label: '刷新当前页面', kind: '操作', icon: 'refresh', run: function () { paint(state.page); } });
    return commands;
  }

  function renderPalette(query) {
    var all = paletteCommands();
    var needle = String(query || '').trim().toLowerCase();
    paletteHits = needle
      ? all.filter(function (item) { return item.label.toLowerCase().indexOf(needle) >= 0 || item.kind.toLowerCase().indexOf(needle) >= 0; })
      : all;
    if (paletteIndex >= paletteHits.length) paletteIndex = 0;
    var list = $('palette-list');
    if (!list) return;
    list.innerHTML = paletteHits.length
      ? paletteHits.map(function (item, index) {
          return '<button class="palette-item" type="button" data-hit="' + index + '" aria-selected="' + (index === paletteIndex) + '">' +
            icon(item.icon) + '<span>' + esc(item.label) + '</span><span class="kind">' + esc(item.kind) + '</span></button>';
        }).join('')
      : '<div class="palette-empty">没有匹配项</div>';
    list.querySelectorAll('[data-hit]').forEach(function (button) {
      button.onclick = function () { runPaletteHit(Number(button.getAttribute('data-hit'))); };
    });
  }

  function runPaletteHit(index) {
    var item = paletteHits[index];
    closePalette();
    if (item) item.run();
  }

  function openPalette() {
    var host = $('palette-host');
    paletteIndex = 0;
    host.innerHTML = '<div class="palette" role="dialog" aria-modal="true" aria-label="快速跳转">' +
      '<input class="palette-input" id="palette-input" type="text" placeholder="跳转到页面或执行操作…" autocomplete="off">' +
      '<div class="palette-list" id="palette-list"></div></div>';
    host.hidden = false;
    renderPalette('');
    host.onclick = function (event) { if (event.target === host) closePalette(); };
    var input = $('palette-input');
    input.focus();
    input.oninput = function () { paletteIndex = 0; renderPalette(input.value); };
    input.onkeydown = function (event) {
      if (event.key === 'Escape') { closePalette(); return; }
      if (event.key === 'ArrowDown') { event.preventDefault(); paletteIndex = Math.min(paletteIndex + 1, paletteHits.length - 1); renderPalette(input.value); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); paletteIndex = Math.max(paletteIndex - 1, 0); renderPalette(input.value); }
      else if (event.key === 'Enter') { event.preventDefault(); runPaletteHit(paletteIndex); }
    };
  }

  function closePalette() {
    var host = $('palette-host');
    host.hidden = true;
    host.innerHTML = '';
    host.onclick = null;
  }

  // ---------------------------------------------------------------- navigation

  // A folder deliberately has no nav entry: it is an attribute of a task — picked
  // when the task is created and shown as a group in the rail — not a place. It
  // used to sit here as 一级菜单 and duplicated the rail's own grouping.
  var NAV = [
    // 对象轨 is the plan's primary surface (文档 8 / 15.3): it answers 「我的东西在哪」,
    // and everything else in this rail is a supporting tool rather than the main screen.
    { key: 'objects', label: '我的对象', title: '我的对象', sub: '按「需要你」排序的工作对象；中央一次只放一个待裁决项', icon: 'layers', view: viewObjects },
    // 文档 7.1：每一次事件订阅都是一条显式、有期限、可撤销的授权记录。这一页就是那条记录
    // 的可见形态——没有它，订阅是一张看不见期限的空白支票。
    { key: 'subscriptions', label: '订阅', title: '订阅', sub: '事件订阅即长期授权：可查触发历史、有期限、可撤销', icon: 'refresh', view: viewSubscriptions },
    { key: 'approvals', label: '待我批准', title: '待我批准', sub: '需要人工决定才能继续的工作', icon: 'shield', view: viewApprovals },
    { key: 'plugins', label: '插件', title: '插件', sub: '可安装或已登记的能力包', icon: 'plug', view: viewPlugins },
    { key: 'skills', label: '技能', title: '技能', sub: '把具体方法与提示词作为可复用资产管理', icon: 'spark', view: viewSkills },
    { key: 'connectors', label: '连接器', title: '连接器', sub: '连接本机目录、MCP 服务和外部来源', icon: 'server', view: viewCapabilities },
    { key: 'models', label: '模型', title: '模型', sub: '配置任务对话和推理使用的模型', icon: 'cpu', view: viewModels },
    { key: 'memory', label: '记忆', title: '记忆', sub: '查看被保存的短期与长期任务记忆', icon: 'db', view: viewMemory },
    { key: 'knowledge', label: '知识', title: '知识', sub: '将 Markdown、JSON 和可核验结论组织成知识库', icon: 'layers', view: viewKnowledge },
    { key: 'workflows', label: '工作流', title: '工作流', sub: '查看复用流程及其运行记录', icon: 'refresh', view: viewWorkflows }
  ];

  // Settings remains routable, but is deliberately anchored at the rail bottom
  // rather than competing with the everyday working surfaces above.
  var SETTINGS_PAGE = { key: 'settings', label: '设置', title: '设置', sub: '外观、默认档位与高级选项', icon: 'sliders', view: viewSettings };
  var FLAT = NAV.concat([SETTINGS_PAGE]);
  var NAV_COUNT = { connectors: 'capability_connector', plugins: 'capability_asset', skills: 'capability_asset', memory: 'memory_item', knowledge: 'knowledge_claim', workflows: 'workflow' };

  // Home is where the app already lands, so it needs no nav entry either: it is
  // the composer and nothing else — the task list lives in the rail.
  var HOME_PAGE = { key: 'home', label: '任务区', title: '任务区', sub: '说清楚要做什么，选一个文件夹，其余交给 Craft', icon: 'tasks', view: viewHome };

  // The folder detail page is reached by clicking a folder name in the rail. It
  // stays out of NAV, but keeps a hash of its own so a reload lands back on it.
  var FOLDER_PAGE = { key: 'projects', label: '文件夹', title: '文件夹', sub: '每个文件夹记下的目标、决策、资料与成果', icon: 'folder', view: viewProjects };

  // A task is a document, not a nav destination: it is opened from a task row in
  // the left rail, so it stays outside NAV but still rides the hash — a reload or
  // a pasted link lands on the same task.
  var TASK_PAGE = { key: 'task', label: '任务', title: '任务', sub: '这个任务的目标、进度、产物与验证结论', icon: 'tasks', view: viewTask };

  function definition(page) {
    if (page === 'task') return TASK_PAGE;
    if (page === 'home') return HOME_PAGE;
    if (page === 'projects') return FOLDER_PAGE;
    return FLAT.filter(function (item) { return item.key === page; })[0] || HOME_PAGE;
  }

  function knownPage(page) {
    return page === 'task' || page === 'home' || page === 'projects' ||
      FLAT.some(function (item) { return item.key === page; });
  }

  function go(page) {
    if (page !== 'task') state.selectedTask = null;
    if (page !== 'projects') state.selectedProject = null;
    var next = '#token=' + encodeURIComponent(state.token) + '&page=' + page;
    if (location.hash === next) paint(page); else location.hash = next;
  }

  // Opening a folder is a two-parameter hash: which page, and which folder.
  function openFolder(key) {
    state.selectedTask = null;
    state.selectedProject = key;
    var next = '#token=' + encodeURIComponent(state.token) + '&page=projects&project=' + encodeURIComponent(key);
    if (location.hash === next) paint('projects'); else location.hash = next;
  }

  function openTask(taskId) {
    state.selectedTask = taskId;
    state.selectedTaskTitle = taskTitleOf(taskId);
    var next = '#token=' + encodeURIComponent(state.token) + '&page=task&task=' + encodeURIComponent(taskId);
    if (location.hash === next) paint('task'); else location.hash = next;
  }

  // The rail already holds every task title, so read it from there instead of
  // flashing a generic「任务」heading while the detail request is in flight.
  function taskTitleOf(taskId) {
    var groups = state.folderGroups || [];
    for (var i = 0; i < groups.length; i += 1) {
      for (var j = 0; j < groups[i].tasks.length; j += 1) {
        if (groups[i].tasks[j].id === taskId) return groups[i].tasks[j].title || '';
      }
    }
    return '';
  }

  function paintNav() {
    // Home, a folder and a task all live "under" 任务 in the rail, so none of the
    // remaining nav entries is current for them.
    var current = state.page;
    $('nav').innerHTML = NAV.map(function (item) {
      var count = state.counts[NAV_COUNT[item.key]];
      return '<button class="nav-item" type="button" data-page="' + item.key + '"' + (item.key === current ? ' aria-current="true"' : '') + '>' +
        icon(item.icon) + '<span class="nav-label">' + esc(item.label) + '</span>' +
        (count ? '<span class="nav-count">' + esc(count) + '</span>' : '') + '</button>';
    }).join('');
    $('nav').onclick = function (event) {
      var button = event.target.closest('[data-page]');
      if (button) go(button.getAttribute('data-page'));
    };
  }

  // ------------------------------------------------------------------- render

  function paint(page) {
    state.page = page;
    var def = definition(page);
    // Changing page drops a form that belonged to the old one, so a half-filled
    // 「记一个目标」 can never follow you onto another page.
    if (inlineForm && inlineForm.page !== def.key) inlineForm = null;
    paintNav();
    var title = def.key === 'task' && state.selectedTaskTitle ? state.selectedTaskTitle : def.title;
    $('page-title').textContent = title;
    $('page-sub').textContent = def.sub;
    $('page-actions').innerHTML = '';
    var panel = $('aside-panel');
    if (panel) panel.innerHTML = '';
    document.title = title + ' · Craft Workbench';

    var content = $('content');
    content.innerHTML = skeleton();
    Promise.resolve(def.view()).then(function (view) {
      if (state.page !== def.key) return;
      content.innerHTML = view.html;
      // Render contextual info into the right panel
      if (panel) panel.innerHTML = view.aside || '';
      (view.mounts || []).forEach(function (mount) { mount(content); });
      // A form opened from this page's action bar belongs at the top of the
      // column, right above the content it edits.
      if (inlineForm && inlineForm.page === def.key) {
        content.insertAdjacentHTML('afterbegin', inlineFormHtml());
        mountInlineForm(content);
      }
      if (view.asideMount) view.asideMount(panel || $('aside'));
      bindAsideCollapsible(panel);
      var actions = $('page-actions');
      actions.innerHTML = '';
      (view.actions || []).forEach(function (action) {
        var button = document.createElement('button');
        button.className = 'btn' + (action.primary ? ' primary' : '');
        button.type = 'button';
        button.innerHTML = (action.icon ? icon(action.icon) : '') + esc(action.label);
        button.onclick = action.run;
        actions.appendChild(button);
      });
      // A sheet requested before the page finished painting (first-run model
      // setup) has to wait until now, otherwise the page would overwrite it.
      if (state.pendingSheet) {
        var pending = state.pendingSheet;
        state.pendingSheet = null;
        if (pending.page === state.page) pending.run();
      }
    }).catch(function (error) {
      content.innerHTML = '<div class="callout warn">' + icon('alert') + '<span>页面加载失败：' + esc(error.message) + '</span></div>';
    });
  }

  // -------------------------------------------------------------------- tasks

  var HOSTS = [['codex-cli', 'Codex CLI'], ['claude-code', 'Claude Code']];
  var SANDBOXES = [['read-only', '只看不改（只读）'], ['workspace-write', '允许改动工作区文件']];

  function options(pairs, selected) {
    return pairs.map(function (pair) {
      return '<option value="' + esc(pair[0]) + '"' + (pair[0] === selected ? ' selected' : '') + '>' + esc(pair[1]) + '</option>';
    }).join('');
  }

  // Users write completion conditions in plain Chinese; the runtime still gets
  // the enum it validates against.
  var CRITERION_WORDS = {
    'file': 'file', '文件': 'file',
    'program': 'program', '命令': 'program',
    'model': 'model', '模型': 'model',
    'human': 'human', '人工': 'human',
    'business_signal': 'business_signal', '业务信号': 'business_signal'
  };

  function parseCriteria() {
    var raw = lines('task-acceptance');
    var specs = raw.map(function (line, index) {
      var match = line.match(/^(program|model|human|business_signal|file|命令|文件|模型|人工|业务信号)\s*[:：]\s*(.+)$/);
      var kind = match ? (CRITERION_WORDS[match[1]] || 'human') : 'human';
      var body = match ? match[2].trim() : line;
      return { id: 'criterion_' + (index + 1), name: (kind === 'file' ? '产出文件：' : '') + body,
        method: kind === 'file' ? 'program' : kind, required: true, file_path: kind === 'file' ? body : null };
    });
    return {
      criteria: specs.map(function (spec) { return { id: spec.id, name: spec.name, method: spec.method, required: true }; }),
      files: specs.filter(function (spec) { return spec.file_path; })
    };
  }

  // ----------------------------------------------------------------- composer
  // A task's folder is decided exactly once — when the task is created — so the
  // picker belongs on the composer, right under the input box, instead of behind
  // a folder menu. Nothing here opens a dialog: what needs more room uses the
  // right panel.

  var WORKSPACE_KEY = 'craft.workspace';
  var caps = { connectors: [], assets: [], userSkills: [] };

  // Sort order is the rail's: folders the store knows first, 「默认」 last, and
  // a folder the store has no record for is still offered (tasks can point at one).
  function composerFolders() {
    var html = '<option value="">默认（不选文件夹）</option>';
    (state.folderGroups || []).forEach(function (group) {
      if (!group.key) return;
      html += '<option value="' + esc(group.key) + '"' + (state.composer.folder === group.key ? ' selected' : '') + '>' +
        esc(group.name) + '（' + group.tasks.length + '）</option>';
    });
    return html + '<option value="__new__">＋ 新建文件夹</option>';
  }

  function capNameOf(id) {
    var list = caps.assets || [];
    for (var i = 0; i < list.length; i += 1) { if (list[i].id === id) return list[i].name || id; }
    list = caps.userSkills || [];
    for (var j = 0; j < list.length; j += 1) { if (list[j].id === id) return list[j].name || id; }
    return id;
  }

  function loadCapabilities() {
    if (caps.assets.length || caps.userSkills.length) return Promise.resolve(caps);
    return Promise.all([api('/api/connectors?limit=100'), api('/api/workbench/resources?kind=skills&limit=100')]).then(function (results) {
      caps.connectors = results[0].connectors || [];
      caps.assets = results[0].assets || [];
      caps.userSkills = results[1].items || [];
      return caps;
    });
  }

  function renderComposerChips() {
    var host = $('composer-chips');
    if (!host) return;
    var chosen = state.composer.caps || [];
    host.innerHTML = chosen.length
      ? '<div class="chips">' + chosen.map(function (id) {
          return '<span class="chip">' + icon('plug') + esc(capNameOf(id)) +
            '<button type="button" data-cap-drop="' + esc(id) + '" aria-label="移除这个能力">' + icon('x') + '</button></span>';
        }).join('') + '</div>'
      : '';
    host.querySelectorAll('[data-cap-drop]').forEach(function (button) {
      button.onclick = function () {
        var id = button.getAttribute('data-cap-drop');
        state.composer.caps = (state.composer.caps || []).filter(function (item) { return item !== id; });
        renderComposerChips();
      };
    });
  }

  // Toggling 更多 flips visibility instead of re-rendering, so whatever the user
  // already typed into the box or the work-directory field survives.
  function composerHtml() {
    var c = state.composer;
    var modelOptions = (c.models || []).map(function (model) {
      return '<option value="' + esc(model.id) + '"' + (model.id === c.model ? ' selected' : '') + '>' +
        esc(model.name + ' · ' + model.model) + (model.configured ? '' : '（待填密钥）') + '</option>';
    }).join('');
    var ready = (c.models || []).filter(function (model) { return model.configured; });
    return '<div class="composer">' +
      '<textarea id="composer-text" rows="3" placeholder="说说要做的事，例如：修复登录超时，并补上回归用例"></textarea>' +
      '<div id="composer-chips"></div>' +
      '<div class="composer-bar">' +
        '<button class="cbtn" type="button" id="composer-caps" title="这个任务可以用哪些已登记的能力">' + icon('plus') + '<span>能力</span></button>' +
        '<label class="cbtn cbtn-pick" title="这个任务算在哪个文件夹">' + icon('folder') +
          '<select id="composer-folder" aria-label="选择文件夹">' + composerFolders() + '</select></label>' +
        '<label class="cbtn cbtn-pick" title="选择本次对话使用的模型">' + icon('cpu') +
          '<select id="composer-model" aria-label="选择模型"' + (ready.length ? '' : ' disabled') + '>' +
            (modelOptions || '<option value="">先到设置添加模型</option>') + '</select></label>' +
        '<label class="cbtn cbtn-pick" title="选择任务权限">' + icon('shield') +
          '<select id="task-permission" aria-label="选择权限">' +
            options([['human_approval', '手动审批'], ['assisted_approval', '帮我审批'], ['full_access', '完全访问']], c.permission) +
          '</select></label>' +
        '<span class="grow"></span>' +
        (ready.length ? '<button class="cbtn primary" type="button" id="composer-send">' + icon('play') + '<span>开始</span></button>' :
          '<button class="cbtn" type="button" id="composer-model-setup">先添加模型</button>') +
      '</div>' +
      '<div class="composer-note">对话从模型开始。文件、命令与外部动作会依照所选权限另行确认。</div>' +
      '</div>';
  }

  function bindComposer(root) {
    var box = root.querySelector('#composer-text');
    if (!box) return;
    var folder = root.querySelector('#composer-folder');
    folder.onchange = function () {
      if (folder.value === '__new__') {
        // Put the picker back where it was, then ask for the new folder in the
        // right panel; createProject() hands the new id back to the composer.
        folder.value = state.composer.folder || '';
        openCreateProjectSheet();
        return;
      }
      state.composer.folder = folder.value;
      var node = $('aside-folder');
      if (node) node.textContent = folderNameOf(folder.value);
    };
    var model = root.querySelector('#composer-model');
    if (model) model.onchange = function () { state.composer.model = model.value; };
    var permission = root.querySelector('#task-permission');
    if (permission) permission.onchange = function () { state.composer.permission = permission.value; };
    root.querySelector('#composer-caps').onclick = openCapabilitySheet;
    var send = root.querySelector('#composer-send');
    if (send) send.onclick = submitComposer;
    var setup = root.querySelector('#composer-model-setup');
    if (setup) setup.onclick = function () { go('models'); };
    box.onkeydown = function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); submitComposer(); }
    };
    renderComposerChips();
  }

  // 「新建任务」 means "put the cursor where a task gets written", so it focuses
  // the composer instead of opening a dialog.
  // 文档 14 红线 3：表单不再是常驻的，而是按下时才出现的一张内联卡，用完即收。
  function openComposer() {
    if (state.page !== 'home') { go('home'); return; }
    openInlineOn('home', { title: '说一个意图', sub: '说完即可开始；Craft 会问你必要的选择题',
      html: composerHtml(), actions: [], mount: bindComposer });
  }

  function submitComposer() {
    var raw = val('composer-text');
    if (!raw) { toast('先说一下要做什么', true); return; }
    var model = val('composer-model') || state.composer.model;
    if (!model) { toast('请先选择一个可用模型', true); return; }
    var configuredModel = (state.composer.models || []).filter(function (item) { return item.id === model; })[0];
    if (!configuredModel || !configuredModel.configured) { toast('这个模型还没有可用密钥，请先到设置完成配置', true); return; }
    var folder = $('composer-folder') ? $('composer-folder').value : '';
    if (folder === '__new__') folder = '';
    var firstLine = raw.split(/\r?\n/)[0].trim();
    var title = firstLine.length > 42 ? firstLine.slice(0, 42) + '…' : firstLine;
    var chosen = state.composer.caps || [];
    // The runtime has no field for capability selection yet, so the names ride
    // along in the prompt as an explicit instruction instead of being dropped.
    var selectedSkills = (caps.userSkills || []).filter(function (item) { return chosen.indexOf(item.id) >= 0; });
    var prompt = chosen.length ? raw + '\n\n可用的能力：' + chosen.map(capNameOf).join('、') : raw;
    if (selectedSkills.length) prompt += '\n\n<craft-user-skills>\n' + selectedSkills.map(function (item) { return '### ' + item.name + '\n' + item.content; }).join('\n\n') + '\n</craft-user-skills>';
    var body = { title: title, goal: raw, model_id: model, permission_mode: val('task-permission') || 'human_approval' };
    if (folder) body.project_id = folder;
    state.composer.model = model;
    state.composer.permission = body.permission_mode;
    state.composer.lastPrompt = prompt;
    api('/api/tasks', { method: 'POST', body: body }).then(function (created) {
      var task = created.task || {};
      if (!task.id) throw new Error('任务创建未返回任务编号');
      return api('/api/tasks/' + encodeURIComponent(task.id) + '/messages', { method: 'POST', body: { content: prompt } }).then(function () { return task; });
    }).then(function (task) {
      toast('任务已开始');
      state.composer.folder = '';
      state.composer.caps = [];
      // 文档 14 红线 3：表单是按需出现的内联卡，提交后即收起，不再停留。
      clearInline();
      renderFolderTree(true);
      openTask(task.id);
    }).catch(fail);
  }

  // `/api/home` caps its task list server-side (default 10, max 50) and used to
  // slice silently: the rail showed 10 rows while the status bar said 12. Ask
  // for the 50-cap, and if the store ever outgrows it, say so on screen instead
  // of dropping rows without a word.
  var TASK_LIST_LIMIT = 50;

  // ------------------------------------------------------------- folder tree
  // The rail groups tasks by folder. Folders are derived from the tasks
  // themselves and unioned with the folder records, because a task may point at
  // a folder that has no record yet (the local store has such a case) and
  // listing records alone would make those tasks vanish.

  function groupByFolder(projects, tasks) {
    var groups = [];
    var index = {};
    function ensure(key, name, known) {
      if (!index[key]) {
        index[key] = { key: key, name: name, known: !!known, tasks: [] };
        groups.push(index[key]);
      } else if (name && !index[key].known && known) {
        index[key].name = name; index[key].known = true;
      }
      return index[key];
    }
    projects.forEach(function (item) {
      var key = String(item.project_id || '');
      if (key) ensure(key, item.name || key, true);
    });
    var fallback = null;
    tasks.forEach(function (task) {
      var key = task.project_id ? String(task.project_id) : '';
      // The default bucket is not a real folder record: marking it known=false
      // keeps the folder page from trying to fetch a brain snapshot for it.
      var group = key ? ensure(key, key, false) : (fallback || (fallback = ensure('', '默认', false)));
      group.tasks.push(task);
    });
    // 「默认」goes last: it is the bucket for tasks that never chose a folder.
    groups.sort(function (a, b) { return (a.key === '') - (b.key === ''); });
    return groups;
  }

  function taskRowHtml(task) {
    var active = state.selectedTask === task.id;
    return '<button class="conv-item" type="button" data-task="' + esc(task.id) + '"' + (active ? ' aria-current="true"' : '') + '>' +
      '<span class="conv-icon">' + icon('tasks') + '</span>' +
      '<span class="conv-main"><span class="conv-title">' + esc(task.title || '未命名任务') + '</span>' +
      '<span class="conv-sub">' + esc(task.goal || '—') + '</span></span></button>';
  }

  // Same tasks, rendered for a page body rather than the rail (wider rows).
  function taskListRows(tasks) {
    return tasks.map(function (task) {
      return '<div class="row selectable" data-task="' + esc(task.id) + '">' + lead('tasks') +
        '<div class="row-main"><span class="row-title">' + esc(task.title || '未命名任务') + '</span>' +
        '<span class="row-sub">' + esc(task.goal || '—') + '</span></div>' +
        statusPill(task.status) + '</div>';
    }).join('');
  }

  // A folder shows its five most recent tasks; anything beyond that is behind one
  // click, so a folder holding ten tasks does not push the rest of the rail off
  // the screen.
  var FOLDER_PREVIEW = 5;

  function folderGroupHtml(group) {
    var collapsed = !!state.collapsedFolders[group.key];
    var all = group.tasks;
    var expanded = state.showAllFolders[group.key] === true;
    var shown = expanded ? all : all.slice(0, FOLDER_PREVIEW);
    var rest = all.length - shown.length;
    var more = '';
    if (expanded && all.length > FOLDER_PREVIEW) {
      more = '<button class="ft-more" type="button" data-more="' + esc(group.key) + '">收起</button>';
    } else if (rest > 0) {
      more = '<button class="ft-more" type="button" data-more="' + esc(group.key) + '">还有 ' + rest + ' 个，展开</button>';
    }
    var body = all.length
      ? '<div class="conv-list ft-tasks">' + shown.map(taskRowHtml).join('') + '</div>' + more
      : '<div class="ft-empty">还没有任务</div>';
    return '<div class="ft-group"' + (collapsed ? ' data-collapsed="true"' : '') + '>' +
      '<button class="ft-head" type="button" data-folder="' + esc(group.key) + '" aria-expanded="' + String(!collapsed) + '">' +
        '<span class="ft-chev" data-chev="' + esc(group.key) + '">' + icon('chev') + '</span>' +
        icon(group.key ? 'folder' : 'inbox', 'ft-ic') +
        '<span class="ft-name">' + esc(group.name) + '</span>' +
        '<span class="ft-count">' + group.tasks.length + '</span>' +
      '</button>' + (collapsed ? '' : body) + '</div>';
  }

  function paintFolderTree() {
    var host = $('folder-tree');
    if (!host) return;
    var groups = state.folderGroups || [];
    var fetched = groups.reduce(function (sum, group) { return sum + group.tasks.length; }, 0);
    // Prefer the real total from /api/workbench/summary so the chip matches the
    // status bar even if the fetch hit the 50-row cap.
    var total = Number(state.counts.task || 0) || fetched;
    var count = $('task-list-count');
    if (count) count.textContent = String(total);
    var sw = $('task-view');
    if (sw) {
      sw.textContent = state.taskView === 'task' ? '按任务' : '按文件夹';
      sw.setAttribute('title', state.taskView === 'task'
        ? '现在按更新时间倒序，点一下切回按文件夹'
        : '现在按文件夹分组，点一下切成按更新时间倒序');
    }
    // 全部展开/折叠 only means something while folders are on screen; a flat list
    // has nothing to fold, so the control goes away instead of doing nothing.
    var fold = $('task-fold');
    if (fold) fold.hidden = state.taskView === 'task';
    var body;
    if (state.taskView === 'task') {
      // One flat list, newest update first — the rail's answer to "what did I
      // touch last?" without opening a single folder.
      var flat = groups.reduce(function (all, group) { return all.concat(group.tasks); }, [])
        .sort(function (a, b) { return String(b.updated_at || '').localeCompare(String(a.updated_at || '')); });
      body = flat.length ? '<div class="conv-list">' + flat.map(taskRowHtml).join('') + '</div>' : '';
    } else {
      body = groups.length ? groups.map(folderGroupHtml).join('') : '';
      if (fetched < total) {
        body += '<div class="aside-note" style="padding:8px">共 ' + total + ' 个任务，这里显示最近 ' + fetched + ' 个。</div>';
      }
    }
    host.innerHTML = body || '<div class="aside-note" style="padding:8px">还没有任务，在上面的输入框里说一句就开始。</div>';
  }

  function renderFolderTree(refetch) {
    var host = $('folder-tree');
    if (!host) return;
    if (!refetch && state.folderGroups) { paintFolderTree(); return; }
    Promise.all([
      settled(api('/api/projects?limit=200'), { projects: [] }),
      api('/api/home?limit=' + TASK_LIST_LIMIT)
    ]).then(function (results) {
      state.folderGroups = groupByFolder(results[0].projects || [], results[1].tasks || []);
      paintFolderTree();
    }).catch(function () {
      var count = $('task-list-count');
      if (count) count.textContent = '—';
      // A fresh workspace has no tasks. Do not turn an empty or unavailable
      // projection into invented sample data or a permanent error row.
      host.innerHTML = '';
    });
  }

  function toggleFolder(key) {
    if (state.collapsedFolders[key]) delete state.collapsedFolders[key];
    else state.collapsedFolders[key] = true;
    renderFolderTree(false);
  }

  // --------------------------------------------------------------------- home
  // Home is the composer and nothing else. The rail already lists every task, so
  // repeating the list here would just be a second copy of the same rows.

  // Right-panel blocks that only repeat what the page already says can be folded
  // away — collapsed by default, because the panel should not explain itself
  // before being asked.
  function asideCollapsible(title, bodyHtml) {
    var open = state.asideOpen[title] === true;
    return '<div class="aside-block">' +
      '<button class="aside-head aside-fold" type="button" data-fold="' + esc(title) + '" aria-expanded="' + String(open) + '">' +
        '<span>' + esc(title) + '</span>' + icon('chev') + '</button>' +
      (open ? bodyHtml : '') + '</div>';
  }

  function bindAsideCollapsible(panel) {
    if (!panel) return;
    panel.querySelectorAll('[data-fold]').forEach(function (button) {
      button.onclick = function () {
        var key = button.getAttribute('data-fold');
        state.asideOpen[key] = !(state.asideOpen[key] === true);
        paint(state.page);
      };
    });
  }

  function viewHome() {
    return Promise.all([
      loadCapabilities().catch(function () { return caps; }),
      settled(api('/api/config/models'), { models: [] })
    ]).then(function (results) {
      state.composer.models = results[1].models || [];
      if (!state.composer.model && state.composer.models.length) state.composer.model = state.composer.models[0].id;
      // 文档 14 红线 3：不许有常驻的大输入框。输入框是 L3 的入口，L3 应该稀有；
      // 把稀有通道做成常驻，等于承认系统大部分时间不知道你要什么。home 只放入口卡，
      // 表单在按下时才以内联卡出现，用完即收。
      var ready = (state.composer.models || []).filter(function (item) { return item.configured; });
      return {
        html: '<div class="stack home">' +
          '<div class="card">' + head('你的对象', '交付物本身，而不是与它的对话', countChip(state.counts.task || 0)) +
          '<div class="card-body">' +
          (ready.length
            ? '<div class="aside-note">要开始一件事，从下面这扇门进。它不会一直开着——大部分时间，系统应该自己知道该做什么。</div>' +
              '<div class="home-entries">' +
              '<button class="btn primary" type="button" id="home-intent">' + icon('plus') + '<span>说一个意图</span></button>' +
              '<button class="btn" type="button" id="home-hatch">' + icon('spark') + '<span>孵化一个新对象</span></button>' +
              '</div>'
            : '<div class="aside-note">还没有可用的模型。先到「模型」完成配置，Craft 才能开始工作。</div>' +
              '<div class="home-entries"><button class="btn primary" type="button" id="home-setup">去配置模型</button></div>') +
          '</div></div>' +
          '<p class="home-hint">所有任务在左边「任务」里，默认按文件夹分组。</p>' +
          '</div>',
        aside: asideCollapsible('文件夹是什么',
            '<div class="aside-note">一个文件夹记录一个方向：目标是什么、做过哪些决定、参考了哪些资料、最后得到了什么。' +
            'Craft 只保存引用与摘要，不保存原文。</div>') +
          asideBlock('这次任务', '', '<div class="aside-list">' +
            '<div class="aside-row"><span class="k">文件夹</span><span class="v" id="aside-folder">' + esc(folderNameOf(state.composer.folder)) + '</span></div>' +
            '<div class="aside-row"><span class="k">权限</span><span class="v" id="aside-sandbox">' + esc(state.composer.sandbox === 'workspace-write' ? '完全访问' : '有限访问') + '</span></div>' +
            '</div>'),
        mounts: [function (root) {
          var intent = root.querySelector('#home-intent');
          if (intent) intent.onclick = openComposer;
          var hatch = root.querySelector('#home-hatch');
          if (hatch) hatch.onclick = openHatch;
          var setup = root.querySelector('#home-setup');
          if (setup) setup.onclick = function () { go('models'); };
        }]
      };
    });
  }

  // ----------------------------------------------------------------- projects

  function createProject() {
    var name = val('project-name');
    if (!name) { toast('请填写文件夹名称', true); return; }
    // The folder's internal id stays invisible; it is derived, never typed.
    var id = 'folder-' + Date.now().toString(36);
    api('/api/projects', { method: 'POST', body: { project_id: id, name: name, description: val('project-desc') } })
      .then(function (result) {
        // Whichever route asked for a new folder, the point was to put something
        // in it, so hand the new id back to the composer's picker.
        state.composer.folder = id;
        state.selectedProject = id;
        toast('文件夹「' + name + '」' + (result.idempotent ? '已存在' : '已创建'));
        return renderFolderTree(true);
      }).then(function () {
        paint(state.page === 'projects' ? 'projects' : 'home');
      }).catch(fail);
  }

  // No dialog: the form renders in the right panel like every other sheet.
  function openCreateProjectSheet() {
    openSheet(function (panel) {
      panel.innerHTML = sheetHead('新建文件夹', '把一组相关任务归到一起') +
        '<div class="sheet-body">' +
          '<div class="field"><label for="project-name">名称</label><input id="project-name" type="text" placeholder="例如：登录体验优化"></div>' +
          '<div class="field"><label for="project-desc">说明（可选）</label><textarea id="project-desc" placeholder="这个方向想达成什么"></textarea></div>' +
          '<button class="btn primary" type="button" id="project-create">' + icon('plus') + '创建</button>' +
        '</div>';
      panel.querySelector('#project-create').onclick = createProject;
      bindSheetBack(panel);
    });
  }

  // The ＋ in the composer picks which already-confirmed capabilities this task
  // may use. A right-panel sheet, like everything else that needs more room.
  function openCapabilitySheet() {
    openSheet(function (panel) {
      panel.innerHTML = sheetHead('这个任务可以用哪些能力', '只有已确认可用的能力才能勾选') +
        '<div class="sheet-body"><div class="splash"><span class="spin"></span>正在读取…</div></div>';
      bindSheetBack(panel);
      loadCapabilities().then(function () {
        var chosen = state.composer.caps || [];
        var usable = (caps.assets || []).filter(function (item) { return item.status === 'approved'; }).map(function (item) { return { id: item.id, name: item.name, sub: label(ASSET_TYPE_LABELS, item.asset_type, item.asset_type) + ' · ' + label(EFFECT_LABELS, item.effect, item.effect) }; });
        var personalSkills = (caps.userSkills || []).filter(function (item) { return item.status === 'active'; }).map(function (item) { return { id: item.id, name: item.name, sub: '已安装技能 · 将作为任务上下文附带' }; });
        var available = usable.concat(personalSkills);
        var body = available.length
          ? available.map(function (item) {
              return '<label class="check cap-row"><input type="checkbox" data-cap="' + esc(item.id) + '"' +
                (chosen.indexOf(item.id) >= 0 ? ' checked' : '') + '>' +
                '<span class="cap-text"><b>' + esc(item.name) + '</b><span>' +
                esc(item.sub) + '</span></span></label>';
            }).join('') + '<div class="aside-note" style="margin-top:10px">外部能力需先在「连接器」确认；本地上传的技能可直接作为任务指令上下文使用。</div>'
          : '<div class="aside-note">还没有可用能力。先上传技能，或在「连接器」里添加一个来源并确认能力。</div>';
        panel.innerHTML = sheetHead('这个任务可以用哪些能力', '只有已确认可用的能力才能勾选') +
          '<div class="sheet-body">' + body + '</div>';
        bindSheetBack(panel);
        panel.querySelectorAll('[data-cap]').forEach(function (input) {
          input.onchange = function () {
            var id = input.getAttribute('data-cap');
            var list = state.composer.caps || [];
            state.composer.caps = input.checked
              ? list.concat([id]).filter(function (x, i, all) { return all.indexOf(x) === i; })
              : list.filter(function (x) { return x !== id; });
            renderComposerChips();
          };
        });
      }).catch(fail);
    });
  }

  // Approving a launch only works while its work-loop id is still in hand, so the
  // button is offered only when it can actually do something — never as a control
  // that fails when pressed. A durable「等我批准」list belongs to the inbox work.
  function taskPageActions(task) {
    var actions = [
      { label: '回到任务', icon: 'tasks', run: function () { go('home'); } },
      { label: '新建任务', icon: 'plus', run: openComposer }
    ];
    var pending = state.pendingApproval;
    if (pending && pending.taskId === task.id && pending.loopId) {
      actions.unshift({ label: '批准并开始', icon: 'check', primary: true, run: function () { approveLaunch(pending.loopId); } });
    }
    return actions;
  }

  function approveLaunch(loopId) {
    // The kernel rejects a decision with no summary and a launch with no prompt,
    // so both are supplied here — passing them empty is what made the old
    // 「批准并开始」 button fail with a 422 every time.
    api('/api/verified-work-loops/' + encodeURIComponent(loopId) + '/decide', {
      method: 'POST', body: {
        decision: 'approve', actor: 'studio-user', approved: true,
        summary: '用户确认这次执行可以改文件',
        prompt: state.composer.lastPrompt || '按原指令执行'
      }
    }).then(function () {
      state.pendingApproval = null;
      toast('已批准，任务开始执行');
      paint('task');
    }).catch(fail);
  }

  function projectAction(kind, body) {
    api('/api/projects/' + encodeURIComponent(state.selectedProject) + '/' + kind, { method: 'POST', body: body })
      .then(function () { clearInline(); toast('已记录'); paint('projects'); }).catch(fail);
  }

  function addGoal() { projectAction('goals', { title: val('goal-title'), metric: val('goal-metric') || undefined, constraint_digests: [] }); }

  function addDecision() {
    projectAction('decisions', { title: val('decision-title'), rationale: val('decision-rationale'), chosen_ref: val('decision-chosen'), excluded_refs: [] });
  }

  function addMaterial() {
    projectAction('materials', { name: val('material-name'), uri: val('material-uri'), content_digest: val('material-digest'), source_type: 'user' });
  }

  function addOutcome() {
    projectAction('outcomes', { verdict: val('outcome-verdict'), summary: val('outcome-summary'), evidence_ids: [], artifact_ids: [] });
  }

  function viewProjects() {
    return Promise.all([
      settled(api('/api/projects?limit=200'), { projects: [] }),
      api('/api/home?limit=' + TASK_LIST_LIMIT)
    ]).then(function (results) {
      var projects = results[0].projects || [];
      var tasks = results[1].tasks || [];
      // The same union the rail uses: folder records plus anything a task points
      // at, so a folder the store has no record for still shows up with its
      // tasks instead of making them unreachable from this page.
      var groups = groupByFolder(projects, tasks);
      state.folderGroups = groups;
      paintFolderTree();
      var selected = state.selectedProject;
      var selectedGroup = groups.filter(function (group) { return group.key === selected; })[0] || null;

      var rows = groups.length
        ? groups.map(function (group) {
            var monogram = String(group.name || '?').trim().charAt(0).toUpperCase();
            return '<div class="row selectable" data-project="' + esc(group.key) + '"' + (group.key === selected ? ' aria-selected="true"' : '') + '>' +
              '<span class="row-lead accent">' + esc(monogram) + '</span>' +
              '<div class="row-main"><span class="row-title">' + esc(group.name) + '</span>' +
              '<span class="row-sub">' + (group.tasks.length ? group.tasks.length + ' 个任务' : '还没有任务') + '</span></div>' +
              countChip(group.tasks.length) + '</div>';
          }).join('')
        : emptyState('还没有文件夹', '文件夹用来把相关任务归到一起，并记下这个方向的目标与结论', 'folder');

      var detail = '<div class="card"><div class="card-body">' + emptyState('还没有选中文件夹', '从左边选一个文件夹，看它记下的目标、决策和成果', 'folder') + '</div></div>';
      var aside = asideBlock('文件夹是什么', '', '<div class="aside-note">一个文件夹记录一个方向：目标是什么、做过哪些决定、参考了哪些资料、最后得到了什么。Craft 只保存引用与摘要，不保存原文。</div>');
      var chain = Promise.resolve();

      if (selectedGroup && selectedGroup.known) {
        chain = api('/api/projects/' + encodeURIComponent(selectedGroup.key)).then(function (snapshot) {
          var groups = [
            ['目标', 'spark', snapshot.goals || []],
            ['决策', 'check', snapshot.decisions || []],
            ['资料', 'file', snapshot.materials || []],
            ['成果', 'layers', snapshot.outcomes || []],
            ['任务', 'tasks', snapshot.tasks || []],
            ['经验', 'db', snapshot.experiences || []]
          ];
          var section = function (title, iconName, items) {
            var body = items.length ? items.map(function (item) {
              return '<div class="row"><div class="row-main">' +
                '<span class="row-title">' + esc(item.title || item.name || item.summary || item.id) + '</span>' +
                (item.metric || item.rationale
                  ? '<span class="row-sub">' + esc(item.metric || item.rationale) + '</span>' : '') +
                '</div>' + statusPill(item.status) + '</div>';
            }).join('') : emptyState('还没有' + title, null, iconName);
            return '<div class="card">' + head(title, items.length + ' 条') + '<div class="card-body tight"><div class="rows">' + body + '</div></div></div>';
          };
          var next = snapshot.next_action;
          detail = '<div class="stack">' +
            '<div class="card">' + head(snapshot.brain.name, '文件夹：' + esc(snapshot.brain.name),
              pill(next === 'replan_session' ? '需要重新规划' : '正常', next === 'replan_session' ? 'warn' : 'info')) +
              '<div class="card-body"><div class="callout accent">' + icon('shield') +
              '<span>Craft 在这个文件夹里只保存引用与摘要，不保存原文。</span></div></div></div>' +
            '<div class="grid-2">' + groups.map(function (group) { return section(group[0], group[1], group[2]); }).join('') + '</div>' +
          '</div>';
          aside = asideBlock('记录概览', '', asideRows(groups.map(function (group) { return [group[0], group[2].length]; }))) +
            asideBlock('下一步', '', '<div class="aside-note">' + esc(next === 'replan_session' ? '这个文件夹里的任务需要重新规划一次' : '暂时不需要额外处理') + '</div>');
        });
      } else if (selectedGroup) {
        //「默认」and folders the store has no record for have no brain snapshot
        // to read, so list the tasks hanging off them instead of an empty pane.
        detail = '<div class="stack">' +
          '<div class="card">' + head(selectedGroup.name, null, countChip(selectedGroup.tasks.length)) +
            '<div class="card-body tight"><div class="rows">' +
              (selectedGroup.tasks.length ? taskListRows(selectedGroup.tasks) : emptyState('还没有任务', null, 'tasks')) +
            '</div></div></div>' +
          (selectedGroup.key ? '<div class="callout warn">' + icon('alert') +
            '<span>这个文件夹还没有登记信息，所以看不到它的目标与成果，只能列出挂在它下面的任务。</span></div>' : '') +
        '</div>';
        aside = asideBlock('这个文件夹', '', asideRows([
          ['任务', selectedGroup.tasks.length],
          ['信息', selectedGroup.key ? '未登记' : '默认文件夹']
        ])) + asideBlock('说明', '', '<div class="aside-note">' +
          (selectedGroup.key
            ? '它只有任务，还没有登记过目标与成果。'
            : '新建任务时没有选文件夹，就会落到这里。') + '</div>');
      }

      return chain.then(function () {
        var actions = [{ label: '新建文件夹', icon: 'plus', run: openCreateProjectSheet }];
        if (selectedGroup && selectedGroup.known) {
          actions.push(['记一个目标', 'spark', function () {
            openInline({ title: '记一个目标', sub: selectedGroup.name, html:
              '<div class="stack"><div class="field"><label for="goal-title">目标</label><input id="goal-title" type="text" placeholder="让首屏加载进入 1 秒内"></div>' +
              '<div class="field"><label for="goal-metric">怎么算达成</label><input id="goal-metric" type="text" placeholder="首屏 p95 小于 1 秒"></div></div>',
              actions: [{ label: '保存', primary: true, run: addGoal }] });
          }]);
          actions.push(['记一个决策', 'check', function () {
            openInline({ title: '记一个决策', sub: selectedGroup.name, html:
              '<div class="stack"><div class="field"><label for="decision-title">决定了什么</label><input id="decision-title" type="text"></div>' +
              '<div class="field"><label for="decision-chosen">选了哪个方案</label><input id="decision-chosen" type="text"></div>' +
              '<div class="field"><label for="decision-rationale">为什么这么选</label><textarea id="decision-rationale"></textarea></div></div>',
              actions: [{ label: '保存', primary: true, run: addDecision }] });
          }]);
          actions.push(['加一份资料', 'file', function () {
            openInline({ title: '加一份资料', sub: selectedGroup.name, html:
              '<div class="stack"><div class="field"><label for="material-name">资料名称</label><input id="material-name" type="text" placeholder="接口设计文档"></div>' +
              '<div class="field"><label for="material-uri">文件位置</label><input id="material-uri" type="text" placeholder="D:\\docs\\spec.md"></div>' +
              '<div class="field"><label for="material-digest">内容指纹（可选）</label><input id="material-digest" type="text" placeholder="留空即可"></div></div>',
              actions: [{ label: '保存', primary: true, run: addMaterial }] });
          }]);
          actions.push(['记一个成果', 'layers', function () {
            openInline({ title: '记一个成果', sub: selectedGroup.name, html:
              '<div class="stack"><div class="field"><label for="outcome-verdict">结论</label><input id="outcome-verdict" type="text" placeholder="达成了 / 部分达成 / 没达成"></div>' +
              '<div class="field"><label for="outcome-summary">说明</label><textarea id="outcome-summary"></textarea></div></div>',
              actions: [{ label: '保存', primary: true, run: addOutcome }] });
          }]);
        }

        return {
          actions: actions.map(function (entry) {
            return Array.isArray(entry)
              ? { label: entry[0], icon: entry[1], run: entry[2] }
              : entry;
          }),
          html: '<div class="split">' +
            '<div class="card">' + head('文件夹', '把相关任务归到一起', countChip(groups.length)) +
              '<div class="card-body tight"><div class="rows">' + rows + '</div></div></div>' +
            detail + '</div>',
          aside: aside,
          mounts: [function (root) {
            root.querySelectorAll('[data-project]').forEach(function (row) {
              row.onclick = function () { state.selectedProject = row.getAttribute('data-project'); paint('projects'); };
            });
            root.querySelectorAll('[data-task]').forEach(function (row) {
              row.onclick = function () { openTask(row.getAttribute('data-task')); };
            });
          }]
        };
      });
    });
  }

  // -------------------------------------------------------------- task page
  // Everything on this page comes from GET /api/tasks/{id}, which already returns
  // human-readable fields (checkpoint.summary/completed/pending, outcome.verdict,
  // artifact.name, evidence.claim) — so the detail page needed no backend change.

  function folderNameOf(projectId) {
    if (!projectId) return '默认';
    var groups = state.folderGroups || [];
    for (var i = 0; i < groups.length; i += 1) {
      if (groups[i].key === String(projectId)) return groups[i].name;
    }
    return String(projectId);
  }

  function stageRows(stages, done) {
    return (stages || []).map(function (stage) {
      return '<div class="row">' + lead(done ? 'check' : 'dot', done ? 'success' : 'muted') +
        '<div class="row-main"><span class="row-title">' + esc(label(STAGE_LABELS, stage, stage)) + '</span></div></div>';
    }).join('');
  }

  function taskCard(title, sub, body, right) {
    return '<div class="card">' + head(title, sub, right) + '<div class="card-body">' + body + '</div></div>';
  }

  function viewTask() {
    var taskId = state.selectedTask;
    if (!taskId) {
      return Promise.resolve({
        html: '<div class="card"><div class="card-body">' +
          emptyState('还没有选中任务', '从左边的文件夹里点一个任务，看它的目标、进度、产物与验证结论', 'tasks') + '</div></div>',
        aside: asideBlock('任务是什么', '', '<div class="aside-note">一个任务是一次完整的工作：一个目标、一条执行过程、一份验证结论。</div>')
      });
    }
    return Promise.all([
      api('/api/tasks/' + encodeURIComponent(taskId)),
      settled(api('/api/workbench-experience?task_id=' + encodeURIComponent(taskId) + '&limit=100'), { sessions: [], launches: [], traces: [], outcomes: [], artifacts: [], timeline: [], next_action: '' })
    ]).then(function (results) {
      var detail = results[0], experience = results[1];
      var task = detail.task || {};
      var checkpoints = detail.checkpoints || [];
      var latest = checkpoints[0] || null;
      var outcomes = detail.outcomes || [];
      var artifacts = detail.artifacts || [];
      var evidence = detail.evidence || [];
      var trace = detail.trace || [];
      var messages = detail.messages || [];
      var hostRuns = detail.host_runs || [];
      var activity = detail.activity || [];
      var context = detail.context || {};
      var usage = messages.reduce(function (total, message) {
        var value = message.usage || {};
        return total + Number(value.total_tokens || value.input_tokens || 0) + Number(value.output_tokens || 0);
      }, 0);

      state.selectedTaskTitle = task.title || '';
      if (state.page === 'task') {
        var heading = state.selectedTaskTitle || '任务';
        $('page-title').textContent = heading;
        document.title = heading + ' · Craft Workbench';
      }

      var folder = folderNameOf(task.project_id);

      var goalCard = taskCard('目标', '文件夹：' + esc(folder),
        '<p class="doc-p">' + esc(task.goal || '这个任务还没有写下目标') + '</p>');

      var messageRows = messages.length ? messages.map(function (message) {
        var role = message.role === 'assistant' ? 'assistant' : 'user';
        return '<article class="task-message ' + role + '">' +
          '<div class="task-message-meta"><span>' + (role === 'assistant' ? 'Craft' : '你') + '</span><time>' + esc(shortTime(message.created_at)) + '</time></div>' +
          '<p>' + esc(message.content) + '</p></article>';
      }).join('') : emptyState('从这里开始任务', '写下第一句话后，Craft 会使用你选择的模型继续这条任务线程。', 'spark');
      var conversationCard = taskCard('对话', task.model_id ? '模型：' + esc(task.model_id) : '尚未选择模型',
        '<div class="task-thread">' + messageRows + '</div>' +
        '<div class="task-composer"><textarea id="task-message-input" rows="2" placeholder="继续这个任务…"></textarea>' +
          '<div class="task-composer-foot"><span>对话不会自行执行文件或外部操作</span><button class="btn primary" type="button" id="task-message-send">发送</button></div></div>');

      var progressCard;
      if (!latest) {
        progressCard = taskCard('进度', '还没有记录',
          emptyState('还没开始执行', '任务跑起来之后，每一步的进展都会记在这里', 'refresh'));
      } else {
        var stages = stageRows(latest.completed, true) + stageRows(latest.pending, false);
        progressCard = taskCard('进度', '最近一次记录 · ' + shortTime(latest.created_at),
          '<div class="stack">' +
            (latest.summary ? '<p class="doc-p">' + esc(latest.summary) + '</p>' : '') +
            (stages ? '<div class="rows">' + stages + '</div>' : '') +
          '</div>');
      }

      var verdictCard;
      if (!outcomes.length) {
        verdictCard = taskCard('结论', '还没有验收结论',
          '<p class="doc-p">任务完成后，Craft 会给出一条独立的验收结论。</p>');
      } else {
        var outcome = outcomes[0];
        verdictCard = taskCard('结论', null,
          '<div class="stack">' +
            '<div>' + statusPill(outcome.verdict) + '</div>' +
            (outcome.summary ? '<p class="doc-p">' + esc(outcome.summary) + '</p>' : '') +
            (outcome.failure_type ? '<p class="doc-p">没通过的原因：' + esc(outcome.failure_type) + '</p>' : '') +
          '</div>');
      }

      var artifactRows = artifacts.length ? artifacts.map(function (item) {
        return '<div class="row">' + lead('layers', 'accent') +
          '<div class="row-main"><span class="row-title">' +
            esc(item.kind === 'route_receipt' ? receiptName(item.name) : (item.name || item.id)) + '</span>' +
            (item.uri ? '<span class="row-sub mono">' + esc(item.uri) + '</span>' : '') + '</div>' +
          '<span class="row-time">' + esc(label(ARTIFACT_KIND_LABELS, item.kind, item.kind)) + '</span></div>';
      }).join('') : emptyState('还没有产物', '任务产生的文件、报告和代码改动都会列在这里', 'layers');

      var evidenceRows = evidence.length ? evidence.map(function (item) {
        return '<div class="row">' + lead('shield', item.confidence === 'confirmed' ? 'success' : 'muted') +
          '<div class="row-main"><span class="row-title">' + esc(item.claim || item.id) + '</span>' +
          (item.confidence
            ? '<span class="row-sub">依据强度：' + esc(label(CONFIDENCE_LABELS, item.confidence, item.confidence)) + '</span>'
            : '') + '</div></div>';
      }).join('') : emptyState('还没有验证记录', '每条站得住的结论都会在这里留下依据', 'shield');

      var traceRows = trace.length ? trace.map(function (item) {
        return '<div class="row">' + lead('dot', 'muted') +
          '<div class="row-main"><span class="row-title">' +
            esc(label(TRACE_LABELS, item.event_type, item.event_type)) + '</span></div>' +
          '<span class="row-time">' + esc(shortTime(item.created_at)) + '</span></div>';
      }).join('') : emptyState('还没有过程记录', null, 'dot');

      var activityRows = activity.length ? activity.map(function (item) {
        return '<div class="row"><span class="row-lead muted">' + icon('dot') + '</span><div class="row-main"><span class="row-title">' +
          esc(label(TRACE_LABELS, item.event_type, item.event_type)) + '</span>' +
          (item.run_id ? '<span class="row-sub mono">运行 ' + esc(item.run_id) + '</span>' : '') +
          '</div><span class="row-time">' + esc(shortTime(item.created_at)) + '</span></div>';
      }).join('') : emptyState('还没有活动记录', '真正发起对话或运行后，时间线会出现在这里。', 'dot');

      var observationTimeline = experience.timeline || [];
      var observationRows = observationTimeline.length ? observationTimeline.map(function (item) {
        return '<div class="row">' + lead('dot', 'muted') + '<div class="row-main"><span class="row-title">' +
          esc(label(TRACE_LABELS, item.event_kind, item.event_kind || '执行事件')) + '</span><span class="row-sub mono">链路 ' + esc(item.trace_id || '—') + ' · #' + esc(item.sequence || '—') + '</span></div>' +
          '<span class="row-time">' + esc(shortTime(item.created_at)) + '</span></div>';
      }).join('') : emptyState('还没有链路事件', '当任务通过受控执行路径运行时，事件会按顺序记录在这里。', 'dot');
      var hostRunRows = hostRuns.length ? hostRuns.map(function (run) {
        return '<div class="row">' + lead('play', run.status === 'completed' ? 'success' : 'muted') + '<div class="row-main"><span class="row-title">' + esc(run.host || '本机运行') + '</span><span class="row-sub mono">' + esc(run.id || '—') + ' · ' + esc(run.event_count || 0) + ' 条事件</span></div>' + statusPill(run.status) + '</div>';
      }).join('') : emptyState('还没有执行运行', '模型对话已经记录在上方；文件、命令等受控运行开始后会在这里显示。', 'play');
      var observeCard = taskCard('观测', '日志、链路追踪与指标',
        '<div class="metrics"><div class="stat"><div class="stat-body"><b>' + esc(messages.length) + '</b><span>对话消息</span></div></div><div class="stat"><div class="stat-body"><b>' + esc(hostRuns.length) + '</b><span>受控运行</span></div></div><div class="stat"><div class="stat-body"><b>' + esc((experience.traces || []).length) + '</b><span>链路</span></div></div><div class="stat"><div class="stat-body"><b>' + esc(usage || 0) + '</b><span>已记录 Token</span></div></div></div>' +
        '<details class="task-observe-fold" open><summary>运行记录与日志</summary><div class="rows">' + hostRunRows + '</div></details>' +
        '<details class="task-observe-fold" open><summary>链路追踪</summary><div class="rows">' + observationRows + '</div></details>');
      var memories = context.memories || [], knowledge = context.knowledge || [], workflows = context.workflows || [], workflowRuns = context.workflow_runs || [], manifests = context.manifests || [];
      var memoryRows = memories.length ? memories.map(function (item) { return '<div class="row">' + lead('db', 'muted') + '<div class="row-main"><span class="row-title">' + esc(item.content || item.id) + '</span><span class="row-sub">' + esc([item.kind, item.source].filter(Boolean).join(' · ')) + '</span></div></div>'; }).join('') : emptyState('没有任务短期记忆', '任务显式记录的有效记忆会显示在这里。', 'db');
      var knowledgeRows = knowledge.length ? knowledge.map(function (item) { return '<div class="row">' + lead('layers', 'muted') + '<div class="row-main"><span class="row-title">' + esc(item.content || item.id) + '</span><span class="row-sub">' + esc(label(STATUS_LABELS, item.status, item.status || '—')) + '</span></div></div>'; }).join('') : emptyState('没有任务知识', '从这个任务中提取且绑定到该任务的知识会显示在这里。', 'layers');
      var workflowRows = workflowRuns.length ? workflowRuns.map(function (item) { return '<div class="row">' + lead('refresh', 'muted') + '<div class="row-main"><span class="row-title">' + esc(item.workflow_id || item.id) + '</span><span class="row-sub">' + esc(shortTime(item.updated_at)) + '</span></div>' + statusPill(item.status) + '</div>'; }).join('') : emptyState('没有任务工作流', workflows.length || manifests.length ? '已有关联上下文，但没有可展示的工作流运行。' : '通过工作流运行该任务后，记录会显示在这里。', 'refresh');
      var contextCard = taskCard('任务上下文', '短期记忆、知识与工作流',
        '<details class="task-observe-fold" open><summary>短期记忆 · ' + esc(memories.length) + '</summary><div class="rows">' + memoryRows + '</div></details>' +
        '<details class="task-observe-fold"><summary>任务知识 · ' + esc(knowledge.length) + '</summary><div class="rows">' + knowledgeRows + '</div></details>' +
        '<details class="task-observe-fold"><summary>工作流与上下文清单 · ' + esc(workflowRuns.length + manifests.length) + '</summary><div class="rows">' + workflowRows + '</div></details>');

      var pending = (latest && latest.pending) || [];
      var aside = asideCollapsible('任务信息', asideRows([
        ['状态', label(STATUS_LABELS, task.status, task.status || '—')],
        ['文件夹', folder],
        ['模型', task.model_id || '—'],
        ['权限', label(TASK_PERMISSION_LABELS, task.permission_mode, '手动审批')],
        ['创建时间', shortTime(task.created_at) || '—'],
        ['最近更新', shortTime(task.updated_at) || '—']
      ])) +
      asideCollapsible('查看说明', '<div class="aside-note">' +
        '目标＝这件事要达成什么；进度＝最近一次做到哪一步；结论＝独立验收的结果；' +
        '产物＝产出的文件与代码改动；验证＝每条结论的依据；活动＝对话与运行过程中发生的事。</div>') +
      (pending.length ? asideCollapsible('还剩 ' + pending.length + ' 步', '<div class="aside-note">' +
        pending.map(function (stage) { return esc(label(STAGE_LABELS, stage, stage)); }).join('、') + '</div>') : '');

      return {
        html: '<div class="stack task-page">' + goalCard + conversationCard + observeCard + contextCard +
          taskCard('活动', (hostRuns.length ? hostRuns.length + ' 次运行' : '暂无运行'), '<div class="rows">' + activityRows + '</div>') +
          '<div class="grid-2">' + progressCard + verdictCard + '</div>' +
          taskCard('产物', artifacts.length + ' 项', '<div class="rows">' + artifactRows + '</div>') +
          '<div class="grid-2">' +
            taskCard('验证', evidence.length + ' 条依据', '<div class="rows">' + evidenceRows + '</div>') +
            taskCard('过程', trace.length + ' 条', '<div class="rows">' + traceRows + '</div>') +
          '</div></div>',
        aside: aside,
        mounts: [function (root) {
          var input = root.querySelector('#task-message-input');
          var send = root.querySelector('#task-message-send');
          if (!input || !send) return;
          function submit() {
            var content = String(input.value || '').trim();
            if (!content) { toast('写点内容再发送', true); return; }
            send.disabled = true; input.disabled = true;
            api('/api/tasks/' + encodeURIComponent(taskId) + '/messages', { method: 'POST', body: { content: content } })
              .then(function () { paint('task'); }).catch(function (error) { send.disabled = false; input.disabled = false; fail(error); });
          }
          send.onclick = submit;
          input.onkeydown = function (event) { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); submit(); } };
        }],
        actions: taskPageActions(task),
      };
    });
  }

  // ------------------------------------------------------------- capabilities

  var SOURCE_KINDS = [
    { key: 'plugins', label: '插件市场', icon: 'plug', hint: '从一个 Git 仓库或能力市场里获取插件与 Skill。填仓库地址即可。',
      kinds: [['github_skill', 'GitHub 仓库']],
      fields: [['git-url', '仓库地址', 'https://github.com/wdx9413/craft']] },
    { key: 'skills', label: 'Skill 集市', icon: 'db', hint: '外部 Skill 来源。Craft 只登记来源与摘要，不会自动下载或运行。',
      kinds: [['github_skill', 'GitHub 仓库'], ['volcengine_skill', '火山引擎']],
      fields: [['git-url', '来源地址', 'https://github.com/example/skills']] },
    { key: 'mcp', label: 'MCP 服务', icon: 'server', hint: '一个 MCP 服务，可以是在本机启动的命令，也可以是一个在线地址。',
      kinds: [['mcp_stdio', '本机启动的命令'], ['mcp_http', '在线地址（HTTPS）'], ['serena_mcp', 'Serena（只读）']],
      fields: [['git-url', '启动命令或服务地址', 'npx -y @modelcontextprotocol/server-filesystem D:\\docs']] },
    { key: 'local', label: '本机文件夹', icon: 'folder', hint: '把本机的一个文件夹作为能力来源，扫描后即可被 Craft 检索。',
      kinds: [], fields: [] }
  ];

  var activeSource = 'plugins';

  function registerSource() {
    var name = val('source-name');
    if (!name) { toast('名称不能为空', true); return; }
    if (activeSource === 'local') {
      api('/api/sources', { method: 'POST', body: { path: val('source-path'), label: name, scan: checked('source-scan'), priority: 0 } })
        .then(function () { toast('已添加本机文件夹'); paint('connectors'); }).catch(fail);
      return;
    }
    var body = { kind: val('source-kind'), name: name, endpoint: val('source-endpoint') || undefined,
      approved: true, approval_ref: 'workbench-user-approval',
      metadata: { registered_from: 'craft-workbench', note: val('source-note') || undefined } };
    var ops = val('source-ops');
    if (ops) body.allowed_operations = ops.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    api('/api/connectors', { method: 'POST', body: body })
      .then(function () {
        toast('已添加来源「' + name + '」');
        // Not an interstitial any more: the next step is a card at the top of
        // the column, right next to the list of sources it refers to.
        openInlineOn('connectors', {
          title: '来源已添加',
          sub: name,
          html: '<div class="callout info">' + icon('arrow') + '<span>下一步：点该来源上的「扫描可用能力」，把里面的能力登记进来。扫描只是登记，不会下载也不会运行。</span></div>' +
            '<div class="aside-note">Craft 只保存来源信息与摘要，不保存任何密码或密钥。</div>',
          actions: [{ label: '知道了', primary: true, run: function () { dismissInline('connectors'); } }]
        });
      }).catch(fail);
  }

  function discoverAssets(connectorId) {
    var raw = ($('discover-lines') ? $('discover-lines').value : '') || '';
    var assets = raw.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean).map(function (line, index) {
      var parts = line.split('|').map(function (x) { return x.trim(); });
      return {
        logical_id: parts[1] || (connectorId + ':asset:' + (index + 1)),
        name: parts[2] || parts[1] || '能力 ' + (index + 1),
        asset_type: fromLabel(ASSET_TYPE_LABELS, parts[0], 'skill'),
        effect: fromLabel(EFFECT_LABELS, parts[3], 'read_only'),
        summary: parts[4] || undefined,
        aliases: []
      };
    });
    if (!assets.length) { toast('请至少填写一个能力', true); return; }
    api('/api/connectors/' + encodeURIComponent(connectorId) + '/discover', { method: 'POST', body: { assets: assets } })
      .then(function () { clearInline(); toast('资产已登记，等待审批'); paint('connectors'); })
      .catch(fail);
  }

  function viewCapabilities() {
    return Promise.all([api('/api/connectors?limit=100'), settled(api('/api/sources'), { sources: [] })]).then(function (results) {
      var connectors = results[0].connectors || [], assets = results[0].assets || [], sources = results[1].sources || [];
      var spec = SOURCE_KINDS.filter(function (item) { return item.key === activeSource; })[0];

      var form = activeSource === 'local'
        ? '<div class="field-row">' +
            '<div class="field"><label for="source-name">名称</label><input id="source-name" type="text" placeholder="我的技能库"></div>' +
            '<div class="field"><label for="source-path">文件夹路径</label><input id="source-path" type="text" placeholder="D:\\skills"></div>' +
          '</div>' +
          '<label class="check"><input id="source-scan" type="checkbox" checked> 添加后立即扫描一次</label>'
        : '<div class="field-row">' +
            '<div class="field"><label for="source-name">名称</label><input id="source-name" type="text" placeholder="craft 插件市场"></div>' +
            '<div class="field"><label for="source-kind">类型</label><select id="source-kind">' + options(spec.kinds, spec.kinds[0][0]) + '</select></div>' +
          '</div>' +
          '<div class="field"><label for="source-endpoint">' + esc(spec.fields[0][1]) + '</label>' +
            '<input id="source-endpoint" type="text" placeholder="' + esc(spec.fields[0][2]) + '"></div>' +
          '<div class="field"><label for="source-ops">允许 Craft 做的操作（可选，逗号分隔）</label>' +
            '<input id="source-ops" type="text" placeholder="inspect, read">' +
            '<span class="hint">留空表示按 Craft 的默认策略放开；填了就只允许这些操作。</span></div>' +
          '<div class="field"><label for="source-note">备注（可选）</label><input id="source-note" type="text" placeholder="为什么要接入这个来源"></div>';

      var tabs = '<div class="tabs" id="source-tabs">' + SOURCE_KINDS.map(function (item) {
        return '<button class="tab-btn" type="button" data-source="' + item.key + '" aria-selected="' + (item.key === activeSource) + '">' + esc(item.label) + '</button>';
      }).join('') + '</div>';

      var pendingAssets = assets.filter(function (asset) { return asset.status === 'discovered'; });

      var connectorRows = connectors.length
        ? connectors.map(function (item) {
            var own = assets.filter(function (asset) { return asset.connector_id === item.id; });
            var assetRows = own.length ? own.map(function (asset) {
              var actions = asset.status === 'discovered'
                ? '<div class="row-actions"><button class="btn sm primary" data-approve-asset="' + esc(asset.id) + '">' + icon('check') + '确认可用</button></div>'
                : '<div class="row-actions">' + pill(label(STATUS_LABELS, asset.status, '已确认'), asset.status === 'approved' ? 'ok' : '') + '</div>';
              return '<div class="row">' + lead('db', 'muted') + '<div class="row-main"><span class="row-title">' + esc(asset.name) + '</span>' +
                '<span class="row-sub">' + esc(label(ASSET_TYPE_LABELS, asset.asset_type, asset.asset_type)) + '</span></div>' +
                effectPill(asset.effect) + actions + '</div>';
            }).join('') : emptyState('还没有扫描到条目', '点「扫描可用能力」把该来源里的能力登记进来', 'inbox');
            var healthTone = item.health === 'healthy' ? 'ok' : (item.health === 'unhealthy' ? 'danger' : '');
            return '<div class="card">' + head(item.name, '外部能力来源',
                '<div class="row-actions">' + statusPill(item.status) +
                (item.health ? pill(label(HEALTH_LABELS, item.health), healthTone) : '') +
                '<button class="btn sm" data-discover="' + esc(item.id) + '">' + icon('plus') + '扫描可用能力</button>' +
                '<button class="btn sm" data-toggle="' + esc(item.id) + '" data-active="' + (item.status === 'active') + '">' + (item.status === 'active' ? '停用' : '启用') + '</button>' +
                '<button class="btn sm danger" data-revoke="' + esc(item.id) + '">移除</button></div>') +
              '<div class="card-body tight"><div class="rows">' + assetRows + '</div></div></div>';
          }).join('')
        : '<div class="card"><div class="card-body">' + emptyState('还没有添加任何外部能力', '在上方选择一种来源，把 Craft 还不会做的事接进来', 'plug') + '</div></div>';

      var sourceRows = sources.length
        ? '<div class="rows">' + sources.map(function (item) {
            return '<div class="row">' + lead('folder', 'muted') + '<div class="row-main"><span class="row-title">' + esc(item.label || item.id) + '</span>' +
              '<span class="row-sub mono">' + esc(item.path || '') + '</span></div>' +
              pill(item.enabled === false ? '已停用' : '已启用', item.enabled === false ? '' : 'ok') + '</div>';
          }).join('') + '</div>'
        : emptyState('没有挂载本地能力目录', '切到「本地目录」标签即可挂载', 'folder');

      var setupCard = state.capabilitySetupOpen
        ? '<div class="card">' + head('添加能力来源', esc(spec.hint),
            '<button class="btn" id="source-setup-close" type="button">完成</button>' +
            '<button class="btn primary" id="source-register" type="button">' + (activeSource === 'local' ? icon('folder') + '添加文件夹' : icon('plus') + '添加来源') + '</button>') +
            '<div class="card-body"><div class="stack">' + tabs + form +
            '<div class="callout info">' + icon('shield') + '<span>外部来源需要你点一下确认才生效。Craft 只保存来源信息与摘要，不保存任何密码或密钥，也不会替你安装或启动服务。</span></div>' +
            '</div></div></div>'
        : '<div class="card">' + head('能力来源', '把已确认的本机目录、插件或 MCP 服务接入任务',
            '<div class="row-actions"><button class="btn" id="connector-config-upload" type="button">' + icon('file') + '导入配置</button><input id="connector-config-file" type="file" accept="application/json,.json" hidden><button class="btn primary" id="source-setup-open" type="button">' + icon('plus') + '添加来源</button></div>') +
            '<div class="card-body"><div class="source-summary">' +
              '<div><b>' + esc(connectors.length) + '</b><span>外部来源</span></div>' +
              '<div><b>' + esc(sources.length) + '</b><span>本机目录</span></div>' +
              '<div><b>' + esc(assets.length) + '</b><span>已登记能力</span></div>' +
            '</div><p class="doc-p">来源只在你添加并确认后才会可用；这里不会预置演示数据或自动安装任何东西。</p></div></div>';

      return {
        html: '<div class="stack">' +
          setupCard +
          connectorRows +
          '<div class="card">' + head('本机能力文件夹', '扫描结果会进入能力检索，做任务时可以直接用', countChip(sources.length)) +
            '<div class="card-body tight">' + sourceRows + '</div></div>' +
        '</div>',
        aside: asideBlock('已有来源', String(connectors.length),
            connectors.length
              ? '<div class="aside-list">' + connectors.map(function (item) {
                  return '<div class="aside-row"><span class="k">' + esc(item.name) + '</span>' + statusPill(item.status) + '</div>';
                }).join('') + '</div>'
              : '<div class="aside-note">还没有添加任何外部能力来源。</div>') +
          asideBlock('等你确认的能力', String(pendingAssets.length),
            '<div class="aside-note">' + (pendingAssets.length ? '有' + pendingAssets.length + '个能力等你确认，确认后才可以被使用。' : '没有等待确认的能力。') + '</div>') +
          asideBlock('本机能力文件夹', String(sources.length),
            sources.length
              ? '<div class="aside-list">' + sources.map(function (item) {
                  return '<div class="aside-row"><span class="k">' + esc(item.label || item.id) + '</span><span class="v">' + esc(item.enabled === false ? '已停用' : '已启用') + '</span></div>';
                }).join('') + '</div>'
              : '<div class="aside-note">没有添加本机能力文件夹。</div>'),
        mounts: [function (root) {
          var setupOpen = root.querySelector('#source-setup-open');
          if (setupOpen) setupOpen.onclick = function () { state.capabilitySetupOpen = true; paint('connectors'); };
          var configUpload = root.querySelector('#connector-config-upload'), configFile = root.querySelector('#connector-config-file');
          if (configUpload && configFile) { configUpload.onclick = function () { configFile.click(); }; configFile.onchange = function () { readUpload(configFile, ['json'], function (content) { try { var config = JSON.parse(content); api('/api/connectors', { method: 'POST', body: { kind: config.kind, name: config.name, endpoint: config.endpoint, allowed_operations: config.allowed_operations, approved: true, approval_ref: 'studio-user-import', metadata: { imported_from: 'user_file' } } }).then(function () { toast('连接器配置已导入，等待扫描与审核'); paint('connectors'); }).catch(fail); } catch (_) { toast('连接器配置不是有效 JSON', true); } }); }; }
          var setupClose = root.querySelector('#source-setup-close');
          if (setupClose) setupClose.onclick = function () { state.capabilitySetupOpen = false; paint('connectors'); };
          var register = root.querySelector('#source-register');
          if (register) register.onclick = registerSource;
          var sourceTabs = root.querySelector('#source-tabs');
          if (sourceTabs) sourceTabs.onclick = function (event) {
            var tab = event.target.closest('[data-source]');
            if (tab) { activeSource = tab.getAttribute('data-source'); paint('connectors'); }
          };
          root.querySelectorAll('[data-discover]').forEach(function (button) {
            button.onclick = function () {
              var id = button.getAttribute('data-discover');
              openInline({
                title: '扫描可用能力', sub: '手动登记这个来源里有哪些能力',
                html: '<div class="field"><label for="discover-lines">每行一个能力，用竖线分成 5 段：<b>类型 | 唯一标识 | 名称 | 影响范围 | 一句话说明</b></label>' +
                  '<textarea id="discover-lines" class="tall" placeholder="skill | your-skill-id | 能力名称 | read_only | 一句话说明"></textarea>' +
                  '<span class="hint">类型可填：Skill、MCP 服务、工具、工作流、适配器、校验器、评分器、评测集。影响范围可填：仅查看 / 可改本机文件 / 会对外发送 / 有破坏性。</span></div>',
                actions: [{ label: '确认登记', primary: true, run: function () { discoverAssets(id); } }]
              });
            };
          });
          root.querySelectorAll('[data-approve-asset]').forEach(function (button) {
            button.onclick = function () {
              var id = button.getAttribute('data-approve-asset');
              api('/api/connector-assets/' + encodeURIComponent(id) + '/approve', { method: 'POST', body: { approval_ref: 'workbench-user-approval' } })
                .then(function () { toast('已确认可用'); paint('connectors'); }).catch(fail);
            };
          });
          root.querySelectorAll('[data-toggle]').forEach(function (button) {
            button.onclick = function () {
              var id = button.getAttribute('data-toggle');
              api('/api/connectors/' + encodeURIComponent(id) + '/status', { method: 'POST', body: { active: button.getAttribute('data-active') !== 'true' } })
                .then(function () { paint('connectors'); }).catch(fail);
            };
          });
          root.querySelectorAll('[data-revoke]').forEach(function (button) {
            button.onclick = function () {
              var id = button.getAttribute('data-revoke');
              // Still confirmed before it runs — but in the column, not with a
              // browser dialog the app cannot style or explain.
              openInline({
                title: '撤销这个来源？', sub: id,
                html: '<div class="callout warn">' + icon('alert') + '<span>撤销后，这个来源上已经确认可用的能力会全部失效，用到它们的任务不能再调用。本机文件不会被删除。</span></div>',
                actions: [
                  { label: '取消', run: function () { clearInline(); paint('connectors'); } },
                  { label: '确认撤销', primary: true, danger: true, run: function () {
                    api('/api/connectors/' + encodeURIComponent(id) + '/revoke', { method: 'POST', body: { reason: 'revoked from Craft Workbench' } })
                      .then(function () { clearInline(); toast('已撤销'); paint('connectors'); }).catch(fail);
                  } }
                ]
              });
            };
          });
        }]
      };
    });
  }

  // --------------------------------------------------------- resource pages
  // The storage layer is plugin-oriented, but people do not think in storage
  // tables.  These views are intentionally separate, while projecting the same
  // local records that the connector and knowledge kernels already manage.

  function catalogRows(items, iconName, title, sub) {
    return items.length ? '<div class="rows">' + items.map(function (item) {
      return '<div class="row">' + lead(iconName, 'muted') + '<div class="row-main"><span class="row-title">' + esc(title(item)) + '</span>' +
        (sub(item) ? '<span class="row-sub">' + esc(sub(item)) + '</span>' : '') + '</div>' +
        (item.status ? statusPill(item.status) : '') + '</div>';
    }).join('') + '</div>' : '';
  }

  function viewPlugins() {
    return Promise.all([api('/api/connectors?limit=100'), api('/api/workbench/resources?kind=plugins&limit=100')]).then(function (results) {
      var connectors = (results[0].connectors || []).filter(function (item) { return item.kind === 'github_skill'; });
      var assets = results[0].assets || [], installed = results[1].items || [];
      var sourceRows = catalogRows(connectors, 'plug', function (item) { return item.name || item.id; }, function (item) {
        var count = assets.filter(function (asset) { return asset.connector_id === item.id; }).length;
        return 'GitHub 来源 · 已登记 ' + count + ' 项';
      });
      var installedRows = catalogRows(installed, 'plug', function (item) { return item.name + ' · v' + item.package_version; }, function (item) { return item.description || '本机插件清单'; });
      return {
        html: '<div class="stack"><div class="card">' + head('已安装插件', '本机插件清单；每个包的技能与连接器仍需独立确认',
          '<div class="row-actions"><button class="btn" id="plugins-add" type="button">' + icon('plus') + '添加来源</button><button class="btn primary" id="plugin-upload" type="button">' + icon('file') + '上传 plugin.json</button><input id="plugin-file" type="file" accept="application/json,.json" hidden></div>') +
          '<div class="card-body">' + (installedRows || emptyState('还没有本机插件', '上传一个 plugin.json，或添加一个 Marketplace / GitHub 来源。', 'plug')) + '</div></div>' +
          '<div class="card">' + head('插件来源', '来自已连接的市场或 GitHub', countChip(connectors.length)) + '<div class="card-body">' + (sourceRows || emptyState('还没有插件来源', '添加来源后可扫描并确认其中的能力。', 'plug')) + '</div></div></div>',
        aside: asideBlock('安装边界', '', '<div class="aside-note">上传 manifest 只安装描述，不执行上传文件中的代码。技能与连接器必须分别安装、审核和启用。</div>'),
        mounts: [function (root) {
          var button = root.querySelector('#plugins-add'); if (button) button.onclick = function () { activeSource = 'plugins'; state.capabilitySetupOpen = true; go('connectors'); };
          var upload = root.querySelector('#plugin-upload'), file = root.querySelector('#plugin-file');
          if (upload && file) { upload.onclick = function () { file.click(); }; file.onchange = function () { readUpload(file, ['json'], function (content) { try { var manifest = JSON.parse(content); api('/api/workbench/plugins', { method: 'POST', body: { manifest: manifest } }).then(function () { toast('插件清单已安装'); paint('plugins'); }).catch(fail); } catch (_) { toast('plugin.json 不是有效 JSON', true); } }); }; }
        }]
      };
    });
  }

  // 「待我批准」是本版新增的持久入口。此前运行时的核心卖点是审批门禁，但
  // Studio 没有任何待办审批的落点：批准决定只经由会话临时状态存在，刷新即
  // 消失。这里直接消费 /api/inbox（refresh/decide），它本来就是持久化投影，
  // 因此不需要任何内核改动。
  //
  // 卡片字段以 src/attention.ts 的 Candidate 类型为准：id / source_kind /
  // priority(数字) / reason / action / audience / details。decide 只接受
  // acknowledge 与 defer 两种决定，推迟必须给出未来的 deferred_until。
  var ATTENTION_ACTIONS = { approve: '批准', resume: '恢复', retry: '重试', review: '审核', decide: '决定' };

  function attentionActionLabel(action) { return label(ATTENTION_ACTIONS, action, action); }

  function attentionDetail(card) {
    var details = card.details || {};
    var parts = [];
    if (details.workspace) parts.push(String(details.workspace));
    if (details.task_id) parts.push('任务 ' + String(details.task_id));
    return parts.join(' · ');
  }

  // 文档 7.1：订阅是长期授权，不是一个开关。这一页必须让四件事同时看得见——
  // 允许的动作范围、最高风险等级、有效期、以及它过去真的做过什么。
  // 文档 9：裁决面按「决策类型」生成，不按 schema 生成。
  // schema 只能告诉你这是个枚举，永远告诉不了你「这里该并排展示两个版本的 diff」。
  // 所以每个 decision_kind 有自己的渲染器；未注册的类型由后端拒绝，不会退化成通用表单。
  function renderDecisionControl(control) {
    switch (control.renderer) {
      case 'comparison':
        // 二选一 → 并排对比：差异本身就是界面。
        return '<div class="decision-compare">' + control.options.map(function (option) {
          return '<div class="decision-option"><b>' + esc(option.label) + '</b>' +
            (option.detail ? '<span>' + esc(option.detail) + '</span>' : '') + '</div>';
        }).join('') + '</div>';
      case 'threshold_slider':
        // 阈值取舍 → 单滑块 + 实时预览。
        return '<div class="decision-slider"><input type="range" min="0" max="100" value="50" ' +
          'oninput="this.nextElementSibling.textContent=this.value" aria-label="阈值">' +
          '<output>50</output></div>';
      case 'diff_view':
        // 多字段校验 → diff 视图，差异高亮。
        return '<div class="decision-diff">' + (control.fields || []).map(function (field) {
          return '<div class="decision-line"><span class="sign">±</span>' + esc(field.label) + '</div>';
        }).join('') + '</div>';
      case 'release_summary':
        // 放行 → 凭证摘要 + 显式确认。
        return '<div class="decision-receipt"><span>凭证摘要：' + esc(control.summary) + '</span>' +
          '<em>放行前请确认这是你看到的那个状态</em></div>';
      case 'inline_tuning':
        // 参数微调 → 原地展开，不跳回原系统。
        return '<div class="decision-inline">' + (control.fields || []).map(function (field) {
          return '<label><span>' + esc(field.label) + '</span><input data-field="' + esc(field.name) + '"></label>';
        }).join('') + '</div>';
      case 'field_form':
        // 信息补全 → 结构化表单（不是自由对话，见 5.3）。
        return '<div class="decision-form">' + (control.fields || []).map(function (field) {
          var input = field.value_kind === 'boolean' ? '<input type="checkbox" data-field="' + esc(field.name) + '">'
            : '<input type="' + (field.value_kind === 'number' ? 'number' : 'text') + '" data-field="' + esc(field.name) + '">';
          return '<label><span>' + esc(field.label) + '</span>' + input + '</label>';
        }).join('') + '</div>';
      default:
        // 后端已经拒绝未注册类型，能走到这里说明前后端注册表不一致；宁可显式报错，
        // 也不要悄悄渲染成一个通用表单。
        return '<div class="decision-unknown">未知的裁决形态：' + esc(String(control.renderer)) + '</div>';
    }
  }

  function viewSubscriptions() {
    return api('/api/subscriptions').then(function (result) {
      var items = result.subscriptions || [];
      var stateTone = function (item) {
        if (item.state === 'revoked') return 'muted';
        if (item.state === 'expired' || item.expired) return 'warn';
        if (item.state === 'suspended') return 'danger';
        return 'ok';
      };
      var stateLabel = function (item) {
        if (item.state === 'revoked') return '已撤销';
        if (item.state === 'suspended') return '已挂起';
        // A lapsed subscription reads as expired even before a sweep touches it.
        if (item.state === 'expired' || item.expired) return '已过期';
        return '生效中';
      };
      var rows = items.length ? items.map(function (item) {
        var risk = 'R0 → ' + esc(String(item.max_risk_level || 'R0'));
        var expiry = shortTime(item.expires_at);
        var confirmations = Number(item.confirmations || 0);
        return '<div class="row"><div class="row-main">' +
          '<span class="row-title">' + esc(item.subscription_id) + '</span>' +
          '<span class="row-sub">触发 ' + esc(JSON.stringify(item.trigger)) + ' · 允许 ' +
          esc((item.allowed_actions || []).join('、')) + ' · 风险上限 ' + risk +
          ' · 有效至 ' + esc(expiry) + ' · 触发 ' + esc(String(item.dispatches || 0)) +
          ' 次（失败 ' + esc(String(item.failures || 0)) + '）' +
          // 一次都没重新确认过的订阅最容易跑过当初批准它的那个情境。
          (confirmations ? ' · 已确认 ' + esc(String(confirmations)) + ' 次' : ' · 从未重新确认') +
          '</span></div>' + pill(stateLabel(item), stateTone(item)) +
          '<div class="row-actions">' +
          '<button class="btn" type="button" data-sub-audit="' + esc(item.subscription_id) + '">历史</button>' +
          '<button class="btn" type="button" data-sub-reconfirm="' + esc(item.subscription_id) + '">重新确认</button>' +
          (item.state === 'revoked' ? '' : '<button class="btn danger" type="button" data-sub-revoke="' + esc(item.subscription_id) + '">撤销</button>') +
          '</div><div class="row-detail" data-sub-detail="' + esc(item.subscription_id) + '"></div></div>';
      }).join('') : emptyState('还没有订阅', '事件订阅会让系统在你不在场时自动开始工作，所以它必须是一条有期限、可撤销的授权记录。', 'refresh');

      return {
        html: '<div class="stack"><div class="card">' +
          head('订阅即授权', '它说「这类事件可以自动开始工作」，不说「这些工作可以跳过裁决」', countChip(items.length)) +
          '<div class="card-body"><div class="rows">' + rows + '</div></div></div></div>',
        aside: asideBlock('为什么订阅单列一页', '', '<div class="aside-note">批准一个动作是「我批准这件事做」，责任清楚、一次性；订阅是「我批准这类事以后自动做」。' +
          '后者是一张长期支票，所以它必须带范围、风险上限和期限，并且到期只能由人重新确认。</div>'),
        mounts: [function (root) {
          Array.prototype.forEach.call(root.querySelectorAll('[data-sub-audit]'), function (button) {
            button.onclick = function () {
              var id = button.getAttribute('data-sub-audit');
              var slot = root.querySelector('[data-sub-detail="' + id + '"]');
              if (!slot) return;
              api('/api/subscriptions/audit?subscription_id=' + encodeURIComponent(id)).then(function (audit) {
                var summary = audit.summary || {};
                var refusals = (audit.refusals || []).map(function (item) {
                  return esc(item.action) + '（' + esc(item.risk_level) + '）被拒：' + esc(item.reason || '');
                });
                var failures = (audit.failure_history || []).map(function (item) {
                  return esc(item.action) + ' 于 ' + esc(shortTime(item.at)) + ' 失败';
                });
                slot.innerHTML = '<pre>触发 ' + esc(String(summary.dispatches || 0)) +
                  ' 次 · 失败 ' + esc(String(summary.failures || 0)) +
                  ' 次 · 被拒 ' + esc(String(summary.refusals || 0)) +
                  ' 次 · 重新确认 ' + esc(String(summary.confirmations || 0)) + ' 次' +
                  (summary.never_reconfirmed ? '\n从未重新确认过' : '') +
                  (refusals.length ? '\n\n被拒记录：\n' + refusals.join('\n') : '') +
                  (failures.length ? '\n\n失败记录：\n' + failures.join('\n') : '') + '</pre>';
              }).catch(function (error) { slot.textContent = error.message; });
            };
          });
          Array.prototype.forEach.call(root.querySelectorAll('[data-sub-reconfirm]'), function (button) {
            button.onclick = function () {
              var id = button.getAttribute('data-sub-reconfirm');
              // 到期只能重新确认，不得自动续期：所以期限必须由人重新给出。
              var days = window.prompt('重新确认：这次有效多少天？', '30');
              if (!days) return;
              var parsed = parseInt(days, 10);
              if (!parsed || parsed < 1) { toast('请填写一个正整数天数'); return; }
              button.disabled = true;
              var now = new Date();
              api('/api/subscriptions/reconfirm', { method: 'POST', body: JSON.stringify({
                subscription_id: id, reconfirmed_at: now.toISOString(),
                expires_at: new Date(now.getTime() + parsed * 86400000).toISOString(),
                reconfirmed_by: 'workbench-user'
              }) })
                .then(function () { toast('已重新确认 ' + parsed + ' 天'); paint('subscriptions'); })
                .catch(function (error) { button.disabled = false; fail(error); });
            };
          });
          Array.prototype.forEach.call(root.querySelectorAll('[data-sub-revoke]'), function (button) {
            button.onclick = function () {
              var id = button.getAttribute('data-sub-revoke');
              var reason = window.prompt('撤销理由（会记入授权记录）：', '');
              if (reason === null) return;
              if (!reason) { toast('需要填写撤销理由'); return; }
              button.disabled = true;
              api('/api/subscriptions/revoke', { method: 'POST', body: JSON.stringify({
                subscription_id: id, revoked_by: 'workbench-user',
                revoked_at: new Date().toISOString(), revocation_reason: reason
              }) })
                .then(function () { toast('已撤销'); paint('subscriptions'); })
                .catch(function (error) { button.disabled = false; fail(error); });
            };
          });
        }]
      };
    });
  }

  // 文档 8 / 15.3：对象轨 + 对象页 + 凭证面板。三块，就三块。
  // 左侧永不重排（按 bucket → priority → id 稳定排序，由 object-rail 内核给出）；
  // 中央一次只放一个待裁决项；右侧默认只显示结论，展开是原始值与复算路径。
  function viewObjects() {
    var selected = state.selectedObject || null;
    var query = selected ? '?object_id=' + encodeURIComponent(selected) : '';
    return api('/api/objects' + query).then(function (rail) {
      var counts = rail.counts || {};
      var focus = rail.focus;

      var groupOf = function (bucket, label, tone) {
        var items = (rail.rail || []).filter(function (item) { return item.bucket === bucket; });
        if (!items.length) return '';
        var rows = items.map(function (item) {
          var isFocus = focus && focus.id === item.id;
          var actions = item.bucket === 'needs_you'
            ? '<button class="btn primary" type="button" data-open-object="' + esc(item.id) + '">去看</button>'
            : '<button class="btn" type="button" data-open-object="' + esc(item.id) + '">打开</button>';
          return '<div class="row' + (item.marked ? ' row-marked' : '') + (isFocus ? ' row-current' : '') + '">' +
            '<div class="row-main"><span class="row-title">' + esc(item.title) + '</span>' +
            '<span class="row-sub">' + esc(item.kind) + ' · ' + esc(item.state) +
            (item.open_adjudications ? ' · 待裁决 ' + esc(String(item.open_adjudications)) : '') +
            (item.awaiting_fields && item.awaiting_fields.length ? ' · 缺字段 ' + esc(item.awaiting_fields.join('、')) : '') +
            '</span></div>' + pill(label, tone) + '<div class="row-actions">' + actions + '</div></div>';
        }).join('');
        return '<div class="card">' + head(label, '', countChip(items.length)) + '<div class="card-body"><div class="rows">' + rows + '</div></div></div>';
      };

      var railHtml = groupOf('needs_you', '需要你', 'danger') + groupOf('in_progress', '进行中', 'muted') + groupOf('done', '已完成', 'ok');

      // 中央：交付物 + 至多一个待裁决项。东西，不是对话。
      var centre;
      if (!focus) {
        centre = '<div class="card">' + head('还没有工作对象', '') + '<div class="card-body">' +
          emptyState('还没有工作对象', '当事件孵化出对象，或你在命令面板里说明一个意图时，它会出现在这里。', 'layers') + '</div></div>';
      } else {
        var fields = Object.keys(focus.fields || {});
        var cardHtml = '';
        if (focus.adjudication) {
          var adjudication = focus.adjudication;
          // A merged card is one action, not one signature (6.4)：把 effect 数量写在卡上，
          // 让人知道一次点击背后有几件不同的事。
          var batchNote = adjudication.batch_effects > 1
            ? '<div class="aside-note">这一张卡合并了 ' + esc(String(adjudication.batch_effects)) + ' 个同类 effect。批准后每个 effect 各自留一条授权记录。</div>'
            : '';
          cardHtml = '<div class="card"><div class="card-body">' +
            '<div class="row"><div class="row-main"><span class="row-title">' + esc(adjudication.summary) + '</span>' +
            '<span class="row-sub">' + esc(adjudication.decision_kind) + ' · 优先级 ' + esc(String(adjudication.priority)) + '</span></div>' +
            pill('待裁决', 'warn') +
            '<div class="row-actions">' +
            '<button class="btn primary" type="button" data-authorize="' + esc(adjudication.id) + '" data-effect="' + esc(focus.id) + '">授权</button>' +
            '<button class="btn" type="button" data-acknowledge="' + esc(adjudication.id) + '">我看到了</button>' +
            '</div></div>' + batchNote +
            // 文档 9：控件形态由决策类型决定，由后端下发；这里只负责按 renderer 渲染。
            // 异步填入，不阻塞卡片本体——锚点先出现，生成元素随后。
            '<div data-decision-slot="' + esc(adjudication.decision_kind) + '"></div>' +
            (focus.waiting_adjudications
              ? '<div class="aside-note">还有 ' + esc(String(focus.waiting_adjudications)) + ' 项在左侧挂起，不会抢中央。</div>' : '') +
            '</div></div>';
        }
        var fieldRows = fields.length
          ? fields.map(function (name) {
              return '<div class="row"><div class="row-main"><span class="row-title">' + esc(name) + '</span>' +
                '<span class="row-sub">' + esc(String(focus.fields[name])) + '</span></div></div>';
            }).join('')
          : '<div class="aside-note">这个对象还没有补充字段。</div>';
        var pendingNote = (focus.pending_fields && focus.pending_fields.length)
          ? '<div class="aside-note">还缺：' + esc(focus.pending_fields.join('、')) + '。请在这里补齐，不要回到自由输入。</div>' : '';
        centre = '<div class="card">' + head(focus.title, focus.intention ? String(focus.intention) : '对象本身与它挂着的待裁决项', pill(focus.kind, 'muted')) +
          '<div class="card-body"><div class="rows">' + fieldRows + '</div>' + pendingNote + '</div></div>' + cardHtml;
      }

      return {
        html: '<div class="stack">' + (railHtml || emptyState('对象轨是空的', '对象会随着事件或你的意图出现。', 'layers')) + centre + '</div>',
        // 右栏：凭证。默认只有结论；原始值与复算路径按需展开。
        aside: focus ? asideBlock('凭证', '', '<div id="receipt-panel" class="aside-note">正在读取凭证…</div>') : '',
        asideMount: focus ? function (panel) { mountReceipts(panel, focus.id); } : null,
        mounts: [function (root) {
          // 文档 9：锚点先出现，生成元素随后填入。控件的形态由后端按决策类型下发；
          // 9.2 的「3 秒内扫完」由后端判定，超预算的会被标为交付物文件而不是裁决控件。
          var slot = root.querySelector('[data-decision-slot]');
          if (slot && focus.adjudication) {
            var kind = slot.getAttribute('data-decision-slot');
            api('/api/decisions?object_id=' + encodeURIComponent(focus.id) +
              '&decision_kind=' + encodeURIComponent(kind) + '&summary=' + encodeURIComponent(focus.adjudication.summary))
              .then(function (composed) {
                if (!composed.rendered) {
                  // 9.2：一眼扫不完的内容是交付物文件，不是裁决控件。
                  slot.innerHTML = '<div class="aside-note">这个决策超出「3 秒内扫完」的预算（' +
                    esc(String(composed.measurement.estimated_lines)) + ' 行），已判定为交付物文件，请打开后逐项查看。</div>';
                  return;
                }
                slot.innerHTML = renderDecisionControl(composed.control);
              })
              .catch(function (error) {
                // 未注册的决策类型：显式说明，不退化成通用表单。
                slot.innerHTML = '<div class="aside-note">' + esc(error.message) + '</div>';
              });
          }
          Array.prototype.forEach.call(root.querySelectorAll('[data-open-object]'), function (button) {
            button.onclick = function () {
              state.selectedObject = button.getAttribute('data-open-object');
              paint('objects');
            };
          });
          // 授权与「我看到了」是两个不同的动作（11.4）：前者绑定 effect 与凭证摘要，
          // 后者只是一条「我看过这张卡」的记录，不授权任何副作用。
          Array.prototype.forEach.call(root.querySelectorAll('[data-authorize]'), function (button) {
            button.onclick = function () {
              var effectId = button.getAttribute('data-effect');
              var reason = window.prompt('授权理由（会记入授权记录）：', '');
              if (reason === null) return;
              if (!reason) { toast('需要填写授权理由'); return; }
              button.disabled = true;
              api('/api/objects/authorize', { method: 'POST', body: JSON.stringify({
                effect_id: effectId, effect_kind: 'adjudication_effect', actor: 'workbench-user',
                authorized_at: new Date().toISOString(), risk_level: 'R2', decision_reason: reason,
                effect: { effect_id: effectId, summary: button.getAttribute('data-authorize') }
              }) })
                .then(function () { toast('已授权'); paint('objects'); })
                .catch(function (error) { button.disabled = false; fail(error); });
            };
          });
          Array.prototype.forEach.call(root.querySelectorAll('[data-acknowledge]'), function (button) {
            button.onclick = function () {
              button.disabled = true;
              api('/api/objects/acknowledge', { method: 'POST', body: JSON.stringify({
                card_id: button.getAttribute('data-acknowledge'), actor: 'workbench-user',
                acknowledged_at: new Date().toISOString()
              }) })
                .then(function () { toast('已记录「我看到了」，这不会授权任何副作用'); paint('objects'); })
                .catch(function (error) { button.disabled = false; fail(error); });
            };
          });
        }]
      };
    });
  }

  // 右栏凭证：先给结论，再给原始值与复算路径（文档 8 / 10.1）。
  function mountReceipts(panel, objectId) {
    var target = panel ? panel.querySelector('#receipt-panel') : null;
    if (!target) return;
    api('/api/objects/receipts?object_id=' + encodeURIComponent(objectId)).then(function (evidence) {
      var summary = evidence.summary || {};
      var lines = ['回执 ' + esc(String(summary.receipt_count || 0)) +
        ' · 可复算 ' + esc(String(summary.recomputable_count || 0)) +
        ' · 授权 ' + esc(String(summary.authorization_count || 0))];
      if (summary.transcribed_count) {
        // 11.5：结论的可靠性取决于谁提供了数据，所以这一条必须在默认视图里看得见。
        lines.push('其中 ' + esc(String(summary.transcribed_count)) + ' 条含人工抄录值，不能仅凭它进入 L1。');
      }
      if (!(evidence.receipts || []).length) {
        target.textContent = lines.join(' · ') + ' · 还没有回执。';
        return;
      }
      target.innerHTML = lines.map(function (line) { return '<div>' + line + '</div>'; }).join('') +
        (evidence.receipts || []).map(function (receipt) {
          var mark = receipt.l1_eligible ? pill('可支持 L1', 'ok') : pill('不可进 L1', 'warn');
          return '<div class="row"><div class="row-main"><span class="row-title">' + esc(receipt.action) + ' · ' + esc(receipt.risk_level) + '</span>' +
            '<span class="row-sub">' + esc(receipt.l1_reason || '') + '</span></div>' + mark +
            '<div class="row-actions"><button class="btn" type="button" data-receipt="' + esc(receipt.id) + '">复算路径</button></div>' +
            '<div class="row-detail" data-receipt-detail="' + esc(receipt.id) + '"></div></div>';
        }).join('');
      Array.prototype.forEach.call(target.querySelectorAll('[data-receipt]'), function (button) {
        button.onclick = function () {
          var id = button.getAttribute('data-receipt');
          var slot = target.querySelector('[data-receipt-detail="' + id + '"]');
          if (!slot) return;
          api('/api/objects/receipts?receipt_id=' + encodeURIComponent(id)).then(function (detail) {
            var steps = (detail.steps || []).map(function (step) {
              return esc(step.metric) + '：' + esc(String(step.pre)) + ' → ' + esc(String(step.post)) + '（Δ ' + esc(String(step.delta)) + '）';
            });
            var missing = (detail.uncomparable || []).map(function (item) {
              return esc(item.metric) + '（缺 ' + esc(item.missing) + '）';
            });
            slot.innerHTML = (steps.length ? '<pre>' + steps.join('\n') + '</pre>' : '<div>没有可比较的指标。</div>') +
              (missing.length ? '<div>无法比较：' + missing.join('、') + '</div>' : '');
          }).catch(function (error) { slot.textContent = error.message; });
        };
      });
    }).catch(function (error) { target.textContent = error.message; });
  }

  function viewApprovals() {
    return api('/api/inbox/refresh', { method: 'POST', body: {} }).then(function (refreshed) {
      // 「待我批准」只关心面向人的卡片；面向 agent / operator 的卡片不是这一页的职责。
      var cards = (refreshed.cards || []).filter(function (card) { return card.audience === 'human' || card.audience === undefined; });
      var open = cards.filter(function (card) { return card.status === 'open'; });
      var rows = open.length ? open.map(function (card) {
        var detail = attentionDetail(card);
        var actions = '<button class="btn primary" type="button" data-attention="' + esc(card.id) + '" data-decision="acknowledge">批准</button>' +
          '<button class="btn" type="button" data-attention="' + esc(card.id) + '" data-decision="defer">稍后</button>';
        return '<div class="row"><div class="row-main"><span class="row-title">' + esc(attentionActionLabel(card.action) + ' · ' + (card.reason || card.source_kind || card.id)) + '</span>' +
          '<span class="row-sub">' + esc(card.source_kind || '') + (detail ? ' · ' + esc(detail) : '') + '</span></div>' +
          pill('优先级 ' + esc(String(card.priority)), card.priority >= 70 ? 'bad' : card.priority >= 40 ? 'warn' : 'muted') +
          '<div class="row-actions">' + actions + '</div></div>';
      }).join('') : emptyState('没有待批准的事项', '当任务需要人工决定时，会出现在这里；刷新页面不会丢失。', 'shield');

      var decided = cards.filter(function (card) { return card.status !== 'open'; });
      return {
        html: '<div class="stack"><div class="card">' + head('待我批准', '需要人工决定才能继续的工作；决定会持久保存，刷新不会丢失', countChip(open.length)) +
          '<div class="card-body"><div class="rows">' + rows + '</div></div></div>' +
          '<div class="card">' + head('已处理', '已经给出决定的事项', countChip(decided.length)) + '<div class="card-body">' +
          (decided.length ? '<div class="rows">' + decided.map(function (card) {
            var when = card.deferred_until ? ' · 推迟至 ' + esc(String(card.deferred_until)) : '';
            return '<div class="row"><div class="row-main"><span class="row-title">' + esc(card.reason || card.id) + '</span><span class="row-sub">' + esc(card.status) + when + (card.decided_by ? ' · ' + esc(card.decided_by) : '') + '</span></div></div>';
          }).join('') + '</div>' : emptyState('还没有已处理事项', '批准或推迟后的事项会记录在这里。', 'check')) + '</div></div></div>',
        aside: asideBlock('为什么需要批准', '', '<div class="aside-note">写入、外部操作与生成代码在本机执行前需要人工决定。Craft 不会替你批准，也不会因为界面刷新而遗忘你的决定。</div>'),
        mounts: [function (root) {
          Array.prototype.forEach.call(root.querySelectorAll('[data-attention]'), function (button) {
            button.onclick = function () {
              var id = button.getAttribute('data-attention'), decision = button.getAttribute('data-decision');
              var body = { item_id: id, decision: decision, decided_by: 'studio-user' };
              if (decision === 'defer') {
                // 后端要求 deferred_until 必须晚于当前时间，默认推迟一小时。
                body.deferred_until = new Date(Date.now() + 3600000).toISOString();
                body.reason = window.prompt('推迟原因（可留空）：') || 'deferred_from_workbench';
              }
              button.disabled = true;
              api('/api/inbox/decide', { method: 'POST', body: body })
                .then(function () { toast(decision === 'acknowledge' ? '已批准' : '已推迟一小时'); paint('approvals'); })
                .catch(function (error) { button.disabled = false; fail(error); });
            };
          });
        }]
      };
    });
  }

  function viewSkills() {
    return Promise.all([api('/api/connectors?limit=100'), api('/api/workbench/resources?kind=skills&limit=100')]).then(function (results) {
      var assets = (results[0].assets || []).filter(function (item) { return item.asset_type === 'skill'; }), personal = results[1].items || [];
      var rows = catalogRows(assets, 'spark', function (item) { return item.name || item.logical_id || item.id; }, function (item) {
        return (item.summary || '没有说明') + ' · ' + label(EFFECT_LABELS, item.effect, item.effect || '仅查看');
      });
      var personalRows = catalogRows(personal, 'spark', function (item) { return item.name; }, function (item) { return item.description || '本机上传 · 可在任务创建时附带'; });
      return {
        html: '<div class="stack"><div class="card">' + head('本机技能', '上传或编辑 SKILL.md；选入任务后会作为只读指令上下文附带',
          '<div class="row-actions"><button class="btn primary" id="skill-upload" type="button">' + icon('file') + '上传 SKILL.md</button><input id="skill-file" type="file" accept="text/markdown,.md" hidden></div>') +
          '<div class="card-body">' + (personalRows || emptyState('还没有本机技能', '上传一个 SKILL.md 后可在新建任务的「能力」中选择它。', 'spark')) + '</div></div>' +
          '<div class="card">' + head('已登记技能', '来自已确认的插件或连接器', countChip(assets.length)) + '<div class="card-body">' + (rows || emptyState('还没有已登记技能', '在连接器中扫描并确认外部技能。', 'spark')) + '</div></div></div>',
        aside: asideBlock('技能的状态', '', '<div class="aside-note">本机技能不会自动获得工具权限；外部技能仍遵循来源审核、权限与连接器健康检查。</div>'),
        mounts: [function (root) { var upload = root.querySelector('#skill-upload'), file = root.querySelector('#skill-file'); if (upload && file) { upload.onclick = function () { file.click(); }; file.onchange = function () { readUpload(file, ['md'], function (content, name) { var title = (content.match(/^name:\s*([^\r\n]+)$/m) || [])[1] || name.replace(/\.md$/i, ''); var description = (content.match(/^description:\s*([^\r\n]+)$/m) || [])[1] || ''; api('/api/workbench/skills', { method: 'POST', body: { name: title.trim(), description: description.trim(), content: content } }).then(function () { caps.userSkills = []; toast('技能已安装'); paint('skills'); }).catch(fail); }); }; } }]
      };
    });
  }

  function viewModels() {
    return api('/api/config/models').then(function (result) {
      var models = result.models || [];
      var rows = models.length ? models.map(function (model) {
        return '<div class="row"><span class="row-lead accent">' + esc(String(model.name || model.id).charAt(0).toUpperCase()) + '</span><div class="row-main"><span class="row-title">' + esc(model.name || model.id) + '</span><span class="row-sub">' + esc(model.model || '未选择模型') + '</span></div>' + (model.configured ? pill('可用', 'ok') : pill('待填密钥', 'warn')) + '</div>';
      }).join('') : emptyState('还没有模型', '添加并配置一个模型后，就能创建并继续任务对话。', 'cpu');
      return {
        html: '<div class="stack"><div class="card">' + head('模型', '先配置模型，再在任务区选择它开始任务', '<button class="btn primary" id="model-add" type="button">' + icon('plus') + '添加模型</button>') +
          '<div class="card-body"><div class="rows">' + rows + '</div><p class="doc-p" style="margin-top:12px">密钥只从本机设置或系统环境变量读取，不会出现在任务记录中。</p></div></div></div>',
        aside: asideBlock('任务执行', '', '<div class="aside-note">任务会先以模型对话方式运行。需要读取文件、执行命令或外部操作时，Craft 会根据任务权限进行治理和记录。</div>'),
        mounts: [function (root) { var button = root.querySelector('#model-add'); if (button) button.onclick = function () { openModelSheet({ step: 1, preset: null, model: '', name: '' }); }; }]
      };
    });
  }

  function openMemoryEditor(item) {
    item = item || {};
    openInlineOn('memory', {
      title: item.id ? '修改记忆' : '添加记忆', sub: '保存会保留人工来源；修改会生成替代版本',
      html: '<div class="field"><label for="memory-content">内容</label><textarea id="memory-content" class="tall">' + esc(item.content || '') + '</textarea></div>' +
        '<div class="field-row"><div class="field"><label for="memory-kind">类型</label><select id="memory-kind">' + options([['fact', '事实'], ['decision', '决策'], ['preference', '偏好'], ['experience', '经验']], item.kind || 'fact') + '</select></div>' +
        '<div class="field"><label>范围</label><input value="' + esc(item.scope === 'task' ? '当前任务' : item.scope === 'workspace' ? '当前工作区' : '用户') + '" readonly></div></div>',
      actions: [{ label: '保存记忆', primary: true, run: function () { var body = { memory_id: item.id, content: val('memory-content'), kind: val('memory-kind') }; if (!item.id) body.scope = 'user'; api('/api/workbench/memory', { method: 'POST', body: body }).then(function () { clearInline(); toast(item.id ? '记忆已更新为新版本' : '记忆已保存'); paint('memory'); }).catch(fail); } }]
    });
  }

  function openKnowledgePageEditor(page) {
    page = page || {};
    var load = page.id ? call('craft_wiki_page_get', { page_id: page.id }) : Promise.resolve({ body: '', page: {} });
    load.then(function (result) {
      openInlineOn('knowledge', {
        title: page.id ? '编辑知识页面' : '新建知识页面', sub: '内容保存为本机 Markdown，并保留版本',
        html: '<div class="field"><label for="wiki-title">标题</label><input id="wiki-title" value="' + esc((result.page || {}).title || page.title || '') + '"></div>' +
          '<div class="field"><label for="wiki-scope">范围</label><input id="wiki-scope" value="' + esc((result.page || {}).scope || 'global') + '"></div>' +
          '<div class="field"><label for="wiki-body">Markdown 内容</label><textarea id="wiki-body" class="tall">' + esc(result.body || '') + '</textarea></div>',
        actions: [{ label: '保存页面', primary: true, run: function () { call('craft_wiki_page_save', { page_id: page.id, title: val('wiki-title'), scope: val('wiki-scope') || 'global', body: val('wiki-body'), author: 'studio-user' }).then(function () { clearInline(); toast('知识页面已保存'); paint('knowledge'); }).catch(fail); } }]
      });
    }).catch(fail);
  }

  function openKnowledgeClaimEditor() {
    openInlineOn('knowledge', {
      title: '添加知识结论', sub: '将自动附上一条人工来源证据，初始状态为待审核',
      html: '<div class="field"><label for="claim-content">结论</label><textarea id="claim-content">' + '</textarea></div><div class="field-row"><div class="field"><label for="claim-kind">类型</label><select id="claim-kind">' + options([['fact', '事实'], ['rule', '规则'], ['decision', '决策'], ['term', '术语'], ['failure_mode', '失败模式']], 'fact') + '</select></div><div class="field"><label for="claim-scope">范围</label><input id="claim-scope" value="global"></div></div>',
      actions: [{ label: '保存结论', primary: true, run: function () { api('/api/workbench/knowledge/claims', { method: 'POST', body: { content: val('claim-content'), kind: val('claim-kind'), scope: val('claim-scope') || 'global' } }).then(function () { clearInline(); toast('知识结论已保存，等待审核'); paint('knowledge'); }).catch(fail); } }]
    });
  }

  function openWorkflowEditor(workflow) {
    workflow = workflow || {};
    openInlineOn('workflows', {
      title: workflow.id ? '编辑工作流' : '新建工作流', sub: '保存为草稿；执行前仍须走权限与审批流程',
      html: '<div class="field"><label for="workflow-name">名称</label><input id="workflow-name" value="' + esc(workflow.name || '') + '"></div><div class="field"><label for="workflow-desc">说明</label><input id="workflow-desc" value="' + esc(workflow.description || '') + '"></div><div class="field"><label for="workflow-inputs">输入定义（JSON 数组）</label><textarea id="workflow-inputs">' + esc(JSON.stringify(workflow.inputs || [], null, 2)) + '</textarea></div><div class="field"><label for="workflow-steps">步骤（JSON 数组）</label><textarea id="workflow-steps" class="tall">' + esc(JSON.stringify(workflow.steps || [], null, 2)) + '</textarea></div>',
      actions: [{ label: '保存草稿', primary: true, run: function () { try { var inputs = JSON.parse(val('workflow-inputs') || '[]'), steps = JSON.parse(val('workflow-steps') || '[]'); api('/api/workbench/workflows', { method: 'POST', body: { workflow_id: workflow.id, name: val('workflow-name'), description: val('workflow-desc'), inputs: inputs, steps: steps } }).then(function () { clearInline(); toast('工作流草稿已保存'); paint('workflows'); }).catch(fail); } catch (_) { toast('输入定义和步骤必须是有效 JSON 数组', true); } } }]
    });
  }

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

  function viewKnowledge() {
    return api('/api/knowledge').then(function (result) {
      var claims = result.claims || [], pages = result.pages || [], bundles = result.bundles || [];
      var claimRows = catalogRows(claims, 'layers', function (item) { return item.content || item.id; }, function (item) { return [item.kind, label(STATUS_LABELS, item.status, item.status), item.scope].filter(Boolean).join(' · '); });
      var pageRows = pages.length ? '<div class="rows">' + pages.map(function (item) { return '<div class="row"><span class="row-lead muted">' + icon('file') + '</span><div class="row-main"><span class="row-title">' + esc(item.title || item.id) + '</span><span class="row-sub">' + esc(item.revision_source || 'Markdown') + '</span></div><button class="btn sm" data-wiki-edit="' + esc(item.id) + '">编辑</button></div>'; }).join('') + '</div>' : '';
      return {
        html: '<div class="stack"><div class="grid-2"><div class="card">' + head('知识结论', '带来源与状态的可核验内容', '<button class="btn sm" id="claim-add">' + icon('plus') + '添加结论</button>') + '<div class="card-body">' + (claimRows || emptyState('还没有知识结论', '从任务或资料中提取后才会显示。', 'layers')) + '</div></div>' +
          '<div class="card">' + head('知识页面', '以本机 Markdown 保存、可直接编辑', '<button class="btn sm primary" id="wiki-add">' + icon('plus') + '新建页面</button>') + '<div class="card-body">' + (pageRows || emptyState('还没有知识页面', '新建页面或导入资料后会显示在这里。', 'file')) + '</div></div></div>' +
          '<div class="card">' + head('知识包', '运行任务时可绑定的已整理上下文', countChip(bundles.length)) + '<div class="card-body">' + (bundles.length ? catalogRows(bundles, 'inbox', function (item) { return item.id; }, function (item) { return (item.claim_refs || []).length + ' 条结论 · ' + (item.scope || '未设范围'); }) : emptyState('还没有知识包', '知识包需要由真实知识记录生成。', 'inbox')) + '</div></div></div>',
        aside: asideBlock('可追溯性', '', '<div class="aside-note">知识页面的修改写入新 Markdown 版本；人工新增结论会附带来源证据，仍可再审核。</div>'),
        mounts: [function (root) { var wiki = root.querySelector('#wiki-add'), claim = root.querySelector('#claim-add'); if (wiki) wiki.onclick = function () { openKnowledgePageEditor(); }; if (claim) claim.onclick = openKnowledgeClaimEditor; root.querySelectorAll('[data-wiki-edit]').forEach(function (button) { button.onclick = function () { var page = pages.filter(function (entry) { return entry.id === button.getAttribute('data-wiki-edit'); })[0]; if (page) openKnowledgePageEditor(page); }; }); }]
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

  // ----------------------------------------------------------------- settings

  // ------------------------------------------------- right-panel "sheet"
  // Everything that needs more room than the page itself renders into the right
  // panel instead of a dialog, so the app never interrupts with a modal.
  // A sheet is transient DOM: paint() blanks the panel, so changing page (or
  // refreshing it) naturally restores the page's own context.

  var sheetClose = null;

  // 文档 5.3：L3 的唯一合法使命，是孵化一个新的工作对象。
  // 这个面板刻意只有「意图 + 类型 + 一个确认按钮」，没有对话历史、没有继续追问的输入框：
  // 连续多轮对话会把「孵化对象」退化成「聊天」，而中间区迟早会被对话流占领。
  // 对象一旦生成，这里立即收起并转入该对象的画布。
  function openHatch() {
    if (state.page !== 'objects') { go('objects'); }
    openSheet(function (panel) {
      var kinds = ['migration', 'refactor', 'investigation', 'delivery', 'incident'];
      panel.innerHTML = '<div class="sheet">' + sheetHead('孵化一个新对象', '只做一件事：把它创建出来') +
        '<div class="sheet-body">' +
        '<label class="field"><span>你想做什么</span>' +
        '<textarea id="hatch-intention" rows="3" placeholder="例如：评估把序列化库从 Fastjson 迁到 Jackson"></textarea></label>' +
        '<label class="field"><span>类型</span><select id="hatch-kind">' +
        kinds.map(function (kind) { return '<option value="' + esc(kind) + '">' + esc(kind) + '</option>'; }).join('') +
        '</select></label>' +
        '<div class="aside-note">创建后这里会立即收起。之后缺什么信息，会在对象上以「补全卡片」的方式问你要哪个字段，不会再回到自由输入。</div>' +
        '</div>' +
        '<div class="sheet-actions"><button class="btn primary" type="button" id="hatch-go">创建对象</button></div>' +
        '</div>';
      bindSheetBack(panel);
      var button = panel.querySelector('#hatch-go');
      button.onclick = function () {
        var intention = (panel.querySelector('#hatch-intention').value || '').trim();
        if (intention.length < 3) { toast('请先写下你想做什么'); return; }
        button.disabled = true;
        // 每次孵化用一个新 session id：会话被关闭后不能再孵化第二个对象，
        // 这正是「窄口」在协议层的体现。
        api('/api/objects/hatch', { method: 'POST', body: JSON.stringify({
          session_id: 'hatch_' + Date.now().toString(36),
          intention: intention,
          object_kind: panel.querySelector('#hatch-kind').value,
          hatched_at: new Date().toISOString()
        }) })
          .then(function (result) {
            // 输入区立即收起：不保留刚才的意图，也不给第二次输入的机会。
            state.selectedObject = String(result.object.id);
            toast('已创建：' + result.object.id);
            paint('objects');
          })
          .catch(function (error) { button.disabled = false; fail(error); });
      };
    });
  }

  function openSheet(render) {
    var panel = $('aside-panel');
    if (!panel) return;
    panel.innerHTML = '';
    render(panel);
  }

  // Viewing is R0: the desktop shell opens an isolated WebView with no Craft IPC
  // capability. In a regular browser this command stays visible but explains that it
  // needs the Tauri desktop shell instead of silently opening an untrusted page here.
  function openEmbeddedBrowser() {
    openSheet(function (panel) {
      panel.innerHTML = sheetHead('在应用内查看网页', '只查看页面；网页无法访问本机 Craft、浏览器驱动或桌面控制权限') +
        '<div class="sheet-body"><div class="field"><label for="embedded-url">网页地址</label><input id="embedded-url" type="url" inputmode="url" autocomplete="url" placeholder="https://example.com"></div>' +
        '<div class="aside-note">打开的是受隔离的网页窗口。填写、点击或提交仍须走已注册的浏览器适配器与审批流程。</div></div>' +
        '<div class="sheet-actions"><button class="btn primary" type="button" id="embedded-open">打开网页</button></div>';
      bindSheetBack(panel);
      var button = panel.querySelector('#embedded-open');
      button.onclick = function () {
        var url = String(panel.querySelector('#embedded-url').value || '').trim();
        if (!/^https?:\/\/\S+$/iu.test(url)) { toast('请输入完整的 http:// 或 https:// 地址'); return; }
        var invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
        if (typeof invoke !== 'function') { toast('请在 Craft Tauri 桌面端中使用内嵌网页', true); return; }
        button.disabled = true;
        invoke('open_embedded_page', { url: url }).then(function () { sheetClose = null; paint(state.page); }).catch(function (error) { button.disabled = false; fail(error); });
      };
    });
  }

  function openManagedBrowser() {
    openSheet(function (panel) {
      panel.innerHTML = sheetHead('在受管浏览器中登录', '会打开独立、可见的本地 Edge 会话；登录内容和 Cookie 不会进入 Craft') +
        '<div class="sheet-body"><div class="field"><label for="managed-url">网页地址</label><input id="managed-url" type="url" inputmode="url" autocomplete="url" placeholder="https://example.com"></div>' +
        '<div class="aside-note">如遇登录、验证码或双重验证，请在打开的浏览器中自行完成。Craft 只检测“需要人工接管”状态，不读取密码、验证码或 Cookie。</div></div>' +
        '<div class="sheet-actions"><button class="btn primary" type="button" id="managed-open">打开受管浏览器</button></div>';
      bindSheetBack(panel);
      var button = panel.querySelector('#managed-open');
      button.onclick = function () {
        var url = String(panel.querySelector('#managed-url').value || '').trim();
        if (!/^https?:\/\/\S+$/iu.test(url)) { toast('请输入完整的 http:// 或 https:// 地址'); return; }
        var invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
        if (typeof invoke !== 'function') { toast('请在 Craft Tauri 桌面端中使用受管浏览器', true); return; }
        button.disabled = true;
        invoke('open_managed_browser', { url: url }).then(function () { toast('已打开受管浏览器；请在其中自行完成登录'); sheetClose = null; paint(state.page); }).catch(function (error) { button.disabled = false; fail(error); });
      };
    });
  }

  function sheetHead(title, sub) {
    sheetClose = true;
    return '<div class="sheet-head">' +
      '<button class="icon-btn sheet-back" type="button" id="sheet-back" aria-label="返回">' + icon('arrow') + '</button>' +
      '<div class="sheet-head-text"><b>' + esc(title) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '') + '</div>' +
      '</div>';
  }

  // Every sheet renders a 返回 control; re-painting the page restores the normal
  // right-panel context, because paint() blanks the panel before rendering.
  function bindSheetBack(panel) {
    var back = panel.querySelector('#sheet-back');
    if (back) back.onclick = function () { sheetClose = null; paint(state.page); };
  }

  function sheetSteps(active) {
    var labels = ['选服务商', '填密钥', '选模型'];
    return '<div class="sheet-steps">' + labels.map(function (text, index) {
      var step = index + 1;
      var state2 = step === active ? ' aria-current="step"' : (step < active ? ' class="done"' : '');
      return '<span class="sheet-step"' + state2 + '><i>' + (step < active ? icon('check') : step) + '</i>' + esc(text) + '</span>';
    }).join('') + '</div>';
  }

  // Service presets. The user picks a brand; protocol, service address, model
  // id and the key's variable name are all derived, never asked for.
  var PROVIDER_PRESETS = [
    { key: 'deepseek', label: 'DeepSeek', protocol: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1', env: 'DEEPSEEK_API_KEY', note: '中文与代码，价格便宜',
      models: ['deepseek-chat', 'deepseek-reasoner'] },
    { key: 'qwen', label: '通义千问', protocol: 'openai-compatible',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', env: 'DASHSCOPE_API_KEY', note: '阿里云百炼',
      models: ['qwen-plus', 'qwen-max', 'qwen-turbo'] },
    { key: 'kimi', label: 'Kimi', protocol: 'openai-compatible',
      baseUrl: 'https://api.moonshot.cn/v1', env: 'MOONSHOT_API_KEY', note: '长文本阅读',
      models: ['moonshot-v1-32k', 'moonshot-v1-128k', 'moonshot-v1-8k'] },
    { key: 'glm', label: '智谱 GLM', protocol: 'openai-compatible',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4', env: 'ZHIPUAI_API_KEY', note: '',
      models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'] },
    { key: 'doubao', label: '豆包', protocol: 'openai-compatible',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', env: 'ARK_API_KEY', note: '火山方舟',
      models: ['doubao-pro-32k', 'doubao-lite-32k'] },
    { key: 'openai', label: 'OpenAI', protocol: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1', env: 'OPENAI_API_KEY', note: '', models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'] },
    { key: 'anthropic', label: 'Anthropic', protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com', env: 'ANTHROPIC_API_KEY', note: '',
      models: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1'] },
    { key: 'custom', label: '其它 / 自建', protocol: 'openai-compatible',
      baseUrl: '', env: 'CRAFT_API_KEY', note: '自己填服务地址', models: [] }
  ];

  function presetOf(key) {
    return PROVIDER_PRESETS.filter(function (item) { return item.key === key; })[0] || PROVIDER_PRESETS[0];
  }

  var settingsAdvanced = false;

  // settings.runtime.defaultTier speaks small/medium/large; users pick a word.
  var TIER_WORDS = [
    ['small', '快速', '省钱，适合简单任务'],
    ['medium', '标准', '日常默认，够快也够聪明'],
    ['large', '最强', '更贵，适合难题']
  ];

  function tierWord(value) {
    var hit = TIER_WORDS.filter(function (pair) { return pair[0] === value; })[0];
    return hit ? hit[1] : (value || '—');
  }

  function saveSettings() {
    var current = (state.settings && state.settings.runtime) || {};
    var stepsNode = $('set-steps');
    var tokensNode = $('set-tokens');
    // maxSteps/maxTokens only exist while 高级 is expanded — never write 0 just
    // because the field is collapsed.
    var patch = {
      theme: val('set-theme') || state.theme,
      runtime: {
        defaultTier: val('set-tier') || current.defaultTier,
        maxSteps: stepsNode ? Number(stepsNode.value) : current.maxSteps,
        maxTokens: tokensNode ? Number(tokensNode.value) : current.maxTokens
      }
    };
    state.theme = patch.theme;
    applyTheme();
    api('/api/settings', { method: 'PATCH', body: patch })
      .then(function () { toast('设置已保存'); paint('settings'); }).catch(fail);
  }

  function viewSettings() {
    return Promise.all([
      api('/api/settings'),
      settled(api('/api/usage'), { totals: {}, daily: {}, weekly: {}, monthly: {}, yearly: {} }),
      settled(api('/api/config/models'), { models: [] })
    ]).then(function (results) {
      var settings = results[0], usage = results[1], models = results[2].models || [];
      state.settings = settings;
      var last = function (bucket) {
        var values = Object.values(bucket || {});
        return values.length ? values[values.length - 1].total_tokens : 0;
      };
      var usageTiles = [
        ['累计', (usage.totals || {}).total_tokens, 'db'],
        ['今天', last(usage.daily), 'play'],
        ['本周', last(usage.weekly), 'layers'],
        ['本月', last(usage.monthly), 'folder'],
        ['今年', last(usage.yearly), 'spark']
      ].map(function (pair) { return statTile(pair[0], pair[1] === undefined ? 0 : pair[1], pair[2]); }).join('');

      var modelRows = models.length ? models.map(function (m) {
        var monogram = String(m.name || m.id).charAt(0).toUpperCase();
        var preset = PROVIDER_PRESETS.filter(function (item) { return item.key === m.id; })[0];
        var brand = preset ? preset.label : (m.name || m.id);
        return '<div class="row model-row" data-id="' + esc(m.id) + '">' +
          '<span class="row-lead accent">' + esc(monogram) + '</span>' +
          '<div class="row-main"><span class="row-title">' + esc(m.name) + '</span>' +
          '<span class="row-sub">' + esc(brand) + ' · ' + esc(m.model) + '</span></div>' +
          (m.configured ? pill('可用', 'ok') : pill('待填密钥', 'warn')) +
          '<button class="icon-btn model-edit-btn" type="button" title="编辑">' + icon('sliders') + '</button>' +
          '<button class="icon-btn model-del-btn" type="button" title="移除">' + icon('trash') + '</button>' +
        '</div>';
      }).join('') : emptyState('还没有可用的模型', '添加一个模型，Craft 才能开始干活', 'cpu');

      var advanced = settingsAdvanced
        ? '<div class="stack">' +
            '<div class="field-row">' +
              '<div class="field"><label for="set-steps">单个任务最多执行多少步</label><input id="set-steps" type="number" value="' + esc(settings.runtime.maxSteps) + '">' +
                '<span class="hint">步数越多，能做的事越复杂，也越慢。</span></div>' +
              '<div class="field"><label for="set-tokens">单个任务最多消耗多少 Token</label><input id="set-tokens" type="number" value="' + esc(settings.runtime.maxTokens) + '">' +
                '<span class="hint">用来避免一个任务跑出意外开销。</span></div>' +
            '</div>' +
            '<div class="field-row">' +
              '<div class="field"><label>配置保存位置</label><input type="text" value="' + esc(settings.dataRoot || '—') + '" readonly></div>' +
              '<div class="field"><label>密钥保存在本机</label><input type="text" value="' + (settings.secretsStored ? '是' : '否（从环境变量读取）') + '" readonly></div>' +
            '</div>' +
            '<div class="aside-note">发送匿名使用数据以改进产品：' + (settings.privacy && settings.privacy.telemetry ? '开启' : '关闭') + '。</div>' +
          '</div>'
        : '<div class="aside-note">步数上限、Token 上限与数据位置属于高级选项，一般不用改。</div>';

      return {
        html: '<div class="stack">' +
          '<div class="card">' + head('模型', 'Craft 用一个模型来思考和动手',
            '<button class="btn sm primary" id="models-manage" type="button">' + icon('plus') + '添加模型</button>') +
            '<div class="card-body tight"><div class="rows">' + modelRows + '</div></div></div>' +
          '<div class="grid-2">' +
            '<div class="card">' + head('外观与偏好', '浅色为默认；更改会立即预览',
              '<button class="btn primary" id="settings-save" type="button">' + icon('check') + '保存设置</button>') +
              '<div class="card-body"><div class="stack">' +
                '<div class="field-row">' +
                  '<div class="field"><label for="set-theme">外观</label><select id="set-theme">' +
                    options([['light', '浅色（默认）'], ['dark', '深色'], ['system', '跟随系统']], settings.theme) + '</select></div>' +
                  '<div class="field"><label for="set-tier">默认档位</label><select id="set-tier">' +
                    options(TIER_WORDS.map(function (pair) { return [pair[0], pair[1] + ' · ' + pair[2]]; }), settings.runtime.defaultTier) + '</select></div>' +
                '</div>' +
              '</div></div></div>' +
            '<div class="card">' + head('用量', '本机统计，只算 Token 数量') +
              '<div class="card-body"><div class="metrics">' + usageTiles + '</div></div></div>' +
          '</div>' +
          '<div class="card">' + head('高级', settingsAdvanced ? '已展开' : '一般不用改',
            '<button class="btn sm" id="adv-toggle" type="button">' + (settingsAdvanced ? '收起' : '展开') + '</button>') +
            '<div class="card-body">' + advanced + '</div></div>' +
        '</div>',
        aside: asideBlock('这台机器', '', asideRows([
            ['数据目录', settings.dataRoot],
            ['界面语言', settings.locale === 'zh-CN' ? '简体中文' : settings.locale],
            ['密钥存放', settings.secretsStored ? '本机' : '系统环境变量']
          ])) +
          asideBlock('默认档位', tierWord(settings.runtime.defaultTier),
            '<div class="aside-note">' + esc((TIER_WORDS.filter(function (pair) { return pair[0] === settings.runtime.defaultTier; })[0] || [])[2] || '日常用标准即可。') + '</div>') +
          asideBlock('模型', String(models.length) + ' 个',
            models.length
              ? '<div class="aside-list">' + models.map(function (m) {
                  return '<div class="aside-row"><span class="k">' + esc(m.name) + '</span>' +
                    (m.configured ? pill('可用', 'ok') : pill('待填密钥', 'warn')) + '</div>';
                }).join('') + '</div>'
              : '<div class="aside-note">还没有添加模型。</div>'),
        mounts: [function (root) {
          root.querySelector('#settings-save').onclick = saveSettings;
          var modelsBtn = root.querySelector('#models-manage');
          if (modelsBtn) modelsBtn.onclick = function () { openModelSheet({ step: 1, preset: null, model: '', name: '' }); };
          var adv = root.querySelector('#adv-toggle');
          if (adv) adv.onclick = function () { settingsAdvanced = !settingsAdvanced; paint('settings'); };

          root.querySelectorAll('.model-edit-btn').forEach(function (btn) {
            btn.onclick = function (event) {
              event.stopPropagation();
              var id = btn.closest('.model-row').getAttribute('data-id');
              var model = models.filter(function (m) { return m.id === id; })[0];
              if (!model) return;
              var preset = PROVIDER_PRESETS.filter(function (item) { return item.key === model.id; })[0];
              openModelSheet({ step: 2, preset: preset ? preset.key : 'custom', model: model.model,
                name: model.name, editing: model });
            };
          });
          root.querySelectorAll('.model-del-btn').forEach(function (btn) {
            btn.onclick = function (event) {
              event.stopPropagation();
              var id = btn.closest('.model-row').getAttribute('data-id');
              openSheet(function (panel) {
                panel.innerHTML =
                  sheetHead('移除模型', id) +
                  '<div class="aside-block"><div class="aside-note">移除后，用这个模型的任务会暂停，直到你再添加一个模型。</div>' +
                  '<div class="sheet-actions">' +
                    '<button class="btn danger" type="button" id="del-confirm">' + icon('trash') + '确认移除</button>' +
                    '<button class="btn" type="button" id="del-cancel">取消</button>' +
                  '</div></div>';
                bindSheetBack(panel);
                panel.querySelector('#del-cancel').onclick = function () { paint('settings'); };
                panel.querySelector('#del-confirm').onclick = function () {
                  api('/api/config/models/' + encodeURIComponent(id), { method: 'DELETE' })
                    .then(function () { toast('已移除'); paint('settings'); }).catch(fail);
                };
              });
            };
          });
          var select = root.querySelector('#set-theme');
          if (select) select.onchange = function () { saveTheme(select.value); };
        }]
      };
    });
  }

  // ------------------------------------------------------- execution setup

  // Execution mode is a pure Studio/前端 preference, kept in localStorage so
  // the choice survives sessions without needing a backend contract change.
  var EXEC_KEY = 'craft.executionMode';

  function execLoad() {
    try { var raw = localStorage.getItem(EXEC_KEY); if (raw) state.execution = JSON.parse(raw); } catch (_) { /* storage off */ }
    if (!state.execution || !state.execution.mode) state.execution = { mode: '', provider: null, tier: 'standard' };
    if (!state.execution.tier) state.execution.tier = 'standard';
  }

  function execSave() {
    try { localStorage.setItem(EXEC_KEY, JSON.stringify(state.execution)); } catch (_) { /* storage off */ }
  }

  // The status bar only ever answers one question: is there a usable model?
  // Craft ships no vendor catalog and no local CLI runner, so a model exists
  // exactly when the user has saved one in settings.
  function renderStatusExecution() {
    var node = $('sb-mode');
    if (!node) return;
    node.textContent = state.modelCount ? '模型 已配置' : '模型 未配置';
  }

  function openExecutionSetup() {
    openSheetAfterPaint('models', function () {
      openModelSheet({ isFirstRun: true });
    });
  }

  // A sheet needs the page to have finished painting first (paint() blanks the
  // panel before it renders the page's own aside), so first-run defers it.
  function openSheetAfterPaint(page, render) {
    state.pendingSheet = { page: page, run: render };
    if (state.page === page) paint(page); else go(page);
  }

  // --------------------------------------------------- model setup wizard
  // Three short questions. Everything technical (protocol, service address,
  // model id, key variable) is derived from the service picked in step 1 and
  // only shown under 高级.

  var wizardAdvanced = false;

  function openModelSheet(wizard) {
    state.modelWizard = wizard;
    wizardAdvanced = false;
    openSheet(function (panel) { renderModelSheet(panel); });
  }

  function wizardRow(key, value) {
    return '<div class="aside-row"><span class="k">' + esc(key) + '</span><span class="v">' + esc(value || '—') + '</span></div>';
  }

  function renderModelSheet(panel) {
    var w = state.modelWizard;
    var preset = w.preset ? presetOf(w.preset) : null;
    if (!w.name && preset) w.name = preset.label;
    var editing = !!w.editing;

    var html = sheetHead(editing ? '编辑模型' : '添加模型', preset ? preset.label : '第 ' + w.step + ' 步 / 共 3 步');
    html += '<div class="sheet-body">';

    if (!editing) html += sheetSteps(w.step);

    if (w.step === 1) {
      html += '<div class="choose-list">' + PROVIDER_PRESETS.map(function (item) {
        return '<button class="choose" type="button" data-preset="' + esc(item.key) + '"' +
          (w.preset === item.key ? ' aria-selected="true"' : '') + '>' +
          '<span class="choose-mark">' + esc(item.label.charAt(0)) + '</span>' +
          '<span class="choose-main"><b>' + esc(item.label) + '</b>' +
          (item.note ? '<span>' + esc(item.note) + '</span>' : '') + '</span>' +
          (w.preset === item.key ? icon('check') : '') + '</button>';
      }).join('') + '</div>';
      html += '<div class="aside-note">不知道选哪个就选 DeepSeek：中文好、便宜，日常够用。</div>';
      html += '<div class="sheet-actions"><button class="btn primary" type="button" id="w-next"' +
        (w.preset ? '' : ' disabled') + '>下一步</button></div>';
    } else if (w.step === 2) {
      var suggestions = preset.models || [];
      html += '<div class="field"><label for="w-key">' + esc(preset.label) + ' 的 API Key</label>' +
        '<input id="w-key" type="password" placeholder="从服务商后台复制后粘贴到这里" autocomplete="off">' +
        '<span class="hint">' + (editing ? '留空表示不改动已设置的密钥。' : 'Craft 不会把它写进配置文件。') + '</span></div>';
      html += '<div class="field"><label for="w-model">用哪个模型</label>' +
        '<input id="w-model" type="text" list="w-model-options" value="' + esc(w.model || suggestions[0] || '') + '" placeholder="模型名称">' +
        '<datalist id="w-model-options">' + suggestions.map(function (m) { return '<option value="' + esc(m) + '"></option>'; }).join('') + '</datalist>' +
        '<span class="hint">下拉是常用选项，也可以直接填服务商文档里的模型名。</span></div>';
      html += '<div class="sheet-actions"><button class="btn" type="button" id="w-prev">上一步</button>' +
        '<button class="btn primary" type="button" id="w-next">下一步</button></div>';
    } else {
      html += '<div class="aside-list">' +
        wizardRow('服务商', preset.label) +
        wizardRow('模型', w.model) +
        wizardRow('名称', w.name) +
        '</div>';
      html += '<div class="callout ' + (w.error ? 'warn' : 'info') + '">' + icon('key') + '<span>' +
        (w.error ? esc(w.error) + '。' : '') +
        'Craft 从<b>系统环境变量</b>里读密钥，不写进配置文件。' +
        '</span></div>';
      html += '<div class="field"><label for="w-env">把 Key 设置到环境变量</label>' +
        '<input id="w-env" type="text" value="' + esc(w.env || preset.env) + '" readonly>' +
        '<span class="hint">设置后重启 Craft 即可生效，之后所有模型都通过它访问。</span></div>';
      html += '<pre class="out" id="w-env-cmd">' + esc(w.envCmd || presetEnvCommand(preset.env)) + '</pre>';
      html += '<div class="sheet-actions"><button class="btn" type="button" id="w-copy">' + icon('file') + '复制命令</button>' +
        '<button class="btn primary" type="button" id="w-save">' + icon('check') + (editing ? '保存' : '完成') + '</button></div>';
      html += '<div class="aside-note">点「完成」只登记模型，不会去连网验证。密钥生效后再跑一个任务即可确认能不能用。</div>';
    }

    html += '<button class="btn ghost sheet-adv-toggle" type="button" id="w-adv">' + (wizardAdvanced ? '收起高级选项' : '高级选项') + '</button>';
    if (wizardAdvanced) {
      html += '<div class="stack sheet-adv">' +
        '<div class="field"><label for="w-name">名称</label><input id="w-name" type="text" value="' + esc(w.name || '') + '"></div>' +
        '<div class="field"><label for="w-baseurl">服务地址</label><input id="w-baseurl" type="text" value="' + esc(w.baseUrl || (preset ? preset.baseUrl : '')) + '"></div>' +
        '<div class="field"><label for="w-protocol">接口协议</label><select id="w-protocol">' +
          options([['openai-compatible', '通用（OpenAI 兼容）'], ['anthropic', 'Anthropic']], w.protocol || (preset ? preset.protocol : 'openai-compatible')) +
        '</select></div>' +
        '<div class="field"><label for="w-envname">密钥所在的环境变量名</label><input id="w-envname" type="text" value="' + esc(w.env || (preset ? preset.env : 'CRAFT_API_KEY')) + '"></div>' +
        '</div>';
    }
    html += '</div>';

    panel.innerHTML = html;
    bindSheetBack(panel);

    var rerender = function () { renderModelSheet(panel); };
    var readAdvanced = function () {
      var node = panel.querySelector('#w-name');
      if (!node) return;
      w.name = String(node.value || '').trim();
      w.baseUrl = String((panel.querySelector('#w-baseurl') || {}).value || '').trim().replace(/\/+$/, '');
      w.protocol = (panel.querySelector('#w-protocol') || {}).value || 'openai-compatible';
      w.env = String((panel.querySelector('#w-envname') || {}).value || '').trim();
    };

    panel.querySelectorAll('[data-preset]').forEach(function (button) {
      button.onclick = function () {
        readAdvanced();
        w.preset = button.getAttribute('data-preset');
        var picked = presetOf(w.preset);
        w.model = (picked.models || [])[0] || '';
        w.name = picked.label;
        w.baseUrl = picked.baseUrl;
        w.protocol = picked.protocol;
        w.env = picked.env;
        w.step = 2;
        rerender();
      };
    });

    var next = panel.querySelector('#w-next');
    if (next) next.onclick = function () {
      readAdvanced();
      if (w.step === 1) { if (!w.preset) return; w.step = 2; }
      else {
        var modelNode = panel.querySelector('#w-model');
        w.model = modelNode ? String(modelNode.value || '').trim() : w.model;
        if (!w.model) { toast('请选择或填写一个模型', true); return; }
        var keyNode = panel.querySelector('#w-key');
        w.pastedKey = keyNode ? String(keyNode.value || '').trim() : '';
        w.step = 3;
      }
      rerender();
    };

    var prev = panel.querySelector('#w-prev');
    if (prev) prev.onclick = function () { readAdvanced(); w.step = Math.max(1, w.step - 1); rerender(); };

    var adv = panel.querySelector('#w-adv');
    if (adv) adv.onclick = function () { readAdvanced(); wizardAdvanced = !wizardAdvanced; rerender(); };

    var copy = panel.querySelector('#w-copy');
    if (copy) copy.onclick = function () {
      var text = panel.querySelector('#w-env-cmd').textContent;
      var done = function () { toast('命令已复制'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { selectAll('w-env-cmd'); });
      } else selectAll('w-env-cmd');
    };

    var save = panel.querySelector('#w-save');
    if (save) save.onclick = function () {
      readAdvanced();
      var payload = {
        id: w.editing ? w.editing.id : w.preset,
        name: w.name || (preset ? preset.label : w.preset),
        protocol: w.protocol || (preset ? preset.protocol : 'openai-compatible'),
        baseUrl: w.baseUrl || (preset ? preset.baseUrl : ''),
        model: w.model,
        apiKeyEnv: w.env || (preset ? preset.env : 'CRAFT_API_KEY'),
        supportsTools: true
      };
      if (!payload.id) { toast('请先选择服务商', true); return; }
      if (!/^[a-z0-9-]+$/.test(payload.id)) { toast('服务商标识只能用小写字母、数字和短横线', true); return; }
      if (!payload.baseUrl) { toast('请填写服务地址', true); return; }
      if (!/^https?:\/\//.test(payload.baseUrl)) { toast('服务地址要以 http:// 或 https:// 开头', true); return; }
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(payload.apiKeyEnv)) { toast('环境变量名格式不正确', true); return; }
      var request = w.editing
        ? api('/api/config/models/' + encodeURIComponent(w.editing.id), { method: 'PATCH', body: payload })
        : api('/api/config/models', { method: 'POST', body: payload });
      request.then(function () {
        state.execution = { mode: 'provider', provider: payload.id, tier: 'standard' };
        execSave();
        renderStatusExecution();
        toast(w.editing ? '已保存' : '已添加模型「' + payload.name + '」');
        if (state.page === 'models') paint('models'); else go('models');
      }).catch(fail);
    };
  }

  function presetEnvCommand(env) {
    return '[Environment]::SetEnvironmentVariable(\'' + env + '\', \'你的Key\', \'User\')';
  }

  function selectAll(id) {
    var node = $(id);
    if (!node || !window.getSelection) return;
    try {
      var range = document.createRange();
      range.selectNodeContents(node);
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      toast('已选中命令，按 Ctrl+C 复制');
    } catch (_) { /* selection unavailable */ }
  }

  // --------------------------------------------------------------------- boot

  function boot() {
    var params = new URLSearchParams(location.hash.replace(/^#/, ''));
    state.token = params.get('token') || '';
    state.page = params.get('page') || 'home';
    if (!knownPage(state.page)) state.page = 'home';
    state.selectedTask = params.get('task') || null;
    state.selectedProject = params.get('project') || null;
    execLoad();
    applyTheme();
    renderStatusExecution();

    if (!state.token) {
      $('content').innerHTML = '<div class="callout warn">' + icon('key') +
        '<span>这个页面没有访问凭证。请从 Craft Workbench 桌面图标重新打开。</span></div>';
      $('rail-status').setAttribute('data-state', 'bad');
      $('rail-status').querySelector('.conn-text').textContent = '未授权';
      $('sb-conn').setAttribute('data-state', 'bad');
      $('sb-conn').lastChild.textContent = '未授权';
      return;
    }

    $('jump-new-task').onclick = openComposer;
    $('settings-nav').onclick = function () { go('settings'); };
    $('nav-back').onclick = function () { history.back(); };
    $('nav-forward').onclick = function () { history.forward(); };
    $('aside-toggle').onclick = function () {
      var app = $('app'); var next = app.getAttribute('data-aside') === 'open' ? 'collapsed' : 'open';
      app.setAttribute('data-aside', next); $('aside-toggle').setAttribute('aria-pressed', String(next === 'collapsed'));
    };
    var settings = $('settings-nav');
    if (settings) settings.setAttribute('aria-current', String(current === 'settings'));
    document.querySelectorAll('[data-menu]').forEach(function (button) { button.onclick = function () { openTopMenu(button.getAttribute('data-menu'), button); }; });
    document.addEventListener('click', function (event) { if (!event.target.closest('[data-menu], #top-menu')) closeTopMenu(); });
    // The folder tree lives in the static rail markup, so bind once here instead
    // of re-binding on every repaint.
    // Three things live in one tree: the chevron folds a folder, the folder name
    // opens its detail page, and a row opens the task.
    $('folder-tree').onclick = function (event) {
      var chevron = event.target.closest('[data-chev]');
      if (chevron) { toggleFolder(chevron.getAttribute('data-chev')); return; }
      var more = event.target.closest('[data-more]');
      if (more) {
        var key = more.getAttribute('data-more');
        if (state.showAllFolders[key]) delete state.showAllFolders[key];
        else state.showAllFolders[key] = true;
        renderFolderTree(false);
        return;
      }
      var task = event.target.closest('[data-task]');
      if (task) { openTask(task.getAttribute('data-task')); return; }
      var folder = event.target.closest('[data-folder]');
      if (folder) openFolder(folder.getAttribute('data-folder'));
    };
    $('task-view').onclick = function () {
      state.taskView = state.taskView === 'task' ? 'folder' : 'task';
      paintFolderTree();
    };
    $('task-fold').onclick = function () {
      var groups = state.folderGroups || [];
      var anyOpen = groups.some(function (group) { return !state.collapsedFolders[group.key]; });
      state.collapsedFolders = {};
      if (anyOpen) groups.forEach(function (group) { state.collapsedFolders[group.key] = true; });
      state.showAllFolders = {};
      paintFolderTree();
    };
    $('rail-toggle').onclick = function () {
      var app = $('app');
      var next = app.getAttribute('data-rail') === 'open' ? 'collapsed' : 'open';
      app.setAttribute('data-rail', next);
      $('rail-toggle').setAttribute('aria-pressed', String(next === 'collapsed'));
    };
    // 文档 8：展开才看细节，默认收起。收起状态不丢信息——一行 live 摘要仍在。
    $('sb-toggle').onclick = function () {
      var bar = $('statusbar');
      var next = bar.getAttribute('data-open') === 'true' ? 'false' : 'true';
      bar.setAttribute('data-open', next);
      $('sb-toggle').setAttribute('aria-expanded', next);
      $('sb-detail').hidden = next !== 'true';
    };
    media.addEventListener('change', function () { if (state.theme === 'system') applyTheme(); });

    document.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if ($('palette-host').hidden) openPalette(); else closePalette();
        return;
      }
      if (event.key !== 'Escape') return;
      if (openMenu) { closeTopMenu(); return; }
      if (!$('palette-host').hidden) { closePalette(); return; }
      if (inlineForm) dismissInline(inlineForm.page);
    });

    api('/api/settings').then(function (settings) {
      state.settings = settings;
      if (settings.theme) { state.theme = settings.theme; applyTheme(); }
      if (settings.runtime && settings.runtime.defaultTier) state.tier = settings.runtime.defaultTier;
    }).catch(function () { /* fall back to the cached theme */ });

    api('/api/workbench/summary').then(function (info) {
      $('brand-version').textContent = 'v' + info.version;
      state.counts = info.counts || {};
      $('rail-status').setAttribute('data-state', 'ok');
      $('rail-status').querySelector('.conn-text').textContent = '已连接 · 仅本机';
      $('sb-conn').setAttribute('data-state', 'ok');
      $('sb-conn').lastChild.textContent = '已连接';
      $('sb-root').textContent = info.data_root || '—';
      $('sb-counts').textContent = '任务 ' + esc(state.counts.task || 0) + ' · 文件夹 ' + esc(state.counts.project_brain || 0) +
        ' · 能力 ' + esc(state.counts.capability_connector || 0);
      paintNav();
      // The rail chip and the status bar must agree; both read the same total.
      var listCount = $('task-list-count');
      if (listCount && state.counts.task != null) listCount.textContent = String(state.counts.task);
    }).catch(function () {
      $('rail-status').setAttribute('data-state', 'bad');
      $('rail-status').querySelector('.conn-text').textContent = '连接失败';
      $('sb-conn').setAttribute('data-state', 'bad');
      $('sb-conn').lastChild.textContent = '连接失败';
    });

    api('/api/home').then(function (home) {
      var launches = home.work_launches || [];
      $('sb-host').textContent = '任务运行 ' + (launches.length ? (launches[0].host || '—') : '自动');
      // 文档 8：「正在发生」收起时只说一句话——现在到底有没有东西在跑。
      // 展开才有细节；把过程摆在中央等于把监工合法化，所以这一行是它唯一的固定位置。
      var summary = home.summary || {};
      var activeRuns = Number(summary.active_runs || 0);
      var activeTasks = Number(summary.active_tasks || 0);
      var live = $('sb-live');
      if (activeRuns || activeTasks) {
        live.textContent = activeRuns + ' 个运行中 · ' + activeTasks + ' 个任务进行中';
        live.setAttribute('data-state', 'busy');
      } else {
        live.textContent = '空闲';
        live.setAttribute('data-state', 'idle');
      }
    }).catch(function () { /* status bar keeps the placeholder */ });

    renderFolderTree(true);

    paint(state.page);

    // First-run setup: without a model Craft cannot do anything, so open the
    // wizard in the right panel (never a modal) instead of leaving a dead app.
    api('/api/config/models').then(function (result) {
      var models = result.models || [];
      if (!models.length) openExecutionSetup();
    }).catch(function () { /* ignore, the settings page can be opened manually */ });
  }

  window.addEventListener('hashchange', function () {
    var params = new URLSearchParams(location.hash.replace(/^#/, ''));
    state.token = params.get('token') || state.token;
    state.page = params.get('page') || state.page;
    if (!knownPage(state.page)) state.page = 'home';
    state.selectedTask = params.get('task') || null;
    state.selectedProject = params.get('project') || null;
    state.selectedTaskTitle = state.selectedTask ? (taskTitleOf(state.selectedTask) || state.selectedTaskTitle) : '';
    paint(state.page);
  });

  boot();
})();
