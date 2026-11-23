// Hermes Chat — a ChatGPT-style web UI on top of the Hermes API server.
// Zero dependencies: Node >= 20 (uses built-in fetch, streams, crypto).
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------- config ----------
function loadEnvFile(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  } catch { /* missing file is fine */ }
  return out;
}

const env = { ...loadEnvFile(path.join(APP_DIR, '.env')), ...process.env };
const HERMES_ENV_FILE = env.HERMES_ENV_FILE || path.join(os.homedir(), '.hermes', '.env');
const hermesEnv = loadEnvFile(HERMES_ENV_FILE);

const CFG = {
  host: env.HOST || '127.0.0.1',
  port: Number(env.PORT || 9120),
  hermesUrl: (env.HERMES_URL || `http://${hermesEnv.API_SERVER_HOST || '127.0.0.1'}:${hermesEnv.API_SERVER_PORT || 8642}`).replace(/\/+$/, ''),
  hermesKey: env.HERMES_API_KEY || hermesEnv.API_SERVER_KEY || '',
  password: env.APP_PASSWORD || '',
  dataDir: path.resolve(APP_DIR, env.DATA_DIR || 'data'),
  maxUploadBytes: Number(env.MAX_UPLOAD_MB || 200) * 1024 * 1024,
  // Language Hermes should answer in (e.g. "Traditional Chinese (繁體中文, Taiwan usage)"); empty = follow the user.
  replyLanguage: (env.REPLY_LANGUAGE || '').trim(),
  // Tag for sessions created through /v1/chat/completions by another client (e.g. a voice assistant); empty = no tag.
  chatCompletionsLabel: (env.CHAT_COMPLETIONS_LABEL || '').trim(),
};
CFG.workspace = path.join(CFG.dataDir, 'workspace');
// Extra roots the browser may download from (besides the workspace). Paths with a
// dot-segment (.ssh, .hermes/.env, ...) are always refused.
CFG.downloadRoots = [CFG.workspace, ...(env.DOWNLOAD_ROOTS ?? `${os.homedir()}:/tmp`).split(':').filter(Boolean)]
  .map((p) => path.resolve(p));

if (!CFG.hermesKey) {
  console.error('[hermes-chat] No Hermes API key: set HERMES_API_KEY or API_SERVER_KEY in', HERMES_ENV_FILE);
  process.exit(1);
}
fs.mkdirSync(CFG.workspace, { recursive: true });

