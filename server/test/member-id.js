/*
  用户名 + 8 位用户 ID + 邮箱找回密码
  ------------------------------------------------------------
  · 用户名是登录凭证：全局唯一、设定后不可改；8 位 ID 只用于记录与显示，不能登录
  · 姓名与用户名分离：同事看到的是姓名，登录用用户名
  · 注册要邮箱验证码（系统配了发信邮箱时强制；一个都没有时降级放行）
  · 找回密码用「用户名或邮箱」，成功后所有设备下线
*/
'use strict';
const net = require('node:net');

const BASE = process.env.BASE || 'http://127.0.0.1:8300';
let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); }
};

async function api(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* ignore */ }
  return { status: res.status, json };
}
const db = (token, q) => api('/api/db', q, token);

/* 极简假 SMTP：把 DATA 阶段的原始邮件收下来即可 */
function fakeSmtp() {
  return new Promise(resolve => {
    const state = { mails: [] };
    const srv = net.createServer(sock => {
      let buf = '', inData = false, step = '';
      sock.write('220 fake ESMTP ready\r\n');
      sock.on('data', chunk => {
        buf += chunk.toString('utf8');
        for (;;) {
          if (inData) {
            const end = buf.indexOf('\r\n.\r\n');
            if (end < 0) return;
            state.mails.push(buf.slice(0, end));
            buf = buf.slice(end + 5);
            inData = false;
            sock.write('250 2.0.0 Ok: queued\r\n');
            continue;
          }
          const nl = buf.indexOf('\r\n');
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          if (step === 'user') { step = 'pass'; sock.write('334 UGFzc3dvcmQ6\r\n'); continue; }
          if (step === 'pass') { step = ''; sock.write('235 2.7.0 Accepted\r\n'); continue; }
          const up = line.toUpperCase();
          if (up.startsWith('EHLO')) sock.write('250-fake\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n');
          else if (up.startsWith('HELO')) sock.write('250 fake\r\n');
          else if (up.startsWith('AUTH LOGIN')) { step = 'user'; sock.write('334 VXNlcm5hbWU6\r\n'); }
          else if (up.startsWith('AUTH PLAIN')) sock.write('235 2.7.0 Accepted\r\n');
          else if (up.startsWith('MAIL FROM')) sock.write('250 2.1.0 Ok\r\n');
          else if (up.startsWith('RCPT TO')) sock.write('250 2.1.5 Ok\r\n');
          else if (up === 'DATA') { inData = true; sock.write('354 End data\r\n'); }
          else if (up === 'QUIT') { sock.write('221 Bye\r\n'); sock.end(); }
          else sock.write('250 Ok\r\n');
        }
      });
      sock.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, state, port: srv.address().port }));
  });
}

/** 从 base64 编码的邮件正文里找出 6 位验证码 */
function codeFromRaw(raw) {
  const flat = String(raw || '').replace(/\r?\n/g, '');
  const chunks = flat.match(/[A-Za-z0-9+/=]{40,}/g) || [];
  let text = '';
  for (const c of chunks) {
    try { text += Buffer.from(c, 'base64').toString('utf8'); } catch (e) { /* ignore */ }
  }
  const m = text.match(/<b>(\d{6})<\/b>/) || text.match(/\b(\d{6})\b/);
  return m ? m[1] : '';
}

