/* Hermes Chat — frontend (no build step) */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};
const svg = (d) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = d; return s; };
const ICON = {
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  dl: '<path d="M12 4v12M6 11l6 6 6-6M5 20h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  retry: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
};

const S = {
  sessions: [],
  current: null,          // session id
  streaming: null,        // { runId, ctrl }
  attachments: [],        // { id, file, isImage, preview, modelUrl, status, uploaded, xhr }
  config: { downloadRoots: [] },
  pendingApproval: null,
  models: { providers: [], global: null, loaded: false },
  model: null,            // { provider, model } or null = Hermes default
  effort: '',             // '' | low | medium | high
};

// ---------- model picker ----------
const LS = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const PROVIDER_SHORT = { anthropic: 'Anthropic', 'openai-codex': 'ChatGPT 訂閱', 'openai-api': 'OpenAI API' };

async function loadModelOptions(refresh) {
  try {
    const d = await api(`/api/model/options${refresh ? '?refresh=1' : ''}`);
    S.models = {
      loaded: true,
      global: d.model ? { provider: d.provider, model: d.model } : null,
      providers: (d.providers || []).filter((p) => p.authenticated && (p.models || []).length).map((p) => ({
        slug: p.slug, name: p.name, current: p.is_current,
        models: p.models.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean),
        caps: p.capabilities || {},
      })),
    };
  } catch (e) { console.warn('model options', e); }
  updateModelButton();
  if (!$('#modelMenu').hidden) renderModelMenu();
}

function effectiveModel() { return S.model || S.models.global; }
function modelCaps(sel) {
  if (!sel) return {};
  return S.models.providers.find((p) => p.slug === sel.provider)?.caps?.[sel.model] || {};
}
function updateModelButton() {
  const sel = effectiveModel();
  const name = $('#modelName');
  name.textContent = sel ? sel.model : '預設模型';
  const effLabel = { low: '低', medium: '中', high: '高' }[S.effort];
  if (effLabel) name.append(h('span', { class: 'eff' }, ` · ${effLabel}`));
  $('#modelBtn').title = sel ? `${PROVIDER_SHORT[sel.provider] || sel.provider} · ${sel.model}${S.model ? '' : '（Hermes 預設）'}` : '切換模型';
}

function renderModelMenu() {
  const list = $('#modelList'); list.innerHTML = '';
  const q = $('#modelSearch').value.trim().toLowerCase();
  const sel = effectiveModel();
  const check = () => { const s = svg(ICON.check); s.setAttribute('class', 'ck'); return s; };
  const g = S.models.global;
  if (!q && g) {
    list.append(h('button', { type: 'button', class: 'mm-item' + (!S.model ? ' sel' : ''), onclick: () => chooseModel(null) },
      h('span', { class: 'nm' }, 'Hermes 預設', h('span', { class: 'sub' }, `${PROVIDER_SHORT[g.provider] || g.provider} · ${g.model}`)), check()));
  }
  for (const p of S.models.providers) {
    const models = p.models.filter((m) => !q || m.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
    if (!models.length) continue;
    list.append(h('div', { class: 'mm-group' }, p.name));
    for (const m of models) {
      const caps = p.caps[m] || {};
      const isSel = S.model && sel && sel.provider === p.slug && sel.model === m;
      list.append(h('button', { type: 'button', role: 'option', class: 'mm-item' + (isSel ? ' sel' : ''), onclick: () => chooseModel({ provider: p.slug, model: m }) },
        h('span', { class: 'nm' }, m),
        caps.reasoning ? h('span', { class: 'tag' }, '推理') : null,
        caps.fast ? h('span', { class: 'tag' }, 'fast') : null,
        check()));
    }
  }
  if (!list.children.length) list.append(h('div', { class: 'mm-empty' }, S.models.loaded ? '沒有符合的模型' : '載入中…'));
  // effort segment
  const seg = $('#effortSeg');
  seg.classList.toggle('disabled', sel ? modelCaps(sel).reasoning === false : false);
  seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.effort));
}

function chooseModel(sel) {
  S.model = sel;
  persistModelChoice();
  updateModelButton(); closeModelMenu();
  toast(sel ? `已切換到 ${sel.model}` : '使用 Hermes 預設模型');
}
function persistModelChoice() {
  const v = { model: S.model, effort: S.effort };
  LS.set('hc.model.last', v);
  if (S.current) LS.set(`hc.model.s.${S.current}`, v);
}
function openModelMenu() {
  $('#modelMenu').hidden = false; $('#modelBtn').setAttribute('aria-expanded', 'true');
  $('#modelSearch').value = ''; renderModelMenu();
  if (!isMobile()) $('#modelSearch').focus();
  if (!S.models.loaded) loadModelOptions();
}
function closeModelMenu() { $('#modelMenu').hidden = true; $('#modelBtn').setAttribute('aria-expanded', 'false'); }

