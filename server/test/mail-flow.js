/*
  多邮箱服务 + 邮箱验证 的端到端测试
  ------------------------------------------------------------
  · 普通成员能自己设「通知邮箱 / PushPlus Token」（之前会被权限拦掉）
  · 邮箱要用验证码验证一遍，验证码真的发到邮箱里（用假 SMTP 收）
  · 一个团队可以配多个发信账号；前一个报「超限」自动换下一个
  · 发信账号 / 导入导出只有团队统筹能改（系统稳定、数据安全）
  · 管理员之间权限相同：可以互相移出，但不能动统筹
*/
const net = require('node:net');

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* 可能是文件 */ }
  return { status: res.status, json };
}
const db = (token, q) => api('/api/db', q, token);

/* ---------- 假 SMTP：quota=true 时 DATA 阶段回「超限」 ---------- */
function fakeSmtp(opts) {
  opts = opts || {};
  return new Promise(resolve => {
    const state = { mails: [], quotaHits: 0, conns: 0, lastUser: '' };
    const srv = net.createServer(sock => {
      state.conns++;
      let buf = '';
      let inData = false;
      let step = '';
      sock.write('220 fake ESMTP ready\r\n');
      sock.on('data', chunk => {
        buf += chunk.toString('utf8');
        for (;;) {
          if (inData) {
            const end = buf.indexOf('\r\n.\r\n');
            if (end < 0) return;
            const data = buf.slice(0, end);
            buf = buf.slice(end + 5);
            inData = false;
            if (opts.quota) {
              state.quotaHits++;
              sock.write('452 4.7.0 Too many messages, quota exceeded\r\n');
            } else {
              state.mails.push(data);
              sock.write('250 2.0.0 Ok: queued\r\n');
            }
            continue;
          }
          const nl = buf.indexOf('\r\n');
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          if (step === 'user') { state.lastUser = Buffer.from(line, 'base64').toString('utf8'); step = 'pass'; sock.write('334 UGFzc3dvcmQ6\r\n'); continue; }
          if (step === 'pass') { step = ''; sock.write('235 2.7.0 Accepted\r\n'); continue; }
          const up = line.toUpperCase();
          if (up.startsWith('EHLO')) sock.write('250-fake\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n');
          else if (up.startsWith('HELO')) sock.write('250 fake\r\n');
          else if (up.startsWith('AUTH LOGIN')) { step = 'user'; sock.write('334 VXNlcm5hbWU6\r\n'); }
          else if (up.startsWith('AUTH PLAIN')) {
            const parts = Buffer.from(line.split(' ')[2] || '', 'base64').toString('utf8').split('\u0000');
            state.lastUser = parts[1] || '';
            sock.write('235 2.7.0 Accepted\r\n');
          }
          else if (up.startsWith('MAIL FROM')) sock.write('250 2.1.0 Ok\r\n');
          else if (up.startsWith('RCPT TO')) sock.write('250 2.1.5 Ok\r\n');
          else if (up === 'DATA') { inData = true; sock.write('354 End data\r\n'); }
          else if (up === 'QUIT') { sock.write('221 Bye\r\n'); sock.end(); }
          else if (up.startsWith('RSET') || up.startsWith('NOOP')) sock.write('250 Ok\r\n');
          else sock.write('500 Unknown\r\n');
        }
      });
      sock.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, state, port: srv.address().port }));
  });
}

/** 从原始邮件里把 base64 正文解出来，找 6 位验证码 */
function codeFromRaw(raw) {
  const flat = String(raw || '').replace(/\r?\n/g, '');
  const chunks = flat.match(/[A-Za-z0-9+/=]{40,}/g) || [];
  let text = '';
  for (const c of chunks) {
    try { text += Buffer.from(c, 'base64').toString('utf8'); } catch (e) { /* ignore */ }
  }
  const m = text.match(/<b>(\d{6})<\/b>/) || text.match(/(?:验证码|code)[^\d]{0,20}(\d{6})/) || text.match(/\b(\d{6})\b/);
  return m ? m[1] : '';
}

