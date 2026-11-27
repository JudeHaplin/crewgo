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
const crypto = require('node:crypto');
const store = require('./store');
const auth = require('./auth');
const sessions = require('./sessions');
const jobs = require('./jobs');
const mailer = require('./mailer');
const team = require('./team');
const wechat = require('./wechat');
const backup = require('./backup');
const autobackup = require('./autobackup');
const schedule = require('./schedule');

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

/* ---------- 预约附件 ---------- */
// 文件本体落在 DATA_DIR/files/<team_id>/ 下，库里只存元数据；不进静态目录，必须带令牌才给下载
const FILES_DIR = path.join(store.DATA_DIR, 'files');
const ATTACH_MAX = 20 * 1024 * 1024;
const INLINE_MIME = /^(image\/|application\/pdf$|text\/plain$)/;

/** 预约单被删掉时，把它的附件行和磁盘文件一起清掉，别留垃圾 */
function dropAttachmentsOf(ids, teamId) {
  if (!ids || !ids.length || !teamId) return 0;
  const marks = ids.map(() => '?').join(',');
  const rows = store.raw().prepare(
    'SELECT * FROM attachments WHERE team_id = ? AND appointment_id IN (' + marks + ')'
  ).all(teamId, ...ids);
  for (const r of rows) {
    try { fs.unlinkSync(path.join(FILES_DIR, String(r.team_id), path.basename(r.store_name))); } catch (e) { /* ignore */ }
  }
  store.raw().prepare('DELETE FROM attachments WHERE team_id = ? AND appointment_id IN (' + marks + ')').run(teamId, ...ids);
  return rows.length;
}

/**
 * 把库里存的时间读成毫秒时间戳。
 * 新数据存的是 JS 算出来的毫秒数（不受时区影响）；老数据是
 * SQLite datetime() 的 'YYYY-MM-DD HH:MM:SS' 字符串，按本地时间解释。
 * 之所以不直接用 SQL 的 localtime：容器里 SQLite 的 localtime 和 Node 的本地时间
 * 可能不是同一个时区（alpine 没装 tzdata 时差 8 小时），混用会让验证码「一发出就过期」。
 */
function timeMs(v) {
  if (v === null || v === undefined || v === '') return NaN;
  const s = String(v).trim();
  if (/^\d{13}$/.test(s)) return Number(s);            // 毫秒
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;      // 秒
  return new Date(s.replace(' ', 'T')).getTime();       // 老的本地时间字符串
}

/* ---------- 密码规则：字母/数字/符号都可以，6–64 位（与前端一致） ---------- */
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 64;
/** 去掉首尾空格（中间空格属于密码的一部分，保留），避免手机键盘尾随空格导致登录失败 */
const normPassword = v => String(v === null || v === undefined ? '' : v).trim();
function passwordError(pw) {
  if (pw.length < PASSWORD_MIN) return '密码至少 ' + PASSWORD_MIN + ' 位';
  if (pw.length > PASSWORD_MAX) return '密码最多 ' + PASSWORD_MAX + ' 位（字母、数字、符号都可以）';
  return '';
}

function send(res, code, payload) {
  const buf = Buffer.from(JSON.stringify(payload));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  });
  res.end(buf);
}

