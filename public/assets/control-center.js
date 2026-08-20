import { button, clear, el, emptyState, pill, skeleton, text } from './components.js';
import { mountNamespaceSelector } from './namespace-selector.mjs';

const NAV_GROUPS = [
  {
    label: '工作台',
    items: [
      { path: '/dashboard', label: '總覽', glyph: '總' },
      { path: '/memories', label: '記憶庫', glyph: '庫' },
      { path: '/review', label: '審核佇列', glyph: '審', badge: true },
    ],
  },
  {
    label: '管理',
    items: [
      { path: '/agents', label: '連線', glyph: '連', admin: true },
      { path: '/namespaces', label: '命名空間', glyph: '域' },
      { path: '/policies', label: '治理政策', glyph: '策', admin: true },
      { path: '/audit', label: '稽核軌跡', glyph: '稽', admin: true },
      { path: '/effectiveness', label: '記憶效益', glyph: '效' },
    ],
  },
  {
    label: '系統',
    items: [{ path: '/settings', label: '安全與維運', glyph: '維', admin: true }],
  },
];

const PAGE_TITLES = {
  '/': '總覽',
  '/dashboard': '總覽',
  '/memories': '記憶庫',
  '/review': '審核佇列',
  '/agents': '連線',
  '/namespaces': '命名空間',
  '/policies': '治理政策',
  '/audit': '稽核軌跡',
  '/effectiveness': '記憶效益',
  '/settings': '安全與維運',
};