// Pick the model to show for a session: our own saved choice, else the model Hermes recorded on it.
function applySessionModel(sessionId) {
  const saved = sessionId ? LS.get(`hc.model.s.${sessionId}`) : LS.get('hc.model.last');
  if (saved) { S.model = saved.model || null; S.effort = saved.effort || ''; }
  else if (sessionId) {
    const s = S.sessions.find((x) => x.id === sessionId);
    S.effort = '';
    S.model = null;
    if (s?.model) {
      const g = S.models.global;
      const owner = (g && S.models.providers.find((p) => p.slug === g.provider && p.models.includes(s.model)))
        || S.models.providers.find((p) => p.models.includes(s.model));
      if (owner && !(g && g.model === s.model && g.provider === owner.slug)) S.model = { provider: owner.slug, model: s.model };
    }
  }
  updateModelButton();
}
function modelRequestFields() {
  const f = {};
  if (S.model) Object.assign(f, { model: S.model.model, provider: S.model.provider, require_model_lock: true });
  if (S.effort) f.model_options = { reasoning: { effort: S.effort } };
  return f;
}

// ---------- utils ----------
const api = async (path, opts = {}) => {
  const r = await fetch(path, {
    ...opts,
    headers: { ...(opts.body && typeof opts.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
  });
  if (r.status === 401) { location.href = '/login'; throw new Error('login required'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `HTTP ${r.status}`);
  return data;
};
const fmtSize = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
const extOf = (name) => (name.match(/\.([A-Za-z0-9]{1,6})$/)?.[1] || 'FILE').toUpperCase();
const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const dlUrl = (p, inline) => `/api/files/download?path=${encodeURIComponent(p)}${inline ? '&inline=1' : ''}`;
const basename = (p) => p.split('/').filter(Boolean).pop() || p;
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
function isMobile() { return matchMedia('(max-width: 820px)').matches; }

function fileChip(name, { href, size, sub } = {}) {
  return h(href ? 'a' : 'div', { class: 'file-chip', href, download: href ? name : null, title: name },
    h('span', { class: 'ico' }, extOf(name).slice(0, 4)),
    h('span', { class: 'meta' }, h('b', {}, name), h('span', {}, sub || (size != null ? fmtSize(size) : '檔案'))),
    href ? h('span', { class: 'dl' }, svg(ICON.dl)) : null);
}

// ---------- markdown ----------
marked.setOptions({ gfm: true, breaks: true });
const PATH_CHARS = "[^\\s`'\"<>()\\[\\]{}，。、；：！？「」]";
const PATH_RE = new RegExp(`(/(?:${PATH_CHARS}+/)*${PATH_CHARS}+\\.[A-Za-z0-9]{1,8})(?![A-Za-z0-9/])`, 'g');

function isDownloadable(p) {
  if (p.split('/').some((seg) => seg.length > 1 && seg.startsWith('.'))) return false;
  return S.config.downloadRoots.some((r) => p === r || p.startsWith(r + '/'));
}

function preprocessMedia(text) {
  // MEDIA:/abs/path tags → inline image / link (Hermes convention for "send this file")
  return text.replace(/(^|\s)MEDIA:\s*(\/[^\s]+)/g, (m, pre, p) => {
    p = p.replace(/[.,;:!?)\]]+$/, '');
    if (!isDownloadable(p)) return m;
    return IMG_RE.test(p) ? `${pre}\n\n![${basename(p)}](${dlUrl(p, true)})\n\n` : `${pre}[${basename(p)}](${dlUrl(p)})`;
  });
}

function renderMarkdown(text, el, { final = true } = {}) {
  const html = DOMPurify.sanitize(marked.parse(preprocessMedia(text || '')), { ADD_ATTR: ['target', 'download'] });
  el.innerHTML = html;
  const found = new Set();
  // links to local absolute paths / file:// → download links
  el.querySelectorAll('a[href]').forEach((a) => {
    let href = a.getAttribute('href');
    if (href.startsWith('file://')) href = decodeURIComponent(href.slice(7));
    if (href.startsWith('/') && !href.startsWith('/api/') && isDownloadable(href)) {
      a.href = dlUrl(href); a.setAttribute('download', basename(href)); found.add(href);
    } else if (/^https?:/.test(href)) { a.target = '_blank'; a.rel = 'noopener'; }
    if (a.getAttribute('href')?.startsWith('/api/files/download')) {
      const p = new URL(a.href, location.href).searchParams.get('path'); if (p) found.add(p);
    }
  });
  el.querySelectorAll('img').forEach((img) => img.addEventListener('click', () => openLightbox(img.src)));
  // code blocks: header + highlight
  el.querySelectorAll('pre > code').forEach((code) => {
    const pre = code.parentElement;
    const lang = (code.className.match(/language-([\w+-]+)/) || [])[1] || '';
    if (final) { try { hljs.highlightElement(code); } catch {} }
    const btn = h('button', { type: 'button', onclick: () => { navigator.clipboard.writeText(code.innerText); btn.textContent = '已複製'; setTimeout(() => (btn.textContent = '複製'), 1500); } }, '複製');
    pre.prepend(h('div', { class: 'code-head' }, h('span', {}, lang || 'code'), btn));
  });
  // absolute paths in text / inline code → links
  if (final) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => n.parentElement.closest('pre, a') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const t = node.nodeValue; PATH_RE.lastIndex = 0;
      if (!PATH_RE.test(t)) continue;
      PATH_RE.lastIndex = 0;
      const frag = document.createDocumentFragment(); let last = 0, m;
      while ((m = PATH_RE.exec(t))) {
        if (!isDownloadable(m[1])) continue;
        frag.append(t.slice(last, m.index));
        frag.append(h('a', { href: dlUrl(m[1]), download: basename(m[1]), title: '下載 ' + m[1] }, m[1]));
        found.add(m[1]); last = m.index + m[0].length;
      }
      if (last === 0) continue;
      frag.append(t.slice(last));
      node.replaceWith(frag);
    }
    const downloads = [...found].filter((p) => !IMG_RE.test(p) || !el.querySelector(`img[src="${CSS.escape(dlUrl(p, true))}"]`));
    if (downloads.length) {
      el.append(h('div', { class: 'files', style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:10px' },
        downloads.map((p) => fileChip(basename(p), { href: dlUrl(p), sub: '點擊下載' }))));
    }
  }
}