function sendFile(res, code, buf, type, filename) {
  const head = {
    'Content-Type': type || 'application/octet-stream',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  };
  if (filename) head['Content-Disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(filename);
  res.writeHead(code, head);
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

function readRaw(req, limit) {
  const max = limit || 64 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > max) {
        reject(new Error('文件太大，单个最多 ' + Math.round(max / 1024 / 1024) + 'MB'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
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

/* 邮箱打码：露前两位 + 域名，既能让本人确认「发到哪个邮箱」，又不当众泄露完整地址 */
function maskEmail(e) {
  const s = String(e || '');
  const at = s.indexOf('@');
  if (at <= 0) return '***';
  const head = s.slice(0, at);
  return (head.length <= 2 ? head.slice(0, 1) : head.slice(0, 2)) + '***' + s.slice(at);
}
/* 找回密码：同一个人 60 秒内只能发一封，别被当成骚扰邮件源。
   必须是模块级——放在 handleApi 里会随每次请求重建，限流等于没有。 */
const recoverAt = new Map();

function actorFrom(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  return actorFromToken(token);
}

/** 附件要能被 <img src> / 下载链接直接打开，那种请求带不了 Authorization 头，
 *  所以允许用 ?t=<token> 传令牌（登录令牌本来就存在前端 localStorage 里） */
function actorFromToken(token) {
  const payload = auth.verify(String(token || ''));
  if (!payload) return null;
  const row = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(payload.pid);
  if (!row || row.active === 0) return null;
  // 令牌版本对不上 = 改过密码（或在别处退出了所有设备），这份旧令牌作废
  if (Number(payload.tv || 0) !== Number(row.token_version || 0)) return null;
  // 带 sid 的令牌还要看会话有没有被撤掉；升级前签发的令牌没有 sid，靠版本号兜底
  if (payload.sid) {
    if (!sessions.get(payload.sid)) return null;
    sessions.touch(payload.sid);
  }
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    teamId: row.team_id ? Number(row.team_id) : null,
    teamRole: row.team_role || 'member',
    needProfile: row.need_profile === 1,
    sid: payload.sid || null
  };
}

const wxBound = id => !!store.raw().prepare('SELECT 1 AS x FROM wx_accounts WHERE profile_id = ? LIMIT 1').get(id);

// 测试邮件限流：同一个人 60 秒内只能发一封，免得连点把发信额度刷完
const mailTestAt = new Map();
// 手动备份限流：同一个团队 30 秒一次，避免连点把邮箱额度刷爆
const backupRunAt = new Map();

const publicProfile = row => ({
  id: row.id,
  username: row.username || null, // 登录凭证，全局唯一、设定后不可更改
  code: row.code || null,         // 8 位用户 ID：只用于记录与显示，不用于登录
  name: row.name,                 // 姓名：同事在派单、排期、通知里看到的就是它
  role: row.role,
  email: row.email,
  email_pending: row.email_pending || null,
  email_verified: !!row.email_verified_at,
  email_verified_at: row.email_verified_at || null,
  phone: row.phone,
  color: row.color,
  avatar: row.avatar || null,
  push_token: row.push_token || null,
  team_id: row.team_id ? Number(row.team_id) : null,
  team_role: row.team_role || 'member',
  need_profile: row.need_profile === 1,
  wx_bound: wxBound(row.id)
});

/** 微信配置存在 team_id 为 NULL 的全局 settings 行里 */
function globalSettings() {
  const row = store.raw().prepare('SELECT * FROM settings WHERE team_id IS NULL ORDER BY id LIMIT 1').get();
  if (row) return row;
  try {
    store.raw().prepare('INSERT INTO settings (team_id) VALUES (NULL)').run();
  } catch (e) { /* 已有全局行 */ }
  return store.raw().prepare('SELECT * FROM settings WHERE team_id IS NULL ORDER BY id LIMIT 1').get() || {};
}

/** 从请求头还原对外的站点地址（反代后也能拿到 https + 真实域名） */
function baseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return proto + '://' + host;
}
const redirectUri = req => baseUrl(req).replace(/\/+$/, '') + '/api/auth/wechat/callback';

/** 一次性 ticket → token（微信授权回来时用，避免 token 出现在地址栏） */
/**
 * 签发令牌。keepSid 传当前会话 id 表示「就用这台设备原来的会话」——
 * 补资料、加入团队这类操作不该在设备列表里多出一条新记录。
 */
function sessionOf(row, req, keepSid) {
  const t = team.teamById(row.team_id);
  let sid = keepSid && sessions.get(keepSid) ? keepSid : null;
  if (!sid) sid = keepSid ? sessions.create(row.id, req) : sessions.createOrReuse(row.id, req);
  return {
    token: auth.issue(row, sid),
    device: sid,
    user: publicProfile(row),
    team: team.publicTeam(t),
    pending: row.team_id ? null : team.myRequest(row.id),
    mail: { ready: !!row.team_id && mailer.configured(row.team_id) }
  };
}

/* ---------- 路由 ---------- */
async function handleApi(req, res, pathname, url) {
  const ip = req.socket.remoteAddress || 'unknown';
  const gs = () => globalSettings();

  if (pathname === '/api/health') {
    return send(res, 200, { ok: true, version: VERSION, time: new Date().toISOString() });
  }

  if (pathname === '/api/auth/status') {
    const row = store.raw().prepare('SELECT COUNT(*) AS n FROM profiles').get();
    return send(res, 200, { initialized: Number(row.n) > 0, wechat: wechat.publicCfg(gs()), version: VERSION });
  }

  /* 首次初始化：建账号 + 建团队（创建人 = 统筹管理员） */
  if (pathname === '/api/auth/setup' && req.method === 'POST') {
    const row = store.raw().prepare('SELECT COUNT(*) AS n FROM profiles').get();
    if (Number(row.n) > 0) return fail(res, 409, '系统已经初始化过了，请直接登录，或用团队码加入');
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    // 用户名是登录凭证；老页面只传 name 时用它兼任用户名（升级与老缓存都还能用）
    const username = String(body.username || name).trim();
    // 前端历史上传 pin，现在传 password；两个都收，老缓存页面也还能用
    const password = normPassword(body.password != null ? body.password : body.pin);
    if (!name) return fail(res, 400, '请填写姓名');
    const ue = store.usernameError(username);
    if (ue) return fail(res, 400, ue);
    if (store.raw().prepare('SELECT 1 AS x FROM profiles WHERE lower(username) = lower(?)').get(username)) {
      return fail(res, 409, '这个用户名已经被用了，换一个');
    }
    const pe = passwordError(password);
    if (pe) return fail(res, 400, pe);
    const phoneRaw = String(body.phone || '').trim();
    if (phoneRaw) {
      const phe = store.phoneError(phoneRaw);
      if (phe) return fail(res, 400, phe);
    }
    const id = 'p_' + Math.random().toString(36).slice(2, 10);
    store.raw().prepare(
      "INSERT INTO profiles (id, username, name, code, phone, role, color, pin_hash, active, user_id) VALUES (?,?,?,?,?,?,?,?,1,?)"
    ).run(id, username, name, store.newMemberCode(), phoneRaw ? store.normPhone(phoneRaw) : null, 'admin', '#2b6ef6', auth.hashPin(password), id);
    const prof = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(id);
    const created = team.createTeam(prof, String(body.teamName || '').trim() || (name + '的团队'));
    log('初始化完成：' + name + '（用户名 ' + username + '，ID ' + prof.code + '），团队「' + created.team.name + '」码 ' + created.code);
    const fresh = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(id);
    return send(res, 200, sessionOf(fresh, req));
  }

  /* 注册验证码：还没建号，所以不需要登录；发到填的邮箱，注册时带回来校验 */
  if (pathname === '/api/auth/register/code' && req.method === 'POST') {
    if (tooMany(ip)) return fail(res, 429, '尝试次数过多，请 1 分钟后再试');
    const body = await readBody(req);
    const email = String(body.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(res, 400, '邮箱格式不对：' + (email || '（空）'));
    const key = email.toLowerCase();
    const rec = store.raw().prepare('SELECT * FROM signup_codes WHERE email = ?').get(key);
    if (rec) {
      const age = Date.now() - timeMs(rec.sent_at);
      if (age >= 0 && age < 60 * 1000) {
        return fail(res, 429, '刚发过一封，' + Math.ceil((60 * 1000 - age) / 1000) + ' 秒后可以再发');
      }
    }
    const code = String(crypto.randomInt(100000, 1000000));
    const sent = await mailer.sendAny({
      to: email,
      toName: '',
      owner: 'signup',
      kind: 'signup',
      subject: '【速派】注册验证码 ' + code + '（10 分钟内有效）',
      html: '<div style="font-family:-apple-system,Segoe UI,PingFang SC,sans-serif;font-size:14px;line-height:1.9;color:#111827">' +
        '<p>你好，这是你在「速派」注册账号的验证码，<b>10 分钟内有效</b>：</p>' +
        '<p style="font-size:30px;font-weight:700;letter-spacing:6px;color:#2b6ef6;margin:14px 0"><b>' + code + '</b></p>' +
        '<p style="color:#6b7280;font-size:13px">如果这不是你本人操作，忽略这封邮件即可，不会有账号被创建。</p></div>'
    });
    if (!sent.ok) {
      return fail(res, 502, '验证码没发出去：' + (sent.error || '未知原因') +
        '。让管理员先在「设置 → 通知 → 邮箱服务」里配一个发信邮箱。');
    }
    store.raw().prepare(
      'INSERT INTO signup_codes (email, code, exp, tries, sent_at) VALUES (?,?,?,0,?) ' +
      'ON CONFLICT(email) DO UPDATE SET code = excluded.code, exp = excluded.exp, tries = 0, sent_at = excluded.sent_at'
    ).run(key, code, String(Date.now() + 10 * 60 * 1000), String(Date.now()));
    log('注册验证码已发送（' + maskEmail(email) + '）');
    return send(res, 200, { ok: true, ttl: 600 });
  }

  /* 自助注册：此时还看不到任何团队数据，要凭团队码申请并被同意 */
  if (pathname === '/api/auth/register' && req.method === 'POST') {
    if (tooMany(ip)) return fail(res, 429, '尝试次数过多，请 1 分钟后再试');
    const body = await readBody(req);
    const username = String(body.username || '').trim() || String(body.name || '').trim();
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim();
    const mailCode = String(body.code || '').replace(/\s/g, '');
    const password = normPassword(body.password != null ? body.password : body.pin);
    const ue = store.usernameError(username);
    if (ue) return fail(res, 400, ue);
    if (!name) return fail(res, 400, '请填写姓名');
    if (name.length > 20) return fail(res, 400, '姓名最多 20 个字');
    const pe = passwordError(password);
    if (pe) return fail(res, 400, pe);
    const phoneRaw = String(body.phone || '').trim();
    if (phoneRaw) {
      const phe = store.phoneError(phoneRaw);
      if (phe) return fail(res, 400, phe);
    }
    // 用户名就是登录凭证，全局唯一（大小写不敏感）
    if (store.raw().prepare('SELECT 1 AS x FROM profiles WHERE lower(username) = lower(?)').get(username)) {
      return fail(res, 409, '这个用户名已经被用了，换一个');
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(res, 400, '邮箱格式不对：' + email);

    // 注册要验证邮箱。系统一个可用发信账号都没有时（刚装好还没配）降级为不强制，
    // 否则第一个注册的人根本进不来；配好发信邮箱后一律强制。
    const wantVerify = !!mailer.anyTeam();
    if (wantVerify) {
      if (!email) return fail(res, 400, '请填写邮箱，注册要收验证码');
      if (!/^\d{6}$/.test(mailCode)) return fail(res, 400, '请填写邮箱收到的 6 位验证码');
      const rec = store.raw().prepare('SELECT * FROM signup_codes WHERE email = ?').get(email.toLowerCase());
      if (!rec) return fail(res, 400, '还没有给这个邮箱发过验证码');
      if (!(timeMs(rec.exp) > Date.now())) return fail(res, 400, '验证码过期了，重新发一次');
      if (Number(rec.tries || 0) >= 5) return fail(res, 429, '试错次数太多，重新发验证码');
      if (String(rec.code) !== mailCode) {
        store.raw().prepare('UPDATE signup_codes SET tries = tries + 1 WHERE email = ?').run(email.toLowerCase());
        markFail(ip);
        return fail(res, 400, '验证码不对');
      }
    }

    // 姓名不再唯一：同名的两个人各建各的账号、各拿一个 8 位 ID，数据互不相干。
    const id = team.newProfileId();
    const memberCode = store.newMemberCode();
    store.raw().exec('BEGIN');
    try {
      store.raw().prepare(
        "INSERT INTO profiles (id, username, name, code, phone, email, email_verified_at, role, color, pin_hash, active, user_id, team_role, need_profile) " +
        "VALUES (?,?,?,?,?,?,?,'tech','#2b6ef6',?,1,?,'member',0)"
      ).run(id, username, name, memberCode,
        phoneRaw ? store.normPhone(phoneRaw) : null,
        email || null,
        wantVerify ? store.localStamp() : null,
        auth.hashPin(password), id);
      if (wantVerify) store.raw().prepare('DELETE FROM signup_codes WHERE email = ?').run(email.toLowerCase());
      store.raw().exec('COMMIT');
    } catch (e) {
      store.raw().exec('ROLLBACK');
      throw e;
    }
    const row = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(id);
    log('新账号注册（待加入团队）：' + name + '（用户名 ' + username + '，ID ' + memberCode + '）');
    return send(res, 200, Object.assign(sessionOf(row, req), {
      registered: true, code: memberCode, username: username, email_verified: wantVerify
    }));
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    if (tooMany(ip)) return fail(res, 429, '尝试次数过多，请 1 分钟后再试');
    const body = await readBody(req);
    const ident = String(body.account || body.username || body.name || '').trim();
    const password = normPassword(body.password != null ? body.password : body.pin);
    if (!ident || !password) return fail(res, 400, '请输入用户名（或邮箱）和密码');
    // 用户名是唯一登录凭证（全局唯一，不会认错人）；也允许填邮箱
    let hit = null;
    if (ident.includes('@')) {
      const hits = team.findByEmail(ident).filter(r => auth.verifyPin(password, r.pin_hash));
      if (hits.length > 1) return fail(res, 409, '这个邮箱绑定了多个账号，请改用用户名登录');
      hit = hits[0] || null;
    } else {
      const row = team.findByUsername(ident);
      if (row && auth.verifyPin(password, row.pin_hash)) hit = row;
    }
    if (!hit) {
      markFail(ip);
      return fail(res, 401, '用户名/邮箱或密码不对。忘记密码可以在登录页点「忘记密码」用邮箱找回，或让管理员重设');
    }
    attempts.delete(ip);
    const patch = ["last_login_at = datetime('now','localtime')"];
    if (!hit.user_id) patch.push('user_id = id');
    store.raw().prepare('UPDATE profiles SET ' + patch.join(', ') + ' WHERE id = ?').run(hit.id);
    const fresh = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(hit.id);
    sessions.prune();
    return send(res, 200, sessionOf(fresh, req));
  }

  /* ---------------- 忘记密码：用已验证邮箱收验证码找回（无需登录） ---------------- */
  if (pathname === '/api/auth/recover/start' && req.method === 'POST') {
    if (tooMany(ip)) return fail(res, 429, '尝试次数过多，请 1 分钟后再试');
    const body = await readBody(req);
    const found = team.lookup(body.account);
    if (found.error) return fail(res, 404, found.error);
    const row = found.row;
    const left = 60 * 1000 - (Date.now() - (recoverAt.get(row.id) || 0));
    if (left > 0) return fail(res, 429, '刚发过一封，' + Math.ceil(left / 1000) + ' 秒后可以再发');
    if (!row.email || !row.email_verified_at) {
      return fail(res, 400, '这个账号还没绑定并验证邮箱，没法自己找回。让管理员在「设置 → 人员 → 编辑」里重设一个密码就行。');
    }
    // 还没入团的账号没有 team_id，就从任意一个配好发信账号的团队发
    const mailTeam = row.team_id || mailer.anyTeam();
    if (!mailTeam) {
      return fail(res, 400, '系统还没配发信邮箱，验证码发不出去。让统筹管理员去「设置 → 通知 → 邮箱服务」配一个。');
    }
    const code = String(crypto.randomInt(100000, 1000000));
    const nm = String(row.name || '').replace(/[<>&"]/g, '');
    const sendRes = await mailer.send(mailTeam, {
      to: row.email,
      toName: row.name || '',
      owner: row.id,
      kind: 'reset',
      subject: '【速派】找回密码验证码 ' + code + '（10 分钟内有效）',
      html: '<div style="font-family:-apple-system,Segoe UI,PingFang SC,sans-serif;font-size:14px;line-height:1.9;color:#111827">' +
        '<p>' + nm + '，你好：</p>' +
        '<p>有人在「速派」用你的账号（用户名 <b>' + String(row.username || '—').replace(/[<>&"]/g, '') + '</b>）申请重设密码，验证码 <b>10 分钟内有效</b>：</p>' +
        '<p style="font-size:30px;font-weight:700;letter-spacing:6px;color:#2b6ef6;margin:14px 0"><b>' + code + '</b></p>' +
        '<p style="color:#6b7280;font-size:13px">重设后，其它设备上的登录会全部失效，需要用新密码重新登录。如果不是你本人操作，忽略这封邮件即可，密码不会变。</p></div>'
    });
    if (!sendRes.ok) return fail(res, 502, '验证码没发出去：' + (sendRes.error || '未知原因'));
    store.raw().prepare(
      'UPDATE profiles SET reset_code = ?, reset_code_exp = ?, reset_code_tries = 0, reset_code_sent_at = ? WHERE id = ?'
    ).run(code, String(Date.now() + 10 * 60 * 1000), String(Date.now()), row.id);
    recoverAt.set(row.id, Date.now());
    log('找回密码验证码已发送（' + row.name + ' → ' + maskEmail(row.email) + '）');
    return send(res, 200, { ok: true, account: row.code || null, name: row.name, email: maskEmail(row.email), ttl: 600 });
  }

  if (pathname === '/api/auth/recover/verify' && req.method === 'POST') {
    if (tooMany(ip)) return fail(res, 429, '尝试次数过多，请 1 分钟后再试');
    const body = await readBody(req);
    const found = team.lookup(body.account);
    if (found.error) return fail(res, 400, found.error);
    const row = found.row;
    const code = String(body.code || '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(code)) return fail(res, 400, '验证码是 6 位数字');
    const pass = normPassword(body.password != null ? body.password : body.pin);
    const pe = passwordError(pass);
    if (pe) return fail(res, 400, pe);
    if (!row.reset_code || !row.reset_code_exp) return fail(res, 400, '还没有发过验证码，先点「发送验证码」');
    if (Number(row.reset_code_tries || 0) >= 5) return fail(res, 429, '试错次数太多，请重新发送验证码');
    if (!(timeMs(row.reset_code_exp) > Date.now())) return fail(res, 400, '验证码已过期，请重新发送');
    if (String(row.reset_code) !== code) {
      store.raw().prepare('UPDATE profiles SET reset_code_tries = IFNULL(reset_code_tries,0) + 1 WHERE id = ?').run(row.id);
      markFail(ip);
      const leftTries = 4 - Number(row.reset_code_tries || 0);
      return fail(res, 400, '验证码不对' + (leftTries > 0 ? '，还能再试 ' + leftTries + ' 次' : '，请重新发送'));
    }
    store.raw().prepare(
      'UPDATE profiles SET pin_hash = ?, reset_code = NULL, reset_code_exp = NULL, reset_code_tries = 0, reset_code_sent_at = NULL WHERE id = ?'
    ).run(auth.hashPin(pass), row.id);
    // 密码换了，之前登录着的所有设备一律失效（和「我的资料」里改密码一致）
    sessions.invalidateAll(row.id);
    recoverAt.delete(row.id);
    attempts.delete(ip);
    log('找回密码成功：' + row.name + '（ID ' + (row.code || '—') + '）');
    return send(res, 200, { ok: true, account: row.code || null, name: row.name });
  }

  if (pathname === '/api/auth/me') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    const row = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(actor.id);
    const t = team.teamById(row.team_id);
    return send(res, 200, {
      user: publicProfile(row),
      team: t ? Object.assign(team.publicTeam(t), { stats: team.stats(t.id) }) : null,
      pending: row.team_id ? null : team.myRequest(row.id),
      // 前端据此决定要不要显示「发派单邮件」这类按钮（配没配发信账号，服务端最清楚）
      mail: { ready: !!row.team_id && mailer.configured(row.team_id) },
      wechat: wechat.publicCfg(gs())
    });
  }

  /* 补全资料：微信注册的账号必须填姓名和手机号才能继续 */
  if (pathname === '/api/auth/profile' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    const phone = String(body.phone || '').trim();
    if (!name) return fail(res, 400, '请填写姓名');
    if (name.length > 20) return fail(res, 400, '姓名最多 20 个字');
    const phe = store.phoneError(phone);
    if (phe) return fail(res, 400, phe);
    const row = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(actor.id);
    // 姓名不再唯一：重名的人各有一个 8 位 ID，同名时登录改用 ID 区分即可，
    // 不该因为团队里有同名同事就挡住本人改姓名/手机号（否则改个电话都报 409）。
    store.raw().prepare('UPDATE profiles SET name = ?, phone = ?, need_profile = 0 WHERE id = ?')
      .run(name, store.normPhone(phone), row.id);
    const fresh = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(row.id);
    return send(res, 200, sessionOf(fresh, req, actor.sid));
  }

  /* 改密码：成功后 token_version +1，除了当前这台，其它设备上的令牌立刻作废 */
  if ((pathname === '/api/auth/password' || pathname === '/api/auth/pin') && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    const body = await readBody(req);
    const oldPw = normPassword(body.oldPassword != null ? body.oldPassword : body.oldPin);
    const newPw = normPassword(body.newPassword != null ? body.newPassword : body.newPin);
    const row = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(actor.id);
    if (row.pin_hash && !auth.verifyPin(oldPw, row.pin_hash)) return fail(res, 400, '原密码不对');
    const pe = passwordError(newPw);
    if (pe) return fail(res, 400, pe);
    if (newPw === oldPw) return fail(res, 400, '新密码和原密码一样，换一个吧');
    store.raw().prepare('UPDATE profiles SET pin_hash = ? WHERE id = ?').run(auth.hashPin(newPw), actor.id);
    // 版本号 +1 并清空全部会话：其它手机、电脑上的登录全部失效
    sessions.invalidateAll(actor.id);
    const fresh = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(actor.id);
    log(actor.name + ' 修改了登录密码，其它设备已退出');
    // 当前这台换个新会话继续用，不用重新登录
    return send(res, 200, Object.assign(sessionOf(fresh, req), { kicked: true }));
  }

  /* 退出登录：只撤掉当前这台设备，别处登录的不管 */
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (actor && actor.sid) sessions.revoke(actor.id, actor.sid);
    return send(res, 200, { ok: true });
  }

  /* ---------------- 登录设备 ---------------- */
  if (pathname === '/api/auth/devices' && req.method === 'GET') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    const rows = sessions.listOf(actor.id);
    return send(res, 200, {
      devices: rows.map(d => Object.assign({}, d, { current: d.id === actor.sid })),
      // 老令牌（1.2.16 以前签发的）没有会话 id，前端据此提示「重新登录一次就能被管理」
      legacy: !actor.sid
    });
  }

  if (pathname === '/api/auth/devices/revoke' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    const body = await readBody(req);
    const id = String(body.id || '');
    if (!id) return fail(res, 400, '缺少设备 id');
    if (id === actor.sid) return fail(res, 400, '这是当前设备，直接点「退出登录」就行');
    if (!sessions.revoke(actor.id, id)) return fail(res, 404, '这台设备已经下线了');
    return send(res, 200, { ok: true });
  }

  /* 其它设备全部下线；all=true 时连当前这台一起（需要重新登录） */
  if (pathname === '/api/auth/devices/revoke-others' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    const body = await readBody(req);
    if (body.all === true) {
      sessions.invalidateAll(actor.id);
      log(actor.name + ' 退出了所有设备');
      return send(res, 200, { ok: true, all: true });
    }
    const n = sessions.revokeAll(actor.id, actor.sid);
    return send(res, 200, { ok: true, revoked: n });
  }

  /* ---------------- 微信登录 ---------------- */
  if (pathname === '/api/auth/wechat/url') {
    const mode = url.searchParams.get('mode') === 'mp' ? 'mp' : 'qr';
    const cfg = wechat.cfgOf(gs())[mode];
    if (!cfg.appid || !cfg.secret) {
      return fail(res, 400, mode === 'mp'
        ? '还没配置公众号登录：设置 → 登录方式，填公众号 AppID / AppSecret'
        : '还没配置扫码登录：设置 → 登录方式，填开放平台网站应用 AppID / AppSecret');
    }
    const bind = url.searchParams.get('bind') === '1';
    if (bind) {
      const actor = actorFrom(req);
      if (!actor) return fail(res, 401, '请先登录再绑定微信');
    }
    const actor = bind ? actorFrom(req) : null;
    const state = wechat.makeState({ mode, app: mode, bind: bind, pid: actor ? actor.id : null, iat: Date.now() });
    return send(res, 200, { url: wechat.buildUrl(mode, cfg.appid, redirectUri(req), state), mode });
  }

  if (pathname === '/api/auth/wechat/callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const st = wechat.readState(state);
    const back = baseUrl(req) + '/';
    if (!st) return redirect(res, back + '?wx_error=' + encodeURIComponent('登录状态已过期，请重新扫码'));
    if (!code) return redirect(res, back + '?wx_error=' + encodeURIComponent('没有拿到微信授权码'));
    const cfg = wechat.cfgOf(gs())[st.app] || {};
    if (!cfg.appid || !cfg.secret) return redirect(res, back + '?wx_error=' + encodeURIComponent('微信登录未配置'));
    let info;
    try {
      info = await wechat.exchange(st.app, cfg.appid, cfg.secret, code);
    } catch (e) {
      return redirect(res, back + '?wx_error=' + encodeURIComponent(e.message || '微信授权失败'));
    }

    let profile = null;
    try {
      if (st.bind) {
        profile = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(st.pid);
        if (!profile) throw new Error('账号不存在，请重新登录');
        const other = store.raw().prepare('SELECT * FROM wx_accounts WHERE app = ? AND openid = ?').get(st.app, info.openid);
        if (other && other.profile_id !== profile.id) throw new Error('这个微信已经绑定到别的账号了，请先用那个账号解绑');
        store.raw().prepare('DELETE FROM wx_accounts WHERE app = ? AND openid = ?').run(st.app, info.openid);
        store.raw().prepare('INSERT INTO wx_accounts (app, openid, unionid, profile_id, nickname, avatar) VALUES (?,?,?,?,?,?)')
          .run(st.app, info.openid, info.unionid, profile.id, info.nickname, info.avatar);
        if (info.avatar && !profile.avatar) {
          store.raw().prepare('UPDATE profiles SET avatar = ? WHERE id = ?').run(info.avatar, profile.id);
        }
        const t = wechat.issueTicket({ pid: profile.id, bind: true });
        return redirect(res, back + '?wx_bind=' + encodeURIComponent(t));
      }

      // 1) 先按 unionid 找（公众号和扫码两个 AppID 下的 openid 不同，unionid 相同）
      let pid = null;
      if (info.unionid) {
        const hit = store.raw().prepare('SELECT profile_id FROM wx_accounts WHERE unionid = ? LIMIT 1').get(info.unionid);
        if (hit) pid = hit.profile_id;
      }
      // 2) 再按 app + openid 找
      if (!pid) {
        const hit = store.raw().prepare('SELECT profile_id FROM wx_accounts WHERE app = ? AND openid = ?').get(st.app, info.openid);
        if (hit) pid = hit.profile_id;
      }
      if (pid) {
        profile = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(pid);
      }
      if (!profile) {
        // 3) 第一次来：建一个「待完善」账号，登录后强制填姓名和手机号
        const id = team.newProfileId();
        const colors = ['#2b6ef6', '#e5484d', '#0f9d76', '#f59e0b', '#6d4aff', '#0891b2'];
        // 微信新用户还没填姓名，先给一个自动用户名（之后在「我的资料」能看到）
        let uname;
        do { uname = 'wx' + String(crypto.randomInt(10000000, 100000000)); }
        while (store.raw().prepare('SELECT 1 AS x FROM profiles WHERE lower(username) = lower(?)').get(uname));
        store.raw().prepare(
          "INSERT INTO profiles (id, username, name, code, phone, role, color, avatar, active, user_id, team_role, need_profile) VALUES (?,?,?,?,?,?,?,?,1,?,'member',1)"
        ).run(id, uname, '', store.newMemberCode(), null, 'tech', colors[Math.floor(Math.random() * colors.length)], info.avatar || null, id);
        profile = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(id);
        log('微信新用户：' + (info.nickname || info.openid) + '（待完善资料）');
      }
      // 补一条 openid 记录（同一微信换入口也能认回来）
      const exists = store.raw().prepare('SELECT id FROM wx_accounts WHERE app = ? AND openid = ?').get(st.app, info.openid);
      if (!exists) {
        store.raw().prepare('INSERT INTO wx_accounts (app, openid, unionid, profile_id, nickname, avatar) VALUES (?,?,?,?,?,?)')
          .run(st.app, info.openid, info.unionid, profile.id, info.nickname, info.avatar);
      } else {
        store.raw().prepare('UPDATE wx_accounts SET unionid = COALESCE(?, unionid), profile_id = ?, nickname = COALESCE(?, nickname) WHERE id = ?')
          .run(info.unionid, profile.id, info.nickname, exists.id);
      }
      store.raw().prepare("UPDATE profiles SET last_login_at = datetime('now','localtime') WHERE id = ?").run(profile.id);
      const ticket = wechat.issueTicket({ pid: profile.id });
      return redirect(res, back + '?wx_ticket=' + encodeURIComponent(ticket));
    } catch (e) {
      return redirect(res, back + '?wx_error=' + encodeURIComponent(e.message || '微信登录失败'));
    }
  }

  if (pathname === '/api/auth/wechat/ticket' && req.method === 'POST') {
    const body = await readBody(req);
    const t = wechat.consumeTicket(body.ticket);
    if (!t) return fail(res, 400, '登录票据已过期，请重新扫码');
    const row = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(t.pid);
    if (!row) return fail(res, 400, '账号不存在');
    if (t.bind) return send(res, 200, { bind: true, user: publicProfile(row) });
    return send(res, 200, sessionOf(row, req));
  }

  if (pathname === '/api/auth/wechat/unbind' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    store.raw().prepare('DELETE FROM wx_accounts WHERE profile_id = ?').run(actor.id);
    return send(res, 200, { ok: true });
  }

  /* ---------------- 团队 ---------------- */
  if (pathname === '/api/team' && req.method === 'GET') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    const t = team.teamById(actor.teamId);
    if (!t) {
      const row = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(actor.id);
      return send(res, 200, { team: null, pending: team.myRequest(actor.id), need_profile: row.need_profile === 1 });
    }
    return send(res, 200, {
      team: Object.assign(team.publicTeam(t), { stats: team.stats(t.id) }),
      my_role: actor.teamRole
    });
  }

  if (pathname === '/api/team/create' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    const body = await readBody(req);
    const row = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(actor.id);
    if (row.need_profile === 1) return fail(res, 400, '请先填写姓名和手机号');
    const created = team.createTeam(row, body.name);
    log('新团队：' + created.team.name + ' 码 ' + created.code + '（创建人 ' + row.name + '）');
    const fresh = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(actor.id);
    return send(res, 200, sessionOf(fresh, req, actor.sid));
  }

  if (pathname === '/api/team/join' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    const body = await readBody(req);
    const row = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(actor.id);
    if (row.need_profile === 1) return fail(res, 400, '请先填写姓名和手机号');
    const r = team.joinByCode(row, body.code, body.message);
    if (r.joined) {
      const fresh = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(actor.id);
      return send(res, 200, Object.assign(sessionOf(fresh, req, actor.sid), { joined: true }));
    }
    return send(res, 200, { joined: false, pending: true, team: r.team });
  }

  if (pathname === '/api/team/cancel' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    const row = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(actor.id);
    team.cancelRequest(row);
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/team/requests') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    return send(res, 200, { data: team.listRequests(actor) });
  }

  if (pathname === '/api/team/requests/decide' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    const body = await readBody(req);
    const r = team.decide(actor, body.id, !!body.approve);
    return send(res, 200, r);
  }

  if (pathname === '/api/team/members') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    return send(res, 200, { data: team.members(actor) });
  }

  if (pathname === '/api/team/members/role' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    const body = await readBody(req);
    return send(res, 200, team.setRole(actor, body.id, body.role));
  }

  if (pathname === '/api/team/members/remove' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    const body = await readBody(req);
    return send(res, 200, team.removeMember(actor, body.id));
  }

  if (pathname === '/api/team/members/migrate' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    const body = await readBody(req);
    return send(res, 200, team.migrateMember(actor, body.fromId, body.toId));
  }

  if (pathname === '/api/team/leave' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    team.leave(actor);
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/team/owner' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    const body = await readBody(req);
    return send(res, 200, team.transferOwner(actor, body.id, body.pin, body.confirm));
  }

  if (pathname === '/api/team/rename' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    const body = await readBody(req);
    return send(res, 200, team.rename(actor, body.name));
  }

  if (pathname === '/api/team/allow-direct' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    const body = await readBody(req);
    return send(res, 200, team.setAllowDirect(actor, !!body.allow));
  }

  if (pathname === '/api/team/code/reset' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    return send(res, 200, team.resetCode(actor));
  }

  if (pathname === '/api/team/dissolve' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    const body = await readBody(req);
    return send(res, 200, team.dissolve(actor, body.name));
  }

  /* ---------------- 微信登录配置（全局，只存服务端） ---------------- */
  if (pathname === '/api/settings/wechat' && req.method === 'GET') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    if (!store.isTeamAdmin(actor)) return fail(res, 403, '只有团队管理员能看');
    const s = gs();
    return send(res, 200, {
      wx_mp_appid: s.wx_mp_appid || '',
      wx_qr_appid: s.wx_qr_appid || '',
      wx_mp_secret_set: !!s.wx_mp_secret,
      wx_qr_secret_set: !!s.wx_qr_secret,
      enabled: wechat.publicCfg(s),
      callback: baseUrl(req) + '/api/auth/wechat/callback'
    });
  }

  if (pathname === '/api/settings/wechat' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    if (!store.isOwner(actor)) return fail(res, 403, '微信登录是整个站点共用的配置，只有统筹管理员能改');
    const body = await readBody(req);
    const s = gs();
    const patch = {
      wx_mp_appid: String(body.wx_mp_appid || '').trim() || null,
      wx_qr_appid: String(body.wx_qr_appid || '').trim() || null,
      wx_mp_secret: String(body.wx_mp_secret || '').trim() || s.wx_mp_secret || null,
      wx_qr_secret: String(body.wx_qr_secret || '').trim() || s.wx_qr_secret || null
    };
    store.raw().prepare('UPDATE settings SET wx_mp_appid = ?, wx_mp_secret = ?, wx_qr_appid = ?, wx_qr_secret = ? WHERE id = ?')
      .run(patch.wx_mp_appid, patch.wx_mp_secret, patch.wx_qr_appid, patch.wx_qr_secret, s.id);
    return send(res, 200, { ok: true, enabled: wechat.publicCfg(Object.assign({}, s, patch)) });
  }

  /* ---------------- 备份 / 导入 ---------------- */
  if (pathname === '/api/backup/export') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    if (!store.isOwner(actor)) return fail(res, 403, '导出会把整个团队的数据下载走，只有统筹管理员能操作');
    const fmt = url.searchParams.get('format') === 'db' ? 'db' : 'json';
    if (fmt === 'db') {
      if (!store.isOwner(actor)) return fail(res, 403, '整库文件包含所有团队的数据，只有统筹管理员能下载');
      const file = store.snapshot();
      const buf = fs.readFileSync(file);
      return sendFile(res, 200, buf, 'application/x-sqlite3', backup.exportFileName('db'));
    }
    const payload = backup.exportTeam(actor.teamId);
    const buf = Buffer.from(JSON.stringify(payload, null, 2));
    return sendFile(res, 200, buf, 'application/json; charset=utf-8', backup.exportFileName('json'));
  }

  if (pathname === '/api/backup/import' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    if (!store.isOwner(actor)) return fail(res, 403, '导入会改写/合并团队数据，只有统筹管理员能操作');
    const filename = String(url.searchParams.get('filename') || 'upload');
    const dry = url.searchParams.get('dry') === '1';

    // JSON/表格走内存解析（64MB 上限），数据库文件同理
    const buf = await readRaw(req, 64 * 1024 * 1024);
    if (!buf.length) return fail(res, 400, '没有收到文件');

    const isDb = /\.(db|sqlite|sqlite3)$/i.test(filename)
      || (buf.length > 16 && String(buf.slice(0, 15)) === 'SQLite format 3');
    if (isDb && !store.isOwner(actor)) return fail(res, 403, '恢复整库只有统筹管理员能操作');

    if (isDb) {
      if (dry) return send(res, 200, { kind: 'db', size: buf.length, requiresOwner: true, dry: true });
      const r = store.replaceDatabase(buf);
      log('整库恢复完成（操作人 ' + actor.name + '，备份 ' + path.basename(r.backup) + '）');
      return send(res, 200, { kind: 'db', restored: true, backup: path.basename(r.backup), relogin: true });
    }
    const report = backup.preview(actor, buf, filename, dry);
    if (!dry) log('导入 ' + filename + '（' + actor.name + '）：' + String(JSON.stringify(report)).slice(0, 220));
    return send(res, 200, report);
  }

  /* ---------------- 自动备份到邮箱 ---------------- */
  if (pathname === '/api/backup/auto' && req.method === 'GET') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    if (!store.isOwner(actor)) return fail(res, 403, '自动备份发的是整个团队的数据，只有统筹管理员能看');
    store.ensureTeamSettings(actor.teamId);
    const s = store.raw().prepare('SELECT * FROM settings WHERE team_id = ? ORDER BY id LIMIT 1').get(actor.teamId) || {};
    const accounts = mailer.accountsOf(actor.teamId);
    return send(res, 200, {
      enabled: Number(s.auto_backup) === 1,
      email: s.backup_email || '',
      hour: Number(s.backup_hour === null || s.backup_hour === undefined ? 3 : s.backup_hour),
      full: Number(s.backup_full) === 1,
      last_at: s.last_backup_at || '',
      last_note: s.last_backup_note || '',
      mail_ready: mailer.configured(actor.teamId),
      smtp_ready: accounts.some(a => a.kind === 'smtp' && a.enabled === 1 && mailer.ready(a)),
      max_mb: Math.round(autobackup.MAX_ATTACH / 1048576)
    });
  }

  if (pathname === '/api/backup/auto' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    if (!store.isOwner(actor)) return fail(res, 403, '自动备份发的是整个团队的数据，只有统筹管理员能设置');
    const body = await readBody(req);
    const enabled = !!body.enabled;
    const emails = autobackup.emailsOf(body.email);
    if (String(body.email || '').trim() && !emails.length) return fail(res, 400, '收件邮箱格式不对，多个用逗号隔开');
    if (enabled && !emails.length) return fail(res, 400, '请先填一个收件邮箱，否则定时备份发不出去');
    let hour = Number(body.hour);
    if (!Number.isFinite(hour)) hour = 3;
    hour = Math.max(0, Math.min(23, Math.round(hour)));
    store.ensureTeamSettings(actor.teamId);
    store.raw().prepare('UPDATE settings SET auto_backup = ?, backup_email = ?, backup_hour = ?, backup_full = ? WHERE team_id = ?')
      .run(enabled ? 1 : 0, emails.join(','), hour, body.full ? 1 : 0, actor.teamId);
    log('自动备份设置已更新（' + actor.name + '）：' + (enabled ? '每天 ' + hour + ':00 发到 ' + emails.join('、') : '已关闭'));
    return send(res, 200, { ok: true, enabled: enabled, email: emails.join(','), hour: hour, full: !!body.full });
  }

  if (pathname === '/api/backup/auto/run' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    if (!store.isOwner(actor)) return fail(res, 403, '自动备份发的是整个团队的数据，只有统筹管理员能操作');
    const last = backupRunAt.get(actor.teamId) || 0;
    if (Date.now() - last < 5 * 1000) return fail(res, 429, '刚发过一次，等 5 秒再试');
    backupRunAt.set(actor.teamId, Date.now());
    try {
      const r = await autobackup.runTeam(actor.teamId, { manual: true });
      log('手动备份发送（' + actor.name + '）：' + r.note);
      if (!r.ok) return fail(res, 502, r.note);
      return send(res, 200, r);
    } catch (e) {
      return fail(res, e.status || 500, e.message || '备份失败');
    }
  }

  /* ---------------- 排期校验 / 休息日 ---------------- */
  if (pathname === '/api/schedule/check' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    if (!actor.teamId) return fail(res, 403, '请先加入团队');
    const body = await readBody(req);
    const r = schedule.check(actor.teamId, {
      date: body.date, slot: body.slot, tech_id: body.tech_id,
      tech_name: body.tech_name, exclude_id: body.exclude_id
    });
    return send(res, 200, { conflicts: r.conflicts, off: r.off, tech: r.tech });
  }

  if (pathname === '/api/schedule/time-off' && req.method === 'GET') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    return send(res, 200, { data: schedule.listOff(actor.teamId, url.searchParams.get('from'), url.searchParams.get('to')) });
  }

  if (pathname === '/api/schedule/time-off' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    if (!actor.teamId) return fail(res, 403, '请先加入团队');
    const body = await readBody(req);
    const target = store.isTeamAdmin(actor) || !body.profile_id ? (body.profile_id || actor.id) : actor.id;
    const r = schedule.addOff(actor.teamId, target, body.from, body.to, body.reason, body.part, body.end_part);
    return send(res, 200, r);
  }

  if (pathname === '/api/schedule/time-off/remove' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    const body = await readBody(req);
    if (body.id) {
      store.run(actor, { table: 'time_off', action: 'delete', filters: [{ op: 'eq', col: 'id', val: Number(body.id) }] });
    } else if (body.profile_id && body.from) {
      // 清掉某个区间的排休
      const from = String(body.from).slice(0, 10);
      const to = String(body.to || body.from).slice(0, 10);
      const target = store.isTeamAdmin(actor) ? body.profile_id : actor.id;
      store.raw().prepare('DELETE FROM time_off WHERE team_id = ? AND profile_id = ? AND off_date >= ? AND off_date <= ?')
        .run(actor.teamId, String(target), from, to);
    }
    return send(res, 200, { ok: true });
  }

  /* ---------------- 预约附件：上传 / 下载 / 删除 / 绑定 ---------------- */
  if (pathname === '/api/files' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '登录已过期，请重新登录');
    if (!actor.teamId) return fail(res, 403, '请先加入团队');
    let name = '';
    try { name = decodeURIComponent(req.headers['x-file-name'] || ''); } catch (e) { name = ''; }
    name = path.basename(String(name || 'file')).slice(0, 120) || 'file';
    const apptQ = Number(url.searchParams.get('appointment_id') || 0);
    let apptId = null;
    if (apptQ) {
      const own = store.raw().prepare('SELECT team_id FROM appointments WHERE id = ?').get(apptQ);
      if (!own || Number(own.team_id) !== Number(actor.teamId)) return fail(res, 404, '预约单不存在');
      apptId = apptQ;
    }
    let buf;
    try { buf = await readRaw(req, ATTACH_MAX); }
    catch (e) { return fail(res, 413, e.message); }
    if (!buf.length) return fail(res, 400, '这个文件是空的');

    const teamDir = path.join(FILES_DIR, String(actor.teamId));
    fs.mkdirSync(teamDir, { recursive: true });
    const ext = (path.extname(name) || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
    const storeName = crypto.randomBytes(12).toString('hex') + ext;
    fs.writeFileSync(path.join(teamDir, storeName), buf);
    const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].slice(0, 100);
    const info = store.raw().prepare(
      'INSERT INTO attachments (team_id, appointment_id, owner_id, name, mime, size, store_name) VALUES (?,?,?,?,?,?,?)'
    ).run(actor.teamId, apptId, actor.id, name, mime, buf.length, storeName);
    return send(res, 200, { ok: true, id: Number(info.lastInsertRowid), name: name, mime: mime, size: buf.length });
  }

  if (pathname === '/api/files/link' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '登录已过期，请重新登录');
    const body = await readBody(req);
    const apptId = Number(body.appointment_id || 0);
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(n => n > 0);
    if (!apptId || !ids.length) return fail(res, 400, '缺少预约单或附件');
    const appt = store.raw().prepare('SELECT team_id FROM appointments WHERE id = ?').get(apptId);
    if (!appt || Number(appt.team_id) !== Number(actor.teamId)) return fail(res, 404, '预约单不存在');
    const marks = ids.map(() => '?').join(',');
    const admin = store.isTeamAdmin(actor);
    const sql = 'UPDATE attachments SET appointment_id = ? WHERE id IN (' + marks + ') AND team_id = ?' +
      (admin ? '' : ' AND owner_id = ?');
    const args = [apptId, ...ids, actor.teamId].concat(admin ? [] : [actor.id]);
    const info = store.raw().prepare(sql).run(...args);
    return send(res, 200, { ok: true, linked: Number(info.changes || 0) });
  }

  const fileMatch = pathname.match(/^\/api\/files\/(\d+)$/);
  if (fileMatch && (req.method === 'GET' || req.method === 'DELETE')) {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('t') || '';
    const actor = actorFromToken(token);
    if (!actor) return fail(res, 401, '登录已过期，请重新登录');
    const id = Number(fileMatch[1]);
    const row = store.raw().prepare('SELECT * FROM attachments WHERE id = ?').get(id);
    if (!row || Number(row.team_id) !== Number(actor.teamId)) return fail(res, 404, '附件不存在');
    const file = path.join(FILES_DIR, String(row.team_id), path.basename(row.store_name));

    if (req.method === 'DELETE') {
      const appt = row.appointment_id
        ? store.raw().prepare('SELECT owner_id FROM appointments WHERE id = ?').get(row.appointment_id)
        : null;
      const allowed = store.isTeamAdmin(actor) || row.owner_id === actor.id || (appt && appt.owner_id === actor.id);
      if (!allowed) return fail(res, 403, '只有上传人和管理员能删除附件');
      try { fs.unlinkSync(file); } catch (e) { /* 磁盘上已经没了也无所谓 */ }
      store.raw().prepare('DELETE FROM attachments WHERE id = ?').run(id);
      return send(res, 200, { ok: true });
    }

    if (!fs.existsSync(file)) return fail(res, 404, '附件文件已丢失（可能在备份恢复时被清掉了）');
    const buf = fs.readFileSync(file);
    const mime = String(row.mime || '');
    // SVG 里能带脚本，一律当附件下载，不在同源里直接渲染
    const inline = INLINE_MIME.test(mime) && !/svg/i.test(mime) && url.searchParams.get('dl') !== '1';
    const head = {
      'Content-Type': row.mime || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'private, max-age=600',
      'X-Content-Type-Options': 'nosniff'
    };
    head['Content-Disposition'] = (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(row.name || 'file');
    res.writeHead(200, head);
    return res.end(buf);
  }

  /* ---------------- 数据接口 ---------------- */
  if (pathname === '/api/db' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '登录已过期，请重新登录');
    if (!actor.teamId) return fail(res, 403, '请先加入团队');
    const body = await readBody(req);
    // 批量插入时 values 是数组，密码 / 手机号 要逐个处理（否则第一行之后都没写进去）
    const valList = body && body.values
      ? (Array.isArray(body.values) ? body.values : [body.values])
      : [];
    /** 这次写入要给谁「重设密码」——写完之后要把那个人的设备全部踢下线 */
    const pwTargets = [];
    for (const v of valList) {
      if (!v || typeof v !== 'object') continue;
      const rawPw = v.password != null ? v.password : v.pin;
      if (rawPw != null && rawPw !== '') {
        const p = normPassword(rawPw);
        const pe = passwordError(p);
        if (pe) return fail(res, 400, pe);
        v.pin_hash = auth.hashPin(p);
        // 插入时 id 由前端给；更新时 id 在 filters 里
        const idf = (body.filters || []).find(f => f && f.col === 'id' && f.op === 'eq');
        const target = v.id || (idf ? idf.val : null);
        if (target) pwTargets.push(String(target));
      }
      if (v.phone) {
        const phe = store.phoneError(v.phone);
        if (phe) return fail(res, 400, phe);
        v.phone = store.normPhone(v.phone);
      }
    }
    // 写预约单前的排期体检：同一人同一时段不能被派两单，休息日不能派
    const touchesSchedule = body && body.table === 'appointments'
      && (body.action === 'insert' || (body.action === 'update' && body.values
        && ['visit_date', 'time_slot', 'tech_id', 'tech_name'].some(k => k in body.values)));
    if (touchesSchedule && !body.force) {
      const vals = Array.isArray(body.values) ? (body.values[0] || {}) : (body.values || {});
      let merged = vals;
      if (body.action === 'update') {
        const idf = (body.filters || []).find(f => f.col === 'id');
        const cur = idf ? store.raw().prepare('SELECT * FROM appointments WHERE id = ? AND team_id = ?').get(idf.val, actor.teamId) : null;
        if (cur) merged = Object.assign({}, cur, vals);
      }
      const chk = schedule.check(actor.teamId, {
        date: merged.visit_date,
        slot: merged.time_slot,
        tech_id: merged.tech_id,
        tech_name: merged.tech_name,
        exclude_id: body.action === 'update' ? merged.id : 0
      });
      if (chk.tech && (chk.off || chk.conflicts.length)) {
        const when = String(merged.visit_date || '').slice(5).replace('-', '月') + '日 ' + (merged.time_slot || '');
        const msg = chk.off
          ? chk.tech.name + ' 在 ' + when + ' 排了休息' + (chk.off.reason ? '（' + chk.off.reason + '）' : '') + '，不能安排预约'
          : chk.tech.name + ' 在 ' + when + ' 已经有别的单了';
        return send(res, 409, {
          error: msg,
          off: chk.off,
          conflicts: chk.conflicts,
          tech: chk.tech
        });
      }
    }
    const result = store.run(actor, body);
    // 管理员在「人员」里重设了别人的密码 → 那个人的所有设备立即下线，逼对方用新密码登录。
    // 给自己重设时只踢其它设备，当前这台留着（否则保存完自己就被弹回登录页）。
    for (const pid of pwTargets) {
      if (pid === actor.id) sessions.revokeAll(pid, actor.sid);
      else sessions.invalidateAll(pid);
    }
    if (pwTargets.length) log(actor.name + ' 重设了 ' + pwTargets.length + ' 个账号的密码，相关设备已退出');
    // 删预约单时连带清掉附件（文件 + 元数据），避免占着磁盘又查不到
    if (body && body.table === 'appointments' && body.action === 'delete') {
      const ids = (body.filters || []).filter(f => f && f.col === 'id' && f.op === 'eq')
        .map(f => Number(f.val)).filter(Boolean);
      if (ids.length) dropAttachmentsOf(ids, actor.teamId);
    }
    return send(res, 200, result);
  }

  /* 发信统一走服务端：账号密码不会到浏览器，也能被定时任务复用。
     一个团队可以配多个邮箱服务，全用完/超限了自动换下一个（mailer.send） */
  if (pathname === '/api/mail/send' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '登录已过期，请重新登录');
    if (!actor.teamId) return fail(res, 403, '请先加入团队');
    const body = await readBody(req);
    if (!mailer.configured(actor.teamId)) {
      return fail(res, 400, '邮件还没配好：让统筹管理员去「设置 → 通知 → 邮箱服务」填一个（QQ 邮箱 + 授权码就行）');
    }
    const to = String(body.to || '').trim();
    if (!to) return fail(res, 400, '收件邮箱不能为空');
    const r = await mailer.send(actor.teamId, {
      to,
      toName: body.toName || '',
      subject: body.subject || '速派通知',
      html: body.html || '',
      text: body.text || '',
      kind: body.kind || 'other',
      owner: actor.id
    });
    if (!r.ok) return fail(res, 502, r.error || '发送失败');
    return send(res, 200, { ok: true, account: r.account || null });
  }

  /* 用指定账号发一封测试信：失败不切换，方便定位是哪个邮箱的问题 */
  if (pathname === '/api/mail/accounts/test' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    if (!store.isOwner(actor)) return fail(res, 403, '邮箱服务只有统筹管理员能配置');
    const body = await readBody(req);
    const row = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(actor.id) || {};
    const to = String(body.to || row.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) {
      return fail(res, 400, '先给自己填一个能收信的邮箱，或直接在测试框里填一个');
    }
    const r = await mailer.sendWith(actor.teamId, body.id, {
      to,
      toName: row.name || '',
      owner: actor.id,
      kind: 'test',
      subject: '【测试】速派发信账号「' + (body.label || '') + '」正常',
      html: '<div style="font-family:-apple-system,Segoe UI,PingFang SC,sans-serif;font-size:14px;line-height:1.8;color:#111827">' +
        '<p>这封是用发信账号 <b>' + String(body.label || '').replace(/[<>&"]/g, '') + '</b> 发出的测试邮件。</p>' +
        '<p>收到说明这个账号可以用；之后派单、出发提醒、每日汇总都可能走它。</p></div>'
    });
    if (!r.ok) return fail(res, 502, r.error || '发送失败');
    return send(res, 200, { ok: true, to, account: r.account });
  }

  /* ---------------- 通知邮箱验证（所有人可自己设自己的） ---------------- */
  if (pathname === '/api/auth/email/code' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    if (!actor.teamId) return fail(res, 403, '请先加入团队');
    const body = await readBody(req);
    const email = String(body.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(res, 400, '邮箱格式不对：' + (email || '（空）'));
    const row = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(actor.id) || {};

    // 60 秒内只能发一次，避免被当成骚扰邮件源
    if (row.email_code_sent_at) {
      const age = Date.now() - timeMs(row.email_code_sent_at);
      if (age >= 0 && age < 60 * 1000) {
        return fail(res, 429, '刚发过一封，' + Math.ceil((60 * 1000 - age) / 1000) + ' 秒后可以再发');
      }
    }
    if (!mailer.configured(actor.teamId)) {
      return fail(res, 400, '团队还没配发信邮箱，先让统筹管理员去「设置 → 通知 → 邮箱服务」配一个，再验证自己的邮箱');
    }

    const code = String(crypto.randomInt(100000, 1000000));
    const sendRes = await mailer.send(actor.teamId, {
      to: email,
      toName: row.name || '',
      owner: actor.id,
      kind: 'verify',
      subject: '【速派】邮箱验证码 ' + code + '（10 分钟内有效）',
      html: '<div style="font-family:-apple-system,Segoe UI,PingFang SC,sans-serif;font-size:14px;line-height:1.9;color:#111827">' +
        '<p>' + String(row.name || '').replace(/[<>&"]/g, '') + '，你好：</p>' +
        '<p>这是你在「速派」设置通知邮箱的验证码，<b>10 分钟内有效</b>：</p>' +
        '<p style="font-size:30px;font-weight:700;letter-spacing:6px;color:#2b6ef6;margin:14px 0">' + code + '</p>' +
        '<p style="color:#6b7280;font-size:13px">验证后，派单、出发提醒、每日汇总会发到这个邮箱。如果不是你本人操作，忽略这封邮件即可。</p></div>'
    });
    if (!sendRes.ok) {
      return fail(res, 502, '验证码没发出去：' + (sendRes.error || '未知原因') +
        (sendRes.error && sendRes.error.indexOf('可用') >= 0 ? '' : '（检查一下管理员配的发信邮箱是否正常）'));
    }
    // 新邮箱先存到 email_pending，验证通过才写进 email —— 这样中途放弃也不会丢掉原来已验证的地址
    // 有效期用 Node 的时钟算（存毫秒），不依赖数据库的 localtime —— 避免容器时区不同导致算错
    store.raw().prepare(
      "UPDATE profiles SET email_pending = ?, email_code = ?, " +
      "email_code_exp = ?, email_code_tries = 0, email_code_sent_at = ? WHERE id = ?"
    ).run(email, code, String(Date.now() + 10 * 60 * 1000), String(Date.now()), actor.id);
    log('邮箱验证码已发送（' + actor.name + ' → ' + email + '）');
    return send(res, 200, { ok: true, email, ttl: 600, account: sendRes.account || null });
  }

  if (pathname === '/api/auth/email/verify' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '未登录');
    const body = await readBody(req);
    const code = String(body.code || '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(code)) return fail(res, 400, '验证码是 6 位数字');
    const row = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(actor.id) || {};
    if (!row.email_code || !row.email_code_exp) return fail(res, 400, '没有待验证的邮箱，先点「发送验证码」');
    if (Number(row.email_code_tries || 0) >= 5) return fail(res, 429, '试错次数太多，请重新发送验证码');
    const exp = timeMs(row.email_code_exp);
    if (!(exp > Date.now())) return fail(res, 400, '验证码已过期，请重新发送');
    if (String(row.email_code) !== code) {
      store.raw().prepare('UPDATE profiles SET email_code_tries = IFNULL(email_code_tries,0) + 1 WHERE id = ?').run(actor.id);
      const left = 4 - Number(row.email_code_tries || 0);
      return fail(res, 400, '验证码不对' + (left > 0 ? '，还能再试 ' + left + ' 次' : '，请重新发送'));
    }
    // 验证通过：把待验证的地址正式写进 email，并清掉验证码
    const finalEmail = String(row.email_pending || row.email || '');
    store.raw().prepare(
      "UPDATE profiles SET email = ?, email_verified_at = datetime('now','localtime'), email_pending = NULL, " +
      "email_code = NULL, email_code_exp = NULL, email_code_tries = 0 WHERE id = ?"
    ).run(finalEmail, actor.id);
    log('邮箱已验证（' + actor.name + ' → ' + finalEmail + '）');
    return send(res, 200, { ok: true, email: finalEmail });
  }

  /* 给自己已验证的通知邮箱发一封测试信：收件人固定取库里本人的地址，前端传不了 to */
  if (pathname === '/api/auth/email/test' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor) return fail(res, 401, '登录已过期，请重新登录');
    const row = store.raw().prepare('SELECT * FROM profiles WHERE id = ?').get(actor.id) || {};
    const to = String(row.email || '').trim();
    if (!to) return fail(res, 400, '还没填通知邮箱，先填一个并验证');
    if (!row.email_verified_at) return fail(res, 400, '这个邮箱还没验证，先点「发送验证码」验证一下再测');
    if (!actor.teamId) return fail(res, 403, '请先加入团队');
    if (!mailer.configured(actor.teamId)) {
      return fail(res, 400, '邮件还没配好：让统筹管理员去「设置 → 通知 → 邮箱服务」填一个（QQ 邮箱 + 授权码就行）');
    }
    const last = mailTestAt.get(actor.id) || 0;
    const left = 60 * 1000 - (Date.now() - last);
    if (left > 0) return fail(res, 429, '刚发过一封测试信，' + Math.ceil(left / 1000) + ' 秒后可以再发');

    const team = store.raw().prepare('SELECT name FROM teams WHERE id = ?').get(actor.teamId) || {};
    const now = new Date().toLocaleString('zh-CN', { hour12: false });
    const safeName = String(row.name || '').replace(/[<>&"]/g, '');
    const r = await mailer.send(actor.teamId, {
      to,
      toName: row.name || '',
      owner: actor.id,
      kind: 'test',
      subject: '【速派】邮件测试 —— 收到说明配置正常',
      html: '<div style="font-family:-apple-system,Segoe UI,PingFang SC,sans-serif;font-size:14px;line-height:1.9;color:#111827">' +
        '<p>' + safeName + '，你好：</p>' +
        '<p>这是一封来自「速派」的测试邮件。你能看到它，说明<b>发信通道正常</b>，派单、出发提醒和每日汇总都能送到这个地址。</p>' +
        '<table style="font-size:13px;color:#374151;border-collapse:collapse;margin:10px 0">' +
        '<tr><td style="padding:2px 12px 2px 0;color:#6b7280">团队</td><td>' + String(team.name || '').replace(/[<>&"]/g, '') + '</td></tr>' +
        '<tr><td style="padding:2px 12px 2px 0;color:#6b7280">收件人</td><td>' + to.replace(/[<>&"]/g, '') + '</td></tr>' +
        '<tr><td style="padding:2px 12px 2px 0;color:#6b7280">发送时间</td><td>' + now + '</td></tr>' +
        '</table>' +
        '<p style="color:#6b7280;font-size:13px">如果不是你本人在「设置 → 通知 → 我的通知邮箱」点的测试，忽略这封邮件即可。</p></div>',
      text: safeName + '，你好：\n\n这是「速派」的测试邮件，收到说明发信通道正常。\n团队：' + (team.name || '') +
        '\n收件人：' + to + '\n发送时间：' + now + '\n\n如果不是你本人点的测试，忽略即可。'
    });
    if (!r.ok) return fail(res, 502, '没发出去：' + (r.error || '未知原因'));
    mailTestAt.set(actor.id, Date.now());
    log('测试邮件已发送（' + actor.name + ' → ' + to + '）');
    return send(res, 200, { ok: true, to, account: r.account || null });
  }

  if (pathname === '/api/mail/digest' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor || !store.isTeamAdmin(actor)) return fail(res, 403, '只有团队管理员能发汇总');
    const ok = await jobs.runDigest(actor.teamId);
    return send(res, 200, { ok: !!ok });
  }

  if (pathname === '/api/jobs/run' && req.method === 'POST') {
    const actor = actorFrom(req);
    if (!actor || !store.isTeamAdmin(actor)) return fail(res, 403, '只有团队管理员能手动触发');
    const n = await jobs.runReminders(actor.teamId);
    const d = await jobs.runDigest(actor.teamId);
    return send(res, 200, { reminders: n, digest: d });
  }

  return fail(res, 404, '接口不存在：' + pathname);
}

function redirect(res, to) {
  res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' });
  res.end();
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  for (const p of STRIP) if (rel.startsWith(p)) { rel = rel.slice(p.length) || '/'; break; }
  if (rel === '/' || rel === '') rel = '/index.html';
  // 只允许访问前端产物，服务端源码不对外
  if (rel.startsWith('/server/') || rel.startsWith('/.git') || rel.startsWith('/data/')) return fail(res, 404, 'Not found');

  // 微信「网页授权域名」要验证站点归属：允许把 MP_verify_xxx.txt 丢进数据目录，
  // 不用为了一个校验文件重新打镜像（放在 volumes 挂载的 /data 下就能直接被验证到）
  if (/^\/MP_verify_[A-Za-z0-9]+\.txt$/.test(rel)) {
    const vp = path.join(store.DATA_DIR, rel.slice(1));
    if (fs.existsSync(vp)) return serveFile(req, res, vp);
  }

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
    handleApi(req, res, pathname, url).catch(err => {
      const code = err.status || 500;
      if (code >= 500) log('接口出错：' + (err.stack || err.message));
      if (res.headersSent) return res.end();
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
  const gs = store.raw().prepare('SELECT * FROM settings WHERE team_id IS NULL LIMIT 1').get();
  if (gs && (gs.wx_mp_appid || gs.wx_qr_appid)) {
    log('微信登录：' + (gs.wx_mp_appid ? '公众号已配置 ' : '') + (gs.wx_qr_appid ? '扫码已配置' : ''));
  }
  jobs.start(log);
});

const shutdown = sig => {
  log('收到 ' + sig + '，正在退出');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
