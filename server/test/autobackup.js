/* 自动备份到邮箱：配置校验、权限、附件内容（团队 JSON / 整库 .db）、发送记录 */
const net = require('node:net');

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); }
};

async function api(path, body, token, method) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* 非 JSON */ }
  return { status: res.status, json };
}

/* ---------- 假 SMTP 服务器：能收多封，把每封 DATA 存进 mails ---------- */
function fakeSmtp(authCode) {
  return new Promise(resolve => {
    const mails = [];
    const srv = net.createServer(sock => {
      const cur = { from: '', to: '', data: '', authUser: '', authPass: '' };
      let buf = '';
      let inData = false;
      let step = '';
      let raw = '';
      sock.write('220 fake ESMTP ready\r\n');
      sock.on('data', chunk => {
        buf += chunk.toString('utf8');
        for (;;) {
          if (inData) {
            const end = buf.indexOf('\r\n.\r\n');
            if (end < 0) return;
            cur.data = buf.slice(0, end);
            buf = buf.slice(end + 5);
            inData = false;
            mails.push(cur);
            sock.write('250 2.0.0 Ok: queued\r\n');
            continue;
          }
          const nl = buf.indexOf('\r\n');
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          if (step === 'user') { cur.authUser = Buffer.from(line, 'base64').toString('utf8'); step = 'pass'; sock.write('334 UGFzc3dvcmQ6\r\n'); continue; }
          if (step === 'pass') {
            cur.authPass = Buffer.from(line, 'base64').toString('utf8');
            step = '';
            sock.write(cur.authPass === authCode ? '235 2.7.0 Accepted\r\n' : '535 5.7.8 Authentication failed\r\n');
            continue;
          }
          raw += line + '\n';
          const up = line.toUpperCase();
          if (up.startsWith('EHLO')) {
            sock.write('250-fake greets you\r\n250-AUTH LOGIN PLAIN\r\n250-SIZE 52428800\r\n250 8BITMIME\r\n');
          } else if (up.startsWith('HELO')) {
            sock.write('250 fake\r\n');
          } else if (up.startsWith('AUTH LOGIN')) {
            step = 'user';
            sock.write('334 VXNlcm5hbWU6\r\n');
          } else if (up.startsWith('AUTH PLAIN')) {
            const parts = Buffer.from(line.split(' ')[2] || '', 'base64').toString('utf8').split('\u0000');
            cur.authUser = parts[1] || '';
            cur.authPass = parts[2] || '';
            sock.write(cur.authPass === authCode ? '235 2.7.0 Accepted\r\n' : '535 5.7.8 Authentication failed\r\n');
          } else if (up.startsWith('MAIL FROM')) {
            cur.from = line.replace(/.*<([^>]*)>.*/, '$1');
            sock.write('250 2.1.0 Ok\r\n');
          } else if (up.startsWith('RCPT TO')) {
            cur.to = line.replace(/.*<([^>]*)>.*/, '$1');
            sock.write('250 2.1.5 Ok\r\n');
          } else if (up === 'DATA') {
            inData = true;
            sock.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (up === 'QUIT') {
            sock.write('221 2.0.0 Bye\r\n');
            sock.end();
          } else {
            sock.write('250 Ok\r\n');
          }
        }
      });
      sock.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv: srv, mails: mails, port: srv.address().port }));
  });
}

