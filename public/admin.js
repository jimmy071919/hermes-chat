/* Hermes Chat — MCP & Skills management (talks to the Hermes dashboard via /api/admin/*) */
'use strict';

const A = { tab: 'mcp', skillsView: 'installed', skills: null, mcp: null, catalog: null, status: null };
const adm = (path, opts) => api(`/api/admin${path}`, opts);
const jbody = (o) => JSON.stringify(o);

// ---------- generic UI bits ----------
function toggleSwitch(on, onchange, { disabled, title } = {}) {
  const input = h('input', { type: 'checkbox', disabled });
  input.checked = !!on;
  input.addEventListener('change', () => onchange(input.checked, input));
  return h('label', { class: 'switch', title }, input, h('span'));
}
function pill(text, kind = '') { return h('span', { class: `pill ${kind}` }, text); }
function btn(label, onclick, cls = '') { return h('button', { type: 'button', class: `abtn ${cls}`, onclick }, label); }
async function busy(button, fn) {
  const old = button.textContent; button.disabled = true; button.textContent = '處理中…';
  try { return await fn(); } finally { button.disabled = false; button.textContent = old; }
}
function openModal(title, body, actions = []) {
  const m = $('#modal'); const card = m.querySelector('.modal-card');
  card.innerHTML = '';
  card.append(h('div', { class: 'modal-head' }, h('strong', {}, title),
    h('button', { type: 'button', class: 'icon-btn', onclick: closeModal, 'aria-label': '關閉' }, svg(ICON.x))),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-actions' }, actions) : null);
  m.hidden = false;
}
function closeModal() { $('#modal').hidden = true; }

// Poll a dashboard background action (skills install, git-bootstrap MCP install, ...)
async function followAction(name, logEl) {
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    let st;
    try { st = await adm(`/api/actions/${encodeURIComponent(name)}/status?lines=40`); } catch (e) { logEl.textContent = e.message; return false; }
    logEl.textContent = (st.lines || []).join('\n');
    logEl.scrollTop = logEl.scrollHeight;
    if (!st.running) return st.exit_code === 0;
  }
  return false;
}

// ---------- shell ----------
async function openAdmin() {
  $('#admin').hidden = false; closeSidebarMobile();
  renderAdmin();
}
function closeAdmin() { $('#admin').hidden = true; }

