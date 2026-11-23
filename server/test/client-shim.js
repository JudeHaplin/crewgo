/* 前端适配层自测：用 vm 模拟浏览器环境，跑 app.js 真实会用到的调用序列 */
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (c, n, extra) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (extra ? ' → ' + JSON.stringify(extra) : ''))); };

const store = {};
const sandbox = {
  window: {},
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  },
  fetch: (p, init) => fetch(BASE + p, init),
  console,
  setTimeout, clearTimeout, URLSearchParams, location: { origin: BASE }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'local-cloud.js'), 'utf8'), sandbox);

const cloud = sandbox.window.WorkBuddyCloud.createWorkBuddyCloud({});
const db = cloud.database;

(async () => {
  console.log('\n[1] 适配层登录');
  const st = await cloud.auth.status();
  ok(typeof st.initialized === 'boolean', '/auth/status 可用', st);
  const su = await cloud.auth.setup('测试员', '1234');
  ok(su.error === null && su.data.user.name === '测试员', 'setup 返回 session');
  const sess = await cloud.auth.getSession();
  ok(sess.data && sess.data.user && sess.data.user.id, 'getSession 带 user.id');
  const uid = sess.data.user.id;

  console.log('\n[2] 链式查询形态');
  const stRow = await db.from('settings').select('*').eq('id', 1).maybeSingle();
  ok(stRow.error === null && stRow.data && stRow.data.id === 1, 'settings maybeSingle 返回对象', stRow);
  ok(stRow.data && typeof stRow.data.notify_enabled === 'boolean', 'notify_enabled 是布尔');

  const mine = await db.from('profiles').select('*').eq('user_id', uid).maybeSingle();
  ok(mine.data && mine.data.name === '测试员', '按 user_id 查自己');

  const proj = await db.from('projects').insert({ name: 'A区', sort_order: 2 }).select();
  await db.from('projects').insert({ name: 'B区', sort_order: 1 }).select();

  const ordered = await db.from('projects').select('*').order('sort_order', { ascending: true }).order('name', { ascending: true });
  ok(ordered.data.length === 2 && ordered.data[0].name === 'B区', '多字段排序生效', ordered.data.map(x => x.name));

  const cnt = await db.from('profiles').select('id', { count: 'exact', head: true });
  ok(cnt.count === 1 && cnt.data === null, 'head+count 返回条数', cnt);

  const unclaimed = await db.from('profiles').select('*').is('user_id', null);
  ok(Array.isArray(unclaimed.data) && unclaimed.data.length === 0, 'is(col, null) 查询可用');

  console.log('\n[3] 预约写入与更新');
  const ins = await db.from('appointments').insert({
    project_id: 1, project_name: 'A区', tech_id: uid, tech_name: '测试员',
    visit_date: '2026-11-25', time_slot: '下午', address: 'A区1栋', content: '试单', status: '待确认'
  }).select();
  ok(ins.data && ins.data[0] && ins.data[0].id, 'insert().select() 返回新行');
  const id = ins.data[0].id;

  const upd = await db.from('appointments').update({ status: '已完成' }).eq('id', id).select();
  ok(upd.data[0].status === '已完成', 'update().eq().select() 生效');

  const del = await db.from('appointments').delete().eq('id', id).select();
  ok(del.data.length === 1, 'delete().eq().select() 生效');

  console.log('\n[4] 错误形态（不抛异常，返回 error）');
  await db.from('profiles').insert({ name: '小工', role: 'tech', pin: '5678' }).select();
  const relogin = await cloud.auth.signIn('小工', '5678');
  ok(relogin.error === null && relogin.data.user.role === 'tech', '新增人员可直接用 PIN 登录');
  const denied = await db.from('settings').update({ digest_email: 'x@y.com' }).eq('id', 1).select();
  ok(denied.error && /统筹|权限/.test(denied.error.message), '越权返回 error 而不是抛出', denied.error);

  const selfOnly = await db.from('profiles').update({ role: 'admin' }).eq('id', 'someone').select();
  ok(selfOnly.error !== null, '非管理员改他人档案被拒');
  await cloud.auth.signIn('测试员', '1234');

  const badTable = await db.from('nope').select('*');
  ok(badTable.error !== null, '未知表返回 error');

  console.log('\n[5] 退出登录');
  await cloud.auth.signOut();
  ok((await cloud.auth.getSession()).data === null, 'signOut 后 session 为空');
  const afterOut = await db.from('projects').select('*');
  ok(afterOut.error !== null, '退出后查询被拒');

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
