'use strict';
/**
 * 极简 SMTP 客户端（零依赖，只用 node:net / node:tls）
 *
 * 支持：
 *   · 465 端口隐式 TLS（QQ / 163 / 企业邮箱最常见）
 *   · 587 / 25 端口 STARTTLS（服务器支持时自动升级）
 *   · AUTH LOGIN，服务器只支持 PLAIN 时自动退化
 *   · UTF-8 主题与发件人（RFC 2047 encoded-word，超长自动折行）
 *   · multipart/alternative：纯文本 + HTML 双份
 *
 * 用法：
 *   const r = await smtp.send({ host, port, user, pass, from, fromName, to, toName, subject, html, text });
 *   r.ok === true / r.error === '...'
 */
const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');
const crypto = require('node:crypto');

const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');

/* UTF-8 字符串 → 若干 encoded-word，按字节切分保证单行不超 76 字符 */
function encWords(str) {
  const s = String(str === null || str === undefined ? '' : str);
  if (!s) return '';
  if (/^[\x20-\x7e]*$/.test(s)) return s; // 纯 ASCII 直接发，可读性更好
  const out = [];
  let buf = '';
  for (const ch of s) {
    const next = buf + ch;
    if (Buffer.byteLength(next, 'utf8') > 30) { out.push('=?UTF-8?B?' + b64(buf) + '?='); buf = ch; }
    else buf = next;
  }
  if (buf) out.push('=?UTF-8?B?' + b64(buf) + '?=');
  return out.join('\r\n ');
}

const wrap76 = b64str => (b64str.match(/.{1,76}/g) || []).join('\r\n');

const stripHtml = html => String(html || '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

/* 附件名：纯 ASCII 直接引号；中文走 RFC 2231（filename*=UTF-8''%XX），各客户端都认 */
function nameParam(name, forType) {
  const s = String(name || 'attachment');
  const key = forType ? 'name' : 'filename';
  if (/^[\x20-\x7e]*$/.test(s)) return key + '="' + s.replace(/["\\]/g, '_') + '"';
  const enc = encodeURIComponent(s).replace(/['()*!]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return key + "*=UTF-8''" + enc;
}

function buildMessage(o) {
  const altBoundary = '=_crewgo_' + crypto.randomBytes(12).toString('hex');
  const mixBoundary = '=_crewgo_mix_' + crypto.randomBytes(12).toString('hex');
  const domain = String(o.from || '').split('@')[1] || 'crewgo.local';
  const fromLine = o.fromName ? encWords(o.fromName) + ' <' + o.from + '>' : o.from;
  const toLine = o.toName ? encWords(o.toName) + ' <' + o.to + '>' : o.to;
  const text = o.text || stripHtml(o.html) || o.subject || '';
  const html = o.html || '<pre style="font:14px/1.7 -apple-system,Segoe UI,Microsoft YaHei,sans-serif;white-space:pre-wrap">' +
    String(text).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) + '</pre>';

  const attachments = (Array.isArray(o.attachments) ? o.attachments : [])
    .filter(a => a && a.content !== undefined && a.content !== null)
    .slice(0, 10);

  const head = [
    'From: ' + fromLine,
    'To: ' + toLine,
    'Subject: ' + encWords(o.subject || '速派通知'),
    'Date: ' + new Date().toUTCString().replace('GMT', '+0000'),
    'Message-ID: <' + crypto.randomBytes(10).toString('hex') + '@' + domain + '>',
    'MIME-Version: 1.0',
    'X-Mailer: CrewGo'
  ];

  const altBody = [
    '--' + altBoundary,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(text)),
    '--' + altBoundary,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(html)),
    '--' + altBoundary + '--'
  ].join('\r\n');

  if (!attachments.length) {
    head.push('Content-Type: multipart/alternative; boundary="' + altBoundary + '"');
    return head.join('\r\n') + '\r\n\r\n' + altBody + '\r\n';
  }

  // 有附件：外层 multipart/mixed，内层还是「纯文本 + HTML」
  head.push('Content-Type: multipart/mixed; boundary="' + mixBoundary + '"');
  const parts = [
    '--' + mixBoundary,
    'Content-Type: multipart/alternative; boundary="' + altBoundary + '"',
    '',
    altBody
  ];
  for (const a of attachments) {
    const buf = Buffer.isBuffer(a.content) ? a.content : Buffer.from(String(a.content), 'utf8');
    parts.push(
      '--' + mixBoundary,
      'Content-Type: ' + (a.type || 'application/octet-stream') + '; ' + nameParam(a.name, true),
      'Content-Disposition: attachment; ' + nameParam(a.name, false),
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(buf.toString('base64'))
    );
  }
  parts.push('--' + mixBoundary + '--');
  return head.join('\r\n') + '\r\n\r\n' + parts.join('\r\n') + '\r\n';
}

/* ---------- 连接 ---------- */
function dial(host, port, implicitTls) {
  return new Promise((resolve, reject) => {
    const sock = implicitTls
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    const event = implicitTls ? 'secureConnect' : 'connect';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('连接 ' + host + ':' + port + ' 超时（20 秒）')); }, 20000);
    sock.once(event, () => { clearTimeout(timer); sock.setTimeout(0); resolve(sock); });
    sock.once('error', e => { clearTimeout(timer); reject(e); });
  });
}