async function renderAdmin() {
  document.querySelectorAll('.admin-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === A.tab));
  const body = $('#adminBody'); body.innerHTML = '';
  if (!A.status) {
    body.append(h('div', { class: 'admin-empty' }, '連線到 Hermes dashboard…'));
    try { A.status = await api('/api/admin/status'); } catch (e) { A.status = { configured: false, error: e.message }; }
    body.innerHTML = '';
  }
  if (!A.status.configured || !A.status.reachable) return body.append(setupHelp());
  if (A.tab === 'mcp') renderMcp(body); else renderSkills(body);
}

function setupHelp() {
  const s = A.status || {};
  return h('div', { class: 'admin-setup' },
    h('h3', {}, s.configured ? '無法連到 Hermes dashboard' : '尚未設定 dashboard 存取'),
    s.error ? h('p', { class: 'err-text' }, s.error) : null,
    h('p', {}, 'MCP 與 Skills 管理透過 Hermes dashboard 的 API 操作（',
      h('code', {}, s.dashboardUrl || 'http://…:9119'), '）。請在 ', h('code', {}, '~/code/hermes-chat/.env'), ' 設定以下其中一種，然後執行 ', h('code', {}, 'docker compose up -d'), '：'),
    h('pre', {}, '# 方式 A：dashboard 部署 token（需 dashboard 以 HERMES_DASHBOARD_SESSION_TOKEN 啟動）\nDASHBOARD_TOKEN_FILE=/run/hermes-dashboard-token\n\n# 方式 B：dashboard 登入帳密（dashboard.basic_auth）\nDASHBOARD_USER=你的 dashboard 帳號\nDASHBOARD_PASSWORD=你的 dashboard 密碼'),
    btn('重新檢查', () => { A.status = null; renderAdmin(); }));
}

// ---------- MCP ----------
async function loadMcp() { A.mcp = (await adm('/api/mcp/servers')).servers || []; }

async function renderMcp(body) {
  const listBox = h('div', { class: 'cards' }, h('div', { class: 'admin-empty' }, '載入中…'));
  const restartBtn = btn('重啟 Gateway 立即套用', async () => {
    if (!confirm('重啟 Hermes gateway？進行中的對話（含 Telegram 等）會被中斷。')) return;
    await busy(restartBtn, async () => { try { await adm('/api/gateway/restart', { method: 'POST', body: '{}' }); toast('Gateway 重啟中…'); } catch (e) { toast('重啟失敗：' + e.message); } });
  });
  body.append(
    h('div', { class: 'admin-note' }, h('span', {}, 'MCP 變更會在新的聊天生效；已開啟的 gateway 連線需重啟才會載入新伺服器。'), restartBtn),
    h('div', { class: 'section-head' }, h('h3', {}, '已設定的伺服器'),
      h('div', { class: 'row-gap' }, btn('＋ 新增伺服器', () => mcpAddForm()), btn('瀏覽 MCP 目錄', () => mcpCatalog(), 'ghost'))),
    listBox);
  try { await loadMcp(); } catch (e) { listBox.innerHTML = ''; listBox.append(h('div', { class: 'err-text' }, e.message)); return; }
  listBox.innerHTML = '';
  if (!A.mcp.length) listBox.append(h('div', { class: 'admin-empty' }, '還沒有 MCP 伺服器。'));
  for (const s of A.mcp) listBox.append(mcpCard(s));
}

function mcpCard(s) {
  const result = h('div', { class: 'card-result' });
  const isPlugin = s.source === 'plugin';
  const where = s.transport === 'http' ? s.url : [s.command, ...(s.args || [])].join(' ');
  const testBtn = btn('測試連線', () => busy(testBtn, async () => {
    result.innerHTML = '';
    try {
      const r = await adm(`/api/mcp/servers/${encodeURIComponent(s.name)}/test`, { method: 'POST', body: '{}' });
      if (!r.ok) { result.append(h('div', { class: 'err-text' }, '✗ ' + (r.error || '失敗'))); return; }
      result.append(h('div', { class: 'ok-text' }, `✓ 連線成功：${r.tools.length} 個工具${r.prompts ? `、${r.prompts} prompts` : ''}${r.resources ? `、${r.resources} resources` : ''}`),
        h('div', { class: 'tool-list' }, r.tools.map((t) => h('div', {}, h('b', {}, t.name), t.description ? h('span', {}, ' — ' + t.description.slice(0, 140)) : null))));
    } catch (e) { result.append(h('div', { class: 'err-text' }, e.message)); }
  }));
  const actions = [testBtn];
  if (s.transport === 'http' && (s.auth === 'oauth' || !s.auth)) actions.push(btn('OAuth 登入', () => mcpOAuth(s, result), 'ghost'));
  if (!isPlugin) actions.push(btn('刪除', async () => {
    if (!confirm(`刪除 MCP 伺服器「${s.name}」？`)) return;
    try { await adm(`/api/mcp/servers/${encodeURIComponent(s.name)}`, { method: 'DELETE' }); toast('已刪除'); renderAdmin(); }
    catch (e) { toast('刪除失敗：' + e.message); }
  }, 'danger'));
  return h('div', { class: 'card' },
    h('div', { class: 'card-top' },
      h('div', { class: 'card-title' }, h('b', {}, s.name), pill(s.transport), s.auth ? pill(s.auth) : null, isPlugin ? pill('plugin: ' + s.plugin, 'muted') : null),
      toggleSwitch(s.enabled, async (on, input) => {
        try { await adm(`/api/mcp/servers/${encodeURIComponent(s.name)}/enabled`, { method: 'PUT', body: jbody({ enabled: on }) }); s.enabled = on; toast(on ? `已啟用 ${s.name}` : `已停用 ${s.name}`); }
        catch (e) { input.checked = !on; toast('失敗：' + e.message); }
      }, { disabled: isPlugin, title: '啟用 / 停用' })),
    h('div', { class: 'card-sub mono' }, where || ''),
    s.env && Object.keys(s.env).length ? h('div', { class: 'card-sub' }, 'env: ' + Object.keys(s.env).join(', ')) : null,
    h('div', { class: 'card-actions' }, actions),
    result);
}

async function mcpOAuth(s, result) {
  result.innerHTML = '';
  try {
    let flow = await adm(`/api/mcp/servers/${encodeURIComponent(s.name)}/auth`, { method: 'POST', body: '{}' });
    const status = h('div', { class: 'card-sub' }, '等待授權…');
    result.append(status);
    let opened = false, pasteBox = null;
    const STATUS_LABEL = { starting: '準備中', authorization_required: '等待你在授權頁登入', approved: '已核准' };
    for (let i = 0; i < 200; i++) {
      if (flow.authorization_url && !opened) {
        opened = true;
        result.prepend(h('div', {}, '請在新分頁完成登入：', h('a', { href: flow.authorization_url, target: '_blank', rel: 'noopener' }, '開啟授權頁')));
        window.open(flow.authorization_url, '_blank', 'noopener');
        const redirect = new URL(flow.authorization_url).searchParams.get('redirect_uri') || '';
        // Loopback redirect (vendors like Canva refuse non-https, non-localhost callbacks): nothing listens
        // there, so the user pastes the address-bar URL back and we hand code/state to the dashboard.
        if (/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(redirect)) {
          pasteBox = oauthPasteBox(s.name, redirect, status);
          result.append(pasteBox);
        }
      }
      if (flow.status === 'approved') {
        status.className = 'ok-text'; status.textContent = '✓ 授權完成，可以按「測試連線」確認';
        pasteBox?.remove(); return;
      }
      if (flow.status === 'error') { status.className = 'err-text'; status.textContent = '✗ ' + (flow.error || '授權失敗'); return; }
      await new Promise((r) => setTimeout(r, 2000));
      try { flow = await adm(`/api/mcp/oauth/flows/${encodeURIComponent(flow.flow_id)}`); }
      catch (e) { status.className = 'err-text'; status.textContent = '✗ ' + e.message; return; }
      if (status.className === 'card-sub') status.textContent = `狀態：${STATUS_LABEL[flow.status] || flow.status}`;
    }
    status.className = 'err-text'; status.textContent = '✗ 等候逾時，請重新按「OAuth 登入」';
  } catch (e) {
    const msg = /already in progress/i.test(e.message)
      ? '上一次的授權還在等待中（最多約 5 分鐘自動過期），請稍等一下再按「OAuth 登入」。'
      : e.message;
    result.append(h('div', { class: 'err-text' }, msg));
  }
}

function oauthPasteBox(serverName, redirect, status) {
  const input = h('input', { placeholder: `${redirect}?code=…&state=…`, autocomplete: 'off', spellcheck: 'false' });
  const go = btn('送出', () => busy(go, async () => {
    let u;
    try { u = new URL(input.value.trim()); } catch { toast('這不是完整網址，請複製整個網址列'); return; }
    const q = new URLSearchParams();
    for (const k of ['code', 'state', 'error', 'iss']) if (u.searchParams.get(k)) q.set(k, u.searchParams.get(k));
    if (!q.get('code') && !q.get('error')) { toast('網址裡沒有 code，請確認已完成授權'); return; }
    try {
      await adm(`/api/mcp/oauth/callback/${encodeURIComponent(serverName)}?${q}`);
      status.className = 'card-sub'; status.textContent = '已送出授權碼，正在完成登入…';
    } catch (e) {
      const msg = /expired/i.test(e.message) ? '這次授權已過期，請重新按「OAuth 登入」' : /already|rejected/i.test(e.message) ? '授權碼無效或已使用過，請重新按「OAuth 登入」' : e.message;
      toast(msg);
    }
  }), 'primary');
  return h('div', { class: 'oauth-paste' },
    h('div', { class: 'card-sub' }, '登入並同意後，瀏覽器會跳到 ', h('code', {}, redirect), '，顯示「無法連線」是正常的。把那一頁', h('b', {}, '網址列的整串網址'), '複製貼到這裡：'),
    h('div', { class: 'toolbar' }, input, go));
}

function mcpAddForm() {
  const f = {
    name: h('input', { placeholder: '例如 github', autocomplete: 'off' }),
    type: h('select', {}, h('option', { value: 'http' }, 'HTTP / SSE (URL)'), h('option', { value: 'stdio' }, 'stdio (本機指令)')),
    url: h('input', { placeholder: 'https://example.com/mcp' }),
    command: h('input', { placeholder: 'npx' }),
    args: h('textarea', { rows: 3, placeholder: '每行一個參數，例如\n-y\n@modelcontextprotocol/server-filesystem\n/path/to/dir' }),
    env: h('textarea', { rows: 3, placeholder: 'KEY=VALUE，每行一個' }),
    auth: h('select', {}, h('option', { value: '' }, '無'), h('option', { value: 'header' }, 'Bearer token'), h('option', { value: 'oauth' }, 'OAuth')),
    token: h('input', { type: 'password', placeholder: 'Bearer token（只存在 ~/.hermes/.env）', autocomplete: 'off' }),
  };
  const field = (label, el, cls = '') => h('label', { class: 'field ' + cls }, h('span', {}, label), el);
  const httpRows = [field('URL', f.url, 'http'), field('認證', f.auth, 'http'), field('Token', f.token, 'http tok')];
  const stdioRows = [field('指令', f.command, 'stdio'), field('參數', f.args, 'stdio'), field('環境變數', f.env, 'stdio')];
  const form = h('div', { class: 'form' }, field('名稱', f.name), field('類型', f.type), httpRows, stdioRows);
  const sync = () => {
    const http = f.type.value === 'http';
    form.querySelectorAll('.http').forEach((e) => (e.hidden = !http));
    form.querySelectorAll('.stdio').forEach((e) => (e.hidden = http));
    form.querySelector('.tok').hidden = !http || f.auth.value !== 'header';
  };
  f.type.addEventListener('change', sync); f.auth.addEventListener('change', sync); sync();
  const save = btn('新增', () => busy(save, async () => {
    const body = { name: f.name.value.trim() };
    if (f.type.value === 'http') {
      body.url = f.url.value.trim();
      if (f.auth.value) body.auth = f.auth.value;
      if (f.auth.value === 'header' && f.token.value) body.bearer_token = f.token.value;
    } else {
      body.command = f.command.value.trim();
      body.args = f.args.value.split('\n').map((s) => s.trim()).filter(Boolean);
      body.env = Object.fromEntries(f.env.value.split('\n').map((l) => l.trim()).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
    }
    try { await adm('/api/mcp/servers', { method: 'POST', body: jbody(body) }); closeModal(); toast(`已新增 ${body.name}`); renderAdmin(); }
    catch (e) { toast('新增失敗：' + e.message); }
  }), 'primary');
  openModal('新增 MCP 伺服器', form, [btn('取消', closeModal, 'ghost'), save]);
}

async function mcpCatalog() {
  const box = h('div', { class: 'cards' }, h('div', { class: 'admin-empty' }, '載入目錄…'));
  openModal('MCP 目錄（Nous 審核）', box);
  try { A.catalog = (await adm('/api/mcp/catalog')).entries || []; }
  catch (e) { box.innerHTML = ''; box.append(h('div', { class: 'err-text' }, e.message)); return; }
  box.innerHTML = '';
  if (!A.catalog.length) box.append(h('div', { class: 'admin-empty' }, '目錄是空的'));
  for (const e of A.catalog) {
    const envInputs = (e.required_env || []).map((v) => ({ spec: v, input: h('input', { type: 'password', placeholder: v.prompt || v.name, autocomplete: 'off' }) }));
    const log = h('pre', { class: 'action-log', hidden: true });
    const inst = btn(e.installed ? '已安裝' : '安裝', () => busy(inst, async () => {
      const env = Object.fromEntries(envInputs.filter((x) => x.input.value).map((x) => [x.spec.name, x.input.value]));
      const missing = envInputs.filter((x) => x.spec.required && !x.input.value);
      if (missing.length) { toast('請填寫：' + missing.map((x) => x.spec.name).join(', ')); return; }
      try {
        const r = await adm('/api/mcp/catalog/install', { method: 'POST', body: jbody({ name: e.name, env, enable: true }) });
        if (r && r.name && r.pid) { log.hidden = false; const ok = await followAction(r.name, log); toast(ok ? `${e.name} 安裝完成` : `${e.name} 安裝失敗，請看紀錄`); }
        else toast(`${e.name} 已安裝`);
        e.installed = true; inst.textContent = '已安裝'; if (!$('#admin').hidden && A.tab === 'mcp') renderMcp(($('#adminBody').innerHTML = '', $('#adminBody')));
      } catch (err) { toast('安裝失敗：' + err.message); }
    }), e.installed ? 'ghost' : 'primary');
    box.append(h('div', { class: 'card' },
      h('div', { class: 'card-top' }, h('div', { class: 'card-title' }, h('b', {}, e.name), pill(e.transport), e.auth_type && e.auth_type !== 'none' ? pill(e.auth_type) : null, e.needs_install ? pill('git 安裝', 'muted') : null), inst),
      h('div', { class: 'card-sub' }, e.description || ''),
      h('div', { class: 'card-sub mono' }, e.url || [e.command, ...(e.args || [])].filter(Boolean).join(' ')),
      envInputs.length ? h('div', { class: 'form compact' }, envInputs.map((x) => h('label', { class: 'field' }, h('span', {}, x.spec.name + (x.spec.required ? ' *' : '')), x.input))) : null,
      log));
  }
}

// ---------- Skills ----------
async function renderSkills(body) {
  const sub = h('nav', { class: 'subtabs' },
    [['installed', '已安裝'], ['hub', '從 Hub 安裝'], ['new', '新增 Skill']].map(([k, label]) =>
      h('button', { type: 'button', class: A.skillsView === k ? 'on' : '', onclick: () => { A.skillsView = k; renderAdmin(); } }, label)));
  const box = h('div');
  body.append(sub, box);
  if (A.skillsView === 'installed') return skillsInstalled(box);
  if (A.skillsView === 'hub') return skillsHub(box);
  return skillNew(box);
}

const PROV_LABEL = { hub: 'Hub', bundled: '內建', external: '外部', agent: '自建' };

async function skillsInstalled(box) {
  const q = h('input', { type: 'search', placeholder: '搜尋 skill…', autocomplete: 'off' });
  const filter = h('select', {}, h('option', { value: '' }, '全部'), h('option', { value: 'on' }, '已啟用'), h('option', { value: 'off' }, '已停用'),
    ...Object.entries(PROV_LABEL).map(([k, v]) => h('option', { value: 'p:' + k }, v)));
  const updBtn = btn('檢查 Hub 更新', () => busy(updBtn, skillsCheckUpdates), 'ghost');
  const list = h('div', { class: 'skill-list' }, h('div', { class: 'admin-empty' }, '載入中…'));
  const count = h('span', { class: 'muted-text' });
  box.append(h('div', { class: 'toolbar' }, q, filter, count, updBtn), list);
  try { A.skills = await adm('/api/skills'); } catch (e) { list.innerHTML = ''; list.append(h('div', { class: 'err-text' }, e.message)); return; }
  const draw = () => {
    const term = q.value.trim().toLowerCase(); const fv = filter.value;
    const rows = A.skills.filter((s) => (!term || `${s.name} ${s.description} ${s.category}`.toLowerCase().includes(term))
      && (!fv || (fv === 'on' && s.enabled) || (fv === 'off' && !s.enabled) || fv === 'p:' + s.provenance));
    count.textContent = `${rows.length} / ${A.skills.length}，啟用 ${A.skills.filter((s) => s.enabled).length}`;
    list.innerHTML = '';
    const groups = new Map();
    for (const s of rows) { const c = s.category || '未分類'; if (!groups.has(c)) groups.set(c, []); groups.get(c).push(s); }
    for (const [cat, items] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      list.append(h('div', { class: 'group-label' }, `${cat}（${items.length}）`));
      for (const s of items) list.append(skillRow(s));
    }
    if (!rows.length) list.append(h('div', { class: 'admin-empty' }, '沒有符合的 skill'));
  };
  q.addEventListener('input', draw); filter.addEventListener('change', draw); draw();
}

function skillRow(s) {
  const actions = [btn('檢視 / 編輯', () => skillEditor(s.name), 'ghost')];
  if (s.provenance === 'hub') actions.push(btn('解除安裝', async () => {
    if (!confirm(`解除安裝 skill「${s.name}」？`)) return;
    try { const r = await adm('/api/skills/hub/uninstall', { method: 'POST', body: jbody({ name: s.name }) }); toast('解除安裝中…'); if (r.name) await followAction(r.name, h('pre')); toast(`已解除安裝 ${s.name}`); renderAdmin(); }
    catch (e) { toast('失敗：' + e.message); }
  }, 'danger'));
  return h('div', { class: 'skill-row' + (s.enabled ? '' : ' off') },
    h('div', { class: 'skill-main' },
      h('div', {}, h('b', {}, s.name), pill(PROV_LABEL[s.provenance] || s.provenance, 'muted'), s.locked ? pill('🔒 鎖定', 'muted') : null, s.usage ? h('span', { class: 'muted-text' }, ` 使用 ${s.usage} 次`) : null),
      h('div', { class: 'card-sub' }, s.description || '')),
    h('div', { class: 'skill-acts' }, actions),
    toggleSwitch(s.enabled, async (on, input) => {
      try { await adm('/api/skills/toggle', { method: 'PUT', body: jbody({ name: s.name, enabled: on }) }); s.enabled = on; input.closest('.skill-row').classList.toggle('off', !on); }
      catch (e) { input.checked = !on; toast('失敗：' + e.message); }
    }, { title: '啟用 / 停用' }));
}

async function skillEditor(name) {
  const ta = h('textarea', { class: 'code-edit', spellcheck: 'false' }, '載入中…');
  const pathEl = h('div', { class: 'muted-text mono' });
  const preview = h('div', { class: 'body md-preview', hidden: true });
  const toggleBtn = btn('預覽', () => { const show = preview.hidden; preview.hidden = !show; ta.hidden = show; if (show) renderMarkdown(ta.value, preview); toggleBtn.textContent = show ? '編輯' : '預覽'; }, 'ghost');
  const save = btn('儲存', () => busy(save, async () => {
    try { await adm('/api/skills/content', { method: 'PUT', body: jbody({ name, content: ta.value }) }); toast('已儲存'); closeModal(); }
    catch (e) { toast('儲存失敗：' + e.message); }
  }), 'primary');
  openModal(`Skill：${name}`, h('div', { class: 'editor-wrap' }, pathEl, ta, preview), [toggleBtn, btn('取消', closeModal, 'ghost'), save]);
  try { const r = await adm(`/api/skills/content?name=${encodeURIComponent(name)}`); ta.value = r.content; pathEl.textContent = r.path; }
  catch (e) { ta.value = ''; pathEl.textContent = e.message; }
}

async function skillsCheckUpdates() {
  try {
    const r = await adm('/api/skills/hub/updates');
    const ups = r.updates || [];
    if (!ups.length) { toast('所有 Hub skills 都是最新版'); return; }
    const log = h('pre', { class: 'action-log', hidden: true });
    const go = btn(`全部更新（${ups.length}）`, () => busy(go, async () => {
      try { const a = await adm('/api/skills/hub/update', { method: 'POST', body: '{}' }); log.hidden = false; const ok = await followAction(a.name || 'skills-update', log); toast(ok ? '更新完成' : '更新有錯誤，請看紀錄'); }
      catch (e) { toast('更新失敗：' + e.message); }
    }), 'primary');
    openModal('有可用更新', h('div', {}, h('ul', {}, ups.map((u) => h('li', {}, h('b', {}, u.name), ` — ${u.source || ''} ${u.identifier || ''}`))), log), [btn('關閉', closeModal, 'ghost'), go]);
  } catch (e) { toast('檢查失敗：' + e.message); }
}

function skillsHub(box) {
  const q = h('input', { type: 'search', placeholder: '搜尋 skills.sh、GitHub、ClawHub… 例如 pdf、github、notion', autocomplete: 'off' });
  const go = btn('搜尋', () => run(), 'primary');
  const results = h('div', { class: 'cards' }, h('div', { class: 'admin-empty' }, '輸入關鍵字搜尋 skill registry，也可以直接貼上 identifier（例如 GitHub 路徑）安裝。'));
  const direct = h('input', { placeholder: 'identifier，例如 owner/repo/path/to/skill', autocomplete: 'off' });
  const directBtn = btn('直接安裝', () => installSkill(direct.value.trim(), directBtn, results), 'ghost');
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  box.append(h('div', { class: 'toolbar' }, q, go), h('div', { class: 'toolbar' }, direct, directBtn), results);
  async function run() {
    const term = q.value.trim(); if (!term) return;
    results.innerHTML = ''; results.append(h('div', { class: 'admin-empty' }, '搜尋中（最多 30 秒）…'));
    try {
      const r = await adm(`/api/skills/hub/search?q=${encodeURIComponent(term)}&limit=30`);
      results.innerHTML = '';
      if (r.timed_out?.length) results.append(h('div', { class: 'muted-text' }, '逾時的來源：' + r.timed_out.join(', ')));
      if (!r.results.length) results.append(h('div', { class: 'admin-empty' }, '找不到結果'));
      const installed = r.installed || {};
      for (const m of r.results) {
        const isInst = !!installed[m.identifier] || Object.values(installed).includes?.(m.identifier);
        const ib = btn(isInst ? '已安裝' : '安裝', () => installSkill(m.identifier, ib, null), isInst ? 'ghost' : 'primary');
        results.append(h('div', { class: 'card' },
          h('div', { class: 'card-top' }, h('div', { class: 'card-title' }, h('b', {}, m.name), pill(m.trust_level, m.trust_level === 'community' ? 'warn' : ''), pill(m.source, 'muted')),
            h('div', { class: 'row-gap' }, btn('預覽', () => previewSkill(m), 'ghost'), ib)),
          h('div', { class: 'card-sub' }, m.description || ''),
          h('div', { class: 'card-sub mono' }, m.identifier)));
      }
    } catch (e) { results.innerHTML = ''; results.append(h('div', { class: 'err-text' }, e.message)); }
  }
}

async function previewSkill(m) {
  const md = h('div', { class: 'body md-preview' }, '載入中…');
  const scanBox = h('div', { class: 'card-sub' });
  const scanBtn = btn('安全掃描', () => busy(scanBtn, async () => {
    try { const r = await adm(`/api/skills/hub/scan?identifier=${encodeURIComponent(m.identifier)}`); scanBox.innerHTML = ''; scanBox.append(h('pre', { class: 'action-log' }, JSON.stringify(r, null, 2))); }
    catch (e) { scanBox.textContent = e.message; }
  }), 'ghost');
  const ib = btn('安裝', () => installSkill(m.identifier, ib, null), 'primary');
  openModal(`預覽：${m.name}`, h('div', {}, h('div', { class: 'muted-text mono' }, m.identifier), scanBox, md), [scanBtn, btn('關閉', closeModal, 'ghost'), ib]);
  try { const r = await adm(`/api/skills/hub/preview?identifier=${encodeURIComponent(m.identifier)}`); renderMarkdown(r.skill_md || '(沒有 SKILL.md)', md); if (r.files?.length) md.append(h('div', { class: 'muted-text' }, '檔案：' + r.files.join(', '))); }
  catch (e) { md.textContent = e.message; }
}

async function installSkill(identifier, button, logParent) {
  if (!identifier) return;
  const log = h('pre', { class: 'action-log' });
  const target = logParent || button.closest('.card, .modal-card');
  target?.append(log);
  await busy(button, async () => {
    try {
      const r = await adm('/api/skills/hub/install', { method: 'POST', body: jbody({ identifier }) });
      const ok = await followAction(r.name, log);
      toast(ok ? `已安裝 ${identifier}` : '安裝失敗，請看紀錄');
      if (ok) button.textContent = '已安裝';
    } catch (e) { log.textContent = e.message; toast('安裝失敗：' + e.message); }
  });
  if (button.textContent === '已安裝') { button.disabled = true; button.classList.replace('primary', 'ghost'); }
}

function skillNew(box) {
  const name = h('input', { placeholder: 'my-skill（小寫、數字、-）', autocomplete: 'off' });
  const category = h('input', { placeholder: '分類（選填），例如 productivity' });
  const content = h('textarea', { class: 'code-edit', spellcheck: 'false' },
    '---\nname: my-skill\ndescription: 一句話說明這個 skill 何時該使用\n---\n\n# My Skill\n\n## 什麼時候用\n\n## 步驟\n1. \n');
  name.addEventListener('input', () => { content.value = content.value.replace(/^name: .*$/m, `name: ${name.value.trim() || 'my-skill'}`); });
  const save = btn('建立 Skill', () => busy(save, async () => {
    try { await adm('/api/skills', { method: 'POST', body: jbody({ name: name.value.trim(), content: content.value, category: category.value.trim() || null }) }); toast('已建立'); A.skillsView = 'installed'; renderAdmin(); }
    catch (e) { toast('建立失敗：' + e.message); }
  }), 'primary');
  box.append(h('div', { class: 'form' },
    h('label', { class: 'field' }, h('span', {}, '名稱'), name),
    h('label', { class: 'field' }, h('span', {}, '分類'), category),
    h('label', { class: 'field' }, h('span', {}, 'SKILL.md'), content)),
  h('div', { class: 'card-actions' }, save));
}

// ---------- wiring ----------
$('#adminBtn').addEventListener('click', openAdmin);
$('#adminClose').addEventListener('click', closeAdmin);
document.querySelectorAll('.admin-tabs button').forEach((b) => b.addEventListener('click', () => { A.tab = b.dataset.tab; renderAdmin(); }));
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#modal').hidden) closeModal(); else if (!$('#admin').hidden) closeAdmin();
});