// ---------- attachments in user text ----------
const ATT_LINE = /^\[附件\] (.+?) — (\/.+)$/;
function splitUserText(text) {
  const files = []; const keep = []; let hermesImages = 0;
  for (const line of String(text || '').split('\n')) {
    const m = line.match(ATT_LINE);
    if (m) files.push({ name: m[1], path: m[2] });
    // Hermes rewrites inline images into these notes when it stores the turn
    else if (/^\[Image attached at: .+\]$/.test(line.trim())) hermesImages++;
    else if (/^\[(screenshot|image|photo)\]$/i.test(line.trim())) continue;
    else keep.push(line);
  }
  return { text: keep.join('\n').trim(), files, hermesImages };
}

function renderUser(content) {
  let text = '', images = [];
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === 'text' || part.type === 'input_text') text += (text ? '\n' : '') + part.text;
      else if (part.type === 'image_url' || part.type === 'input_image') images.push(typeof part.image_url === 'string' ? part.image_url : part.image_url?.url);
    }
  } else text = String(content ?? '');
  const { text: body, files, hermesImages } = splitUserText(text);
  const imgFiles = files.filter((f) => IMG_RE.test(f.name));
  const otherFiles = files.filter((f) => !IMG_RE.test(f.name));
  if (!images.length && imgFiles.length) images = imgFiles.map((f) => dlUrl(f.path, true));
  if (!images.length && hermesImages) otherFiles.push(...Array.from({ length: hermesImages }, () => ({ name: '圖片', path: null })));
  const wrap = h('div', { class: 'msg user' });
  if (images.length) wrap.append(h('div', { class: 'imgs' }, images.filter(Boolean).map((src) => h('img', { src, alt: '', onclick: () => openLightbox(src) }))));
  if (otherFiles.length) wrap.append(h('div', { class: 'files' }, otherFiles.map((f) => fileChip(f.name, { href: f.path ? dlUrl(f.path) : null, sub: f.path ? '附件' : '已傳送的圖片' }))));
  if (body) wrap.append(h('div', { class: 'bubble' }, body));
  wrap.append(h('div', { class: 'actions' }, actBtn(ICON.copy, '複製', () => copyText(body))));
  return wrap;
}

function actBtn(icon, title, fn) { return h('button', { type: 'button', title, onclick: fn }, svg(icon)); }
async function copyText(t) { try { await navigator.clipboard.writeText(t); toast('已複製'); } catch { toast('無法複製'); } }

class AssistantView {
  constructor() {
    this.text = ''; this.tools = new Map(); this.toolSeq = 0;
    this.toolsEl = h('div', { class: 'tools' });
    this.thinkEl = null;
    this.body = h('div', { class: 'body' });
    this.actions = h('div', { class: 'actions' }, actBtn(ICON.copy, '複製', () => copyText(this.text)));
    this.el = h('div', { class: 'msg assistant' }, this.toolsEl, this.body, this.actions);
    this.raf = 0;
  }
  setStreaming(on) { this.body.classList.toggle('cursor', on && !this.text); this.streaming = on; }
  delta(d) { this.text += d; this.schedule(); }
  setText(t) { this.text = t; this.schedule(true); }
  schedule(final) {
    if (final) { cancelAnimationFrame(this.raf); this.raf = 0; renderMarkdown(this.text, this.body, { final: true }); this.body.classList.remove('cursor'); return; }
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0; renderMarkdown(this.text, this.body, { final: false });
      this.body.classList.toggle('cursor', this.streaming);
      stickToBottom();
    });
  }
  thinking(d) {
    if (!this.thinkEl) {
      this.thinkText = h('div');
      this.thinkEl = h('details', { class: 'thinking' }, h('summary', {}, '思考中…'), this.thinkText);
      this.toolsEl.before(this.thinkEl);
    }
    this.thinkText.textContent += d;
  }
  toolStart(name, preview, args, key) {
    const k = key || `${name}#${++this.toolSeq}`;
    const pre = h('pre', {}, preview || (args ? JSON.stringify(args, null, 2) : ''));
    const el = h('details', { class: 'tool running' }, h('summary', {}, h('span', { class: 'st' }), toolLabel(name, preview)), pre);
    this.toolsEl.append(el);
    this.tools.set(k, { name, el, pre });
    return k;
  }
  toolEnd(name, ok, preview, key) {
    let entry = key && this.tools.get(key);
    if (!entry) for (const e of this.tools.values()) if (e.name === name && e.el.classList.contains('running')) { entry = e; break; }
    if (!entry) { const k = this.toolStart(name, preview); entry = this.tools.get(k); }
    entry.el.classList.remove('running'); entry.el.classList.add(ok ? 'done' : 'failed');
    if (preview && key) entry.pre.textContent += (entry.pre.textContent ? '\n\n── 結果 ──\n' : '') + preview;
  }
  finishTools() { for (const e of this.tools.values()) if (e.el.classList.contains('running')) { e.el.classList.remove('running'); e.el.classList.add('done'); } if (this.thinkEl) this.thinkEl.querySelector('summary').textContent = '思考過程'; }
  commentary(t) { this.toolsEl.append(h('div', { class: 'thinking' }, t)); }
  error(msg) { this.el.append(h('div', { class: 'err-box' }, msg)); }
  meta(t) { this.el.append(h('div', { class: 'meta-line' }, t)); }
}
function toolLabel(name, preview) {
  const short = (preview || '').replace(/\s+/g, ' ').slice(0, 70);
  return `${name || 'tool'}${short ? ' · ' + short : ''}`;
}

