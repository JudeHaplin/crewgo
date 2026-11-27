/*
  关于页 + 头像
  ------------------------------------------------------------
  · 简介所有人可见；更新日志只给管理员（普通成员拿到 null）
  · 只有统筹能改/清空；管理员和成员都改不了
  · 头像是本人上传，只收图片 data URL、限大小；/api/db 改不动 avatar
  · 头像会随备份导出
*/
'use strict';

const BASE = process.env.BASE || 'http://127.0.0.1:8311';
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

(async () => {
  console.log('\n[1] 准备三种角色');
  const setup = await api('/api/auth/setup', { username: 'boss', name: '老板', password: '123456' });
  ok(setup.status === 200 && setup.json.token, '初始化统筹');
  const owner = setup.json.token;

  const ins1 = await db(owner, { table: 'profiles', action: 'insert', values: { name: '张三', role: 'tech', pin: '123456' } });
  const ins2 = await db(owner, { table: 'profiles', action: 'insert', values: { name: '李四', role: 'tech', pin: '123456' } });
  ok(ins1.status === 200 && ins2.status === 200, '加两个成员');
  const zhangId = ins1.json.data[0].id, liId = ins2.json.data[0].id;

  const m1 = await api('/api/auth/login', { username: '张三', password: '123456' });
  const member = m1.json.token;
  await api('/api/team/members/role', { id: liId, role: 'admin' }, owner);
  const m2 = await api('/api/auth/login', { username: '李四', password: '123456' });
  const admin = m2.json.token;
  ok(!!member && !!admin, '三种角色都拿到令牌');

  console.log('\n[2] 关于页的可见性');
  const o = await api('/api/about', undefined, owner);
  ok(o.status === 200 && !!o.json.intro && !!o.json.version, '统筹能看到简介和版本号', o.json);
  ok(o.json.canEdit === true && o.json.canSeeChangelog === true, '统筹可编辑、可见更新日志');
  ok(typeof o.json.changelog === 'string' && o.json.changelog.indexOf('1.2.') >= 0, '更新日志带内置的版本记录');
  const ad = await api('/api/about', undefined, admin);
  ok(ad.json.canSeeChangelog === true && ad.json.canEdit === false, '管理员能看更新日志但不能改');
  const mb = await api('/api/about', undefined, member);
  ok(mb.json.changelog === null && mb.json.canSeeChangelog === false, '普通成员看不到更新日志', mb.json);
  ok(!!mb.json.intro, '普通成员能看简介');

  console.log('\n[3] 只有统筹能改');
  ok((await api('/api/about', { intro: 'hack' }, member)).status === 403, '成员改不了');
  ok((await api('/api/about', { intro: 'hack' }, admin)).status === 403, '管理员也改不了');
  const save = await api('/api/about', { intro: '我们组的维修派单系统', changelog: '1.0 上线' }, owner);
  ok(save.status === 200 && save.json.intro === '我们组的维修派单系统', '统筹能改简介', save.json);
  ok(save.json.changelog === '1.0 上线', '统筹能改更新日志');
  const mb2 = await api('/api/about', undefined, member);
  ok(mb2.json.intro === '我们组的维修派单系统', '成员随后看到新简介');
  ok((await api('/api/about', { intro: 'x'.repeat(4001) }, owner)).status === 400, '简介超长被拒');
  ok((await api('/api/about', { changelog: 'x'.repeat(20001) }, owner)).status === 400, '更新日志超长被拒');

  console.log('\n[4] 清空（等于删掉两项）');
  const clear = await api('/api/about', { intro: '', changelog: '' }, owner);
  ok(clear.status === 200 && clear.json.intro === '' && clear.json.changelog === '', '清空后返回空串', clear.json);
  const mb3 = await api('/api/about', undefined, member);
  ok(mb3.json.intro === '', '成员看到的是空简介', mb3.json.intro);

  console.log('\n[5] 头像');
  const png = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const up = await api('/api/auth/avatar', { dataUrl: png }, member);
  ok(up.status === 200 && up.json.avatar === png, '本人能上传头像', up.json && up.json.error);
  ok(up.json.user && up.json.user.avatar === png, '返回的 user 里带新头像');
  ok((await api('/api/auth/me', null, member)).json.user.avatar === png, '/api/auth/me 也带头像');
  ok((await api('/api/auth/avatar', { dataUrl: 'data:text/html;base64,AAAA' }, member)).status === 400, '非图片 dataUrl 被拒');
  ok((await api('/api/auth/avatar', { dataUrl: 'javascript:alert(1)' }, member)).status === 400, 'javascript 伪协议被拒');
  const huge = 'data:image/png;base64,' + 'A'.repeat(420 * 1024);
  ok((await api('/api/auth/avatar', { dataUrl: huge }, member)).status === 400, '超大图片被拒');
  const viaDb = await db(member, {
    table: 'profiles', action: 'update',
    values: { avatar: 'data:image/png;base64,AAAA' },
    filters: [{ op: 'eq', col: 'id', val: zhangId }]
  });
  ok(viaDb.status === 200 && ((viaDb.json && viaDb.json.data) || []).length === 0, '走 /api/db 改不了头像（字段被剥掉）', viaDb.json);
  ok((await api('/api/auth/me', null, member)).json.user.avatar === png, '头像保持原样，没被 /api/db 覆盖');
  const rm = await api('/api/auth/avatar', { dataUrl: '' }, member);
  ok(rm.status === 200 && rm.json.avatar === null, '能清空头像');
  ok((await api('/api/auth/me', null, member)).json.user.avatar === null, '清空后 me 里也没有');

  console.log('\n[6] 头像随备份导出');
  await api('/api/auth/avatar', { dataUrl: png }, member);
  const exp = await fetch(BASE + '/api/backup/export?format=json', { headers: { Authorization: 'Bearer ' + owner } });
  const payload = await exp.json();
  const row = (payload.data.profiles || []).filter(p => p.id === zhangId)[0];
  ok(row && row.avatar === png, '导出的 JSON 里有头像', row && String(row.avatar).slice(0, 30));

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('测试异常：', e);
  process.exit(1);
});
