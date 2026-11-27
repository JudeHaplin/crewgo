/*
  用户 ID（8 位数字）+ 邮箱找回密码
  ------------------------------------------------------------
  · 建号时自动分配 8 位 ID，前端伪造不了、编辑也改不了
  · 重名注册各拿一个 ID；用 ID 登录不会认错人；同名同密码必须改用 ID
  · 邮箱找回密码：验证码发到已验证邮箱，重设后所有设备重新登录
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
  console.log('\n[1] 建号自动分配 8 位用户 ID，且不可更改');
  const setup = await api('/api/auth/setup', { name: '王老板', password: '123456', phone: '13800000001' });
  ok(setup.status === 200 && setup.json.token, '初始化成功');
  const owner = setup.json.token, ownerCode = setup.json.user.code;
  ok(/^\d{8}$/.test(ownerCode), '统筹拿到 8 位数字 ID：' + ownerCode);
  ok((await api('/api/auth/me', null, owner)).json.user.code === ownerCode, '「我的资料」能看到自己的 ID');

  const reg = await api('/api/auth/register', { name: '李工', password: '567890' });
  ok(reg.status === 200 && /^\d{8}$/.test(reg.json.user.code), '注册也自动分配 ID', reg.json && reg.json.error);
  ok(reg.json.user.code !== ownerCode, '两个账号 ID 不重复');

  const ins = await db(owner, { table: 'profiles', action: 'insert', values: { name: '赵工', role: 'tech' } });
  ok(ins.status === 200 && /^\d{8}$/.test(ins.json.data[0].code), '管理员添加人员也分配 ID', ins.json);
  const zhaoId = ins.json.data[0].id, zhaoCode = ins.json.data[0].code;

  const fake = await db(owner, { table: 'profiles', action: 'insert', values: { name: '钱工', role: 'tech', code: '00000000' } });
  ok(fake.status === 200 && fake.json.data[0].code !== '00000000', '前端伪造的 code 被忽略', fake.json && fake.json.data);

  const upd = await db(owner, {
    table: 'profiles', action: 'update',
    values: { name: '赵工（改）', code: '11111111' },
    filters: [{ op: 'eq', col: 'id', val: zhaoId }]
  });
  ok(upd.status === 200 && upd.json.data[0].code === zhaoCode, '编辑人员改不了 ID', upd.json && upd.json.data);

  const all = (await db(owner, { table: 'profiles', action: 'select' })).json.data;
  ok(all.every(p => /^\d{8}$/.test(p.code)), '团队里每个人都有 8 位 ID');
  ok(new Set(all.map(p => p.code)).size === all.length, '所有 ID 全局唯一');

  console.log('\n[2] 用 ID 登录：重名的人不会认错');
  const r1 = await api('/api/auth/register', { name: '同名', password: 'aaaaaa' });
  const r2 = await api('/api/auth/register', { name: '同名', password: 'bbbbbb' });
  ok(r1.status === 200 && r2.status === 200 && r1.json.user.code !== r2.json.user.code,
    '同名注册各拿一个 ID', [r1.json && r1.json.error, r2.json && r2.json.error]);
  const c1 = r1.json.user.code, c2 = r2.json.user.code;
  const l1 = await api('/api/auth/login', { account: c1, password: 'aaaaaa' });
  ok(l1.status === 200 && l1.json.user.id === r1.json.user.id, '按 ID 精确登录第一个', l1.json && l1.json.error);
  const l2 = await api('/api/auth/login', { account: c2, password: 'bbbbbb' });
  ok(l2.status === 200 && l2.json.user.id === r2.json.user.id, '按 ID 精确登录第二个', l2.json && l2.json.error);
  ok((await api('/api/auth/login', { account: c1, password: 'bbbbbb' })).status === 401, 'ID 对了密码错也进不去');
  ok((await api('/api/auth/login', { name: '王老板', password: '123456' })).status === 200, '姓名仍可登录（向后兼容）');

  const s1 = await api('/api/auth/register', { name: '同名同密', password: 'cccccc' });
  await api('/api/auth/register', { name: '同名同密', password: 'cccccc' });
  const amb = await api('/api/auth/login', { name: '同名同密', password: 'cccccc' });
  ok(amb.status === 409 && /ID/.test(amb.json.error || ''), '同名同密码按姓名登录会提示改用 ID', amb.json);
  ok((await api('/api/auth/login', { account: s1.json.user.code, password: 'cccccc' })).status === 200, '改用 ID 就能登');
  const ambRecover = await api('/api/auth/recover/start', { account: '同名同密' });
  ok(ambRecover.status === 404 && /ID/.test(ambRecover.json.error || ''), '同名时找回密码也要求改用 ID', ambRecover.json);

  console.log('\n[3] 邮箱找回密码');
  const fakeS = await fakeSmtp();
  const acc = await db(owner, {
    table: 'mail_accounts', action: 'insert',
    values: { label: '测试发信', kind: 'smtp', host: '127.0.0.1', port: fakeS.port,
      user: 'noreply@example.com', pass: 'p', from_addr: 'noreply@example.com', priority: 10, daily_limit: 0 }
  });
  ok(acc.status === 200, '配置发信账号', acc.json);
  const sendCode = await api('/api/auth/email/code', { email: 'owner@example.com' }, owner);
  ok(sendCode.status === 200, '发出邮箱验证码', sendCode.json);
  const vcode = codeFromRaw(fakeS.state.mails[fakeS.state.mails.length - 1] || '');
  ok(/^\d{6}$/.test(vcode), '从邮件里取到 6 位验证码：' + vcode);
  const verified = await api('/api/auth/email/verify', { code: vcode }, owner);
  ok(verified.status === 200 && verified.json.ok, '邮箱验证通过', verified.json);

  const start = await api('/api/auth/recover/start', { account: ownerCode });
  ok(start.status === 200 && start.json.ok, '用 ID 申请找回密码', start.json);
  ok(start.json.email && start.json.email.indexOf('@example.com') >= 0 && start.json.email.indexOf('owner@') < 0,
    '回显的是打码邮箱，不泄露完整地址', start.json.email);
  const again = await api('/api/auth/recover/start', { account: ownerCode });
  ok(again.status === 429 && /秒后/.test(again.json.error || ''), '60 秒内不能重复发（限流生效）', again.json);
  const rcode = codeFromRaw(fakeS.state.mails[fakeS.state.mails.length - 1] || '');
  ok(/^\d{6}$/.test(rcode), '从找回密码邮件里取到验证码：' + rcode);

  ok((await api('/api/auth/recover/verify', { account: ownerCode, code: rcode, password: '123' })).status === 400,
    '过短的新密码被拒绝');
  const wrong = await api('/api/auth/recover/verify',
    { account: ownerCode, code: rcode === '000000' ? '111111' : '000000', password: 'newpass123' });
  ok(wrong.status === 400 && /验证码/.test(wrong.json.error || ''), '错码被拒绝', wrong.json);
  const done = await api('/api/auth/recover/verify', { account: ownerCode, code: rcode, password: 'newpass123' });
  ok(done.status === 200 && done.json.ok, '正确验证码 + 新密码重设成功', done.json);
  ok((await api('/api/auth/login', { account: ownerCode, password: '123456' })).status === 401, '旧密码立刻失效');
  const fresh = await api('/api/auth/login', { account: ownerCode, password: 'newpass123' });
  ok(fresh.status === 200 && fresh.json.token, '新密码可以登录', fresh.json && fresh.json.error);
  ok((await api('/api/auth/me', null, owner)).status === 401, '找回密码后，之前登录着的设备全部下线');
  ok((await api('/api/auth/recover/verify', { account: ownerCode, code: rcode, password: 'otherpass1' })).status === 400,
    '验证码用过一次就作废');

  try { fakeS.srv.close(); } catch (e) {}
  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('测试异常：', e);
  process.exit(1);
});
