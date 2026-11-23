/* 接口自测：初始化 → 增删改查 → 权限边界 */
const BASE = process.env.BASE || 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); }
};

async function api(path, body, token, method) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method: method || (body ? 'POST' : 'GET'), headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch (e) {}
  return { status: res.status, json };
}
const db = (token, q) => api('/api/db', q, token);

(async () => {
  console.log('\n[1] 初始化与登录');
  const setup = await api('/api/auth/setup', { name: '王建国', pin: '1234' });
  ok(setup.status === 200 && setup.json.token, '初始化管理员返回 token');
  ok(setup.json.user.role === 'admin', '第一个账号是 admin');
  const admin = setup.json.token;

  const again = await api('/api/auth/setup', { name: '李四', pin: '1234' });
  ok(again.status === 409, '重复初始化被拒绝');

  const badLogin = await api('/api/auth/login', { name: '王建国', pin: '0000' });
  ok(badLogin.status === 401, 'PIN 错误被拒绝');

  const me = await api('/api/auth/me', null, admin);
  ok(me.status === 200 && me.json.user.name === '王建国', '/api/auth/me 正常');

  console.log('\n[2] 管理员建项目 / 建人员');
  const proj = await db(admin, { table: 'projects', action: 'insert', values: { name: '阳光小区', address: '3栋', color: '#2b6ef6', sort_order: 1 } });
  ok(proj.status === 200 && proj.json.data[0].id === 1, '新增项目返回自增 id');
  ok(proj.json.data[0].active === true, '布尔字段返回 true 而不是 1');

  const tech = await db(admin, { table: 'profiles', action: 'insert', values: { name: '张工', role: 'tech', phone: '13800000001', email: 'zhang@example.com', pin: '5678', color: '#0f9d76' } });
  ok(tech.status === 200 && tech.json.data[0].id, '新增维修工');
  ok(!tech.json.data[0].pin_hash, '接口不回传 pin_hash');
  const techId = tech.json.data[0].id;

  console.log('\n[3] 维修工登录后的权限边界');
  const tlogin = await api('/api/auth/login', { name: '张工', pin: '5678' });
  ok(tlogin.status === 200 && tlogin.json.user.role === 'tech', '维修工可用姓名+PIN 登录');
  const token = tlogin.json.token;

  const tProj = await db(token, { table: 'projects', action: 'insert', values: { name: '偷偷加的项目' } });
  ok(tProj.status === 403, '维修工不能建项目', tProj.json);

  const tSettings = await db(token, { table: 'settings', action: 'update', values: { digest_email: 'x@y.com' }, filters: [{ op: 'eq', col: 'id', val: 1 }] });
  ok(tSettings.status === 403, '维修工不能改通知设置');

  const tSelf = await db(token, { table: 'profiles', action: 'update', values: { phone: '13900000000' }, filters: [{ op: 'eq', col: 'id', val: techId }] });
  ok(tSelf.status === 200 && tSelf.json.data[0].phone === '13900000000', '可以改自己的手机号');

  const tRole = await db(token, { table: 'profiles', action: 'update', values: { role: 'admin' }, filters: [{ op: 'eq', col: 'id', val: techId }] });
  ok(tRole.status === 403, '不能给自己提权成 admin');

  console.log('\n[4] 预约单流转');
  const appt = await db(token, {
    table: 'appointments', action: 'insert',
    values: { project_id: 1, project_name: '阳光小区', tech_id: techId, tech_name: '张工', visit_date: '2026-11-24', time_slot: '上午', address: '阳光小区3栋501', content: '厨房漏水', contact_name: '刘女士', contact_phone: '13800000001', status: '待确认', priority: '加急' }
  });
  ok(appt.status === 200 && appt.json.data[0].id === 1, '新建预约成功');
  ok(appt.json.data[0].owner_id === techId, 'owner_id 自动记为创建人');
  const apptId = appt.json.data[0].id;

  const list = await db(token, { table: 'appointments', action: 'select', columns: '*', order: [{ col: 'visit_date', asc: false }], limit: 100 });
  ok(list.status === 200 && list.json.data.length === 1, '预约列表可读');

  const cnt = await db(token, { table: 'appointments', action: 'select', columns: 'id', head: true });
  ok(cnt.json.count === 1, 'head 查询返回 count');

  const notif = await db(token, { table: 'notifications', action: 'insert', values: { owner_id: 'someone-else', appointment_id: apptId, title: '测试', body: 'test' } });
  ok(notif.status === 200 && notif.json.data[0].owner_id === 'someone-else', '通知可写');

  console.log('\n[5] 越权删除与管理员操作');
  const otherTech = await db(admin, { table: 'profiles', action: 'insert', values: { name: '李工', role: 'tech', pin: '9999' } });
  const llogin = await api('/api/auth/login', { name: '李工', pin: '9999' });
  const ltoken = llogin.json.token;
  const delOther = await db(ltoken, { table: 'appointments', action: 'delete', filters: [{ op: 'eq', col: 'id', val: apptId }] });
  ok(delOther.status === 403, '非创建人不能删别人的预约', delOther.json);

  const delAdmin = await db(admin, { table: 'appointments', action: 'delete', filters: [{ op: 'eq', col: 'id', val: apptId }] });
  ok(delAdmin.status === 200, '管理员可删除');
  ok((await db(admin, { table: 'appointments', action: 'select' })).json.data.length === 0, '删除后列表为空');

  const setOk = await db(admin, { table: 'settings', action: 'update', values: { email_enabled: true, digest_email: 'boss@example.com' }, filters: [{ op: 'eq', col: 'id', val: 1 }] });
  ok(setOk.status === 200 && setOk.json.data[0].email_enabled === true, '管理员可改通知设置并返回布尔');

  const noFilter = await db(admin, { table: 'appointments', action: 'delete' });
  ok(noFilter.status === 400, '拒绝无条件删除');

  const wrongTable = await db(admin, { table: 'sqlite_master', action: 'select' });
  ok(wrongTable.status === 400, '拒绝非白名单表');

  console.log('\n[6] 改 PIN');
  const chg = await api('/api/auth/pin', { oldPin: '5678', newPin: '4321' }, token);
  ok(chg.status === 200, '本人可改 PIN');
  ok((await api('/api/auth/login', { name: '张工', pin: '5678' })).status === 401, '旧 PIN 失效');
  ok((await api('/api/auth/login', { name: '张工', pin: '4321' })).status === 200, '新 PIN 可登录');

  console.log('\n[7] 静态资源');
  for (const p of ['/', '/assets/app.js', '/assets/app.css', '/assets/local-cloud.js', '/favicon.ico', '/app/crewgo/']) {
    const r = await fetch(BASE + p);
    ok(r.status === 200 || r.status === 404, p + ' → ' + r.status + ' ' + (r.headers.get('content-type') || ''));
  }

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