(async () => {
  console.log('\n[1] 建号时分配用户名与 8 位 ID');
  const setup = await api('/api/auth/setup', { username: 'boss', name: '王老板', password: '123456', phone: '13800000001' });
  ok(setup.status === 200 && setup.json.token, '初始化成功');
  const owner = setup.json.token;
  ok(setup.json.user.username === 'boss', '用户名按填写的保存', setup.json.user);
  ok(/^\d{8}$/.test(setup.json.user.code), '同时拿到 8 位数字 ID：' + setup.json.user.code);
  ok(setup.json.user.name === '王老板', '姓名与用户名分开存', setup.json.user);

  const reg = await api('/api/auth/register', { username: 'li-gong', name: '李工', password: '567890' });
  ok(reg.status === 200 && reg.json.user.username === 'li-gong', '注册时用户名生效', reg.json && reg.json.error);
  ok(reg.json.user.code !== setup.json.user.code, 'ID 不重复');

  const ins = await db(owner, { table: 'profiles', action: 'insert', values: { name: '赵工', role: 'tech' } });
  ok(ins.status === 200 && ins.json.data[0].username === '赵工', '管理员加人没填用户名时用姓名兜底', ins.json);
  const zhaoId = ins.json.data[0].id, zhaoUser = ins.json.data[0].username;

  const badName = await db(owner, { table: 'profiles', action: 'insert', values: { name: '纯数字', username: '12345678', role: 'tech' } });
  ok(badName.status === 400, '纯数字用户名被拒绝', badName.json);

  const upd = await db(owner, {
    table: 'profiles', action: 'update',
    values: { name: '赵工（改）', username: 'hacker' },
    filters: [{ op: 'eq', col: 'id', val: zhaoId }]
  });
  ok(upd.status === 200 && upd.json.data[0].username === zhaoUser, '接口改不动用户名（设定后不可更改）', upd.json && upd.json.data);
  ok(upd.json.data[0].name === '赵工（改）', '姓名可以改', upd.json && upd.json.data);

  const all = (await db(owner, { table: 'profiles', action: 'select' })).json.data;
  ok(all.every(p => p.username && /^\d{8}$/.test(p.code)), '每个人都有用户名和 8 位 ID');
  ok(new Set(all.map(p => p.username.toLowerCase())).size === all.length, '用户名全局唯一');

  console.log('\n[2] 登录只认用户名或邮箱，8 位 ID 不能登录');
  const l1 = await api('/api/auth/login', { username: 'li-gong', password: '567890' });
  ok(l1.status === 200 && l1.json.user.username === 'li-gong', '用户名登录', l1.json && l1.json.error);
  ok((await api('/api/auth/login', { username: 'LI-GONG', password: '567890' })).status === 200, '用户名大小写不敏感');
  ok((await api('/api/auth/login', { username: 'li-gong', password: 'wrongpass' })).status === 401, '密码错进不去');
  const byCode = await api('/api/auth/login', { account: reg.json.user.code, password: '567890' });
  ok(byCode.status === 401, '8 位 ID 不能用来登录', byCode.json);

  console.log('\n[3] 注册要邮箱验证码（配好发信邮箱后强制）');
  const fake = await fakeSmtp();
  const acc = await db(owner, {
    table: 'mail_accounts', action: 'insert',
    values: { label: '测试发信', kind: 'smtp', host: '127.0.0.1', port: fake.port,
      user: 'noreply@example.com', pass: 'p', from_addr: 'noreply@example.com', priority: 10, daily_limit: 0 }
  });
  ok(acc.status === 200, '配置发信账号', acc.json);

  const codeRes = await api('/api/auth/register/code', { email: 'li2@example.com' });
  ok(codeRes.status === 200 && codeRes.json.ok, '发出注册验证码', codeRes.json);
  const again = await api('/api/auth/register/code', { email: 'li2@example.com' });
  ok(again.status === 429 && /秒后/.test(again.json.error || ''), '60 秒内不能重复发', again.json);
  const mailCode = codeFromRaw(fake.state.mails[fake.state.mails.length - 1] || '');
  ok(/^\d{6}$/.test(mailCode), '从邮件里取到验证码：' + mailCode);

  const noCode = await api('/api/auth/register', { username: 'li2', name: '李二', password: '567890', email: 'li2@example.com' });
  ok(noCode.status === 400 && /验证码/.test(noCode.json.error || ''), '没带验证码不能注册', noCode.json);
  const wrongCode = await api('/api/auth/register',
    { username: 'li2', name: '李二', password: '567890', email: 'li2@example.com', code: mailCode === '000000' ? '111111' : '000000' });
  ok(wrongCode.status === 400 && /验证码/.test(wrongCode.json.error || ''), '错验证码不能注册', wrongCode.json);
  const okReg = await api('/api/auth/register',
    { username: 'li2', name: '李二', password: '567890', email: 'li2@example.com', code: mailCode });
  ok(okReg.status === 200 && okReg.json.email_verified === true, '验证码对就注册成功，邮箱直接标已验证', okReg.json && okReg.json.error);
  const dupUser = await api('/api/auth/register',
    { username: 'li2', name: '另一个', password: '567890', email: 'other@example.com', code: '123456' });
  ok(dupUser.status === 409 && /用户名/.test(dupUser.json.error || ''), '用户名重复被拒绝', dupUser.json);

  console.log('\n[4] 用用户名或邮箱找回密码');
  const byMailLogin = await api('/api/auth/login', { account: 'li2@example.com', password: '567890' });
  ok(byMailLogin.status === 200 && byMailLogin.json.user.username === 'li2', '邮箱也能登录', byMailLogin.json && byMailLogin.json.error);

  const startByName = await api('/api/auth/recover/start', { account: 'li2' });
  ok(startByName.status === 200 && startByName.json.ok, '用用户名申请找回', startByName.json);
  ok(startByName.json.email && startByName.json.email.indexOf('li2@') < 0, '回显的是打码邮箱', startByName.json.email);
  const startByMail = await api('/api/auth/recover/start', { account: 'li2@example.com' });
  ok(startByMail.status === 429, '刚发过，60 秒内不能再发', startByMail.json);
  const rcode = codeFromRaw(fake.state.mails[fake.state.mails.length - 1] || '');
  ok(/^\d{6}$/.test(rcode), '从找回邮件里取到验证码：' + rcode);
  const done = await api('/api/auth/recover/verify', { account: 'li2', code: rcode, password: 'newpass123' });
  ok(done.status === 200 && done.json.ok, '重设成功', done.json);
  ok((await api('/api/auth/login', { username: 'li2', password: '567890' })).status === 401, '旧密码立刻失效');
  ok((await api('/api/auth/login', { username: 'li2', password: 'newpass123' })).status === 200, '新密码能登');
  ok((await api('/api/auth/me', null, okReg.json.token)).status === 401, '找回后之前登录的设备全部下线');

  try { fake.srv.close(); } catch (e) {}
  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('测试异常：', e);
  process.exit(1);
});