// ---------- scrolling ----------
const chatEl = () => $('#chat');
let autoStick = true;
function stickToBottom(force) {
  const c = chatEl();
  if (force || autoStick) c.scrollTop = c.scrollHeight;
}

// ---------- sessions sidebar ----------
async function loadSessions() {
  const all = $('#showAll').checked;
  try {
    const data = await api(`/api/sessions?limit=200${all ? '' : '&source=api_server'}`);
    S.sessions = (data.data || []).filter((s) => !s.hidden && !s.is_internal_child);
    renderSessions();
  } catch (e) { console.warn(e); }
}

// Xiaozhi talks to Hermes through /v1/chat/completions, whose sessions get a derived
// id "api-<16 hex>"; sessions this web UI creates are "api_<ts>_<hex>".
const XIAOZHI_ID_RE = /^api-[0-9a-f]{16}$/;
const ccLabel = () => S.config.chatCompletionsLabel || '';
const isXiaozhi = (s) => !!ccLabel() && !!s && (s.source || 'api_server') === 'api_server' && XIAOZHI_ID_RE.test(s.id || '');
function sessionKind(s) { return isXiaozhi(s) ? 'xiaozhi' : s.source === 'api_server' || !s.source ? 'web' : 'other'; }
let sessionFilter = 'all';

function renderSessions() {
  const q = $('#search').value.trim().toLowerCase();
  const list = $('#sessionList'); list.innerHTML = '';
  const now = Date.now() / 1000; const day = 86400;
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0); const t0 = startOfToday / 1000;
  const groups = [['已釘選', []], ['今天', []], ['昨天', []], ['過去 7 天', []], ['過去 30 天', []], ['更早', []]];
  for (const s of S.sessions) {
    const title = s.title || s.preview || '新聊天';
    if (q && !(`${title} ${s.preview || ''}`.toLowerCase().includes(q))) continue;
    if (sessionFilter !== 'all' && sessionKind(s) !== sessionFilter) continue;
    const t = s.last_active || s.started_at || now;
    const g = s.pinned ? 0 : t >= t0 ? 1 : t >= t0 - day ? 2 : t >= now - 7 * day ? 3 : t >= now - 30 * day ? 4 : 5;
    groups[g][1].push(s);
  }
  for (const [label, items] of groups) {
    if (!items.length) continue;
    list.append(h('div', { class: 'group-label' }, label));
    for (const s of items) {
      const title = s.title || s.preview || '新聊天';
      const row = h('div', { class: 'sess' + (s.id === S.current ? ' active' : ''), title: `${title}\n${s.message_count || 0} 則訊息 · ${s.model || ''}`, onclick: () => openSession(s.id) },
        h('span', { class: 'name' }, title),
        isXiaozhi(s) ? h('span', { class: 'src xz' }, ccLabel()) : s.source && s.source !== 'api_server' ? h('span', { class: 'src' }, s.source) : null,
        h('button', { class: 'more', type: 'button', 'aria-label': '選項', onclick: (e) => { e.stopPropagation(); sessionMenu(e.currentTarget, s); } }, svg(ICON.more)));
      list.append(row);
    }
  }
  if (!list.children.length) list.append(h('div', { class: 'group-label' }, q ? '找不到符合的聊天' : '還沒有聊天'));
}

function sessionMenu(anchor, s) {
  document.querySelector('.sess-menu')?.remove();
  const r = anchor.getBoundingClientRect();
  const menu = h('div', { class: 'sess-menu', style: `top:${r.bottom + 4}px;left:${Math.min(r.left, innerWidth - 160)}px` },
    h('button', { type: 'button', onclick: () => { menu.remove(); renameSession(s); } }, svg(ICON.edit), '重新命名'),
    h('button', { type: 'button', class: 'danger', onclick: () => { menu.remove(); deleteSession(s); } }, svg(ICON.trash), '刪除'));
  document.body.append(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }));
}

