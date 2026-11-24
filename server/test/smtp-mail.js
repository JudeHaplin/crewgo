/* SMTP 发信自测：假 SMTP 服务器验协议，接口验鉴权与错误映射 */
const net = require('node:net');

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
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
  try { json = await res.json(); } catch (e) {}
  return { status: res.status, json };
}

/* ---------- 假 SMTP 服务器 ---------- */
function fakeSmtp(authCode) {
  return new Promise(resolve => {
    const state = { authUser: '', authPass: '', from: '', to: '', data: '', subject: '' };
    const srv = net.createServer(sock => {
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
            state.data = buf.slice(0, end);
            buf = buf.slice(end + 5);
            inData = false;
            sock.write('250 2.0.0 Ok: queued\r\n');
            continue;
          }
          const nl = buf.indexOf('\r\n');
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          if (step === 'user') { state.authUser = Buffer.from(line, 'base64').toString('utf8'); step = 'pass'; sock.write('334 UGFzc3dvcmQ6\r\n'); continue; }
          if (step === 'pass') {
            state.authPass = Buffer.from(line, 'base64').toString('utf8');
            step = '';
            sock.write(state.authPass === authCode ? '235 2.7.0 Accepted\r\n' : '535 5.7.8 Authentication failed\r\n');
            continue;
          }
          const up = line.toUpperCase();
          if (up.startsWith('EHLO')) {
            sock.write('250-fake greets you\r\n250-AUTH LOGIN PLAIN\r\n250-SIZE 10485760\r\n250 8BITMIME\r\n');
          } else if (up.startsWith('HELO')) {
            sock.write('250 fake\r\n');
          } else if (up.startsWith('AUTH LOGIN')) {
            step = 'user';
            sock.write('334 VXNlcm5hbWU6\r\n');
          } else if (up.startsWith('AUTH PLAIN')) {
            const parts = Buffer.from(line.split(' ')[2] || '', 'base64').toString('utf8').split('\u0000');
            state.authUser = parts[1] || '';
            state.authPass = parts[2] || '';
            sock.write(state.authPass === authCode ? '235 2.7.0 Accepted\r\n' : '535 5.7.8 Authentication failed\r\n');
          } else if (up.startsWith('MAIL FROM')) {
            state.from = line.replace(/.*<([^>]*)>.*/, '$1');
            sock.write('250 2.1.0 Ok\r\n');
          } else if (up.startsWith('RCPT TO')) {
            state.to = line.replace(/.*<([^>]*)>.*/, '$1');
            sock.write('250 2.1.5 Ok\r\n');
          } else if (up === 'DATA') {
            inData = true;
            sock.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (up === 'QUIT') {
            sock.write('221 2.0.0 Bye\r\n');
            sock.end();
          } else if (up.startsWith('RSET') || up.startsWith('NOOP')) {
            sock.write('250 Ok\r\n');
          } else {
            sock.write('500 Unknown command\r\n');
          }
        }
      });
      sock.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, state, port: srv.address().port }));
  });
}

(async () => {
  console.log('\n[1] 准备账号与假邮件服务器');
  const setup = await api('/api/auth/setup', { name: '管理员', pin: '830512' });
  ok(setup.status === 200 && setup.json.token, '初始化管理员');
  const admin = setup.json.token;

  const fake = await fakeSmtp('abcd1234efgh5678');
  ok(fake.port > 0, '假 SMTP 服务器已监听 :' + fake.port);

  console.log('\n[2] 保存 SMTP 配置');
  const save = await api('/api/db', {
    table: 'settings', action: 'update',
    values: {
      email_enabled: true,
      mail_mode: 'smtp',
      smtp_host: '127.0.0.1',
      smtp_port: fake.port,
      smtp_user: 'sender@qq.com',
      smtp_pass: 'abcd1234efgh5678',
      smtp_from: 'sender@qq.com',
      smtp_name: '速派',
      digest_email: 'boss@example.com'
    },
    filters: [{ op: 'eq', col: 'id', val: 1 }]
  }, admin);
  ok(save.status === 200 && save.json.data[0].mail_mode === 'smtp', '邮件配置已保存');
  ok(save.json.data[0].smtp_pass === undefined, '接口不回传授权码');
  ok(save.json.data[0].smtp_pass_set === true, '只回传「授权码已设置」标记');

  console.log('\n[3] 通过接口发信 → 假服务器收到');
  const r1 = await api('/api/mail/send', {
    to: 'zhang@example.com', toName: '张工',
    subject: '【测试】派单通知 · 阳光小区',
    html: '<p>明天 09:00 上门，地址：3 栋 501</p>',
    kind: 'test'
  }, admin);
  ok(r1.status === 200 && r1.json.ok === true, '发信接口返回成功', r1.json);
  ok(r1.json.mode === 'smtp', '走的是 SMTP 模式');

  await new Promise(r => setTimeout(r, 200));
  ok(fake.state.authUser === 'sender@qq.com', 'AUTH LOGIN 用户名正确', fake.state.authUser);
  ok(fake.state.authPass === 'abcd1234efgh5678', 'AUTH LOGIN 授权码正确');
  ok(fake.state.from === 'sender@qq.com', 'MAIL FROM 正确', fake.state.from);
  ok(fake.state.to === 'zhang@example.com', 'RCPT TO 正确', fake.state.to);
  ok(/^Subject: =\?UTF-8\?B\?/m.test(fake.state.data), '中文主题做了 RFC2047 编码');
  ok(/multipart\/alternative/.test(fake.state.data), '正文是 multipart/alternative');
  ok(/Content-Type: text\/html; charset=UTF-8/.test(fake.state.data), '包含 HTML 部分');
  ok(/Content-Transfer-Encoding: base64/.test(fake.state.data), '正文 base64 编码');

  console.log('\n[4] 错误路径');
  const noAuth = await api('/api/mail/send', { to: 'zhang@example.com', subject: 'x' });
  ok(noAuth.status === 401, '未登录不能调用发信接口');

  const badMail = await api('/api/mail/send', { to: 'not-an-email', subject: 'x' }, admin);
  ok(badMail.status === 502 || badMail.status === 400, '收件人非法时被拒绝', badMail.json);

  // 把授权码改错，验证 535 的友好提示
  await api('/api/db', {
    table: 'settings', action: 'update',
    values: { smtp_pass: 'wrong-pass' },
    filters: [{ op: 'eq', col: 'id', val: 1 }]
  }, admin);
  const wrong = await api('/api/mail/send', { to: 'zhang@example.com', subject: '测试授权码错误' }, admin);
  ok(wrong.status === 502, '授权码错误时返回失败');
  ok(/535|授权码/.test(String(wrong.json && wrong.json.error)), '错误信息提示到授权码', wrong.json);

  console.log('\n[5] 发送记录');
  const logs = await api('/api/db', { table: 'email_logs', action: 'select', order: [{ col: 'created_at', asc: false }] }, admin);
  const rows = (logs.json && logs.json.data) || [];
  ok(rows.length >= 2, 'email_logs 写入了记录（' + rows.length + ' 条）');
  ok(rows.some(x => x.status === 'sent'), '有成功记录');
  ok(rows.some(x => x.status === 'failed'), '有失败记录');

  try { fake.srv.close(); } catch (e) {}
  console.log('\n' + (fail ? '✗ ' + fail + ' 项失败，' + pass + ' 项通过' : '✓ 全部 ' + pass + ' 项通过'));
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('测试异常：', e);
  process.exit(1);
});
