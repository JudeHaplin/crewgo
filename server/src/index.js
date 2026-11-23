'use strict';
/**
 * 速派 · 自托管服务
 * 一个进程同时做三件事：托管前端静态文件、提供本地 API、跑定时通知任务。
 * 零外部依赖（只用 Node 内置模块 + node:sqlite）。
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('./store');
const auth = require('./auth');
const jobs = require('./jobs');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
// 排障用：ACCESS_LOG=0 可关掉每个请求一行日志
const ACCESS_LOG = process.env.ACCESS_LOG !== '0';
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..', '..');
const VERSION = require('../package.json').version;
// 飞牛 fnOS 网关会把 /app/<appname>/ 反代进来，这里统一剥掉前缀
const STRIP = ['/app/crewgo', '/app/crewgo'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json'
};

const log = msg => console.log(new Date().toLocaleString('zh-CN', { hour12: false }) + '  ' + msg);
const fail = (res, code, msg) => send(res, code, { error: msg });

/* ---------- PIN 规则：只限长度，字母/数字/符号都可以（与前端一致） ---------- */
const PIN_MIN = 4;
const PIN_MAX = 32;
/** 去掉首尾空格（中间空格属于 PIN 的一部分，保留），避免手机键盘尾随空格导致登录失败 */
const normPin = v => String(v === null || v === undefined ? '' : v).trim();
function pinError(pin) {
  if (pin.length < PIN_MIN) return 'PIN 至少 ' + PIN_MIN + ' 位';
  if (pin.length > PIN_MAX) return 'PIN 最多 ' + PIN_MAX + ' 位（字母、数字、符号都可以）';
  return '';
}

function send(res, code, payload) {
  const buf = Buffer.from(JSON.stringify(payload));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

/* ---------- 登录暴破简单限速 ---------- */
const attempts = new Map();
function tooMany(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.until) { attempts.delete(ip); return false; }
  return rec.count >= 5;
}
function markFail(ip) {
  const rec = attempts.get(ip) || { count: 0, until: 0 };
  rec.count++;
  rec.until = Date.now() + 60 * 1000;
  attempts.set(ip, rec);
}

function actorFrom(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const payload = auth.verify(token);
  if (!payload) return null;
  const row = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(payload.pid);
  if (!row || row.active === 0) return null;
  return { id: row.id, name: row.name, role: row.role };
}

const publicProfile = row => ({ id: row.id, name: row.name, role: row.role, email: row.email, phone: row.phone });