// ---------- Hermes dashboard client (MCP / skills management) ----------
// The API server has no MCP/skills write endpoints; the dashboard does. Auth, in order:
//   DASHBOARD_TOKEN / DASHBOARD_TOKEN_FILE  -> deployment session token (HERMES_DASHBOARD_SESSION_TOKEN)
//   DASHBOARD_USER + DASHBOARD_PASSWORD     -> basic_auth password login, cookie session
const DASH = {
  url: (env.DASHBOARD_URL || `http://${hermesEnv.API_SERVER_HOST || '127.0.0.1'}:9119`).replace(/\/+$/, ''),
  token: env.DASHBOARD_TOKEN || '',
  tokenFile: env.DASHBOARD_TOKEN_FILE || '',
  user: env.DASHBOARD_USER || '',
  pass: env.DASHBOARD_PASSWORD || '',
  cookies: new Map(),
  loggingIn: null,
};
function dashToken() {
  if (DASH.token) return DASH.token;
  if (DASH.tokenFile) { try { return fs.readFileSync(DASH.tokenFile, 'utf8').trim(); } catch { return ''; } }
  return '';
}
function dashMode() { return dashToken() ? 'token' : DASH.user && DASH.pass ? 'password' : ''; }
function absorbCookies(res) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const [pair, ...attrs] = c.split(';');
    const i = pair.indexOf('=');
    const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim();
    const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || !value;
    if (expired) DASH.cookies.delete(name); else DASH.cookies.set(name, value);
  }
}
async function dashLogin() {
  if (!DASH.loggingIn) {
    DASH.loggingIn = (async () => {
      DASH.cookies.clear();
      const r = await fetch(`${DASH.url}/auth/password-login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: DASH.url },
        body: JSON.stringify({ provider: 'basic', username: DASH.user, password: DASH.pass, next: '/' }),
      });
      absorbCookies(r);
      if (!r.ok) throw Object.assign(new Error(`Dashboard login failed (HTTP ${r.status})`), { status: 502 });
    })().finally(() => { DASH.loggingIn = null; });
  }
  return DASH.loggingIn;
}
async function dashFetch(pathAndQuery, { method = 'GET', body } = {}, retried = false) {
  const mode = dashMode();
  if (!mode) throw Object.assign(new Error('Dashboard access is not configured'), { status: 503 });
  const headers = { Accept: 'application/json', Origin: DASH.url };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (mode === 'token') headers.Authorization = `Bearer ${dashToken()}`;
  else {
    if (!DASH.cookies.size) await dashLogin();
    headers.Cookie = [...DASH.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  const r = await fetch(DASH.url + pathAndQuery, { method, headers, body, redirect: 'manual' });
  absorbCookies(r);
  if (mode === 'password' && r.status === 401 && !retried) {
    DASH.cookies.clear();
    return dashFetch(pathAndQuery, { method, body }, true);
  }
  return r;
}
// Only these dashboard routes are reachable through Hermes Chat.
const DASH_ROUTES = [
  ['GET', /^\/api\/mcp\/servers$/], ['POST', /^\/api\/mcp\/servers$/],
  ['DELETE', /^\/api\/mcp\/servers\/[^/]+$/], ['POST', /^\/api\/mcp\/servers\/[^/]+\/(test|auth)$/],
  ['PUT', /^\/api\/mcp\/servers\/[^/]+\/enabled$/],
  ['GET', /^\/api\/mcp\/oauth\/flows\/[^/]+$/], ['DELETE', /^\/api\/mcp\/oauth\/flows\/[^/]+$/],
  ['GET', /^\/api\/mcp\/oauth\/callback\/[^/]+$/],  // hand-off of a pasted loopback redirect
  ['GET', /^\/api\/mcp\/catalog$/], ['POST', /^\/api\/mcp\/catalog\/install$/],
  ['GET', /^\/api\/skills$/], ['POST', /^\/api\/skills$/], ['GET', /^\/api\/skills\/content$/],
  ['PUT', /^\/api\/skills\/(content|toggle|lock)$/],
  ['GET', /^\/api\/skills\/hub\/(search|preview|scan|updates|sources)$/],
  ['POST', /^\/api\/skills\/hub\/(install|uninstall|update)$/],
  ['GET', /^\/api\/actions\/[A-Za-z0-9_.-]+\/status$/],
  ['POST', /^\/api\/gateway\/restart$/],
  ['GET', /^\/api\/tools\/toolsets$/],
];

// ---------- helpers ----------
const SESSION_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': isBuf || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(data);
}

async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function sessionDirs(sessionId) {
  const base = path.join(CFG.workspace, sessionId.replace(/[^A-Za-z0-9_.-]/g, '_'));
  return { base, uploads: path.join(base, 'uploads'), outputs: path.join(base, 'outputs') };
}

function safeFileName(name) {
  let n = String(name || 'file').normalize('NFC').replace(/[\/\\\0]/g, '_').replace(/[\x00-\x1f]/g, '').trim();
  n = n.replace(/^\.+/, '_');
  if (!n) n = 'file';
  if (Buffer.byteLength(n) > 200) {
    const ext = path.extname(n).slice(0, 20);
    n = n.slice(0, 120) + ext;
  }
  return n;
}

async function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 1; ; i++) {
    try { await fsp.access(candidate); } catch { return candidate; }
    candidate = path.join(dir, `${stem} (${i})${ext}`);
  }
}

function isDownloadAllowed(p) {
  const resolved = path.resolve(p);
  if (resolved.split(path.sep).some((seg) => seg.startsWith('.') && seg.length > 1)) return false;
  return CFG.downloadRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.zip': 'application/zip', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2',
};
const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

// ---------- auth ----------
const COOKIE = 'hermes_chat';
const authToken = CFG.password
  ? crypto.createHmac('sha256', CFG.password).update('hermes-chat-v1').digest('hex')
  : '';

function isAuthed(req) {
  if (!CFG.password) return true;
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => {
    const i = c.indexOf('=');
    return [c.slice(0, i).trim(), c.slice(i + 1).trim()];
  }));
  const got = Buffer.from(cookies[COOKIE] || '');
  const want = Buffer.from(authToken);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ---------- Hermes proxy ----------
function hermesHeaders(extra = {}) {
  return { Authorization: `Bearer ${CFG.hermesKey}`, ...extra };
}

async function proxy(req, res, upstreamPath, { body, method } = {}) {
  const init = { method: method || req.method, headers: hermesHeaders() };
  if (body !== undefined) {
    init.body = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  } else if (!['GET', 'HEAD', 'DELETE'].includes(init.method)) {
    init.body = await readBody(req);
    init.headers['Content-Type'] = 'application/json';
  }
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  init.signal = ac.signal;
  let up;
  try {
    up = await fetch(CFG.hermesUrl + upstreamPath, init);
  } catch (e) {
    if (ac.signal.aborted) return;
    return send(res, 502, { error: { message: `Cannot reach Hermes at ${CFG.hermesUrl}: ${e.message}` } });
  }
  const headers = { 'Content-Type': up.headers.get('content-type') || 'application/json' };
  const isSse = headers['Content-Type'].includes('text/event-stream');
  if (isSse) Object.assign(headers, { 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
  res.writeHead(up.status, headers);
  if (!up.body) return res.end();
  try {
    await pipeline(Readable.fromWeb(up.body), res);
  } catch { /* client went away */ }
}

// Resolve a pending command approval. When the gateway runs with a session authority, Hermes
// only accepts exactly {request_id, execution_generation, choice}, where request_id is the
// pending prompt's id and execution_generation the run's generation — neither is in the
// approval.request event, so read them from GET /v1/runs/{id}. Without an authority the run
// projection has no pending_controls and the plain {choice, request_id?} body is used.
async function handleApproval(req, res, runId) {
  const body = await readJson(req);
  const choice = String(body.choice || '');
  let payload = { choice, ...(body.request_id ? { request_id: String(body.request_id) } : {}) };
  try {
    const r = await fetch(`${CFG.hermesUrl}/v1/runs/${runId}`, { headers: hermesHeaders() });
    if (r.ok) {
      const run = await r.json();
      const pending = (run.pending_controls || []).filter((c) => c && c.kind === 'approval');
      const prompt = pending.find((c) => body.request_id && (c.prompt_id === body.request_id || c.request_id === body.request_id)) || pending[0];
      if (prompt && Number.isInteger(run.execution_generation)) {
        payload = { request_id: prompt.prompt_id || prompt.request_id, execution_generation: run.execution_generation, choice };
      }
    }
  } catch { /* fall back to the plain body */ }
  let up;
  try {
    up = await fetch(`${CFG.hermesUrl}/v1/runs/${runId}/approval`, {
      method: 'POST', headers: hermesHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(payload),
    });
  } catch (e) {
    return send(res, 502, { error: { message: `Cannot reach Hermes: ${e.message}` } });
  }
  const text = await up.text();
  let data; try { data = JSON.parse(text); } catch { data = { error: { message: text.slice(0, 300) } }; }
  if (!up.ok) console.warn('[hermes-chat] approval refused', up.status, runId, text.slice(0, 300));
  return send(res, up.status, data);
}

function workspaceInstructions(sessionId) {
  const d = sessionDirs(sessionId);
  return [
    '[Hermes Chat web UI]',
    'The user is talking to you through a ChatGPT-style web page.',
    CFG.replyLanguage
      ? `Always reply in ${CFG.replyLanguage} unless the user explicitly asks for another language. Code, commands, file paths and proper nouns may stay in their original form.`
      : 'Reply in the same language the user writes in.',
    `Files the user attaches are saved under ${d.uploads} and referenced in their message as lines like "[附件] name — /absolute/path". Read them from disk with your tools when needed.`,
    `When you create a file the user should download (documents, code, images, archives, reports...), save it under ${d.outputs} and mention its full absolute path in your reply — the web page turns absolute paths into download links automatically.`,
    'To show an image inline you may also write MEDIA:/absolute/path/to/image.png on its own line.',
  ].join('\n');
}

// ---------- routes ----------
async function handleApi(req, res, url) {
  const p = url.pathname;
  let m;

  if (p === '/api/config' && req.method === 'GET') {
    return send(res, 200, { downloadRoots: CFG.downloadRoots, chatCompletionsLabel: CFG.chatCompletionsLabel });
  }
  if (p === '/api/health') return proxy(req, res, '/health');
  if (p === '/api/models') return proxy(req, res, '/v1/models');
  if (p === '/api/model/options' && req.method === 'GET') {
    return proxy(req, res, '/api/model/options' + (url.searchParams.get('refresh') === '1' ? '?refresh=1' : ''));
  }

  if (p === '/api/sessions' && (req.method === 'GET' || req.method === 'POST')) {
    if (req.method === 'POST') {
      const body = { source: 'api_server', ...(await readJson(req)) };
      // Hermes refuses a title another session already uses (e.g. two chats both opened with
      // "哈囉"). Retry once without a title and let Hermes name the session itself.
      if (body.title) {
        const r = await fetch(`${CFG.hermesUrl}/api/sessions`, {
          method: 'POST', headers: hermesHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body),
        }).catch((e) => ({ ok: false, status: 502, text: async () => JSON.stringify({ error: { message: e.message } }) }));
        const text = await r.text();
        if (!(r.status === 400 && text.includes('invalid_title'))) {
          res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(text);
        }
        delete body.title;
      }
      return proxy(req, res, '/api/sessions', { body });
    }
    return proxy(req, res, '/api/sessions' + url.search);
  }

  if ((m = p.match(/^\/api\/sessions\/([^/]+)(\/messages|\/chat\/stream)?$/))) {
    const id = decodeURIComponent(m[1]);
    if (!SESSION_ID_RE.test(id)) return send(res, 400, { error: { message: 'bad session id' } });
    const enc = encodeURIComponent(id);
    if (!m[2] && ['GET', 'PATCH', 'DELETE'].includes(req.method)) {
      return proxy(req, res, `/api/sessions/${enc}`);
    }
    if (m[2] === '/messages' && req.method === 'GET') {
      return proxy(req, res, `/api/sessions/${enc}/messages${url.search}`);
    }
    if (m[2] === '/chat/stream' && req.method === 'POST') {
      const body = await readJson(req);
      const d = sessionDirs(id);
      await fsp.mkdir(d.uploads, { recursive: true });
      await fsp.mkdir(d.outputs, { recursive: true });
      const extra = workspaceInstructions(id);
      body.system_message = body.system_message ? `${extra}\n\n${body.system_message}` : extra;
      return proxy(req, res, `/api/sessions/${enc}/chat/stream`, { body });
    }
  }

  if ((m = p.match(/^\/api\/runs\/([^/]+)\/(stop|approval)$/)) && req.method === 'POST') {
    if (!RUN_ID_RE.test(m[1])) return send(res, 400, { error: { message: 'bad run id' } });
    if (m[2] === 'approval') return handleApproval(req, res, m[1]);
    return proxy(req, res, `/v1/runs/${m[1]}/${m[2]}`);
  }

  // ---- admin: MCP / skills via the Hermes dashboard ----
  if (p === '/api/admin/status' && req.method === 'GET') {
    const mode = dashMode();
    let reachable = false, error = '';
    if (mode) {
      try {
        const r = await dashFetch('/api/mcp/servers');
        reachable = r.ok;
        if (!r.ok) error = `HTTP ${r.status}`;
      } catch (e) { error = e.message; }
    }
    return send(res, 200, { configured: !!mode, mode, reachable, error, dashboardUrl: DASH.url });
  }
  if (p.startsWith('/api/admin/')) {
    const target = p.slice('/api/admin'.length);
    if (!DASH_ROUTES.some(([m, re]) => m === req.method && re.test(target))) {
      return send(res, 404, { error: { message: 'Not an allowed admin route' } });
    }
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? (await readBody(req)).toString('utf8') || '{}' : undefined;
    let r;
    try { r = await dashFetch(target + url.search, { method: req.method, body }); }
    catch (e) { return send(res, e.status || 502, { error: { message: `Hermes dashboard: ${e.message}` } }); }
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { detail: text.slice(0, 500) }; }
    if (!r.ok) {
      const detail = typeof data?.detail === 'string' ? data.detail : data?.detail ? JSON.stringify(data.detail) : data?.error || `HTTP ${r.status}`;
      const status = r.status === 401 || (r.status >= 300 && r.status < 400) ? 502 : r.status;
      return send(res, status, { error: { message: r.status === 401 ? 'Hermes dashboard 認證失敗，請檢查 DASHBOARD_* 設定' : String(detail) } });
    }
    return send(res, 200, data);
  }

  // ---- files ----
  if (p === '/api/files/upload' && (req.method === 'PUT' || req.method === 'POST')) {
    const sessionId = url.searchParams.get('session') || '';
    if (!SESSION_ID_RE.test(sessionId)) return send(res, 400, { error: { message: 'bad session id' } });
    const len = Number(req.headers['content-length'] || 0);
    if (len > CFG.maxUploadBytes) return send(res, 413, { error: { message: 'File too large' } });
    const d = sessionDirs(sessionId);
    await fsp.mkdir(d.uploads, { recursive: true });
    const target = await uniquePath(d.uploads, safeFileName(url.searchParams.get('name')));
    let size = 0;
    const counter = new Transform({
      transform(chunk, _e, cb) {
        size += chunk.length;
        if (size > CFG.maxUploadBytes) return cb(Object.assign(new Error('File too large'), { status: 413 }));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, counter, fs.createWriteStream(target));
    } catch (e) {
      await fsp.rm(target, { force: true });
      throw e;
    }
    return send(res, 200, { name: path.basename(target), path: target, size, mime: mimeOf(target) });
  }

  if (p === '/api/files/list' && req.method === 'GET') {
    const sessionId = url.searchParams.get('session') || '';
    if (!SESSION_ID_RE.test(sessionId)) return send(res, 400, { error: { message: 'bad session id' } });
    const d = sessionDirs(sessionId);
    const out = [];
    for (const [kind, dir] of [['output', d.outputs], ['upload', d.uploads]]) {
      const walk = async (cur) => {
        let entries = [];
        try { entries = await fsp.readdir(cur, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const full = path.join(cur, e.name);
          if (e.isDirectory()) await walk(full);
          else if (e.isFile()) {
            const st = await fsp.stat(full);
            out.push({ kind, name: path.relative(dir, full), path: full, size: st.size, mtime: st.mtimeMs, mime: mimeOf(full) });
          }
        }
      };
      await walk(dir);
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return send(res, 200, { files: out, dirs: d });
  }

  if (p === '/api/files/download' && req.method === 'GET') {
    const fp = url.searchParams.get('path') || '';
    if (!path.isAbsolute(fp) || !isDownloadAllowed(fp)) return send(res, 403, 'This path is not downloadable from Hermes Chat.');
    let st;
    try { st = await fsp.stat(fp); } catch { return send(res, 404, 'File not found'); }
    if (!st.isFile()) return send(res, 400, 'Not a file');
    const inline = url.searchParams.get('inline') === '1';
    const name = path.basename(fp);
    res.writeHead(200, {
      'Content-Type': mimeOf(fp),
      'Content-Length': st.size,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
    });
    return pipeline(fs.createReadStream(fp), res).catch(() => {});
  }

  return send(res, 404, { error: { message: 'Not found' } });
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '/login') rel = rel === '/' ? '/index.html' : '/login.html';
  const root = path.join(APP_DIR, 'public');
  const fp = path.resolve(root, '.' + rel);
  if (!fp.startsWith(root + path.sep)) return send(res, 403, 'Forbidden');
  try {
    const st = await fsp.stat(fp);
    if (!st.isFile()) throw new Error();
    res.writeHead(200, { 'Content-Type': mimeOf(fp), 'Content-Length': st.size, 'Cache-Control': rel.startsWith('/vendor/') ? 'max-age=86400' : 'no-cache' });
    fs.createReadStream(fp).pipe(res);
  } catch {
    send(res, 404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  try {
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const { password } = await readJson(req);
      const a = Buffer.from(String(password || '')), b = Buffer.from(CFG.password);
      if (!CFG.password || (a.length === b.length && crypto.timingSafeEqual(a, b))) {
        return send(res, 200, { ok: true }, {
          'Set-Cookie': `${COOKIE}=${authToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 90}`,
        });
      }
      await new Promise((r) => setTimeout(r, 800));
      return send(res, 401, { error: { message: '密碼錯誤' } });
    }
    if (url.pathname === '/api/logout') {
      return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }
    const publicPaths = ['/login', '/login.html', '/style.css', '/favicon.svg'];
    if (!isAuthed(req) && !publicPaths.includes(url.pathname) && !url.pathname.startsWith('/vendor/')) {
      if (url.pathname.startsWith('/api/')) return send(res, 401, { error: { message: 'Login required' } });
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (e) {
    console.error('[hermes-chat]', req.method, url.pathname, e);
    if (!res.headersSent) send(res, e.status || 500, { error: { message: e.message } });
    else res.end();
  }
});
server.requestTimeout = 0; // long agent turns + big uploads
server.headersTimeout = 60_000;

server.listen(CFG.port, CFG.host, () => {
  console.log(`[hermes-chat] http://${CFG.host}:${CFG.port}  →  Hermes ${CFG.hermesUrl}`);
  console.log(`[hermes-chat] workspace: ${CFG.workspace}  password: ${CFG.password ? 'on' : 'OFF'}`);
});