/** 从原始邮件里取某个 Content-Type 部分的 base64 正文并解码 */
function partBody(data, type) {
  const i = data.indexOf('Content-Type: ' + type);
  if (i < 0) return null;
  const blank = data.indexOf('\r\n\r\n', i);
  if (blank < 0) return null;
  const lines = data.slice(blank + 4).split('\r\n');
  const keep = [];
  for (const ln of lines) {
    if (ln.startsWith('--')) break;
    keep.push(ln);
  }
  return Buffer.from(keep.join(''), 'base64');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('\n[1] 准备账号 / 邮件服务 / 一条预约');
  const setup = await api('/api/auth/setup', { name: '管理员', pin: '830512' });
  ok(setup.status === 200 && setup.json.token, '初始化管理员（统筹）');
  const owner = setup.json.token;

  const fake = await fakeSmtp('abcd1234efgh5678');
  ok(fake.port > 0, '假 SMTP 服务器已监听 :' + fake.port);

  const cfg = await api('/api/db', {
    table: 'settings', action: 'update',
    values: {
      email_enabled: true, mail_mode: 'smtp',
      smtp_host: '127.0.0.1', smtp_port: fake.port,
      smtp_user: 'sender@qq.com', smtp_pass: 'abcd1234efgh5678',
      smtp_from: 'sender@qq.com', smtp_name: '速派'
    },
    filters: [{ op: 'eq', col: 'id', val: 1 }]
  }, owner);
  ok(cfg.status === 200, 'SMTP 账号已保存');

  const appt = await api('/api/db', {
    table: 'appointments', action: 'insert',
    values: { visit_date: '2026-12-01', time_slot: '上午', address: '3栋501', content: '修水管', status: '已确认' }
  }, owner);
  ok(appt.status === 200, '写入一条预约，备份里应该有它');

  console.log('\n[2] 默认状态');
  const st0 = await api('/api/backup/auto', undefined, owner);
  ok(st0.status === 200 && st0.json.enabled === false, '默认没开自动备份');
  ok(st0.json.hour === 3, '默认每天 3:00 发', st0.json);
  ok(st0.json.mail_ready === true && st0.json.smtp_ready === true, '发信账号可用');
  ok(st0.json.max_mb === 15, '附件上限 15MB');

  console.log('\n[3] 配置校验');
  const noMail = await api('/api/backup/auto', { enabled: true, email: '' }, owner);
  ok(noMail.status === 400, '开了自动备份但没填邮箱被拒', noMail.json);
  const badMail = await api('/api/backup/auto', { enabled: true, email: 'not-an-email' }, owner);
  ok(badMail.status === 400, '邮箱格式不对被拒', badMail.json);
  const save1 = await api('/api/backup/auto', { enabled: true, email: 'boss@example.com', hour: 99, full: false }, owner);
  ok(save1.status === 200 && save1.json.hour === 23, '小时数被夹到 0–23', save1.json);
  const st1 = await api('/api/backup/auto', undefined, owner);
  ok(st1.json.enabled === true && st1.json.email === 'boss@example.com', '配置已生效');

  console.log('\n[4] 权限：只有统筹能配置和触发');
  const member = await api('/api/auth/register', { name: '张工', pin: '123456', phone: '13800000009' });
  const tech = member.json.token;
  ok((await api('/api/backup/auto', undefined, tech)).status === 403, '普通成员看不到自动备份配置');
  ok((await api('/api/backup/auto', { enabled: false }, tech)).status === 403, '普通成员改不了');
  ok((await api('/api/backup/auto/run', {}, tech)).status === 403, '普通成员不能触发备份');

  console.log('\n[5] 立即备份一次：邮件与附件');
  fake.mails.length = 0;
  const run1 = await api('/api/backup/auto/run', {}, owner);
  ok(run1.status === 200 && run1.json.ok === true, '发送成功', run1.json);
  ok(/已发送到 boss@example\.com/.test(String(run1.json.note)), '返回了发送说明', run1.json.note);

  await sleep(300);
  const mail1 = fake.mails[0] || { data: '' };
  ok(fake.mails.length === 1, '假服务器收到一封', fake.mails.length);
  ok(mail1.to === 'boss@example.com', '收件人正确', mail1.to);
  ok(/^Subject: =\?UTF-8\?B\?/m.test(mail1.data), '中文主题做了 RFC2047 编码');
  ok(/Content-Type: multipart\/mixed/.test(mail1.data), '有附件时用 multipart/mixed');
  ok(/Content-Type: multipart\/alternative/.test(mail1.data), '正文仍然有 text + html 两份');
  ok(/Content-Disposition: attachment/.test(mail1.data), '带 Content-Disposition: attachment');
  ok(/filename\*=UTF-8''/.test(mail1.data), '中文附件名用 RFC 2231 编码', /filename[^\r\n]*/.exec(mail1.data));
  ok(/application\/json/.test(mail1.data), '附件是 JSON');

  const jsonBuf = partBody(mail1.data, 'application/json; charset=utf-8');
  ok(!!jsonBuf && jsonBuf.length > 100, '能解出 JSON 附件');
  let payload = null;
  try { payload = JSON.parse(String(jsonBuf)); } catch (e) { payload = null; }
  ok(!!payload && payload.app === 'crewgo', '附件是速派备份格式', payload && payload.app);
  ok(!!payload && payload.data.appointments.length === 1, '备份里有那条预约', payload && payload.data && payload.data.appointments.length);
  ok(!!payload && payload.data.settings && payload.data.settings.smtp_pass === null, 'JSON 备份里授权码已脱敏',
    payload && payload.data && payload.data.settings && payload.data.settings.smtp_pass);

  const textBuf = partBody(mail1.data, 'text/plain; charset=UTF-8');
  ok(!!textBuf && /备份/.test(String(textBuf)), '纯文本正文能读出来');

  console.log('\n[6] 防连点 + 整库附件');
  const again = await api('/api/backup/auto/run', {}, owner);
  ok(again.status === 429, '5 秒内再点被限流', again.json);

  await sleep(5200);
  const save2 = await api('/api/backup/auto', { enabled: true, email: 'boss@example.com', hour: 3, full: true }, owner);
  ok(save2.status === 200 && save2.json.full === true, '打开「同时附上整库 .db」');
  fake.mails.length = 0;
  const run2 = await api('/api/backup/auto/run', {}, owner);
  ok(run2.status === 200 && run2.json.ok === true, '带整库的备份发送成功', run2.json);
  await sleep(300);
  const mail2 = fake.mails[0] || { data: '' };
  ok(/application\/x-sqlite3/.test(mail2.data), '整库 .db 也在附件里');
  const dbBuf = partBody(mail2.data, 'application/x-sqlite3');
  ok(!!dbBuf && String(dbBuf.slice(0, 15)) === 'SQLite format 3', '解出来的确实是 SQLite 文件',
    dbBuf && String(dbBuf.slice(0, 15)));

  console.log('\n[7] 状态与发送记录');
  const st2 = await api('/api/backup/auto', undefined, owner);
  ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(st2.json.last_at)), '记下了上次备份时间', st2.json.last_at);
  ok(/已发送到/.test(String(st2.json.last_note)), '记下了上次结果', st2.json.last_note);

  const logs = await api('/api/db', { table: 'email_logs', action: 'select' }, owner);
  const rows = (logs.json && logs.json.data) || [];
  ok(rows.some(r => r.kind === 'backup' && r.status === 'sent'), 'email_logs 里有 backup 的成功记录');

  const srow = await api('/api/db', { table: 'settings', action: 'select' }, owner);
  const row0 = (srow.json && srow.json.data && srow.json.data[0]) || {};
  ok(!row0.last_backup_date, '手动发的不占用当天自动备份的名额', row0.last_backup_date);

  console.log('\n[8] 关闭自动备份');
  const off = await api('/api/backup/auto', { enabled: false, email: 'boss@example.com', hour: 3, full: false }, owner);
  ok(off.status === 200 && off.json.enabled === false, '可以再次关掉');
  const st3 = await api('/api/backup/auto', undefined, owner);
  ok(st3.json.enabled === false, '关掉后状态正确');

  console.log('\n[9] 定时判断：什么时候该发');
  const { dueNow } = require(require('node:path').join(__dirname, '../../server/src/autobackup'));
  const at = (h, m) => new Date(2026, 11, 1, h, m || 0);
  const base = { auto_backup: 1, backup_email: 'a@b.com', backup_hour: 3, last_backup_date: '' };
  ok(dueNow(base, at(2, 59)) === false, '还没到点不发');
  ok(dueNow(base, at(3, 0)) === true, '到点就发');
  ok(dueNow(Object.assign({}, base, { last_backup_date: '2026-12-01' }), at(9)) === false, '今天已经发过就不再发');
  ok(dueNow(Object.assign({}, base, { auto_backup: 0 }), at(9)) === false, '关掉的不发');
  ok(dueNow(Object.assign({}, base, { backup_email: '' }), at(9)) === false, '没填邮箱不发');
  ok(dueNow(Object.assign({}, base, { backup_hour: 23 }), at(9)) === false, '设的是晚上 23 点，上午不发');
  ok(dueNow(Object.assign({}, base, { backup_hour: 0 }), at(0, 5)) === true, '设 0 点，过了 0 点就发');

  try { fake.srv.close(); } catch (e) { /* ignore */ }
  console.log('\n' + (fail ? '✗ ' + fail + ' 项失败，' + pass + ' 项通过' : '✓ 全部 ' + pass + ' 项通过'));
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('测试异常：', e);
  process.exit(1);
});