async function renameSession(s) {
  const title = prompt('新的名稱', s.title || '');
  if (title == null || !title.trim()) return;
  try { await api(`/api/sessions/${encodeURIComponent(s.id)}`, { method: 'PATCH', body: JSON.stringify({ title: title.trim() }) }); s.title = title.trim(); renderSessions(); if (s.id === S.current) setTitle(s.title); }
  catch (e) { toast('改名失敗：' + e.message); }
}
async function deleteSession(s) {
  if (!confirm(`刪除「${s.title || '這個聊天'}」？此動作無法復原。`)) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
    S.sessions = S.sessions.filter((x) => x.id !== s.id);
    if (s.id === S.current) newChat(); else renderSessions();
  } catch (e) { toast('刪除失敗：' + e.message); }
}

function setTitle(t) { $('#title').textContent = t || '';document.title = t ? `${t} · Hermes Chat` : 'Hermes Chat'; }

// ---------- open / new ----------
function newChat() {
  if (S.streaming) stopRun();
  S.current = null; history.replaceState(null, '', '/');
  $('#messages').innerHTML = ''; chatEl().classList.remove('has-messages');
  setTitle(''); clearAttachments(); renderSessions(); updateFilesBadge(0); applySessionModel(null);
  if (!$('#filesPanel').hidden) renderFiles();
  closeSidebarMobile(); $('#input').focus();
}

async function openSession(id, { quiet } = {}) {
  if (S.streaming && S.current !== id) stopRun();
  S.current = id; history.replaceState(null, '', `#/s/${encodeURIComponent(id)}`);
  renderSessions(); closeSidebarMobile();
  const s = S.sessions.find((x) => x.id === id);
  setTitle(s?.title || s?.preview || '聊天');
  $('#title').classList.toggle('xz-title', isXiaozhi(s ?? { id }));
  $('#title').dataset.label = ccLabel();
  applySessionModel(id);
  const box = $('#messages');
  if (!quiet) box.innerHTML = '';
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(id)}/messages?limit=500`);
    if (S.current !== id) return;
    box.innerHTML = '';
    renderHistory(data.data || []);
    chatEl().classList.toggle('has-messages', box.children.length > 0);
    stickToBottom(true);
  } catch (e) { box.innerHTML = ''; box.append(h('div', { class: 'err-box' }, '載入失敗：' + e.message)); }
  refreshFiles();
}

function parseMaybeJson(v) { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } }

function renderHistory(msgs) {
  const box = $('#messages');
  msgs = [...msgs].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  let cur = null; // AssistantView for grouped assistant/tool msgs
  const flush = () => { if (cur) { cur.setText(cur.text); cur.finishTools(); cur = null; } };
  for (const m of msgs) {
    if (m.role === 'user') {
      flush();
      box.append(renderUser(parseMaybeJson(m.content)));
    } else if (m.role === 'assistant') {
      if (!cur) { cur = new AssistantView(); box.append(cur.el); }
      const reasoning = m.reasoning || m.reasoning_content;
      if (reasoning) cur.thinking(reasoning + '\n');
      const calls = parseMaybeJson(m.tool_calls);
      if (Array.isArray(calls)) for (const c of calls) {
        const fn = c.function || c; const args = parseMaybeJson(fn.arguments);
        cur.toolStart(fn.name, typeof args === 'string' ? args : JSON.stringify(args, null, 2), null, c.id);
      }
      const content = parseMaybeJson(m.content);
      const text = Array.isArray(content) ? content.map((p) => p.text || '').join('') : (content || '');
      if (text) cur.text = cur.text ? `${cur.text}\n\n${text}` : text;
    } else if (m.role === 'tool') {
      if (!cur) { cur = new AssistantView(); box.append(cur.el); }
      const out = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      cur.toolEnd(m.tool_name, !/^\s*\{?\s*"?error/i.test(out || ''), (out || '').slice(0, 4000), m.tool_call_id);
    }
  }
  flush();
}

// ---------- attachments ----------
let attSeq = 0;
function addFiles(fileList) {
  for (const file of fileList) {
    if (!file || !file.size && !file.name) continue;
    const isImage = /^image\/(png|jpeg|gif|webp|bmp)$/.test(file.type);
    const a = { id: ++attSeq, file, isImage, status: 'pending', progress: 0 };
    if (isImage) a.preview = URL.createObjectURL(file);
    S.attachments.push(a);
    startUpload(a);
  }
  renderAttachments(); updateSendState();
}

function renderAttachments() {
  const box = $('#attachments'); box.innerHTML = '';
  for (const a of S.attachments) {
    const rm = h('button', { class: 'x', type: 'button', 'aria-label': '移除', onclick: () => removeAttachment(a) }, svg(ICON.x));
    const prog = a.status === 'uploading' ? h('div', { class: 'prog' }, h('i', { style: `width:${Math.round(a.progress * 100)}%` })) : null;
    const inner = a.isImage ? h('img', { src: a.preview, alt: a.file.name }) : fileChip(a.file.name, { size: a.file.size, sub: a.status === 'error' ? '上傳失敗' : a.status === 'uploading' ? '上傳中…' : fmtSize(a.file.size) });
    box.append(h('div', { class: 'att' + (a.status === 'uploading' ? ' uploading' : ''), title: a.file.name }, inner, rm, prog));
  }
}
function removeAttachment(a) {
  a.xhr?.abort(); if (a.preview) URL.revokeObjectURL(a.preview);
  S.attachments = S.attachments.filter((x) => x !== a); renderAttachments(); updateSendState();
}
function clearAttachments() { for (const a of S.attachments) if (a.preview) URL.revokeObjectURL(a.preview); S.attachments = []; renderAttachments(); updateSendState(); }

let sessionCreating = null;
async function ensureSession(titleHint) {
  if (S.current) return S.current;
  if (!sessionCreating) {
    sessionCreating = api('/api/sessions', { method: 'POST', body: JSON.stringify({ title: (titleHint || '新聊天').slice(0, 60) }) })
      .then((d) => {
        const s = d.session || d; S.sessions.unshift(s); S.current = s.id; persistModelChoice();
        history.replaceState(null, '', `#/s/${encodeURIComponent(s.id)}`); renderSessions(); return s.id;
      }).finally(() => { sessionCreating = null; });
  }
  return sessionCreating;
}