/* ---------- 路由 ---------- */
async function handleApi(req, res, pathname) {
  const ip = req.socket.remoteAddress || 'unknown';

  if (pathname === '/api/health') {
    return send(res, 200, { ok: true, version: VERSION, time: new Date().toISOString() });
  }

  if (pathname === '/api/auth/status') {
    const row = store.raw().prepare('SELECT COUNT(*) AS n FROM profiles').get();
    return send(res, 200, { initialized: Number(row.n) > 0 });
  }

  if (pathname === '/api/auth/setup' && req.method === 'POST') {
    const row = store.raw().prepare('SELECT COUNT(*) AS n FROM profiles').get();
    if (Number(row.n) > 0) return fail(res, 409, '系统已经初始化过了，请直接用姓名和 PIN 登录');
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    const pin = normPin(body.pin);
    if (!name) return fail(res, 400, '请填写姓名');
    const pe = pinError(pin);
    if (pe) return fail(res, 400, pe);
    const id = 'p_' + Math.random().toString(36).slice(2, 10);
    store.raw().prepare(
      "INSERT INTO profiles (id, name, phone, role, color, pin_hash, active, user_id) VALUES (?,?,?,?,?,?,1,?)"
    ).run(id, name, String(body.phone || '').trim() || null, 'admin', '#2b6ef6', auth.hashPin(pin), id);
    const prof = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(id);
    log('初始化完成，管理员：' + name);
    return send(res, 200, { token: auth.issue(prof), user: publicProfile(prof) });
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    if (tooMany(ip)) return fail(res, 429, '尝试次数过多，请 1 分钟后再试');
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    const pin = normPin(body.pin);
    if (!name || !pin) return fail(res, 400, '请输入姓名和 PIN');
    const row = store.raw().prepare('SELECT * FROM profiles WHERE lower(name) = lower(?)').get(name);
    if (!row || row.active === 0 || !auth.verifyPin(pin, row.pin_hash)) {
      markFail(ip);
      return fail(res, 401, '姓名或 PIN 不对。忘记 PIN 可让统筹在「设置 → 人员」里重设');
    }
    attempts.delete(ip);
    if (!row.user_id) store.raw().prepare('UPDATE profiles SET user_id = id WHERE id = ?').run(row.id);
    return send(res, 200, { token: auth.issue(row), user: publicProfile(row) });
  }

  if (pathname === '/api/auth/me') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    const row = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(actor.id);
    return send(res, 200, { user: publicProfile(row) });
  }

  if (pathname === '/api/auth/pin' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    const body = await readBody(req);
    const row = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(actor.id);
    if (!auth.verifyPin(normPin(body.oldPin), row.pin_hash)) return fail(res, 400, '原 PIN 不对');
    const newPin = normPin(body.newPin);
    const pe = pinError(newPin);
    if (pe) return fail(res, 400, pe);
    if (newPin === normPin(body.oldPin)) return fail(res, 400, '新 PIN 和原 PIN 一样');
    store.raw().prepare('UPDATE profiles SET pin_hash = ? WHERE id = ?').run(auth.hashPin(newPin), actor.id);
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/auth/logout') return send(res, 200, { ok: true });

  if (pathname === '/api/db' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '登录已过期，请重新登录');
    const body = await readBody(req);
    if (body && body.values && body.values.pin != null && body.values.pin !== '') {
      const p = normPin(body.values.pin);
      const pe = pinError(p);
      if (pe) return fail(res, 400, pe);
      body.values.pin_hash = auth.hashPin(p);
    }
    const result = store.run(actor, body);
    return send(res, 200, result);
  }

  if (pathname === '/api/jobs/run' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor || actor.role !== 'admin') return fail(res, 403, '只有统筹能手动触发');
    const n = await jobs.runReminders();
    const d = await jobs.runDigest();
    return send(res, 200, { reminders: n, digest: d });
  }

  return fail(res, 404, '接口不存在：' + pathname);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  for (const p of STRIP) if (rel.startsWith(p)) { rel = rel.slice(p.length) || '/'; break; }
  if (rel === '/' || rel === '') rel = '/index.html';
  // 只允许访问前端产物，服务端源码不对外
  if (rel.startsWith('/server/') || rel.startsWith('/.git') || rel.startsWith('/data/')) return fail(res, 404, 'Not found');

  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) return fail(res, 403, 'Forbidden');

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // 前端是单页应用，未知路径回落到首页
      if (!path.extname(rel)) return serveFile(req, res, path.join(ROOT, 'index.html'));
      return fail(res, 404, 'Not found');
    }
    serveFile(req, res, file, st);
  });
}

function serveFile(req, res, file, stat) {
  const ext = path.extname(file).toLowerCase();
  const etag = 'W/"' + (stat ? stat.size : 0) + '-' + (stat ? Number(stat.mtimeMs) : 0) + '"';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    return res.end();
  }
  const isHtml = ext === '.html';
  fs.readFile(file, (err, buf) => {
    if (err) return fail(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=300',
      ETag: etag
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let pathname = url.pathname;
  for (const p of STRIP) if (pathname.startsWith(p)) { pathname = pathname.slice(p.length) || '/'; break; }

  if (ACCESS_LOG) {
    const started = Date.now();
    res.on('finish', () => {
      const via = req.headers['x-forwarded-proto'] ? ' via=' + req.headers['x-forwarded-proto'] : '';
      log(req.method + ' ' + pathname + ' → ' + res.statusCode + ' ' + (Date.now() - started) + 'ms  host=' + (req.headers.host || '-') + via);
    });
  }

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch(err => {
      const code = err.status || 500;
      if (code >= 500) log('接口出错：' + (err.stack || err.message));
      fail(res, code, err.message || '服务端出错');
    });
    return;
  }
  serveStatic(req, res, pathname);
});

store.open();
server.listen(PORT, HOST, () => {
  log('速派已启动 v' + VERSION + ' → 监听 ' + HOST + ':' + PORT);
  log('数据目录：' + store.DATA_DIR);
  // 把局域网地址直接打出来，装完在日志里就能看到该用哪个地址打开
  const lan = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) lan.push(ni.address);
  }
  if (lan.length) log('浏览器打开：' + lan.map(a => 'http://' + a + ':' + PORT + '/').join('  或  '));
  jobs.start(log);
});

const shutdown = sig => {
  log('收到 ' + sig + '，正在退出');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
