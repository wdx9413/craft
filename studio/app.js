/* Craft Studio — desktop shell for the Craft runtime.
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
    human_approval: '人工审批', assisted_approval: '帮我审批', full_access: '完全访问'
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
      view: [['收起左侧栏', function () { $('rail-toggle').click(); }], ['收起右侧信息', function () { $('aside-toggle').click(); }], [resolvedTheme() === 'dark' ? '切换浅色主题' : '切换深色主题', toggleTheme]],
      help: [['键盘快捷键', function () { toast('Ctrl/⌘ + Enter 发送对话；Esc 关闭面板。'); }], ['关于 Craft Studio', function () { toast('Craft Studio · 本机任务工作台'); }]]
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

  function call(tool, args) { return api('/api/studio/call', { method: 'POST', body: { tool: tool, args: args || {} } }); }

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
    { key: 'capabilities', label: '能力', title: '能力', sub: 'Craft 能替你做的事，以及每件事的来源与影响范围', icon: 'plug', view: viewCapabilities },
    { key: 'settings', label: '设置', title: '设置', sub: '模型、用量、外观与高级选项', icon: 'sliders', view: viewSettings }
  ];

  var FLAT = NAV;
  var NAV_COUNT = { capabilities: 'capability_connector' };

  // Home is where the app already lands, so it needs no nav entry either: it is
  // the composer and nothing else — the task list lives in the rail.
  var HOME_PAGE = { key: 'home', label: '任务', title: '任务', sub: '说清楚要做什么，选一个文件夹，其余交给 Craft', icon: 'tasks', view: viewHome };

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
    document.title = title + ' · Craft Studio';

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
  var caps = { connectors: [], assets: [] };

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
    return id;
  }

  function loadCapabilities() {
    if (caps.assets.length) return Promise.resolve(caps);
    return api('/api/connectors?limit=100').then(function (result) {
      caps.connectors = result.connectors || [];
      caps.assets = result.assets || [];
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
            options([['human_approval', '人工审批'], ['assisted_approval', '帮我审批'], ['full_access', '完全访问']], c.permission) +
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
    if (setup) setup.onclick = function () { go('settings'); };
    box.onkeydown = function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); submitComposer(); }
    };
    renderComposerChips();
  }

  // 「新建任务」 means "put the cursor where a task gets written", so it focuses
  // the composer instead of opening a dialog.
  function openComposer() {
    if (state.page !== 'home') { go('home'); return; }
    var box = $('composer-text');
    if (box) box.focus();
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
    var prompt = chosen.length ? raw + '\n\n可用的能力：' + chosen.map(capNameOf).join('、') : raw;
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
    // Prefer the real total from /api/studio/summary so the chip matches the
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
      return {
        html: '<div class="stack home">' + composerHtml() +
          '<p class="home-hint">按 Ctrl + Enter 直接开始。所有任务在左边「任务」里，默认按文件夹分组。</p>' +
          '</div>',
        aside: asideCollapsible('文件夹是什么',
            '<div class="aside-note">一个文件夹记录一个方向：目标是什么、做过哪些决定、参考了哪些资料、最后得到了什么。' +
            'Craft 只保存引用与摘要，不保存原文。</div>') +
          asideBlock('这次任务', '', '<div class="aside-list">' +
            '<div class="aside-row"><span class="k">文件夹</span><span class="v" id="aside-folder">' + esc(folderNameOf(state.composer.folder)) + '</span></div>' +
            '<div class="aside-row"><span class="k">权限</span><span class="v" id="aside-sandbox">' + esc(state.composer.sandbox === 'workspace-write' ? '完全访问' : '有限访问') + '</span></div>' +
            '</div>'),
        mounts: [bindComposer]
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
        var usable = (caps.assets || []).filter(function (item) { return item.status === 'approved'; });
        var body = usable.length
          ? usable.map(function (item) {
              return '<label class="check cap-row"><input type="checkbox" data-cap="' + esc(item.id) + '"' +
                (chosen.indexOf(item.id) >= 0 ? ' checked' : '') + '>' +
                '<span class="cap-text"><b>' + esc(item.name) + '</b><span>' +
                esc(label(ASSET_TYPE_LABELS, item.asset_type, item.asset_type)) + ' · ' +
                esc(label(EFFECT_LABELS, item.effect, item.effect)) + '</span></span></label>';
            }).join('') + '<div class="aside-note" style="margin-top:10px">还没处理的能力先到「能力」页确认。</div>'
          : '<div class="aside-note">还没有已确认可用的能力。先到「能力」页添加一个来源，扫描并确认要用的能力。</div>';
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
    return api('/api/tasks/' + encodeURIComponent(taskId)).then(function (detail) {
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

      state.selectedTaskTitle = task.title || '';
      if (state.page === 'task') {
        var heading = state.selectedTaskTitle || '任务';
        $('page-title').textContent = heading;
        document.title = heading + ' · Craft Studio';
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

      var pending = (latest && latest.pending) || [];
      var aside = asideCollapsible('任务信息', asideRows([
        ['状态', label(STATUS_LABELS, task.status, task.status || '—')],
        ['文件夹', folder],
        ['模型', task.model_id || '—'],
        ['权限', label(TASK_PERMISSION_LABELS, task.permission_mode, '人工审批')],
        ['创建时间', shortTime(task.created_at) || '—'],
        ['最近更新', shortTime(task.updated_at) || '—']
      ])) +
      asideCollapsible('查看说明', '<div class="aside-note">' +
        '目标＝这件事要达成什么；进度＝最近一次做到哪一步；结论＝独立验收的结果；' +
        '产物＝产出的文件与代码改动；验证＝每条结论的依据；活动＝对话与运行过程中发生的事。</div>') +
      (pending.length ? asideCollapsible('还剩 ' + pending.length + ' 步', '<div class="aside-note">' +
        pending.map(function (stage) { return esc(label(STAGE_LABELS, stage, stage)); }).join('、') + '</div>') : '');

      return {
        html: '<div class="stack task-page">' + goalCard + conversationCard +
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
        .then(function () { toast('已添加本机文件夹'); paint('capabilities'); }).catch(fail);
      return;
    }
    var body = { kind: val('source-kind'), name: name, endpoint: val('source-endpoint') || undefined,
      approved: true, approval_ref: 'studio-user-approval',
      metadata: { registered_from: 'craft-studio', note: val('source-note') || undefined } };
    var ops = val('source-ops');
    if (ops) body.allowed_operations = ops.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    api('/api/connectors', { method: 'POST', body: body })
      .then(function () {
        toast('已添加来源「' + name + '」');
        // Not an interstitial any more: the next step is a card at the top of
        // the column, right next to the list of sources it refers to.
        openInlineOn('capabilities', {
          title: '来源已添加',
          sub: name,
          html: '<div class="callout info">' + icon('arrow') + '<span>下一步：点该来源上的「扫描可用能力」，把里面的能力登记进来。扫描只是登记，不会下载也不会运行。</span></div>' +
            '<div class="aside-note">Craft 只保存来源信息与摘要，不保存任何密码或密钥。</div>',
          actions: [{ label: '知道了', primary: true, run: function () { dismissInline('capabilities'); } }]
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
      .then(function () { clearInline(); toast('资产已登记，等待审批'); paint('capabilities'); })
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
            '<button class="btn primary" id="source-setup-open" type="button">' + icon('plus') + '添加来源</button>') +
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
          if (setupOpen) setupOpen.onclick = function () { state.capabilitySetupOpen = true; paint('capabilities'); };
          var setupClose = root.querySelector('#source-setup-close');
          if (setupClose) setupClose.onclick = function () { state.capabilitySetupOpen = false; paint('capabilities'); };
          var register = root.querySelector('#source-register');
          if (register) register.onclick = registerSource;
          var sourceTabs = root.querySelector('#source-tabs');
          if (sourceTabs) sourceTabs.onclick = function (event) {
            var tab = event.target.closest('[data-source]');
            if (tab) { activeSource = tab.getAttribute('data-source'); paint('capabilities'); }
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
              api('/api/connector-assets/' + encodeURIComponent(id) + '/approve', { method: 'POST', body: { approval_ref: 'studio-user-approval' } })
                .then(function () { toast('已确认可用'); paint('capabilities'); }).catch(fail);
            };
          });
          root.querySelectorAll('[data-toggle]').forEach(function (button) {
            button.onclick = function () {
              var id = button.getAttribute('data-toggle');
              api('/api/connectors/' + encodeURIComponent(id) + '/status', { method: 'POST', body: { active: button.getAttribute('data-active') !== 'true' } })
                .then(function () { paint('capabilities'); }).catch(fail);
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
                  { label: '取消', run: function () { clearInline(); paint('capabilities'); } },
                  { label: '确认撤销', primary: true, danger: true, run: function () {
                    api('/api/connectors/' + encodeURIComponent(id) + '/revoke', { method: 'POST', body: { reason: 'revoked from Craft Studio' } })
                      .then(function () { clearInline(); toast('已撤销'); paint('capabilities'); }).catch(fail);
                  } }
                ]
              });
            };
          });
        }]
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

  function openSheet(render) {
    var panel = $('aside-panel');
    if (!panel) return;
    panel.innerHTML = '';
    render(panel);
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

  // Execution mode is genuinely three-state: '' (nothing chosen yet), 'cli'
  // (local CLI runner) and 'provider' (vendor model API). The status bar used
  // to compress that into a "is a model configured?" boolean and only ever set
  // 'provider' on a first run with zero models, so it kept reading 未配置 even
  // after a model had been saved. Render the real mode and refresh on change.
  function renderStatusExecution() {
    var node = $('sb-mode');
    if (!node) return;
    var mode = state.execution && state.execution.mode;
    if (mode === 'cli') node.textContent = '模型 本地 CLI';
    else if (mode === 'provider') node.textContent = '模型 API 已配置';
    else node.textContent = '模型 未设置';
  }

  function openExecutionSetup() {
    openSheetAfterPaint('settings', function () {
      openModelSheet({ step: 1, preset: null, model: '', name: '' });
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
        if (state.page === 'settings') paint('settings'); else go('settings');
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
        '<span>这个页面没有访问凭证。请从 Craft Studio 桌面图标重新打开。</span></div>';
      $('rail-status').setAttribute('data-state', 'bad');
      $('rail-status').querySelector('.conn-text').textContent = '未授权';
      $('sb-conn').setAttribute('data-state', 'bad');
      $('sb-conn').lastChild.textContent = '未授权';
      return;
    }

    $('jump-new-task').onclick = openComposer;
    $('nav-back').onclick = function () { history.back(); };
    $('nav-forward').onclick = function () { history.forward(); };
    $('aside-toggle').onclick = function () {
      var app = $('app'); var next = app.getAttribute('data-aside') === 'open' ? 'collapsed' : 'open';
      app.setAttribute('data-aside', next); $('aside-toggle').setAttribute('aria-pressed', String(next === 'collapsed'));
    };
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

    api('/api/studio/summary').then(function (info) {
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