async function startUpload(a) {
  try {
    const sid = await ensureSession(a.file.name);
    a.status = 'uploading'; renderAttachments();
    a.uploaded = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); a.xhr = xhr;
      xhr.open('PUT', `/api/files/upload?session=${encodeURIComponent(sid)}&name=${encodeURIComponent(a.file.name)}`);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) { a.progress = e.loaded / e.total; const bar = document.querySelector(`#attachments .att:nth-child(${S.attachments.indexOf(a) + 1}) .prog i`); if (bar) bar.style.width = `${Math.round(a.progress * 100)}%`; } };
      xhr.onload = () => xhr.status < 300 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error(JSON.parse(xhr.responseText || '{}')?.error?.message || `HTTP ${xhr.status}`));
      xhr.onerror = () => reject(new Error('網路錯誤'));
      xhr.onabort = () => reject(new Error('aborted'));
      xhr.send(a.file);
    });
    if (a.isImage) a.modelUrl = await imageForModel(a.file);
    a.status = 'done';
  } catch (e) {
    if (e.message !== 'aborted') { a.status = 'error'; toast(`${a.file.name} 上傳失敗：${e.message}`); }
  }
  renderAttachments(); updateSendState();
}

// Downscale big images so the inline data URL stays reasonable for the model.
async function imageForModel(file) {
  const MAX = 2048;
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return null;
  if (bmp.width <= MAX && bmp.height <= MAX && file.size < 3.5 * 1048576) {
    return new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
  }
  const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.88);
}

// ---------- send / stream ----------
function updateSendState() {
  const btn = $('#sendBtn');
  if (S.streaming) { btn.disabled = false; btn.classList.add('stop'); btn.setAttribute('aria-label', '停止'); return; }
  btn.classList.remove('stop'); btn.setAttribute('aria-label', '送出');
  const uploading = S.attachments.some((a) => a.status === 'uploading' || a.status === 'pending');
  const has = $('#input').value.trim() || S.attachments.some((a) => a.status === 'done');
  btn.disabled = !has || uploading;
}

async function send() {
  if (S.streaming) return;
  const input = $('#input');
  const text = input.value.trim();
  const atts = S.attachments.filter((a) => a.status === 'done');
  if (!text && !atts.length) return;
  if (S.attachments.some((a) => a.status === 'uploading' || a.status === 'pending')) { toast('檔案還在上傳中'); return; }

  let sid;
  try { sid = await ensureSession(text || atts[0]?.file.name); } catch (e) { toast('建立聊天失敗：' + e.message); return; }

  const lines = atts.map((a) => `[附件] ${a.uploaded.name} — ${a.uploaded.path}`);
  const fullText = [text || (atts.length ? '（請查看附件）' : ''), lines.length ? '\n' + lines.join('\n') : ''].join('\n').trim();
  const images = atts.filter((a) => a.isImage && a.modelUrl);
  const message = images.length
    ? [{ type: 'text', text: fullText }, ...images.map((a) => ({ type: 'image_url', image_url: { url: a.modelUrl } }))]
    : fullText;

  input.value = ''; autoResize(); clearAttachments();
  const box = $('#messages'); chatEl().classList.add('has-messages');
  box.append(renderUser(images.length ? [{ type: 'text', text: fullText }, ...images.map((a) => ({ type: 'image_url', image_url: { url: a.modelUrl } }))] : fullText));
  const view = new AssistantView(); box.append(view.el); view.setStreaming(true);
  autoStick = true; stickToBottom(true);

  const ctrl = new AbortController();
  S.streaming = { runId: null, ctrl, sid }; updateSendState();
  let finished = false, gotFinal = false;
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/chat/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, ...modelRequestFields() }), signal: ctrl.signal,
    });
    if (r.status === 401) { location.href = '/login'; return; }
    if (!r.ok || !r.body) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err?.error?.message || `HTTP ${r.status}`);
    }
    for await (const [event, data] of sseEvents(r.body)) {
      if (data?.run_id && !S.streaming?.runId && S.streaming) S.streaming.runId = data.run_id;
      switch (event) {
        case 'assistant.delta': view.delta(data.delta || ''); break;
        case 'assistant.commentary': if (!data.already_streamed) view.commentary(data.text); break;
        case 'tool.progress': if (data.tool_name === '_thinking') view.thinking(data.delta || ''); break;
        case 'tool.started': view.toolStart(data.tool_name, data.preview, data.args); stickToBottom(); break;
        case 'tool.completed': view.toolEnd(data.tool_name, true, data.preview); break;
        case 'tool.failed': view.toolEnd(data.tool_name, false, data.preview); break;
        case 'approval.request': showApproval(data); break;
        case 'assistant.completed': gotFinal = true; view.setText(data.content ?? view.text); break;
        case 'run.completed': {
          finished = true;
          const bits = [data.runtime?.model, data.usage?.total_tokens ? `${data.usage.total_tokens.toLocaleString()} tokens` : ''].filter(Boolean);
          if (bits.length) view.meta(bits.join(' · '));
          break;
        }
        case 'run.failed': finished = true; view.error('執行失敗：' + (data.error || data.message || data.reason || '未知錯誤')); break;
        case 'run.cancelled': finished = true; view.meta('已停止'); break;
        case 'run.queued': view.meta('已排入佇列，稍後完成'); break;
        case 'error': view.error(data.message || '發生錯誤'); break;
        case 'done': finished = true; break;
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') view.meta('已停止');
    else view.error('連線錯誤：' + e.message);
  } finally {
    if (!gotFinal) view.setText(view.text);
    view.setStreaming(false); view.finishTools(); hideApproval();
    S.streaming = null; updateSendState();
    loadSessions(); refreshFiles();
    if (!finished) console.warn('stream ended without terminal event');
  }
}

