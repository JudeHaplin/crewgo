/* 登录设备与密码：改密码踢掉所有其它设备、单台下线、设备列表、管理员重设密码 */
const BASE = process.env.BASE || 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); }
};

/** 每次请求带不同的 UA，模拟「另一台设备」 */
async function api(path, body, token, ua) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (ua) headers['User-Agent'] = ua;
  const res = await fetch(BASE + path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch (e) { /* 空响应 */ }
  return { status: res.status, json };
}
const db = (token, q) => api('/api/db', q, token);

const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.44';
const PC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36';
const TAB_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15';

(async () => {
  console.log('\n[1] 初始化：第一次登录就有一台设备');
  const setup = await api('/api/auth/setup', { name: '王建国', password: 'admin2026', phone: '13800000001' }, null, PC_UA);
  ok(setup.status === 200 && setup.json.token, '初始化并拿到令牌');
  const admin = setup.json.token;
  const dev0 = await api('/api/auth/devices', null, admin);
  ok(dev0.status === 200 && dev0.json.devices.length === 1, '设备列表有 1 台');
  ok(dev0.json.devices[0].current === true, '那台被标成当前设备');
  ok(/Windows/.test(dev0.json.devices[0].ua), '记下了 UA（前端据此显示「Windows · Chrome」）');
  ok(dev0.json.devices[0].ip, '记下了 IP');

  console.log('\n[2] 同一账号在手机、Mac 上再各登一次');
  const phone = await api('/api/auth/login', { name: '王建国', password: 'admin2026' }, null, PHONE_UA);
  const mac = await api('/api/auth/login', { name: '王建国', password: 'admin2026' }, null, TAB_UA);
  ok(phone.status === 200 && phone.json.token !== admin, '手机登录拿到独立令牌');
  ok(mac.status === 200, 'Mac 登录成功');
  const dev1 = await api('/api/auth/devices', null, admin);
  ok(dev1.json.devices.length === 3, '三台设备都在列表里', dev1.json.devices.length);
  ok(dev1.json.devices.filter(d => d.current).length === 1, '只有一台是「当前设备」');

  console.log('\n[3] 同一设备重复登录不会刷出一堆记录');
  const again = await api('/api/auth/login', { name: '王建国', password: 'admin2026' }, null, PHONE_UA);
  const dev2 = await api('/api/auth/devices', null, again.json.token);
  ok(dev2.json.devices.length === 3, '还是 3 台，没有多出来', dev2.json.devices.length);

  console.log('\n[4] 单台下线：只影响那一台');
  const phoneSid = dev2.json.devices.filter(d => /iPhone/.test(d.ua))[0].id;
  const rv = await api('/api/auth/devices/revoke', { id: phoneSid }, admin);
  ok(rv.status === 200, '下线手机');
  ok((await api('/api/auth/me', null, phone.json.token)).status === 401, '手机上的令牌立刻失效');
  ok((await api('/api/auth/me', null, admin)).status === 200, '电脑不受影响');
  ok((await api('/api/auth/me', null, mac.json.token)).status === 200, 'Mac 不受影响');
  const rvAgain = await api('/api/auth/devices/revoke', { id: phoneSid }, admin);
  ok(rvAgain.status === 404, '重复下线同一台会报「已经下线」');

  console.log('\n[5] 不能借「下线」踢掉自己当前这台（要踢就退出登录）');
  const selfSid = (await api('/api/auth/devices', null, admin)).json.devices.filter(d => d.current)[0].id;
  const rvSelf = await api('/api/auth/devices/revoke', { id: selfSid }, admin);
  ok(rvSelf.status === 400, '拒绝下线当前设备');

  console.log('\n[6] 改密码：当前这台换新令牌，其它设备全部要重新登录');
  const phone2 = await api('/api/auth/login', { name: '王建国', password: 'admin2026' }, null, PHONE_UA);
  const chg = await api('/api/auth/password', { oldPassword: 'admin2026', newPassword: 'newpass2026' }, admin);
  ok(chg.status === 200 && chg.json.token, '改密码成功并返回新令牌');
  ok((await api('/api/auth/me', null, admin)).status === 401, '改密码前签发的老令牌作废');
  ok((await api('/api/auth/me', null, phone2.json.token)).status === 401, '手机被踢下线');
  ok((await api('/api/auth/me', null, mac.json.token)).status === 401, 'Mac 被踢下线');
  const adminNew = chg.json.token;
  ok((await api('/api/auth/me', null, adminNew)).status === 200, '当前这台用新令牌继续用，不用重新登录');
  const devAfter = await api('/api/auth/devices', null, adminNew);
  ok(devAfter.json.devices.length === 1, '设备列表只剩当前这台', devAfter.json.devices.length);
  ok((await api('/api/auth/login', { name: '王建国', password: 'admin2026' })).status === 401, '旧密码登不进来');
  ok((await api('/api/auth/login', { name: '王建国', password: 'newpass2026' })).status === 200, '新密码可以登录');

  console.log('\n[7] 其它设备全部下线 / 全部下线');
  const d1 = await api('/api/auth/login', { name: '王建国', password: 'newpass2026' }, null, PHONE_UA);
  const d2 = await api('/api/auth/login', { name: '王建国', password: 'newpass2026' }, null, TAB_UA);
  const kick = await api('/api/auth/devices/revoke-others', {}, adminNew);
  ok(kick.status === 200 && kick.json.revoked === 2, '一次踢掉 2 台', kick.json);
  ok((await api('/api/auth/me', null, d1.json.token)).status === 401 && (await api('/api/auth/me', null, d2.json.token)).status === 401, '两台都被踢');
  ok((await api('/api/auth/me', null, adminNew)).status === 200, '当前这台留着');
  const all = await api('/api/auth/devices/revoke-others', { all: true }, adminNew);
  ok(all.status === 200 && all.json.all === true, '「全部下线」执行了');
  ok((await api('/api/auth/me', null, adminNew)).status === 401, '连当前这台也失效了');

  console.log('\n[8] 管理员重设别人的密码 → 那个人所有设备下线');
  const adminLogin = await api('/api/auth/login', { name: '王建国', password: 'newpass2026' }, null, PC_UA);
  const adminTok = adminLogin.json.token;
  const mk = await db(adminTok, {
    table: 'profiles', action: 'insert',
    values: { id: 'p_zhang', name: '张工', role: 'tech', phone: '13800000009', pin: 'zhang2026' }
  });
  ok(mk.status === 200, '新建张工（带初始密码）');
  const zhang = await api('/api/auth/login', { name: '张工', password: 'zhang2026' }, null, PHONE_UA);
  ok(zhang.status === 200 && zhang.json.token, '张工登录成功');
  const reset = await db(adminTok, {
    table: 'profiles', action: 'update',
    values: { pin: 'zhang8888' }, filters: [{ op: 'eq', col: 'id', val: 'p_zhang' }]
  });
  ok(reset.status === 200, '管理员重设密码');
  ok((await api('/api/auth/me', null, zhang.json.token)).status === 401, '张工原来那台被踢下线');
  ok((await api('/api/auth/login', { name: '张工', password: 'zhang2026' })).status === 401, '旧密码不能用了');
  ok((await api('/api/auth/login', { name: '张工', password: 'zhang8888' })).status === 200, '新密码可以登录');
  ok((await api('/api/auth/me', null, adminTok)).status === 200, '管理员自己没被误伤');

  console.log('\n[9] 管理员给自己重设密码只踢其它设备');
  const adminPhone = await api('/api/auth/login', { name: '王建国', password: 'newpass2026' }, null, PHONE_UA);
  const selfReset = await db(adminTok, {
    table: 'profiles', action: 'update',
    values: { pin: 'boss2026' }, filters: [{ op: 'eq', col: 'id', val: adminLogin.json.user.id }]
  });
  ok(selfReset.status === 200, '给自己重设密码');
  ok((await api('/api/auth/me', null, adminTok)).status === 200, '当前这台还活着，不会被弹回登录页');
  ok((await api('/api/auth/me', null, adminPhone.json.token)).status === 401, '自己的其它设备被踢');

  console.log('\n[10] 退出登录只撤当前设备；停用账号立即失效');
  const a1 = await api('/api/auth/login', { name: '王建国', password: 'boss2026' }, null, PC_UA);
  const a2 = await api('/api/auth/login', { name: '王建国', password: 'boss2026' }, null, PHONE_UA);
  const out = await api('/api/auth/logout', {}, a1.json.token);
  ok(out.status === 200, '退出登录返回 ok');
  ok((await api('/api/auth/me', null, a1.json.token)).status === 401, '退出的这台失效');
  ok((await api('/api/auth/me', null, a2.json.token)).status === 200, '另一台还在');
  await db(a2.json.token, {
    table: 'profiles', action: 'update',
    values: { active: false }, filters: [{ op: 'eq', col: 'id', val: adminLogin.json.user.id }]
  });
  ok((await api('/api/auth/me', null, a2.json.token)).status === 401, '停用后令牌立刻失效');

  console.log('\n[11] 旧字段名仍然兼容（老缓存页面 / 老脚本）');
  await db(a2.json.token, {
    table: 'profiles', action: 'update',
    values: { active: true }, filters: [{ op: 'eq', col: 'id', val: adminLogin.json.user.id }]
  }).catch(() => {});
  const legacyLogin = await api('/api/auth/login', { name: '张工', pin: 'zhang8888' });
  ok(legacyLogin.status === 200, '登录接口仍收 pin 字段');
  const legacyChg = await api('/api/auth/pin', { oldPin: 'zhang8888', newPin: 'zhang9999' }, legacyLogin.json.token);
  ok(legacyChg.status === 200 && legacyChg.json.token, '/api/auth/pin 与 oldPin/newPin 仍可用');

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