(async () => {
  console.log('\n[1] 统筹建团队 + 一个普通成员');
  const setup = await api('/api/auth/setup', { name: '王老板', pin: '123456', phone: '13800000001' });
  ok(setup.status === 200 && setup.json.token, '初始化（王老板是统筹）');
  const owner = setup.json.token;
  const teamId = setup.json.team.id;

  const ins = await db(owner, {
    table: 'profiles', action: 'insert',
    values: [{ id: 'p_zhang', name: '张工', phone: '13800000009', role: 'tech', pin: '123456', active: true }]
  });
  ok(ins.status === 200 && ins.json.data.length === 1, '统筹添加维修工张工', ins.json);
  const login = await api('/api/auth/login', { name: '张工', pin: '123456' });
  ok(login.status === 200 && login.json.token, '张工能登录');
  const tech = login.json.token;
  ok(login.json.user.team_role === 'member', '张工是普通成员');

  console.log('\n[2] 普通成员自己设通知邮箱 / PushPlus（原来会报「只能由团队管理员修改」）');
  const self = await db(tech, {
    table: 'profiles', action: 'update',
    values: { email: 'zhang@example.com', push_token: 'tk-zhang' },
    filters: [{ op: 'eq', col: 'id', val: 'p_zhang' }]
  });
  ok(self.status === 200 && self.json.data && self.json.data.length === 1, '成员能改自己的邮箱与 Token', self.json);
  ok(self.json.data && self.json.data[0].email === 'zhang@example.com', '邮箱已保存');
  ok(self.json.data && self.json.data[0].push_token === 'tk-zhang', 'PushPlus Token 已保存');
  const me1 = await api('/api/auth/me', null, tech);
  ok(me1.json.user.email_verified === false, '刚填的邮箱是「未验证」状态');

  const steal = await db(tech, {
    table: 'profiles', action: 'update',
    values: { email: 'hacker@example.com' },
    filters: [{ op: 'eq', col: 'id', val: 'p_zhang'.replace('zhang', 'nobody') }]
  });
  ok(steal.status === 200 || steal.status === 403, '改不存在的/别人的资料不会成功', steal.json);

  console.log('\n[3] 成员不能碰邮箱服务（系统级配置）');
  const denyAcc = await db(tech, {
    table: 'mail_accounts', action: 'insert',
    values: { label: '偷配一个', kind: 'smtp', host: 'smtp.evil.com', user: 'a@b.com', pass: 'x' }
  });
  ok(denyAcc.status === 403 && /统筹/.test(denyAcc.json.error || ''), '成员不能新增发信账号', denyAcc.json);

  console.log('\n[4] 统筹配两个发信账号：A 已超限，B 正常');
  const fakeA = await fakeSmtp({ quota: true });
  const fakeB = await fakeSmtp();
  const accA = await db(owner, {
    table: 'mail_accounts', action: 'insert',
    values: { label: 'A-已限额', kind: 'smtp', host: '127.0.0.1', port: fakeA.port, user: 'a@qq.com', pass: 'pa', from_addr: 'a@qq.com', priority: 10, daily_limit: 500 }
  });
  const accB = await db(owner, {
    table: 'mail_accounts', action: 'insert',
    values: { label: 'B-备用', kind: 'smtp', host: '127.0.0.1', port: fakeB.port, user: 'b@qq.com', pass: 'pb', from_addr: 'b@qq.com', priority: 20, daily_limit: 0 }
  });
  ok(accA.status === 200 && accA.json.data.length === 1, '统筹新增账号 A');
  ok(accB.status === 200 && accB.json.data.length === 1, '统筹新增账号 B');
  ok(accA.json.data[0].pass === undefined && accA.json.data[0].pass_set === true, '授权码不回传，只给「已设置」标记');
  const accBId = accB.json.data[0].id;

  const readAsTech = await db(tech, { table: 'mail_accounts', action: 'select' });
  ok(readAsTech.json.data.length === 2 && readAsTech.json.data.every(a => a.pass === undefined), '成员能看到账号列表但看不到授权码');

  console.log('\n[5] 发信：A 超限 → 自动换 B 发出去');
  const send1 = await api('/api/mail/send', { to: 'zhang@example.com', subject: '派单', html: '<p>明天上午上门</p>', kind: 'assignment' }, tech);
  ok(send1.status === 200 && send1.json.ok === true, '发信成功（自动切换）', send1.json);
  ok(send1.json.account === 'B-备用', '实际用的是备用账号 B', send1.json.account);
  ok(fakeA.state.quotaHits >= 1, 'A 被尝试过并判为超限', fakeA.state.quotaHits);
  ok(fakeB.state.mails.length === 1, 'B 收到了这封信', fakeB.state.mails.length);

  const listAfter = await db(owner, { table: 'mail_accounts', action: 'select', order: [{ col: 'priority', asc: true }] });
  const rowA = listAfter.json.data.filter(a => a.label === 'A-已限额')[0];
  ok(rowA && rowA.exhausted_today === true, 'A 被标记为「今天额度用完」');
  ok(rowA && /452|quota|exceed/i.test(String(rowA.last_error || '')), '记下了上次的错误原因', rowA && rowA.last_error);

  const connsBefore = fakeA.state.conns;
  const send2 = await api('/api/mail/send', { to: 'zhang@example.com', subject: '第二封', html: '<p>第二次</p>' }, tech);
  ok(send2.status === 200 && send2.json.account === 'B-备用', '第二次仍然走 B');
  ok(fakeA.state.conns === connsBefore, 'A 今天被跳过，不再浪费一次连接');

  console.log('\n[6] 邮箱验证码：发出去 → 填回来 → 变「已验证」');
  const mailCountBefore = fakeB.state.mails.length;
  const code1 = await api('/api/auth/email/code', { email: 'zhang.new@example.com' }, tech);
  ok(code1.status === 200 && code1.json.ok === true, '给张工发验证码', code1.json);

  // 新地址先进 email_pending：验证没通过之前，原来能收信的地址不能被动
  const pend = await api('/api/auth/me', null, tech);
  ok(pend.json.user.email === 'zhang@example.com', '发码期间旧邮箱保持不变（不会先被换掉）', pend.json.user);
  ok(pend.json.user.email_pending === 'zhang.new@example.com', '新地址暂存在 email_pending', pend.json.user);

  const raw = fakeB.state.mails[fakeB.state.mails.length - 1] || '';
  const code = codeFromRaw(raw);
  ok(/^\d{6}$/.test(code), '从邮件正文里取到 6 位验证码（' + code + '）', code);

  const wrong = await api('/api/auth/email/verify', { code: code === '000000' ? '111111' : '000000' }, tech);
  ok(wrong.status === 400 && /不对/.test(wrong.json.error || ''), '错码被拒绝', wrong.json);

  const verify = await api('/api/auth/email/verify', { code }, tech);
  ok(verify.status === 200 && verify.json.ok === true, '正确验证码通过', verify.json);
  const me2 = await api('/api/auth/me', null, tech);
  ok(me2.json.user.email_verified === true, '邮箱状态变成「已验证」');
  ok(me2.json.user.email === 'zhang.new@example.com', '验证通过后才把新地址写进 email', me2.json.user);
  ok(!me2.json.user.email_pending, '验证完成后 email_pending 清空', me2.json.user);

  // 测试邮件：只有已验证的地址能发，收件人由服务端取
  const t1 = await api('/api/auth/email/test', {}, tech);
  ok(t1.status === 200 && t1.json.ok === true && t1.json.to === 'zhang.new@example.com', '已验证的邮箱能发测试信', t1.json);
  ok(fakeB.state.mails.length > mailCountBefore + 1, '测试信真的进了 SMTP 通道');
  const t2 = await api('/api/auth/email/test', {}, tech);
  ok(t2.status === 429 && /秒后/.test(t2.json.error || ''), '60 秒内不能连点发测试信', t2.json);

  const t0 = await api('/api/auth/email/test', {}, owner);
  ok(t0.status === 400 && /邮箱/.test(t0.json.error || ''), '没填邮箱的人不能发测试信', t0.json);

  const again = await api('/api/auth/email/code', { email: 'zhang@example.com' }, tech);
  ok(again.status === 429 && /秒后/.test(again.json.error || ''), '60 秒内不能重复发（防刷）', again.json);

  // 改邮箱会清掉验证状态，避免「验证 A 邮箱却收 B 的邮件」
  await db(tech, {
    table: 'profiles', action: 'update', values: { email: 'zhang2@example.com' },
    filters: [{ op: 'eq', col: 'id', val: 'p_zhang' }]
  });
  const me3 = await api('/api/auth/me', null, tech);
  ok(me3.json.user.email_verified === false, '换邮箱后重新变「未验证」');
  await db(tech, {
    table: 'profiles', action: 'update', values: { email: 'zhang@example.com' },
    filters: [{ op: 'eq', col: 'id', val: 'p_zhang' }]
  });

  console.log('\n[7] 涉及数据安全的操作只有统筹能做');
  const promote = await api('/api/team/members/role', { id: 'p_zhang', role: 'admin' }, owner);
  ok(promote.status === 200, '统筹把张工提成管理员');
  const techRelog = await api('/api/auth/login', { name: '张工', pin: '123456' });
  const adminTok = techRelog.json.token;

  ok((await api('/api/backup/export?format=json', undefined, adminTok)).status === 403, '管理员不能导出团队数据');
  ok((await db(adminTok, { table: 'mail_accounts', action: 'insert', values: { label: 'x', kind: 'smtp', host: 'h', user: 'u@u.com', pass: 'p' } })).status === 403, '管理员不能加发信账号');
  ok((await api('/api/mail/accounts/test', { id: accBId }, adminTok)).status === 403, '管理员不能测发信账号');
  ok((await api('/api/settings/wechat', undefined, adminTok)).status === 200, '管理员仍然能看微信配置（只读）');

  // 但业务操作照样能做：建项目、改预约、管人员
  const proj = await db(adminTok, { table: 'projects', action: 'insert', values: { name: '管理员建的项目' } });
  ok(proj.status === 200, '管理员能建项目（业务权限不受影响）', proj.json);

  console.log('\n[8] 管理员之间权限相同：可以互相移出，但动不了统筹');
  await db(owner, {
    table: 'profiles', action: 'insert',
    values: [{ id: 'p_li', name: '李工', role: 'tech', pin: '123456', active: true }]
  });
  ok((await api('/api/team/members/role', { id: 'p_li', role: 'admin' }, owner)).status === 200, '统筹把李工也提成管理员');

  await db(owner, {
    table: 'profiles', action: 'insert',
    values: [{ id: 'p_wang', name: '王工', role: 'tech', pin: '123456', active: true }]
  });
  ok((await api('/api/team/members/role', { id: 'p_wang', role: 'admin' }, adminTok)).status === 200, '管理员（张工）也能把成员提成管理员');
  ok((await api('/api/team/members/role', { id: 'p_wang', role: 'member' }, adminTok)).status === 200, '管理员也能把另一个管理员降为成员');
  const demoteOwner = await api('/api/team/members/role', { id: setup.json.user.id, role: 'member' }, adminTok);
  ok(demoteOwner.status === 403 && /统筹/.test(demoteOwner.json.error || ''), '管理员不能降统筹的身份', demoteOwner.json);
  ok((await api('/api/team/members/remove', { id: 'p_li' }, adminTok)).status === 200, '张工（管理员）能把另一个管理员移出');
  const ownerRow = await db(owner, { table: 'profiles', action: 'select', filters: [{ op: 'eq', col: 'id', val: setup.json.user.id }] });
  ok(ownerRow.json.data[0].team_role === 'owner', '统筹本人还是统筹');

  const kickOwner = await api('/api/team/members/remove', { id: setup.json.user.id }, adminTok);
  ok(kickOwner.status === 403 && /统筹/.test(kickOwner.json.error || ''), '管理员不能移出统筹（唯一例外）', kickOwner.json);

  console.log('\n[9] 统筹只能「转让」，不能「设置」；转让要密码 + 手输「确认」');
  const asRole = await api('/api/team/members/role', { id: 'p_zhang', role: 'owner' }, owner);
  ok(asRole.status === 400, '不能把人「设为统筹」，这条路根本不开放', asRole.json);
  const touchOwner = await api('/api/team/members/role', { id: setup.json.user.id, role: 'admin' }, adminTok);
  ok(touchOwner.status === 403 && /统筹/.test(touchOwner.json.error || ''), '管理员改不了统筹的身份', touchOwner.json);

  const noConfirm = await api('/api/team/owner', { id: 'p_zhang', pin: '123456' }, owner);
  ok(noConfirm.status === 400 && /确认/.test(noConfirm.json.error || ''), '没手输「确认」不能转让', noConfirm.json);
  const badPin = await api('/api/team/owner', { id: 'p_zhang', pin: '000000', confirm: '确认' }, owner);
  ok(badPin.status === 403 && /密码/.test(badPin.json.error || ''), '密码不对不能转让', badPin.json);
  const looseWord = await api('/api/team/owner', { id: 'p_zhang', pin: '123456', confirm: '确认转让' }, owner);
  ok(looseWord.status === 400, '「确认」必须原样两个字，多字也不行', looseWord.json);

  const moved = await api('/api/team/owner', { id: 'p_zhang', pin: '123456', confirm: '确认' }, owner);
  ok(moved.status === 200, '统筹成功转让给张工', moved.json);
  const oldMe = await api('/api/auth/me', null, owner);
  ok(oldMe.json.user.team_role === 'admin', '原统筹变成管理员');
  const newMe = await api('/api/auth/me', null, adminTok);
  ok(newMe.json.user.team_role === 'owner', '张工成为新的统筹管理员');
  ok((await api('/api/backup/export?format=json', undefined, adminTok)).status === 200, '新统筹能导出数据');
  ok((await api('/api/backup/export?format=json', undefined, owner)).status === 403, '原统筹（现在的管理员）导不动了');

  try { fakeA.srv.close(); fakeB.srv.close(); } catch (e) {}
  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('测试异常：', e);
  process.exit(1);
});