async function* sseEvents(stream) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value.replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      let event = 'message'; const data = [];
      for (const line of raw.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) continue;
      let parsed; try { parsed = JSON.parse(data.join('\n')); } catch { parsed = { raw: data.join('\n') }; }
      yield [event, parsed];
    }
  }
}

async function stopRun() {
  const st = S.streaming; if (!st) return;
  if (st.runId) { try { await api(`/api/runs/${st.runId}/stop`, { method: 'POST', body: '{}' }); } catch {} }
  setTimeout(() => st.ctrl.abort(), st.runId ? 1500 : 0);
}

// ---------- approvals ----------
const CHOICE_LABEL = { once: '允許一次', session: '此聊天都允許', always: '永遠允許', deny: '拒絕' };
function showApproval(ev) {
  const box = $('#approval'); box.innerHTML = '';
  const runId = ev.run_id || S.streaming?.runId;
  const choices = (Array.isArray(ev.choices) && ev.choices.length ? ev.choices : ['once', 'deny']).map((c) => typeof c === 'string' ? c : c.id || c.value || c.choice);
  box.append(h('div', {}, h('strong', {}, '⚠️ Hermes 要求核准'), ev.description ? h('div', { style: 'font-size:13px;color:var(--text-2);margin-top:4px' }, ev.description) : null));
  if (ev.command) box.append(h('div', { class: 'cmd' }, ev.command));
  box.append(h('div', { class: 'btns' }, choices.map((c) => h('button', {
    type: 'button', class: c === 'deny' ? 'no' : c === 'once' ? 'ok' : '',
    onclick: async () => {
      try { await api(`/api/runs/${runId}/approval`, { method: 'POST', body: JSON.stringify({ choice: c, ...(ev.request_id ? { request_id: ev.request_id } : {}) }) }); hideApproval(); }
      catch (e) { toast('送出失敗：' + e.message); }
    },
  }, CHOICE_LABEL[c] || c))));
  box.hidden = false;
}
function hideApproval() { $('#approval').hidden = true; $('#approval').innerHTML = ''; }

// ---------- files panel ----------
let filesCache = [];
async function refreshFiles() {
  if (!S.current) { filesCache = []; updateFilesBadge(0); if (!$('#filesPanel').hidden) renderFiles(); return; }
  try {
    const d = await api(`/api/files/list?session=${encodeURIComponent(S.current)}`);
    filesCache = d.files || []; S.fileDirs = d.dirs;
    updateFilesBadge(filesCache.filter((f) => f.kind === 'output').length);
    if (!$('#filesPanel').hidden) renderFiles();
  } catch (e) { console.warn(e); }
}
function updateFilesBadge(n) { const b = $('#filesCount'); b.hidden = !n; b.textContent = n; }
function renderFiles() {
  const body = $('#filesBody'); body.innerHTML = '';
  if (!S.current) { body.append(h('div', { class: 'note' }, '開始聊天後，這裡會列出你上傳的檔案和 Hermes 產生的檔案。')); return; }
  const out = filesCache.filter((f) => f.kind === 'output'), up = filesCache.filter((f) => f.kind === 'upload');
  const item = (f) => fileChip(f.name, { href: dlUrl(f.path), sub: `${fmtSize(f.size)} · ${new Date(f.mtime).toLocaleString()}` });
  body.append(h('h4', {}, `Hermes 產生的檔案 (${out.length})`));
  out.length ? out.forEach((f) => body.append(item(f))) : body.append(h('div', { class: 'note' }, '尚無。請 Hermes 把要給你的檔案存到：' + (S.fileDirs?.outputs || '')));
  body.append(h('h4', {}, `你上傳的檔案 (${up.length})`));
  up.length ? up.forEach((f) => body.append(item(f))) : body.append(h('div', { class: 'note' }, '尚無'));
}