/* 逐条读 SMTP 应答：多行应答以 "250-xxx" 开头，最后一行是 "250 xxx" */
function reader(sock) {
  let buf = '';
  const waiters = [];
  let closed = null;

  const finalIdx = s => {
    let i = 0;
    for (;;) {
      const nl = s.indexOf('\r\n', i);
      if (nl < 0) return -1;
      const line = s.slice(i, nl);
      if (!/^\d{3}-/.test(line)) return nl + 2;
      i = nl + 2;
    }
  };
  const flush = () => {
    while (waiters.length) {
      const idx = finalIdx(buf);
      if (idx < 0) return;
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx);
      const code = Number(raw.slice(0, 3)) || 0;
      const text = raw.replace(/\r\n/g, ' ').replace(/^\d{3}[ -]?/, '').trim();
      waiters.shift().resolve({ code, text, raw });
    }
  };
  const fail = err => {
    closed = err;
    while (waiters.length) waiters.shift().reject(err);
  };
  const onData = d => { buf += d.toString('utf8'); flush(); };
  const onErr = e => fail(e);
  const onClose = () => fail(new Error('服务器提前关闭了连接'));
  sock.on('data', onData);
  sock.on('error', onErr);
  sock.on('close', onClose);

  return {
    next() {
      if (closed) return Promise.reject(closed);
      const idx = finalIdx(buf);
      if (idx >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx);
        const code = Number(raw.slice(0, 3)) || 0;
        const text = raw.replace(/\r\n/g, ' ').replace(/^\d{3}[ -]?/, '').trim();
        return Promise.resolve({ code, text, raw });
      }
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    write(line) { sock.write(line + '\r\n'); },
    writeRaw(str) { sock.write(str); },
    detach() { sock.removeListener('data', onData); sock.removeListener('error', onErr); sock.removeListener('close', onClose); }
  };
}

async function cmd(io, line, expect) {
  io.write(line);
  const r = await io.next();
  if (expect && r.code !== expect) {
    const err = new Error('服务器返回 ' + r.code + '：' + (r.text || '（无内容）'));
    err.code = r.code;
    err.reply = r.text;
    throw err;
  }
  return r;
}