const state = {
  me: null,
  csrf: '',
  namespace: '',
  pending: 0,
  toastTimer: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const content = $('#content');

function formatDate(value, includeTime = true) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-TW', includeTime
    ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function relativeTime(value) {
  if (!value) return '尚未連線';
  const ms = Date.now() - Date.parse(value);
  if (!Number.isFinite(ms)) return formatDate(value);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '剛剛';
  if (minutes < 60) return `${minutes} 分鐘前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小時前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatDate(value, false);
}

function humanize(value) {
  const labels = {
    source: '來源投影', memory: '長期記憶', task_state: '任務狀態', accepted: '已接受', candidate: '待審核', rejected: '已拒絕', revoked: '已撤銷',
    normal: '一般', private: '私密', active: '有效', completed: '完成', cancelled: '取消', superseded: '已取代',
    fact: '事實', preference: '偏好', decision: '決策', experience: '經驗', procedure: '程序', relationship: '關係', working_state: '進行中狀態',
    helpful: '有幫助', mixed: '部分有幫助', harmful: '有害', unknown: '未知',
    pass: '通過', warn: '注意', fail: '失敗', allow: '允許', deny: '拒絕',
  };
  return labels[value] || String(value || '—').replaceAll('_', ' ');
}

function toneFor(value) {
  if (['accepted', 'active', 'pass', 'allow', 'helpful'].includes(value)) return 'good';
  if (['candidate', 'warn', 'mixed', 'private', 'working_state'].includes(value)) return 'warn';
  if (['rejected', 'revoked', 'disabled', 'fail', 'deny', 'harmful'].includes(value)) return 'bad';
  if (['memory', 'agent', 'enrollment_key'].includes(value)) return 'blue';
  if (['source', 'service'].includes(value)) return 'violet';
  return 'neutral';
}

function showStatus(message, bad = false) {
  const node = $('#status');
  clearTimeout(state.toastTimer);
  node.textContent = message || '';
  node.className = `toast${message ? ' visible' : ''}${bad ? ' bad' : ''}`;
  if (message) state.toastTimer = setTimeout(() => { node.className = 'toast'; }, 4200);
}

function withNamespace(path, params = {}) {
  const url = new URL(path, location.origin);
  if (state.namespace && path.startsWith('/v1/control/') && !url.searchParams.has('namespace')) url.searchParams.set('namespace', state.namespace);
  for (const [key, value] of Object.entries(params)) {
    if (value !== '' && value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.pathname + url.search;
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.csrf) headers['X-CSRF-Token'] = state.csrf;
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (response.status === 401) {
    location.assign('/auth/login?return_to=' + encodeURIComponent(location.pathname + location.search));
    throw new Error('需要重新登入');
  }
  if (!response.ok) throw new Error(body?.error?.message || `HTTP ${response.status}`);
  return body;
}

function pageHeader(kicker, title, description, actions = []) {
  return el('header', { className: 'page-header' }, [
    el('div', { className: 'page-heading' }, [
      text('span', kicker, 'section-kicker'),
      text('h1', title),
      text('p', description),
    ]),
    actions.length ? el('div', { className: 'page-actions' }, actions) : null,
  ]);
}

function card(title, description, body, action) {
  return el('section', { className: 'card' }, [
    el('header', { className: 'card-header' }, [
      el('div', {}, [text('h2', title), description ? text('p', description) : null]),
      action || null,
    ]),
    el('div', { className: 'card-body' }, body),
  ]);
}

function metric(label, value, meta, tone = '') {
  return el('article', { className: `metric-card ${tone}`.trim() }, [
    text('span', label, 'metric-label'),
    text('strong', value, 'metric-value'),
    text('span', meta, `metric-meta ${tone === 'warn' ? 'warn' : tone === 'good' ? 'good' : ''}`.trim()),
  ]);
}

function linkButton(label, href, tone = 'secondary') {
  return el('a', { className: `button ${tone}`, text: label, href });
}

function setBusy(value = true) {
  content.setAttribute('aria-busy', String(value));
  if (value) clear(content).append(skeleton(4));
}

function renderError(error) {
  clear(content).append(
    pageHeader('ERROR', '無法載入這個畫面', '請確認目前身分、命名空間權限與服務狀態。'),
    card('錯誤資訊', null, [text('p', error.message || String(error), 'danger-text')]),
  );
  content.setAttribute('aria-busy', 'false');
}

function mountNavigation() {
  const nav = $('#primary-nav');
  clear(nav);
  for (const group of NAV_GROUPS) {
    nav.append(text('div', group.label, 'nav-label'));
    for (const item of group.items) {
      if (item.admin && !state.me.principal.controlAdmin) continue;
      const link = el('a', { className: 'nav-link', href: `${item.path}?namespace=${encodeURIComponent(state.namespace)}` }, [
        text('span', item.glyph, 'nav-glyph'),
        text('span', item.label),
      ]);
      if ((location.pathname === '/' ? '/dashboard' : location.pathname) === item.path) link.setAttribute('aria-current', 'page');
      if (item.badge && state.pending > 0) link.append(text('span', state.pending > 99 ? '99+' : state.pending, 'nav-badge'));
      nav.append(link);
    }
  }
  $('#current-section').textContent = PAGE_TITLES[location.pathname] || 'Control Center';
}

function mountIdentity() {
  const principal = state.me.principal;
  const name = principal.displayName || principal.display_name || principal.subject;
  const initials = name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  const root = $('#identity-button');
  $('.avatar', root).textContent = initials || 'U';
  $('strong', root).textContent = name;
  $('small', root).textContent = principal.controlAdmin ? 'Control admin' : 'Namespace reviewer';
  root.addEventListener('click', () => location.assign(`/settings?namespace=${encodeURIComponent(state.namespace)}`));
}

function setupMobileNavigation() {
  const sidebar = $('#sidebar');
  const toggle = $('#menu-toggle');
  const scrim = $('#sidebar-scrim');
  const close = () => {
    sidebar.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
    scrim.hidden = true;
  };
  toggle.addEventListener('click', () => {
    const open = !sidebar.classList.contains('open');
    sidebar.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    scrim.hidden = !open;
  });
  scrim.addEventListener('click', close);
  sidebar.addEventListener('click', (event) => { if (event.target.closest('a')) close(); });
}

function summaryCount(counts, informationClass) {
  return (counts || []).filter((row) => row.information_class === informationClass).reduce((sum, row) => sum + Number(row.count || 0), 0);
}

function effectivenessStats(data) {
  const rows = data?.summary || [];
  const total = rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const helpful = rows.filter((row) => row.outcome === 'helpful').reduce((sum, row) => sum + Number(row.count || 0), 0);
  const changed = rows.filter((row) => Boolean(row.action_changed)).reduce((sum, row) => sum + Number(row.count || 0), 0);
  return { total, helpful, changed, ratio: total ? Math.round((helpful / total) * 100) : 0 };
}

async function renderDashboard() {
  setBusy();
  const [dashboard, effectiveness, maintenance] = await Promise.all([
    api(withNamespace('/v1/control/dashboard')),
    api(withNamespace('/v1/control/effectiveness')).catch(() => null),
    state.me.principal.controlAdmin ? api('/v1/control/maintenance').catch(() => null) : Promise.resolve(null),
  ]);
  state.pending = Number(dashboard.candidates || 0);
  mountNavigation();
  const counts = dashboard.counts || [];
  const sources = summaryCount(counts, 'source');
  const memories = summaryCount(counts, 'memory');
  const taskStates = summaryCount(counts, 'task_state');
  const agents = dashboard.agents || [];
  const activeAgents = agents.filter((agent) => !agent.disabled && agent.activity?.last_tool_call_at).length;
  const neverConnected = agents.filter((agent) => !agent.disabled && !agent.activity?.last_tool_call_at).length;
  const effect = effectivenessStats(effectiveness);

  const root = clear(content);
  root.append(pageHeader('TODAY', '管理總覽', `聚焦 ${state.namespace} 命名空間中需要處理的事項、資料健康與 Agent 連線狀態。`, [
    linkButton('搜尋記憶', `/memories?namespace=${encodeURIComponent(state.namespace)}`),
    linkButton('開始審核', `/review?namespace=${encodeURIComponent(state.namespace)}`, 'primary'),
  ]));

  if (state.pending > 0) {
    root.append(el('a', { className: 'attention-banner', href: `/review?namespace=${encodeURIComponent(state.namespace)}` }, [
      el('div', { className: 'attention-copy' }, [
        text('span', '!', 'attention-icon'),
        el('div', {}, [text('strong', `${state.pending} 筆 AI 提案等待你的裁決`), text('p', 'Candidate 不會進入其他 Agent 的共享讀取面，直到你接受。')]),
      ]),
      text('span', '前往審核 →', 'button ghost'),
    ]));
  }

  root.append(el('div', { className: 'metric-grid' }, [
    metric('正式記憶', memories, '可跨對話重用的 accepted Memory', 'good'),
    metric('來源投影', sources, '保留 source_uri 的最小化投影'),
    metric('待審提案', state.pending, state.pending ? '需要 human reviewer 裁決' : '目前已清空', state.pending ? 'warn' : 'good'),
    metric('有幫助比例', effect.total ? `${effect.ratio}%` : '—', effect.total ? `${effect.helpful} / ${effect.total} 次 outcome` : '尚無 outcome feedback', 'violet'),
  ]));

  const actionRows = [];
  actionRows.push(el('a', { className: 'action-row', href: `/review?namespace=${encodeURIComponent(state.namespace)}` }, [
    text('span', '審', `action-glyph ${state.pending ? 'warn' : 'good'}`),
    el('span', { className: 'action-copy' }, [text('strong', state.pending ? `${state.pending} 筆提案待審` : '審核佇列已清空'), text('small', state.pending ? '檢查內容、來源、敏感度與 successor 關係' : 'Agent 新提案會出現在這裡')]),
    text('span', '›', 'arrow'),
  ]));
  actionRows.push(el('a', { className: 'action-row', href: `/agents?namespace=${encodeURIComponent(state.namespace)}` }, [
    text('span', '連', `action-glyph ${neverConnected ? 'warn' : 'good'}`),
    el('span', { className: 'action-copy' }, [text('strong', neverConnected ? `${neverConnected} 個連線尚無活動` : `${activeAgents} 個連線近期有活動`), text('small', '查看 credential 狀態、權限上限與 enrollment lifecycle')]),
    text('span', '›', 'arrow'),
  ]));
  if (effectiveness?.low_value?.length) {
    actionRows.push(el('a', { className: 'action-row', href: `/effectiveness?namespace=${encodeURIComponent(state.namespace)}` }, [
      text('span', '效', 'action-glyph warn'),
      el('span', { className: 'action-copy' }, [text('strong', `${effectiveness.low_value.length} 筆記憶出現低價值訊號`), text('small', '只提供整理建議，不會自動修改 accepted Memory')]),
      text('span', '›', 'arrow'),
    ]));
  }
  if (maintenance) {
    actionRows.push(el('a', { className: 'action-row', href: `/settings?namespace=${encodeURIComponent(state.namespace)}` }, [
      text('span', '維', `action-glyph ${maintenance.status === 'pass' ? 'good' : 'warn'}`),
      el('span', { className: 'action-copy' }, [text('strong', `Doctor：${humanize(maintenance.status)}`), text('small', `Schema ${maintenance.runtime?.schema_version ?? '—'} · ${maintenance.runtime?.version ?? 'unknown'}@${String(maintenance.runtime?.build_commit || 'unknown').slice(0, 7)}`)]),
      text('span', '›', 'arrow'),
    ]));
  }

  const total = Math.max(1, sources + memories + taskStates);
  const distribution = [
    ['來源投影', sources], ['長期記憶', memories], ['任務狀態', taskStates],
  ].map(([label, value]) => el('div', { className: 'distribution-row' }, [
    text('span', label),
    el('progress', { attrs: { max: total, value, 'aria-label': `${label} ${value}` } }),
    text('b', value),
  ]));

  root.append(el('div', { className: 'panel-grid' }, [
    card('需要你處理', '把管理工作依風險與時效集中在同一個入口。', actionRows),
    card('資料結構', `目前可見共 ${sources + memories + taskStates} 筆 accepted 資訊。`, [el('div', { className: 'distribution-list' }, distribution)]),
  ]));

  const rows = agents.slice(0, 8).map((agent) => {
    const activity = agent.activity?.last_tool_call_at || agent.activity?.last_write_at || agent.activity?.last_seen_at;
    const status = agent.disabled ? 'disabled' : activity ? 'active' : 'pending';
    return el('tr', {}, [
      el('td', {}, [el('div', { className: 'table-primary' }, [text('strong', agent.name), text('small', agent.id)])]),
      el('td', {}, [pill(agent.principal_kind === 'service' ? 'Service' : 'Agent', toneFor(agent.principal_kind))]),
      el('td', {}, [pill(status === 'active' ? '已連線' : status === 'disabled' ? '已停用' : '等待首次連線', toneFor(status))]),
      text('td', humanize(agent.auth_method || 'legacy_key')),
      text('td', relativeTime(activity)),
    ]);
  });
  root.append(card('連線近況', '只顯示 metadata 與活動時間，不顯示或保存 raw credential。', [
    rows.length ? el('div', { className: 'table-wrap' }, [
      el('table', { className: 'data-table' }, [
        el('thead', {}, [el('tr', {}, ['名稱', '類型', '狀態', '認證', '最近活動'].map((label) => text('th', label)))]),
        el('tbody', {}, rows),
      ]),
    ]) : emptyState('尚未建立連線', '建立 Agent 或來源 service 後，就能在這裡查看連線狀態。'),
  ], linkButton('管理全部連線', `/agents?namespace=${encodeURIComponent(state.namespace)}`, 'ghost')));

  content.setAttribute('aria-busy', 'false');
}

function facetOptions(select, rows, placeholder) {
  clear(select).append(el('option', { text: placeholder, value: '' }));
  for (const row of rows || []) select.append(el('option', { text: `${humanize(row.value)} (${row.count})`, value: row.value }));
}

function itemRows(items, openItem) {
  return items.map((item) => {
    const row = el('tr', { attrs: { 'data-open': item.id, tabindex: '0' } }, [
      el('td', {}, [el('div', { className: 'table-primary' }, [text('strong', item.title || '未命名'), text('small', item.content || item.snippet || '沒有文字內容')])]),
      el('td', {}, [pill(humanize(item.information_class), toneFor(item.information_class)), item.memory_kind ? pill(humanize(item.memory_kind), 'neutral') : null]),
      el('td', {}, [pill(humanize(item.trust_state), toneFor(item.trust_state))]),
      text('td', item.source || '—'),
      el('td', {}, [pill(humanize(item.sensitivity), toneFor(item.sensitivity))]),
      text('td', formatDate(item.updated_at || item.created_at, false)),
    ]);
    row.addEventListener('click', () => openItem(item.id));
    row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openItem(item.id); } });
    return row;
  });
}

function openSheet(title) {
  const dialog = $('#detail-dialog');
  $('#detail-dialog-title').textContent = title;
  clear($('#detail-dialog-content'));
  if (!dialog.open) dialog.showModal();
  return $('#detail-dialog-content');
}

function detailDefinition(entries) {
  const list = el('dl', { className: 'detail-list' });
  for (const [label, value] of entries) list.append(text('dt', label), value instanceof Node ? el('dd', {}, [value]) : text('dd', value ?? '—'));
  return list;
}

async function showMemoryDetail(id) {
  const mount = openSheet('載入記憶…');
  mount.append(skeleton(4));
  try {
    const data = await api(withNamespace(`/v1/control/memories/${encodeURIComponent(id)}`));
    const item = data.item;
    $('#detail-dialog-title').textContent = item.title || '記憶詳細資料';
    clear(mount);
    mount.append(
      el('div', { className: 'row-actions' }, [
        pill(humanize(item.information_class), toneFor(item.information_class)),
        item.memory_kind ? pill(humanize(item.memory_kind), 'neutral') : null,
        pill(humanize(item.trust_state), toneFor(item.trust_state)),
        pill(humanize(item.sensitivity), toneFor(item.sensitivity)),
      ]),
      el('section', { className: 'dialog-section' }, [text('h3', '內容'), text('div', item.content || '沒有文字內容', 'content-block')]),
      el('section', { className: 'dialog-section' }, [
        text('h3', '治理與來源'),
        detailDefinition([
          ['ID', text('span', item.id, 'mono')],
          ['Namespace', item.namespace],
          ['來源 / authority', `${item.source} / ${humanize(item.authority)}`],
          ['狀態', humanize(item.status)],
          ['有效期間', `${formatDate(item.valid_from)} ～ ${formatDate(item.valid_until)}`],
          ['接受方式', item.acceptance_method ? `${humanize(item.acceptance_method)} · policy v${item.acceptance_policy_version ?? '—'}` : '—'],
          ['來源連結', item.source_uri || '—'],
          ['Tags', item.tags?.length ? item.tags.join(' · ') : '—'],
          ['Entities', item.entities?.length ? item.entities.join(' · ') : '—'],
        ]),
      ]),
    );

    if (data.curation_suggestions?.length) {
      mount.append(el('section', { className: 'dialog-section' }, [
        text('h3', '整理建議'),
        ...data.curation_suggestions.map((suggestion) => el('div', { className: 'boundary-note' }, [
          text('span', '◇', 'action-glyph warn'),
          el('div', {}, [text('strong', humanize(suggestion.kind)), text('p', suggestion.reason || `Related: ${(suggestion.related_item_ids || []).join(', ')}`)]),
        ])),
      ]));
    }

    if (data.predecessor || data.successor) {
      mount.append(el('section', { className: 'dialog-section' }, [
        text('h3', '版本關係'),
        detailDefinition([
          ['前一版本', data.predecessor ? data.predecessor.title : '—'],
          ['後繼版本', data.successor ? data.successor.title : '—'],
        ]),
      ]));
    }

    const timelineRows = [
      ...(data.versions || []).map((version) => ({ title: `Revision ${version.revision} · ${humanize(version.event_type || version.action || 'version')}`, at: version.created_at, by: version.created_by || version.actor_id })),
      ...(data.reviews || []).map((review) => ({ title: `審核：${humanize(review.decision)}`, at: review.created_at, by: review.reviewer_id || review.reviewed_by, note: review.note || review.review_note })),
    ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    mount.append(el('section', { className: 'dialog-section' }, [
      text('h3', `版本與裁決 (${timelineRows.length})`),
      timelineRows.length ? el('div', { className: 'timeline' }, timelineRows.map((entry) => el('div', { className: 'timeline-item' }, [
        text('span', '', 'timeline-dot'),
        el('div', {}, [text('strong', entry.title), text('small', `${formatDate(entry.at)} · ${entry.by || 'system'}${entry.note ? ` · ${entry.note}` : ''}`)]),
      ]))) : text('p', '尚無額外版本紀錄。', 'muted subtle'),
    ]));

    if (item.trust_state === 'accepted' && item.information_class === 'memory' && !item.superseded_by) {
      const form = el('form', { className: 'form-grid' }, [
        el('label', { className: 'field span-2' }, [text('span', '新標題'), el('input', { name: 'title', value: item.title, required: true })]),
        el('label', { className: 'field' }, [text('span', 'Memory kind'), el('select', { name: 'memory_kind' }, ['fact', 'preference', 'decision', 'experience', 'procedure', 'relationship', 'working_state'].map((kind) => el('option', { value: kind, text: humanize(kind), attrs: kind === item.memory_kind ? { selected: '' } : {} })))]),
        el('label', { className: 'field' }, [text('span', '敏感度'), el('select', { name: 'sensitivity' }, ['normal', 'private'].map((value) => el('option', { value, text: humanize(value), attrs: value === item.sensitivity ? { selected: '' } : {} })))]),
        el('label', { className: 'field span-2' }, [text('span', '新的內容'), el('textarea', { name: 'content', value: item.content, required: true })]),
        el('div', { className: 'span-2 dialog-actions' }, [button('提出 successor', 'primary', { type: 'submit' })]),
      ]);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(form));
        try {
          await api(withNamespace(`/v1/control/memories/${encodeURIComponent(item.id)}/successors`), {
            method: 'POST',
            body: JSON.stringify({
              namespace: state.namespace,
              type: item.type,
              title: values.title,
              content: values.content,
              tags: item.tags || [],
              entities: item.entities || [],
              sensitivity: values.sensitivity,
              status: 'active',
              memory_kind: values.memory_kind,
              derived_from: [],
              idempotency_key: crypto.randomUUID(),
            }),
          });
          showStatus('已建立 successor 提案，等待審核。');
          $('#detail-dialog').close();
        } catch (error) { showStatus(error.message, true); }
      });
      mount.append(el('section', { className: 'dialog-section' }, [
        text('h3', '修正這筆 accepted Memory'),
        text('p', '正式記憶不可直接覆寫。新的 successor 經接受後，舊記憶才會原子地標記為已取代。', 'muted subtle'),
        form,
      ]));
    }
  } catch (error) {
    clear(mount).append(emptyState('無法讀取這筆記憶', error.message));
  }
}

async function renderMemories() {
  setBusy();
  const root = clear(content);
  const search = el('input', { placeholder: '搜尋標題、內容、entity…', attrs: { type: 'search', 'aria-label': '搜尋記憶' } });
  const infoClass = el('select', { attrs: { 'aria-label': '資訊角色' } });
  const memoryKind = el('select', { attrs: { 'aria-label': '記憶種類' } });
  const source = el('select', { attrs: { 'aria-label': '來源' } });
  const sensitivity = el('select', { attrs: { 'aria-label': '敏感度' } }, [
    el('option', { value: '', text: '所有敏感度' }), el('option', { value: 'normal', text: '一般' }), el('option', { value: 'private', text: '私密' }),
  ]);
  const validity = el('select', { attrs: { 'aria-label': '有效性' } }, [
    el('option', { value: 'current', text: '目前有效' }), el('option', { value: 'scheduled', text: '尚未生效' }), el('option', { value: 'expired', text: '已過期' }), el('option', { value: 'all', text: '全部有效期' }),
  ]);
  const submit = button('套用篩選', 'primary');
  const reset = button('清除', 'secondary');
  const toolbar = el('form', { className: 'toolbar' }, [
    el('div', { className: 'search-field' }, [search]), infoClass, memoryKind, source, sensitivity, validity, submit, reset,
  ]);
  const summary = el('div', { className: 'result-summary' });
  const tableMount = el('div', { className: 'card' });
  root.append(
    pageHeader('LIBRARY', '記憶庫', '用同一個工作台查看 Source、Memory 與 Task State；搜尋仍先套用 namespace、ACL、trust 與有效期過濾。'),
    toolbar,
    summary,
    tableMount,
  );

  let cursor = null;
  let rows = [];
  async function load(resetRows = true) {
    tableMount.setAttribute('aria-busy', 'true');
    if (resetRows) { cursor = null; rows = []; clear(tableMount).append(skeleton(4)); }
    const params = {
      q: search.value.trim(),
      information_class: infoClass.value,
      memory_kind: memoryKind.value,
      source: source.value,
      sensitivity: sensitivity.value,
      validity: validity.value,
      cursor,
      limit: 40,
      mode: 'hybrid',
    };
    try {
      const data = await api(withNamespace('/v1/control/memories', params));
      const incoming = data.fullItems || data.items || [];
      rows = resetRows ? incoming : [...rows, ...incoming];
      cursor = data.next_cursor || null;
      clear(tableMount);
      summary.replaceChildren(text('span', `找到 ${data.totalMatched ?? rows.length} 筆，目前顯示 ${rows.length} 筆`));
      const chips = el('div', { className: 'filter-chips' });
      for (const [label, value] of [['角色', infoClass.value], ['種類', memoryKind.value], ['來源', source.value], ['敏感度', sensitivity.value], ['有效性', validity.value !== 'current' ? validity.value : '']]) {
        if (value) chips.append(text('span', `${label}：${humanize(value)}`, 'filter-chip'));
      }
      summary.append(chips);
      if (!rows.length) {
        tableMount.append(emptyState('沒有符合條件的資料', '調整搜尋字詞或篩選條件；candidate 請到審核佇列查看。'));
      } else {
        tableMount.append(el('div', { className: 'table-wrap' }, [
          el('table', { className: 'data-table' }, [
            el('thead', {}, [el('tr', {}, ['標題與內容', '角色 / 種類', 'Trust', '來源', '敏感度', '更新'].map((label) => text('th', label)))]),
            el('tbody', {}, itemRows(rows, showMemoryDetail)),
          ]),
        ]));
        if (cursor) {
          const more = button('載入更多', 'secondary');
          more.addEventListener('click', () => load(false));
          tableMount.append(el('div', { className: 'load-more' }, [more]));
        }
      }
    } catch (error) {
      clear(tableMount).append(emptyState('載入失敗', error.message));
    } finally { tableMount.setAttribute('aria-busy', 'false'); }
  }

  submit.addEventListener('click', (event) => { event.preventDefault(); load(true); });
  toolbar.addEventListener('submit', (event) => { event.preventDefault(); load(true); });
  reset.addEventListener('click', () => {
    search.value = ''; infoClass.value = ''; memoryKind.value = ''; source.value = ''; sensitivity.value = ''; validity.value = 'current'; load(true);
  });

  try {
    const facetsData = await api(withNamespace('/v1/control/memories/facets'));
    facetOptions(infoClass, facetsData.facets?.information_class, '所有資訊角色');
    facetOptions(memoryKind, facetsData.facets?.memory_kind, '所有記憶種類');
    facetOptions(source, facetsData.facets?.source, '所有來源');
  } catch {
    facetOptions(infoClass, [], '所有資訊角色'); facetOptions(memoryKind, [], '所有記憶種類'); facetOptions(source, [], '所有來源');
  }
  await load(true);
  content.setAttribute('aria-busy', 'false');
}

async function reviewOne(item, decision, note = '') {
  return api(withNamespace(`/v1/control/review/items/${encodeURIComponent(item.id)}`), {
    method: 'POST',
    body: JSON.stringify({ namespace: state.namespace, decision, expected_revision: item.revision, note, idempotency_key: crypto.randomUUID() }),
  });
}

async function renderReview() {
  setBusy();
  const data = await api(withNamespace('/v1/control/review/candidates'));
  state.pending = data.items.length;
  mountNavigation();
  const root = clear(content);
  const selected = new Map();
  let activeGroup = 'all';
  const groupCounts = {
    all: data.items.length,
    conflict: data.groups?.conflict?.length || 0,
    duplicate: data.groups?.duplicate?.length || 0,
    stale: data.groups?.stale?.length || 0,
    general: data.groups?.general?.length || 0,
  };
  const tabs = el('div', { className: 'review-tabs', attrs: { role: 'tablist', 'aria-label': '提案分類' } });
  const list = el('div', { className: 'review-list' });
  const batch = el('div', { className: 'batch-bar hidden' });
  root.append(
    pageHeader('REVIEW', '審核佇列', '用內容、來源、敏感度與版本關係判斷一則提案是否值得成為跨 Agent 的正式記憶。'),
    tabs,
    el('div', { className: 'result-summary' }, [text('span', `共 ${data.items.length} 筆待審提案`)]),
    list,
    batch,
  );

  function visibleItems() {
    if (activeGroup === 'all') return data.items;
    return data.groups?.[activeGroup] || [];
  }

  function renderBatch() {
    clear(batch);
    const values = [...selected.values()];
    batch.classList.toggle('hidden', !values.length);
    if (!values.length) return;
    const privateCount = values.filter((item) => item.sensitivity === 'private').length;
    const confirmation = el('label', { className: privateCount ? '' : 'hidden' }, [
      el('input', { type: 'checkbox', attrs: { 'aria-label': '確認審核私密記憶' } }),
      text('span', ` 我已確認 ${privateCount} 筆私密提案`, 'subtle'),
    ]);
    const note = el('input', { placeholder: '批次審核註記（選填）', attrs: { 'aria-label': '批次審核註記' } });
    const accept = button('全部接受', 'primary', { attrs: { 'data-batch': 'accept' } });
    const reject = button('全部拒絕', 'danger', { attrs: { 'data-batch': 'reject' } });
    async function run(decision) {
      if (privateCount && !$('input', confirmation).checked) { showStatus('請先確認已檢查私密提案。', true); return; }
      accept.disabled = true; reject.disabled = true;
      try {
        await api(withNamespace('/v1/control/review/batch'), {
          method: 'POST',
          body: JSON.stringify({
            namespace: state.namespace,
            confirm_namespace: state.namespace,
            confirm_item_ids: values.map((item) => item.id),
            confirm_counts: { normal: values.length - privateCount, private: privateCount },
            confirm_private: !privateCount || $('input', confirmation).checked,
            items: values.map((item) => ({ id: item.id, decision, expected_revision: item.revision, note: note.value, idempotency_key: crypto.randomUUID() })),
          }),
        });
        showStatus(`已完成 ${values.length} 筆批次審核。`);
        await renderReview();
      } catch (error) { showStatus(error.message, true); accept.disabled = false; reject.disabled = false; }
    }
    accept.addEventListener('click', () => run('accept'));
    reject.addEventListener('click', () => run('reject'));
    batch.append(
      el('div', {}, [text('strong', `已選 ${values.length} 筆`), text('small', `${values.length - privateCount} 一般 · ${privateCount} 私密`)]),
      note,
      confirmation,
      el('div', { className: 'row-actions' }, [reject, accept]),
    );
  }

  function renderList() {
    clear(list);
    const items = visibleItems();
    if (!items.length) {
      list.append(emptyState(data.items.length ? '這個分類沒有提案' : '審核佇列已清空', data.items.length ? '切換其他分類繼續查看。' : '新的 Agent 提案會先停在這裡，不會自動進入共享讀取面。'));
      return;
    }
    for (const item of items) {
      const checkbox = el('input', { className: 'review-checkbox', type: 'checkbox', checked: selected.has(item.id), attrs: { 'aria-label': `選取 ${item.title}` } });
      const cardNode = el('article', { className: `review-card${selected.has(item.id) ? ' selected' : ''}` }, [checkbox]);
      const note = el('input', { placeholder: '審核註記（選填）', attrs: { 'aria-label': `${item.title} 審核註記` } });
      const accept = button('接受', 'primary small');
      const reject = button('拒絕', 'danger small');
      const detail = button('查看完整資料', 'ghost small');
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.set(item.id, item); else selected.delete(item.id);
        cardNode.classList.toggle('selected', checkbox.checked);
        renderBatch();
      });
      detail.addEventListener('click', () => showMemoryDetail(item.id));
      const decide = async (decision) => {
        accept.disabled = true; reject.disabled = true;
        try {
          await reviewOne(item, decision, note.value);
          showStatus(`已${decision === 'accept' ? '接受' : '拒絕'}「${item.title}」。`);
          await renderReview();
        } catch (error) { showStatus(error.message, true); accept.disabled = false; reject.disabled = false; }
      };
      accept.addEventListener('click', () => decide('accept'));
      reject.addEventListener('click', () => decide('reject'));
      cardNode.append(el('div', { className: 'review-main' }, [
        el('div', { className: 'review-top' }, [
          el('div', {}, [text('h3', item.title || '未命名提案'), el('div', { className: 'review-meta' }, [pill(humanize(item.memory_kind || item.type)), pill(item.source, 'blue'), pill(humanize(item.sensitivity), toneFor(item.sensitivity)), item.successor_of ? pill('Successor', 'violet') : null])]),
          text('span', `rev ${item.revision}`, 'mono muted'),
        ]),
        text('div', item.content || '沒有文字內容', 'review-content'),
        el('div', { className: 'review-actions' }, [note, el('div', { className: 'row-actions' }, [detail, reject, accept])]),
      ]));
      list.append(cardNode);
    }
  }

  for (const [key, label] of [['all', '全部'], ['conflict', '衝突 / successor'], ['duplicate', '可能重複'], ['stale', '已過期'], ['general', '一般']]) {
    const tab = button(`${label} ${groupCounts[key]}`, '');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(key === activeGroup));
    tab.addEventListener('click', () => {
      activeGroup = key;
      for (const node of tabs.querySelectorAll('button')) node.setAttribute('aria-selected', String(node === tab));
      renderList();
    });
    tabs.append(tab);
  }
  renderList();
  renderBatch();
  content.setAttribute('aria-busy', 'false');
}

function showEnrollment(enrollment) {
  const modal = $('#enrollment-secret-modal');
  const code = $('[data-enrollment-code]', modal);
  const countdown = $('[data-enrollment-countdown]', modal);
  code.textContent = enrollment?.code || '';
  if (!code.textContent) return;
  const expires = Date.parse(enrollment.expiresAt || enrollment.expires_at || '') || Date.now() + 600_000;
  const tick = () => { countdown.textContent = `${Math.max(0, Math.ceil((expires - Date.now()) / 1000))} 秒後到期`; };
  tick();
  const timer = setInterval(tick, 1000);
  modal.dataset.timer = String(timer);
  modal.showModal();
}

function agentStatus(agent) {
  if (agent.disabled) return { value: 'disabled', label: '已停用' };
  if (agent.enrollments?.some((enrollment) => enrollment.status === 'pending')) return { value: 'pending', label: '等待 enrollment' };
  if (agent.activity?.last_tool_call_at || agent.activity?.last_write_at) return { value: 'active', label: '已連線' };
  return { value: 'pending', label: '等待首次活動' };
}

async function showAgentDetail(id, refreshPage) {
  const mount = openSheet('載入連線…');
  mount.append(skeleton(4));
  try {
    const data = await api(withNamespace(`/v1/control/agents/${encodeURIComponent(id)}`));
    const client = data.client;
    const status = agentStatus({ ...client, activity: data.activity, enrollments: data.enrollments });
    $('#detail-dialog-title').textContent = client.name;
    clear(mount).append(
      el('div', { className: 'row-actions' }, [pill(status.label, toneFor(status.value)), pill(humanize(client.principal_kind), toneFor(client.principal_kind)), pill(humanize(client.auth_method || 'legacy_key'), 'blue')]),
      el('section', { className: 'dialog-section' }, [
        text('h3', '有效權限'),
        data.policy_capabilities?.length ? el('div', { className: 'row-actions' }, data.policy_capabilities.map((capability) => pill(capability, 'neutral'))) : text('p', '目前政策沒有授予 capability。', 'muted subtle'),
      ]),
      el('section', { className: 'dialog-section' }, [
        text('h3', 'Credential 與邊界'),
        detailDefinition([
          ['Client ID', text('span', client.id, 'mono')],
          ['Namespace', data.namespace],
          ['Scopes', (data.scopes || []).join(' · ') || '—'],
          ['敏感度上限', humanize(data.sensitivity_ceiling)],
          ['來源上限', data.source_ceiling?.join(' · ') || '所有已授權來源'],
          ['Credential version', String(data.credential_version ?? '—')],
          ['最近 tool call', relativeTime(data.activity?.last_tool_call_at)],
          ['最近寫入', relativeTime(data.activity?.last_write_at)],
        ]),
      ]),
      el('section', { className: 'dialog-section' }, [
        text('h3', `Enrollment lifecycle (${data.enrollments?.length || 0})`),
        ...(data.enrollments?.length ? data.enrollments.map((enrollment) => el('div', { className: 'history-row' }, [
          text('span', 'ENR', 'version-badge'),
          el('div', {}, [text('strong', enrollment.status), text('small', `${formatDate(enrollment.created_at)} · expires ${formatDate(enrollment.expires_at)}`)]),
          enrollment.status === 'pending' ? pill('待交換', 'warn') : pill(humanize(enrollment.status), toneFor(enrollment.status)),
        ])) : [text('p', '尚無 enrollment 紀錄。', 'muted subtle')]),
      ]),
    );
    const actions = el('div', { className: 'dialog-actions' });
    const toggle = button(client.disabled ? '重新啟用' : '停用連線', client.disabled ? 'primary' : 'danger');
    toggle.addEventListener('click', async () => {
      const verb = client.disabled ? 'enable' : 'disable';
      if (!window.confirm(`${client.disabled ? '重新啟用' : '停用'} ${client.id}？`)) return;
      try {
        await api(withNamespace(`/v1/control/agents/${encodeURIComponent(id)}/${verb}`), { method: 'POST', body: JSON.stringify({ confirm_id: id, idempotency_key: crypto.randomUUID() }) });
        showStatus(`已${client.disabled ? '啟用' : '停用'} ${client.name}。`);
        $('#detail-dialog').close();
        await refreshPage();
      } catch (error) { showStatus(error.message, true); }
    });
    actions.append(toggle);
    if (!client.disabled && client.auth_method === 'enrollment_key') {
      const enroll = button('建立新的 enrollment', 'secondary');
      enroll.addEventListener('click', async () => {
        try {
          const result = await api(withNamespace(`/v1/control/agents/${encodeURIComponent(id)}/re-enroll`), { method: 'POST', body: JSON.stringify({ confirm_id: id, idempotency_key: crypto.randomUUID() }) });
          if (result.replayed || !result.code) showStatus('這次重試不會再次顯示 secret，請建立新的 enrollment。', true);
          else showEnrollment(result);
        } catch (error) { showStatus(error.message, true); }
      });
      actions.prepend(enroll);
    }
    mount.append(actions);
  } catch (error) { clear(mount).append(emptyState('無法載入連線', error.message)); }
}

async function showAgentCreate(refreshPage) {
  const mount = openSheet('建立新的連線');
  const kind = el('select', { name: 'principal_kind' }, [el('option', { value: 'agent', text: 'AI Agent' }), el('option', { value: 'service', text: '來源 Service / Connector' })]);
  const profile = el('select', { name: 'profile' }, [
    el('option', { value: 'agent-default', text: 'Agent default（提案先進 candidate）' }),
    el('option', { value: 'app-producer', text: 'App producer（來源投影）' }),
    el('option', { value: 'connector-producer', text: 'Connector producer' }),
    el('option', { value: 'none', text: 'None（零權限，稍後設定）' }),
  ]);
  kind.addEventListener('change', () => { profile.value = kind.value === 'service' ? 'app-producer' : 'agent-default'; });
  const form = el('form', { className: 'form-grid' }, [
    el('label', { className: 'field' }, [text('span', 'Client ID'), el('input', { name: 'id', placeholder: '例如 hermes-personal', required: true, attrs: { pattern: '[a-z0-9][a-z0-9_-]{1,63}' } }), text('small', '建立後不可重用；只使用小寫、數字、_、-。', 'field-help')]),
    el('label', { className: 'field' }, [text('span', '顯示名稱'), el('input', { name: 'name', placeholder: '例如 Hermes 個人助理', required: true })]),
    el('label', { className: 'field' }, [text('span', 'Principal 類型'), kind]),
    el('label', { className: 'field' }, [text('span', 'Namespace'), el('input', { name: 'namespace', value: state.namespace, required: true, attrs: { readonly: '' } })]),
    el('label', { className: 'field span-2' }, [text('span', '權限 Profile'), profile, text('small', 'Profile 只是在建立時產生明確、可版本化的 policy grants。', 'field-help')]),
    el('label', { className: 'field' }, [text('span', '敏感度上限'), el('select', { name: 'max_sensitivity' }, [el('option', { value: 'normal', text: '一般' }), el('option', { value: 'private', text: '可讀私密資料' })])]),
    el('label', { className: 'field' }, [text('span', '認證方式'), el('select', { name: 'auth_method' }, [el('option', { value: 'enrollment_key', text: 'Single-use enrollment' }), el('option', { value: 'legacy_key', text: 'Legacy API key' })])]),
    el('label', { className: 'field span-2' }, [text('span', '限制可讀來源（選填，以逗號分隔）'), el('input', { name: 'read_sources', placeholder: 'github-worker, calendar-worker' })]),
    el('div', { className: 'span-2 boundary-note' }, [text('span', '!', 'action-glyph'), el('div', {}, [text('strong', '一個 credential 只綁定一個 namespace'), text('p', '若同一個 Agent 需要 personal 與 work，請建立兩個分開的 client 與連線。')])]),
    el('div', { className: 'span-2 dialog-actions' }, [button('取消', 'secondary', { attrs: { 'data-cancel': '' } }), button('建立連線', 'primary', { type: 'submit' })]),
  ]);
  $('[data-cancel]', form).addEventListener('click', () => $('#detail-dialog').close());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    const submit = $('button[type="submit"]', form);
    submit.disabled = true;
    try {
      const result = await api(withNamespace('/v1/control/agents'), {
        method: 'POST',
        body: JSON.stringify({
          id: values.id,
          name: values.name,
          namespace: values.namespace,
          principal_kind: values.principal_kind,
          scopes: ['read', 'write'],
          profile: values.profile,
          max_sensitivity: values.max_sensitivity,
          read_sources: values.read_sources ? String(values.read_sources).split(',').map((value) => value.trim()).filter(Boolean) : null,
          auth_method: values.auth_method,
          idempotency_key: crypto.randomUUID(),
          confirm_id: values.id,
        }),
      });
      $('#detail-dialog').close();
      showStatus(`已建立 ${result.client.name}。`);
      if (result.enrollment?.code && !result.replayed) showEnrollment(result.enrollment);
      await refreshPage();
    } catch (error) { showStatus(error.message, true); submit.disabled = false; }
  });
  mount.append(
    text('p', '建立 Agent 或來源 service。Credential raw value 不會進入瀏覽器長期儲存。', 'muted subtle'),
    form,
  );
}

async function renderAgents() {
  setBusy();
  const data = await api(withNamespace('/v1/control/agents'));
  const root = clear(content);
  const create = button('新增連線', 'primary');
  const search = el('input', { placeholder: '搜尋名稱或 Client ID', attrs: { type: 'search', 'aria-label': '搜尋連線' } });
  const kind = el('select', { attrs: { 'aria-label': '連線類型' } }, [el('option', { value: '', text: '所有類型' }), el('option', { value: 'agent', text: 'Agent' }), el('option', { value: 'service', text: 'Service / Connector' })]);
  const grid = el('div', { className: 'connection-grid' });
  root.append(
    pageHeader('CONNECTIONS', 'Agent 與來源連線', '把 Agent、App producer 與 Connector 視為受治理的 principal；查看它們的權限、credential lifecycle 與最近活動。', [create]),
    el('div', { className: 'toolbar' }, [el('div', { className: 'search-field' }, [search]), kind]),
    el('div', { className: 'result-summary' }, [text('span', `${data.agents.length} 個 ${state.namespace} 連線`)]),
    grid,
  );
  const refresh = () => renderAgents();
  create.addEventListener('click', () => showAgentCreate(refresh));

  function renderGrid() {
    clear(grid);
    const query = search.value.trim().toLowerCase();
    const agents = data.agents.filter((agent) => (!kind.value || agent.principal_kind === kind.value) && (!query || `${agent.name} ${agent.id}`.toLowerCase().includes(query)));
    if (!agents.length) {
      const emptyCreate = button('建立連線', 'primary');
      emptyCreate.addEventListener('click', () => showAgentCreate(refresh));
      grid.append(emptyState('找不到符合條件的連線', '清除搜尋或建立新的 Agent / Service。', emptyCreate));
      return;
    }
    for (const agent of agents) {
      const status = agentStatus(agent);
      const activity = agent.activity?.last_tool_call_at || agent.activity?.last_write_at || agent.activity?.last_seen_at;
      const open = button('查看權限', 'ghost small');
      open.addEventListener('click', () => showAgentDetail(agent.id, refresh));
      grid.append(el('article', { className: 'connection-card' }, [
        el('div', { className: 'connection-head' }, [
          el('div', { className: 'connection-name' }, [
            text('span', agent.principal_kind === 'service' ? 'APP' : 'AI', 'connection-icon'),
            el('div', {}, [text('strong', agent.name), text('small', agent.id)]),
          ]),
          pill(status.label, toneFor(status.value)),
        ]),
        el('div', { className: 'connection-stats' }, [
          el('div', { className: 'mini-stat' }, [text('span', '認證'), text('b', humanize(agent.auth_method || 'legacy_key'))]),
          el('div', { className: 'mini-stat' }, [text('span', '最近活動'), text('b', relativeTime(activity))]),
          el('div', { className: 'mini-stat' }, [text('span', '敏感度'), text('b', humanize(agent.max_sensitivity))]),
          el('div', { className: 'mini-stat' }, [text('span', 'Credential'), text('b', `v${agent.credential_version ?? '—'}`)]),
        ]),
        el('div', { className: 'connection-footer' }, [
          el('div', {}, [pill(humanize(agent.principal_kind), toneFor(agent.principal_kind)), agent.enrollments?.some((enrollment) => enrollment.status === 'pending') ? pill('待 enrollment', 'warn') : null]),
          open,
        ]),
      ]));
    }
  }
  search.addEventListener('input', renderGrid);
  kind.addEventListener('change', renderGrid);
  renderGrid();
  content.setAttribute('aria-busy', 'false');
}

async function renderNamespaces() {
  setBusy();
  const data = await api('/v1/control/namespaces');
  const root = clear(content);
  root.append(pageHeader('BOUNDARIES', '命名空間', 'Namespace 是 server-side security boundary。Control admin 身分本身不會取得任何 namespace 的 Memory 讀取權。'));
  const grid = el('div', { className: 'namespace-grid' });
  for (const entry of data.namespaces || []) {
    const isWork = entry.namespace === 'work';
    grid.append(el('article', { className: `namespace-card${isWork ? ' work' : ''}` }, [
      el('div', { className: 'connection-head' }, [text('h2', entry.namespace), pill(entry.namespace === state.namespace ? '目前使用' : '可存取', entry.namespace === state.namespace ? 'blue' : 'neutral')]),
      text('p', isWork ? '只保存抽取後的工作摘要、決議與行動項目；禁止 raw mail、逐字稿、PII 與機密原文。' : '個人偏好、生活脈絡、個人專案與一般任務記憶。'),
      text('span', '已連結 Human clients', 'section-kicker'),
      el('div', { className: 'namespace-links' }, (entry.linked_clients || []).map((client) => pill(client, 'neutral'))),
      linkButton(entry.namespace === state.namespace ? '查看記憶庫' : '切換到這個空間', `/dashboard?namespace=${encodeURIComponent(entry.namespace)}`, entry.namespace === state.namespace ? 'secondary' : 'primary'),
    ]));
  }
  root.append(grid);
  root.append(el('div', { className: 'boundary-note' }, [
    text('span', '界', 'action-glyph'),
    el('div', {}, [text('strong', '同一個工具跨 personal / work 時，必須使用兩把不同的 key 與兩條 MCP 連線。'), text('p', 'Namespace、source、authority 與 creator identity 都由 server 從 credential 決定，caller payload 無法覆寫。')]),
  ]));
  content.setAttribute('aria-busy', 'false');
}

function policyOverview(rules) {
  const grants = rules.grants || [];
  const createRules = rules.create_rules || [];
  const stateRules = rules.state_rules || [];
  return el('div', {}, [
    el('div', { className: 'policy-summary' }, [
      el('div', { className: 'policy-count' }, [text('b', grants.length), text('span', 'Capability grants')]),
      el('div', { className: 'policy-count' }, [text('b', createRules.length), text('span', 'Create rules')]),
      el('div', { className: 'policy-count' }, [text('b', stateRules.length), text('span', 'Exact state rules')]),
    ]),
    text('h3', 'Client grants'),
    grants.length ? el('div', { className: 'check-list' }, grants.map((grant) => el('div', { className: 'check-row' }, [
      text('span', '•', 'status-dot good'),
      el('div', { className: 'check-copy' }, [text('strong', grant.client_id), text('small', (grant.capabilities || []).join(' · '))]),
      pill(`${grant.capabilities?.length || 0} capabilities`, 'neutral'),
    ]))) : text('p', '目前沒有 grants；此 namespace 會 fail-closed。', 'muted subtle'),
  ]);
}

async function renderPolicies() {
  setBusy();
  const data = await api(withNamespace(`/v1/control/policies/${encodeURIComponent(state.namespace)}`));
  const root = clear(content);
  const editor = el('textarea', { className: 'policy-editor', value: JSON.stringify(data.rules, null, 2), attrs: { spellcheck: 'false', 'aria-label': 'Policy JSON 編輯器' } });
  const validation = el('div');
  const validate = button('驗證草稿', 'secondary');
  const apply = button('套用為新版本', 'primary');
  const overviewMount = el('div');
  overviewMount.append(policyOverview(data.rules));
  root.append(pageHeader('GOVERNANCE', '治理政策', `目前 ${state.namespace} policy v${data.version}。政策缺失、schema 未知或跨 namespace 引用都會 fail-closed。`, [validate, apply]));
  root.append(el('div', { className: 'panel-grid' }, [
    card('目前政策摘要', '先用管理者語言檢查 grants 與規則，再到右側進階編輯。', [overviewMount]),
    card('Policy JSON', '編輯不會立即生效；請先驗證，套用時使用 optimistic concurrency。', [editor, validation]),
  ]));

  const simulationClient = el('input', { placeholder: 'client id', attrs: { 'aria-label': '模擬 Client ID' } });
  const simulationKind = el('select', { attrs: { 'aria-label': '模擬操作' } }, [
    el('option', { value: 'capability', text: 'Capability' }), el('option', { value: 'create', text: 'Create item type' }), el('option', { value: 'state_read', text: 'State read' }), el('option', { value: 'state_write', text: 'State write' }),
  ]);
  const simulationValue = el('input', { placeholder: '例如 memory.read_accepted', attrs: { 'aria-label': '模擬值' } });
  const simulate = button('執行模擬', 'secondary');
  const simulationResult = el('div');
  const simulationCard = card('變更前模擬', '以一個具體 client / operation 驗證草稿的 allow 或 deny，不寫入政策。', [
    el('div', { className: 'toolbar' }, [simulationClient, simulationKind, simulationValue, simulate]),
    simulationResult,
  ]);
  root.append(simulationCard);

  const historyMount = el('div', { className: 'policy-history' });
  for (const version of data.history || []) {
    const rollback = button('回復到此版', 'ghost small', { disabled: version.version === data.version });
    rollback.addEventListener('click', async () => {
      if (!window.confirm(`建立一個內容等同 v${version.version} 的新政策版本？`)) return;
      try {
        await api(withNamespace(`/v1/control/policies/${encodeURIComponent(state.namespace)}/rollback`), { method: 'POST', body: JSON.stringify({ version: version.version, base_version: data.version, idempotency_key: crypto.randomUUID() }) });
        showStatus(`已回復到 v${version.version} 的規則內容。`);
        await renderPolicies();
      } catch (error) { showStatus(error.message, true); }
    });
    historyMount.append(el('div', { className: 'history-row' }, [
      text('span', `v${version.version}`, 'version-badge'),
      el('div', {}, [text('strong', version.version === data.version ? '目前版本' : '歷史版本'), text('small', `${formatDate(version.created_at)} · ${version.created_by || version.applied_by || 'system'}`)]),
      rollback,
    ]));
  }
  root.append(card('版本歷史', 'Rollback 不會覆寫歷史，而是以舊規則建立一個新的 current version。', [historyMount]));

  function readDraft() {
    try { return JSON.parse(editor.value); }
    catch (error) { throw new Error(`JSON 格式錯誤：${error.message}`); }
  }
  editor.addEventListener('input', () => {
    try { clear(overviewMount).append(policyOverview(readDraft())); }
    catch { /* keep the last valid overview while editing */ }
  });
  validate.addEventListener('click', async () => {
    try {
      const result = await api(withNamespace(`/v1/control/policies/${encodeURIComponent(state.namespace)}/validate`), { method: 'POST', body: JSON.stringify({ rules: readDraft() }) });
      validation.className = `validation-result ${result.valid ? 'good' : 'bad'}`;
      validation.textContent = result.valid ? '✓ 草稿結構、引用與安全規則均通過驗證。' : result.error || '政策未通過驗證。';
    } catch (error) { validation.className = 'validation-result bad'; validation.textContent = error.message; }
  });
  apply.addEventListener('click', async () => {
    if (!window.confirm(`將草稿套用為 ${state.namespace} 的新 policy version？`)) return;
    try {
      await api(withNamespace(`/v1/control/policies/${encodeURIComponent(state.namespace)}/apply`), { method: 'POST', body: JSON.stringify({ rules: readDraft(), base_version: data.version, idempotency_key: crypto.randomUUID() }) });
      showStatus('Policy 已套用為新版本。');
      await renderPolicies();
    } catch (error) { showStatus(error.message, true); }
  });
  simulate.addEventListener('click', async () => {
    try {
      const kind = simulationKind.value;
      const input = { kind, client_id: simulationClient.value.trim() };
      if (kind === 'capability') input.capability = simulationValue.value.trim();
      else if (kind === 'create') input.item_type = simulationValue.value.trim();
      else input.state_key = simulationValue.value.trim();
      const result = await api(withNamespace(`/v1/control/policies/${encodeURIComponent(state.namespace)}/simulate`), { method: 'POST', body: JSON.stringify({ rules: readDraft(), cases: [input] }) });
      const first = result.results?.[0];
      clear(simulationResult).append(el('div', { className: `validation-result ${first?.allowed ? 'good' : 'bad'}` }, [text('strong', first?.allowed ? '允許' : '拒絕'), text('span', ` · ${humanize(first?.reason_code)}${first?.matched_rule_id ? ` · ${first.matched_rule_id}` : ''}`)]));
    } catch (error) { clear(simulationResult).append(text('div', error.message, 'validation-result bad')); }
  });
  content.setAttribute('aria-busy', 'false');
}

function auditRows(entries) {
  return entries.map((entry) => {
    const status = entry.outcome || 'allow';
    return el('div', { className: 'audit-event' }, [
      text('span', '', `status-dot ${toneFor(status)}`),
      el('div', { className: 'audit-main' }, [
        text('strong', entry.action || 'unknown action'),
        text('small', `${entry.client_id || entry.clientId || 'system'} · ${entry.namespace || '*'}${entry.item_id ? ` · ${entry.item_id}` : ''}`),
      ]),
      el('div', {}, [text('span', formatDate(entry.created_at || entry.occurred_at), 'audit-time'), pill(humanize(status), toneFor(status))]),
    ]);
  });
}

async function renderAudit() {
  setBusy();
  const root = clear(content);
  const client = el('input', { placeholder: 'Client ID', attrs: { 'aria-label': 'Client ID 篩選' } });
  const action = el('input', { placeholder: 'Action，例如 read.search', attrs: { 'aria-label': 'Action 篩選' } });
  const outcome = el('select', { attrs: { 'aria-label': '結果篩選' } }, [el('option', { value: '', text: '允許與拒絕' }), el('option', { value: 'allow', text: '允許' }), el('option', { value: 'deny', text: '拒絕' })]);
  const submit = button('套用', 'primary');
  const list = el('div', { className: 'card' }, [skeleton(4)]);
  root.append(
    pageHeader('AUDIT', '稽核軌跡', '每一次讀取、寫入、拒絕與管理操作都 fail-closed 留痕；details 不保存 query 原文、item 內容或 snippet。', [linkButton('查看記憶效益', `/effectiveness?namespace=${encodeURIComponent(state.namespace)}`)]),
    el('form', { className: 'toolbar' }, [client, action, outcome, submit]),
    el('div', { className: 'result-summary' }),
    list,
  );
  async function load() {
    clear(list).append(skeleton(4));
    try {
      const data = await api(withNamespace('/v1/control/audit', { client_id: client.value.trim(), action: action.value.trim(), outcome: outcome.value, limit: 300 }));
      clear(list);
      $('.result-summary', root).textContent = `顯示最近 ${data.entries.length} 筆 metadata-only 稽核事件`;
      list.append(data.entries.length ? el('div', { className: 'card-body' }, auditRows(data.entries)) : emptyState('沒有符合條件的稽核事件', '調整 Client ID、Action 或結果篩選。'));
    } catch (error) { clear(list).append(emptyState('無法讀取稽核軌跡', error.message)); }
  }
  submit.addEventListener('click', (event) => { event.preventDefault(); load(); });
  $('form', root).addEventListener('submit', (event) => { event.preventDefault(); load(); });
  await load();
  content.setAttribute('aria-busy', 'false');
}

async function renderEffectiveness() {
  setBusy();
  const data = await api(withNamespace('/v1/control/effectiveness'));
  const stats = effectivenessStats(data);
  const root = clear(content);
  root.append(pageHeader('QUALITY SIGNAL', '記憶效益', 'Outcome feedback 只記錄 package / item ids、粗粒度結果與 action_changed；不保存 prompt、action 文字或 context package。', [linkButton('返回稽核', `/audit?namespace=${encodeURIComponent(state.namespace)}`)]));
  root.append(el('div', { className: 'metric-grid' }, [
    metric('Outcome 次數', stats.total, '已回傳的粗粒度 feedback'),
    metric('有幫助', stats.helpful, stats.total ? `${stats.ratio}% helpful` : '尚無樣本', 'good'),
    metric('改變行動', stats.changed, stats.total ? `${Math.round((stats.changed / stats.total) * 100)}% action changed` : '尚無樣本', 'violet'),
    metric('低價值訊號', data.low_value?.length || 0, '至少 3 次使用且 helpful 偏低', data.low_value?.length ? 'warn' : 'good'),
  ]));

  const sourceRows = (data.sources || []).map((source) => el('tr', {}, [
    el('td', {}, [el('div', { className: 'table-primary' }, [text('strong', source.source)])]),
    text('td', source.uses), text('td', source.helpful), text('td', source.harmful),
    el('td', {}, [pill(source.uses ? `${Math.round((source.helpful / source.uses) * 100)}%` : '—', source.helpful > source.harmful ? 'good' : 'warn')]),
  ]));
  const itemRowsData = (data.items || []).slice(0, 30).map((item) => el('tr', { attrs: { 'data-open': item.item_id, tabindex: '0' } }, [
    el('td', {}, [el('div', { className: 'table-primary' }, [text('strong', item.title), text('small', `${item.source} · ${item.item_id}`)])]),
    text('td', item.uses), text('td', item.helpful), text('td', item.harmful),
    el('td', {}, [pill(item.uses ? `${Math.round((item.helpful / item.uses) * 100)}%` : '—', item.helpful > item.harmful ? 'good' : 'warn')]),
  ]));
  for (const row of itemRowsData) {
    const open = () => showMemoryDetail(row.getAttribute('data-open'));
    row.addEventListener('click', open);
    row.addEventListener('keydown', (event) => { if (event.key === 'Enter') open(); });
  }
  root.append(el('div', { className: 'equal-grid' }, [
    card('來源效益', '比較各 source 被採用後的 helpful / harmful 訊號。', [sourceRows.length ? el('div', { className: 'table-wrap' }, [el('table', { className: 'data-table' }, [el('thead', {}, [el('tr', {}, ['來源', '使用', '有幫助', '有害', 'Helpful'].map((label) => text('th', label)))]), el('tbody', {}, sourceRows)])]) : emptyState('尚無來源效益資料', 'Agent 回傳 outcome feedback 後會出現在這裡。')]),
    card('低價值提醒', '這是 reviewer-facing 訊號；不會自動刪除、合併或改寫 accepted Memory。', [
      data.low_value?.length ? el('div', { className: 'action-list' }, data.low_value.map((item) => {
        const open = el('button', { className: 'action-row', type: 'button' }, [text('span', '!', 'action-glyph warn'), el('span', { className: 'action-copy' }, [text('strong', item.item_id), text('small', `${item.uses} 次使用 · ${item.helpful} helpful · ${item.harmful} harmful`)]), text('span', '›', 'arrow')]);
        open.addEventListener('click', () => showMemoryDetail(item.item_id));
        return open;
      })) : emptyState('沒有低價值警訊', '需要至少三次使用資料後才會形成此訊號。'),
    ]),
  ]));
  root.append(card('最常使用的記憶', '點選項目可查看完整 provenance、版本與整理建議。', [itemRowsData.length ? el('div', { className: 'table-wrap' }, [el('table', { className: 'data-table' }, [el('thead', {}, [el('tr', {}, ['記憶', '使用', '有幫助', '有害', 'Helpful'].map((label) => text('th', label)))]), el('tbody', {}, itemRowsData)])]) : emptyState('尚無 item-level outcome', '目前沒有足夠 feedback 可供分析。')]));
  content.setAttribute('aria-busy', 'false');
}

async function renderSettings() {
  setBusy();
  const [settings, maintenance] = await Promise.all([
    api('/v1/control/settings'),
    api('/v1/control/maintenance').catch((error) => ({ status: 'fail', error: error.message, checks: {} })),
  ]);
  const root = clear(content);
  const refresh = button('重新執行 Doctor', 'secondary');
  refresh.addEventListener('click', () => renderSettings());
  root.append(pageHeader('SYSTEM', '安全與維運', '確認認證平面、功能旗標、資料庫／索引／備份健康與目前登入 sessions。', [refresh]));

  const checks = Object.entries(maintenance.checks || {}).map(([name, check]) => el('div', { className: 'check-row' }, [
    text('span', '', `status-dot ${toneFor(check.status)}`),
    el('div', { className: 'check-copy' }, [text('strong', humanize(name)), text('small', check.message || check.remediation || '—')]),
    pill(humanize(check.status), toneFor(check.status)),
  ]));
  const flags = [
    ['Control Center', settings.control_center_enabled],
    ['Tailscale identity', settings.tailscale_auth_enabled],
    ['Agent enrollment', settings.enrollment_enabled],
    ['MCP OAuth pilot', settings.oauth_enabled],
    ['Legacy API key fallback', settings.legacy_api_keys_enabled],
  ].map(([label, enabled]) => el('div', { className: 'feature-row' }, [text('span', label), pill(enabled ? '已啟用' : '未啟用', enabled ? 'good' : 'neutral')]));

  root.append(el('div', { className: 'panel-grid' }, [
    card('Doctor', `整體狀態：${humanize(maintenance.status)}${maintenance.runtime ? ` · ${maintenance.runtime.version}@${String(maintenance.runtime.build_commit).slice(0, 7)}` : ''}`, [
      checks.length ? el('div', { className: 'check-list' }, checks) : emptyState('Doctor 資訊不可用', maintenance.error || '請確認 control_admin 權限與服務狀態。'),
    ], pill(humanize(maintenance.status), toneFor(maintenance.status))),
    card('功能與認證', '這裡只顯示開關狀態；不顯示 ADMIN_TOKEN、API key 或 OAuth secret。', [el('div', { className: 'feature-grid' }, flags)]),
  ]));

  const sessionRows = (settings.sessions || []).map((session) => {
    const current = session.id === settings.current_session_id;
    const revoke = button('撤銷', 'danger small', { disabled: current || Boolean(session.revoked_at) });
    revoke.addEventListener('click', async () => {
      if (!window.confirm(`撤銷 session ${session.id}？`)) return;
      try {
        await api(`/v1/control/sessions/${encodeURIComponent(session.id)}/revoke`, { method: 'POST', body: '{}' });
        showStatus('Session 已撤銷。');
        await renderSettings();
      } catch (error) { showStatus(error.message, true); }
    });
    return el('div', { className: 'session-row' }, [
      el('div', {}, [text('strong', current ? '目前 session' : session.id), text('small', `Idle 到期 ${formatDate(session.idle_expires_at)} · Absolute ${formatDate(session.absolute_expires_at)}`)]),
      current ? pill('目前使用', 'blue') : session.revoked_at ? pill('已撤銷', 'bad') : revoke,
    ]);
  });
  const logout = button('登出目前裝置', 'danger');
  logout.addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST', body: '{}' }); location.assign('/auth/login'); }
    catch (error) { showStatus(error.message, true); }
  });
  root.append(card('登入 Sessions', 'Web session 是短期、HttpOnly、Secure、SameSite=Strict，並可逐一撤銷。', [
    el('div', { className: 'check-list' }, sessionRows),
    el('div', { className: 'dialog-actions' }, [logout]),
  ]));
  root.append(el('div', { className: 'boundary-note' }, [
    text('span', '安', 'action-glyph good'),
    el('div', {}, [text('strong', '三個認證平面彼此分離'), text('p', '人類 Control Plane 使用 Tailscale identity + Web session；Agent Data Plane 使用 namespace-bound credential；ADMIN_TOKEN 只保留給 NAS CLI break-glass，永不進入瀏覽器。')]),
  ]));
  content.setAttribute('aria-busy', 'false');
}

function setupDialogs() {
  const detail = $('#detail-dialog');
  $('[data-dialog-close]', detail).addEventListener('click', () => detail.close());
  detail.addEventListener('click', (event) => { if (event.target === detail) detail.close(); });
  const modal = $('#enrollment-secret-modal');
  const clearSecret = () => {
    if (modal.dataset.timer) clearInterval(Number(modal.dataset.timer));
    delete modal.dataset.timer;
    $('[data-enrollment-code]', modal).textContent = '';
    $('[data-enrollment-countdown]', modal).textContent = '';
    if (modal.open) modal.close();
  };
  for (const close of modal.querySelectorAll('[data-enrollment-close]')) close.addEventListener('click', clearSecret);
  modal.addEventListener('cancel', (event) => { event.preventDefault(); clearSecret(); });
  $('[data-enrollment-copy]', modal).addEventListener('click', async () => {
    const code = $('[data-enrollment-code]', modal).textContent;
    if (code) { await navigator.clipboard.writeText(code); showStatus('Enrollment code 已複製。'); }
  });
}

async function boot() {
  try {
    state.me = await api('/v1/control/me');
    state.csrf = state.me.csrf_token;
    state.namespace = mountNamespaceSelector($('#namespace-selector'), state.me.linked_clients || []);
    if (!state.namespace && !state.me.principal.controlAdmin) throw new Error('目前 Web principal 沒有 linked human client，無法讀取任何 namespace。');
    mountIdentity();
    mountNavigation();
    setupMobileNavigation();
    setupDialogs();
    const path = location.pathname === '/' ? '/dashboard' : location.pathname;
    const routes = {
      '/dashboard': renderDashboard,
      '/memories': renderMemories,
      '/review': renderReview,
      '/agents': renderAgents,
      '/namespaces': renderNamespaces,
      '/policies': renderPolicies,
      '/audit': renderAudit,
      '/effectiveness': renderEffectiveness,
      '/settings': renderSettings,
    };
    await (routes[path] || renderDashboard)();
  } catch (error) { renderError(error); }
}

boot();