// ---------- misc UI ----------
function openLightbox(src) { const lb = $('#lightbox'); lb.querySelector('img').src = src; lb.hidden = false; }
function autoResize() { const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, innerHeight * 0.4) + 'px'; }
function closeSidebarMobile() { if (isMobile()) $('#app').classList.remove('side-open'); }

async function checkHealth() {
  const el = $('#health');
  try {
    const h2 = await api('/api/health');
    el.className = 'health ok'; el.querySelector('.txt').textContent = `Hermes 已連線${h2.version ? ' · v' + h2.version : ''}`;
  } catch (e) { el.className = 'health bad'; el.querySelector('.txt').textContent = 'Hermes 無法連線'; }
}

function bind() {
  const input = $('#input');
  input.addEventListener('input', () => { autoResize(); updateSendState(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); if (!S.streaming) send(); }
  });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); S.streaming ? stopRun() : send(); });
  $('#attachBtn').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
  $('#newChat').addEventListener('click', newChat);
  $('#search').addEventListener('input', renderSessions);
  $('#showAll').addEventListener('change', () => { try { localStorage.setItem('hc.showAll', $('#showAll').checked ? '1' : ''); } catch {} loadSessions(); });
  $('#openSidebar').addEventListener('click', () => {
    if (isMobile()) $('#app').classList.add('side-open'); else $('#app').classList.toggle('side-collapsed');
  });
  $('#closeSidebar').addEventListener('click', closeSidebarMobile);
  $('#modelBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#modelMenu').hidden ? openModelMenu() : closeModelMenu(); });
  $('#modelMenu').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', closeModelMenu);
  $('#modelSearch').addEventListener('input', renderModelMenu);
  $('#modelSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModelMenu();
    if (e.key === 'Enter') { e.preventDefault(); $('#modelList .mm-item:not(.sel)')?.click() || $('#modelList .mm-item')?.click(); }
  });
  $('#modelRefresh').addEventListener('click', () => { S.models.loaded = false; renderModelMenu(); loadModelOptions(true); });
  $('#effortSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.effort = b.dataset.v; persistModelChoice(); updateModelButton(); renderModelMenu();
  });
  $('#scrim').addEventListener('click', closeSidebarMobile);
  $('#filesBtn').addEventListener('click', () => { const p = $('#filesPanel'); p.hidden = !p.hidden; if (!p.hidden) { renderFiles(); refreshFiles(); } });
  $('#closeFiles').addEventListener('click', () => { $('#filesPanel').hidden = true; });
  $('#refreshFiles').addEventListener('click', refreshFiles);
  $('#lightbox').addEventListener('click', () => { $('#lightbox').hidden = true; });
  $('#logout').addEventListener('click', async () => { await fetch('/api/logout'); location.href = '/login'; });
  chatEl().addEventListener('scroll', () => { const c = chatEl(); autoStick = c.scrollHeight - c.scrollTop - c.clientHeight < 80; });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); newChat(); }
    if (e.key === 'Escape') { $('#lightbox').hidden = true; }
  });
  // drag & drop
  const main = $('#main'); let depth = 0;
  main.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { depth++; main.classList.add('dragging'); } });
  main.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; main.classList.remove('dragging'); } });
  main.addEventListener('dragover', (e) => e.preventDefault());
  main.addEventListener('drop', (e) => { e.preventDefault(); depth = 0; main.classList.remove('dragging'); if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]); });
}

async function init() {
  try { $('#showAll').checked = localStorage.getItem('hc.showAll') === '1'; } catch {}
  try { sessionFilter = localStorage.getItem('hc.filter') || 'all'; } catch {}
  document.querySelectorAll('#sessFilter button').forEach((b) => {
    b.classList.toggle('on', b.dataset.f === sessionFilter);
    b.addEventListener('click', () => {
      sessionFilter = b.dataset.f;
      try { localStorage.setItem('hc.filter', sessionFilter); } catch {}
      document.querySelectorAll('#sessFilter button').forEach((x) => x.classList.toggle('on', x === b));
      renderSessions();
    });
  });
  bind();
  try { S.config = await api('/api/config'); } catch {}
  // Label filter only when a chat-completions client label is configured.
  const xzBtn = $('#sessFilter button[data-f=xiaozhi]');
  if (ccLabel()) xzBtn.textContent = ccLabel();
  else { $('#sessFilter').hidden = true; sessionFilter = 'all'; }
  await Promise.all([loadSessions(), loadModelOptions()]);
  const m = location.hash.match(/^#\/s\/(.+)$/);
  if (m) openSession(decodeURIComponent(m[1])); else { applySessionModel(null); $('#input').focus(); }
  checkHealth(); setInterval(checkHealth, 30000);
  setInterval(() => { if (!S.streaming && document.visibilityState === 'visible') loadSessions(); }, 20000);
}
init();