function friendly(err) {
  const c = err && err.code;
  const t = String((err && (err.reply || err.message)) || err);
  if (/535|530|authentication|username and password/i.test(String(c) + ' ' + t)) {
    return '认证失败（535）：账号或授权码不对。QQ 邮箱要填「授权码」而不是登录密码，且账号要写完整邮箱地址';
  }
  if (/timeout|超时|ETIMEDOUT|ECONNREFUSED|ENOTFOUND/i.test(t)) {
    return '连不上邮件服务器：' + t + '。确认服务器可出网访问 ' + (err && err.host ? err.host : '对应端口');
  }
  if (/certificate|SSL|TLS|handshake/i.test(t)) {
    return '加密握手失败：' + t + '。465 端口必须用 SSL，587 端口用 STARTTLS';
  }
  return t.slice(0, 400);
}

/**
 * 发送一封邮件
 * @param {object} o host/port/user/pass/from/fromName/to/toName/subject/html/text
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function send(o) {
  const host = String(o.host || '').trim();
  const port = Number(o.port || 465);
  const from = String(o.from || o.user || '').trim();
  const to = String(o.to || '').trim();
  if (!host) return { ok: false, error: '没填 SMTP 服务器地址' };
  if (!from) return { ok: false, error: '没填发件邮箱' };
  if (!to) return { ok: false, error: '没填收件邮箱' };

  const implicit = o.secure === true || port === 465;
  let sock = null;
  let io = null;
  try {
    sock = await dial(host, port, implicit);
    io = reader(sock);
    const greet = await io.next();
    if (greet.code !== 220) throw Object.assign(new Error('服务器问候异常：' + greet.text), { code: greet.code, reply: greet.text });

    const me = os.hostname() || 'localhost';
    let ehlo = await cmd(io, 'EHLO ' + me);
    if (ehlo.code !== 250) {
      ehlo = await cmd(io, 'HELO ' + me);
      if (ehlo.code !== 250) throw Object.assign(new Error('服务器拒绝 EHLO/HELO：' + ehlo.text), { code: ehlo.code, reply: ehlo.text });
    }

    if (!implicit && /\bSTARTTLS\b/i.test(ehlo.text)) {
      await cmd(io, 'STARTTLS', 220);
      io.detach();
      sock = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket: sock, servername: host }, () => resolve(s));
        s.once('error', reject);
        setTimeout(() => reject(new Error('STARTTLS 握手超时')), 20000);
      });
      io = reader(sock);
      ehlo = await cmd(io, 'EHLO ' + me);
    }

    if (o.user && o.pass) {
      const caps = (ehlo.text || '').toUpperCase();
      if (/AUTH[ =]?[^\n]*PLAIN/.test(caps) && !/AUTH[ =]?[^\n]*LOGIN/.test(caps)) {
        await cmd(io, 'AUTH PLAIN ' + b64('\u0000' + o.user + '\u0000' + o.pass), 235);
      } else {
        await cmd(io, 'AUTH LOGIN', 334);
        await cmd(io, b64(o.user), 334);
        await cmd(io, b64(o.pass), 235);
      }
    }

    await cmd(io, 'MAIL FROM:<' + from + '>', 250);
    const rcpt = await cmd(io, 'RCPT TO:<' + to + '>');
    if (rcpt.code !== 250 && rcpt.code !== 251) {
      throw Object.assign(new Error('收件人被拒：' + rcpt.text), { code: rcpt.code, reply: rcpt.text });
    }
    await cmd(io, 'DATA', 354);

    const msg = buildMessage(Object.assign({}, o, { from }));
    const stuffed = msg.split('\r\n').map(line => (line.startsWith('.') ? '.' + line : line)).join('\r\n');
    io.writeRaw(stuffed + '\r\n.\r\n');
    const fin = await io.next();
    if (fin.code !== 250) throw Object.assign(new Error('发送失败：' + fin.text), { code: fin.code, reply: fin.text });

    try { await cmd(io, 'QUIT', 221); } catch (e) { /* 有些服务器直接断开 */ }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: friendly(e) };
  } finally {
    try { if (io) io.detach(); } catch (e) { /* ignore */ }
    try { if (sock) sock.destroy(); } catch (e) { /* ignore */ }
  }
}

module.exports = { send, buildMessage, stripHtml };
