/* 老库升级：1.1.0 的库直接跑新版本，必须能起来、数据一条不丢。
   数据由 legacy-upgrade.prep.js 在起服务之前写好。 */
const BASE = process.env.BASE || 'http://127.0.0.1:8301';
let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};

async function api(path, body, token, method) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method: method || (body ? 'POST' : 'GET'), headers, body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* 非 JSON */ }
  return { status: res.status, json };
}
const db = (token, q) => api('/api/db', q, token);

(async () => {
  console.log('\n[1] 服务能起来（这一步就是历史上挂掉的地方）');
  const health = await api('/api/health');
  ok(health.status === 200 && health.json.ok === true, '健康检查通过，说明建库/迁移没抛异常', health.json);
  ok(typeof health.json.version === 'string' && health.json.version !== '0', '版本号读到了：' + health.json.version);

  const st = await api('/api/auth/status');
  ok(st.json.initialized === true, '认出这是已初始化的老库（不会又让你重新初始化）');

  console.log('\n[2] 老账号照旧能登');
  const bad = await api('/api/auth/login', { name: '王建国', pin: '9999' });
  ok(bad.status === 401, '错的老密码还是进不去');
  const login = await api('/api/auth/login', { name: '王建国', pin: '1234' });
  ok(login.status === 200 && login.json.token, '老 4 位 PIN 还能登录（哈希格式没变、不强制重设）', login.json && login.json.error);
  const admin = login.json.token;
  ok(login.json.user.team_role === 'owner', '原管理员自动成为团队统筹', login.json.user.team_role);
  ok(login.json.team && /^[A-Z]{3}\d{6}$/.test(login.json.team.code), '自动生成了团队和团队码：' + (login.json.team && login.json.team.code));

  const me = await api('/api/auth/me', null, admin);
  ok(me.json.team && me.json.team.name.indexOf('王建国') >= 0, '默认团队名用管理员名字：' + (me.json.team && me.json.team.name));

  const techLogin = await api('/api/auth/login', { name: '周红祥', pin: '5678' });
  ok(techLogin.status === 200 && techLogin.json.user.team_role === 'member', '普通维修工也在同一团队里，角色是成员');
  const tech = techLogin.json.token;
  const gone = await api('/api/auth/login', { name: '已离职的张工', pin: '1111' });
  ok(gone.status === 401, '已停用的账号升级后仍然不能登录');

  console.log('\n[3] 老数据一条不少');
  const appts = await db(admin, { table: 'appointments', action: 'select' });
  ok(appts.status === 200 && appts.json.data.length === 3, '3 条预约都在', appts.json.data && appts.json.data.length);
  ok(appts.json.data.every(a => a.team_id > 0), '每条预约都自动归到了团队');
  const a1 = appts.json.data.filter(a => a.visit_date === '2026-11-28')[0];
  ok(a1 && a1.content === '台盆下沉' && a1.tech_name === '周红祥' && a1.time_slot === '上午', '预约字段没串位', a1);
  ok(appts.json.data.filter(a => a.status === '已完成').length === 1, '状态保持原样');

  const projs = await db(admin, { table: 'projects', action: 'select' });
  ok(projs.json.data.length === 2 && projs.json.data.every(p => p.team_id > 0), '项目和它原来的地址都在');

  const profs = await db(admin, { table: 'profiles', action: 'select' });
  ok(profs.json.data.length === 3, '3 个人员都在');
  ok(profs.json.data.filter(p => p.role === 'admin').length === 1, '原管理员业务身份没变');
  ok(profs.json.data.filter(p => p.active === false).length === 1, '停用的那个还是停用状态');

  console.log('\n[4] 老设置没丢（settings 表是从按 id=1 重建过的）');
  const set = await db(admin, { table: 'settings', action: 'select' });
  ok(set.status === 200 && set.json.data.length === 1, '每团队恰好一行设置', set.json.data && set.json.data.length);
  const s = set.json.data[0];
  ok(s.digest_email === 'boss@example.com' && s.smtp_host === 'smtp.qq.com' && s.smtp_port === 465, '邮箱配置搬过来了', { d: s && s.digest_email, h: s && s.smtp_host });
  ok(s.smtp_pass === undefined, '授权码不会通过接口回传');
  ok(s.email_enabled === true && s.notify_enabled === true, '布尔值仍然是布尔');

  console.log('\n[5] 升级后新功能可用');
  const t = await db(admin, { table: 'time_off', action: 'select' });
  ok(t.status === 200 && Array.isArray(t.json.data), '新表 time_off 已就绪');
  const off = await api('/api/schedule/time-off', { profile_id: 'p_old_tech', from: '2026-12-01', to: '2026-12-02' }, admin);
  ok(off.status === 200 && off.json.added === 2, '能给老员工排休息日', off.json);
  const clash = await api('/api/db', {
    table: 'appointments', action: 'insert',
    values: { project_name: '皇都花园', tech_name: '周红祥', visit_date: '2026-11-28', time_slot: '上午', content: '撞单测试' }
  }, admin);
  ok(clash.status === 409, '冲突检测对新老数据都生效（返回 409）', clash.status);

  const reg = await api('/api/auth/register', { name: '新来的小李', pin: '888888', phone: '13800000088' });
  ok(reg.status === 200 && reg.json.user.team_id === null, '老库升级后也能自助注册');
  const join = await api('/api/team/join', { code: login.json.team.code }, reg.json.token);
  ok(join.status === 200, '凭团队码申请入团');
  const reqs = await api('/api/team/requests', null, admin);
  ok(reqs.status === 200 && reqs.json.data.length === 1, '管理员能看到待审批');
  const dec = await api('/api/team/requests/decide', { id: reqs.json.data[0].id, approve: true }, admin);
  ok(dec.status === 200, '同意后新人进团');
  const memberView = await db(reg.json.token, { table: 'appointments', action: 'select' });
  ok(memberView.status === 200 && memberView.json.data.length === 3, '新人能看到团队的老数据');

  const exp = await fetch(BASE + '/api/backup/export?format=json', { headers: { Authorization: 'Bearer ' + admin } });
  const payload = await exp.json();
  ok(exp.status === 200 && payload.data.appointments.length === 3, '升级后立刻能导出备份');

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
