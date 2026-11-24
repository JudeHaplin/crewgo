/* 前端渲染冒烟：用最小 DOM 桩把 app.js 跑起来，确保登录页/团队门不抛异常。
   不做视觉断言，只看「能不能渲染出预期的关键文字」。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');
let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};

function el(id) {
  const store = { innerHTML: '', textContent: '', style: {}, value: '', files: [], type: '', disabled: false };
  const cls = new Set();
  const self = Object.assign(store, {
    id,
    classList: {
      add: c => cls.add(c),
      remove: c => cls.delete(c),
      toggle: (c, on) => { if (on === undefined) { cls.has(c) ? cls.delete(c) : cls.add(c); } else if (on) cls.add(c); else cls.delete(c); },
      contains: c => cls.has(c)
    },
    _cls: cls,
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll: () => [],
    closest: () => null,
    getAttribute: () => null,
    setAttribute() {},
    appendChild() {},
    click() {},
    focus() {}
  });
  // 弹窗挂载时会找 .modal-mask 绑关闭事件，这里给个替身，别让渲染测试炸掉
  self.querySelector = () => self;
  self.firstElementChild = self;
  return self;
}

function makeEnv(routes, token) {
  const nodes = {};
  const ids = ['boot', 'login-view', 'onboard-view', 'app-view', 'modal-root', 'toast',
    'notif-btn', 'user-btn', 'notif-badge', 'user-name', 'user-avatar', 'page', 'tabbar', 'mainnav'];
  ids.forEach(i => { nodes['#' + i] = el(i); });

  const listeners = {};
  const document = {
    readyState: 'complete',
    body: { style: {}, appendChild() {}, removeChild() {} },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    querySelector: sel => nodes[sel] || null,
    querySelectorAll: () => [],
    createElement: () => el('tmp')
  };
  const location = {
    href: 'http://127.0.0.1:8302/',
    origin: 'http://127.0.0.1:8302',
    pathname: '/',
    search: '',
    hash: '',
    assign() {}
  };
  const store = {};
  if (token) store['crewgo_token'] = token;
  const localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  };
  const fetchStub = async (url, init) => {
    const p = String(url).replace(/^https?:\/\/[^/]+/, '');
    let reqBody = null;
    try { reqBody = init && init.body ? JSON.parse(init.body) : null; } catch (e) { reqBody = null; }
    const body = routes(p, reqBody);
    const status = body === undefined ? 404 : (body.__status || 200);
    const data = body === undefined ? {} : body;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      async json() { return data; },
      async text() { return JSON.stringify(data); }
    };
  };

  const sandbox = {
    console,
    document,
    location,
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' },
    localStorage,
    sessionStorage: localStorage,
    history: { replaceState() {}, pushState() {} },
    fetch: fetchStub,
    setTimeout: (fn) => { try { fn(); } catch (e) { /* 忽略延迟任务 */ } return 0; },
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    URL: global.URL,
    URLSearchParams: global.URLSearchParams,
    Blob: global.Blob,
    TextDecoder: global.TextDecoder,
    alert() {},
    prompt: () => null
  };
  sandbox.__listeners = listeners;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return { sandbox, nodes, listeners };
}

const tick = () => new Promise(r => setImmediate(r));

async function run(routes, token) {
  const { sandbox, nodes, listeners } = makeEnv(routes, token);
  vm.createContext(sandbox);
  const lc = fs.readFileSync(path.join(ROOT, 'assets/local-cloud.js'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'assets/app.js'), 'utf8');
  vm.runInContext(lc, sandbox, { filename: 'local-cloud.js' });
  vm.runInContext(app, sandbox, { filename: 'app.js' });
  // 让 await 链跑完（fetch 是异步的）
  for (let i = 0; i < 10; i++) await tick();
  return { nodes, listeners };
}

/** 触发一次点击：act 是 data-act，attrs 是其它 data-* */
function click(listeners, act, attrs) {
  const a = Object.assign({}, attrs || {});
  const fake = {
    checked: !!a.checked,
    value: a.value === undefined ? '' : String(a.value),
    getAttribute: k => (k === 'data-act' ? act : (a[k.replace('data-', '')] === undefined ? null : String(a[k.replace('data-', '')])))
  };
  const target = {
    closest: sel => {
      if (sel === '[data-nav]') return act === 'nav' ? { getAttribute: () => a.nav } : null;
      if (sel === '[data-act]') return act === 'nav' ? null : fake;
      return null;
    },
    getAttribute: () => null
  };
  const ev = { target, preventDefault() {} };
  (listeners.click || []).forEach(fn => fn(ev));
}

(async () => {
  console.log('\n[1] 全新部署：直接进「初始化」');
  let r0 = await run(p => {
    if (p === '/api/auth/status') return { initialized: false, wechat: { mp: false, qr: false }, version: '1.2.0' };
    if (p === '/api/auth/me') return { __status: 401, error: '未登录' };
    return undefined;
  });
  let nodes = r0.nodes;
  const loginHtml = nodes['#login-view'].innerHTML;
  ok(loginHtml.indexOf('初始化') >= 0, '渲染出初始化页');
  ok(loginHtml.indexOf('团队名称') >= 0, '初始化时能填团队名称');
  ok(nodes['#onboard-view'].innerHTML === '', '没有多余的中间页');

  console.log('\n[2] 已初始化 + 配了扫码登录：登录页出现微信按钮');
  r0 = await run(p => {
    if (p === '/api/auth/status') return { initialized: true, wechat: { mp: true, qr: true }, version: '1.2.0' };
    if (p === '/api/auth/me') return { __status: 401, error: '未登录' };
    return undefined;
  });
  nodes = r0.nodes;
  const h2 = nodes['#login-view'].innerHTML;
  ok(h2.indexOf('登录') >= 0, '渲染出登录页');
  ok(h2.indexOf('微信扫码登录') >= 0, '电脑上显示扫码登录');
  ok(h2.indexOf('注册') >= 0, '有注册入口');

  console.log('\n[3] 未入团：显示团队门');
  r0 = await run(p => {
    if (p === '/api/auth/status') return { initialized: true, wechat: { mp: false, qr: false } };
    if (p === '/api/auth/me') {
      return {
        user: { id: 'p_1', name: '张工', role: 'tech', team_id: null, team_role: 'member', need_profile: false, wx_bound: false },
        team: null, pending: null, wechat: { mp: false, qr: false }
      };
    }
    if (p.indexOf('/api/db') === 0) return { data: [] };
    return undefined;
  }, 'tok-a');
  nodes = r0.nodes;
  const gate = nodes['#onboard-view'].innerHTML;
  ok(gate.indexOf('加入团队') >= 0, '渲染团队门');
  ok(gate.indexOf('团队码') >= 0, '有团队码输入');
  ok(gate.indexOf('创建新团队') >= 0, '能创建团队');

  console.log('\n[4] 微信账号缺资料：强制完善资料');
  r0 = await run(p => {
    if (p === '/api/auth/status') return { initialized: true, wechat: { mp: true, qr: false } };
    if (p === '/api/auth/me') {
      return {
        user: { id: 'p_2', name: '', role: 'tech', team_id: null, team_role: 'member', need_profile: true, wx_bound: true },
        team: null, pending: null, wechat: { mp: true, qr: false }
      };
    }
    if (p.indexOf('/api/db') === 0) return { data: [] };
    return undefined;
  }, 'tok-b');
  nodes = r0.nodes;
  const prof = nodes['#onboard-view'].innerHTML;
  ok(prof.indexOf('完善资料') >= 0, '渲染完善资料页');
  ok(prof.indexOf('手机号') >= 0, '要求填手机号');

  console.log('\n[5] 等待审批');
  r0 = await run(p => {
    if (p === '/api/auth/status') return { initialized: true, wechat: { mp: false, qr: false } };
    if (p === '/api/auth/me') {
      return {
        user: { id: 'p_3', name: '李四', role: 'tech', team_id: null, team_role: 'member', need_profile: false, wx_bound: false },
        team: null,
        pending: { id: 1, team_id: 2, team_name: '某某物业' },
        wechat: { mp: false, qr: false }
      };
    }
    if (p.indexOf('/api/db') === 0) return { data: [] };
    return undefined;
  }, 'tok-c');
  nodes = r0.nodes;
  const pend = nodes['#onboard-view'].innerHTML;
  ok(pend.indexOf('等待审批') >= 0, '渲染等待审批页');
  ok(pend.indexOf('某某物业') >= 0, '显示申请的团队名');

  console.log('\n[6] 登录后的主界面与设置页');
  const adminRow = {
    id: 'p_1', name: '王建国', phone: '13800000001', email: null, role: 'admin',
    team_role: 'owner', team_id: 1, color: '#2b6ef6', active: 1, user_id: 'p_1',
    push_token: null, need_profile: 0, avatar: null
  };
  const techRow = {
    id: 'p_9', name: '张工', phone: '13800000009', email: null, role: 'tech',
    team_role: 'member', team_id: 1, color: '#0f9d76', active: 1, user_id: 'p_9',
    push_token: null, need_profile: 0, avatar: null
  };
  const apptRow = {
    id: 1, team_id: 1, owner_id: 'p_9', creator_name: '张工', project_id: 1, project_name: '阳光小区',
    tech_id: 'p_9', tech_name: '张工', visit_date: '2026-12-05', time_slot: '上午',
    address: '3栋501', content: '厨房漏水', contact_name: '刘女士', contact_phone: '13800000001',
    status: '待确认', priority: '普通', note: null, created_at: '2026-11-24 10:00'
  };
  const fullRoutes = meRow => (p, body) => {
    const path = p.split('?')[0];
    if (path === '/api/auth/status') return { initialized: true, wechat: { mp: true, qr: true }, version: '1.2.0' };
    if (path === '/api/auth/me') {
      return {
        user: Object.assign({}, meRow, { wx_bound: false, need_profile: false }),
        team: { id: 1, name: '测试物业', code: 'ABC123456', owner_id: 'p_1', allow_direct: false, stats: { members: 2, pending: 1, appointments: 1, projects: 1 } },
        pending: null,
        wechat: { mp: true, qr: true }
      };
    }
    if (path === '/api/team/requests') return { data: [{ id: 3, profile_id: 'p_9', name: '新同事', phone: '13800000010', message: '我是水电' }] };
    if (path === '/api/settings/wechat') return { wx_mp_appid: 'wxaa', wx_qr_appid: 'wxbb', wx_mp_secret_set: true, wx_qr_secret_set: false, enabled: { mp: true, qr: true }, callback: 'http://x/api/auth/wechat/callback' };
    if (path === '/api/db') {
      const table = body && body.table;
      if (table === 'profiles') return { data: [meRow, techRow] };
      if (table === 'projects') return { data: [{ id: 1, team_id: 1, name: '阳光小区', address: '3栋', color: '#2b6ef6', active: 1 }] };
      if (table === 'appointments') return { data: [apptRow] };
      if (table === 'settings') return { id: 1, team_id: 1, notify_enabled: 1, email_enabled: 0, smtp_pass_set: false };
      if (table === 'notifications') return { data: [] };
      if (table === 'time_off') return { data: [{ id: 1, team_id: 1, profile_id: 'p_9', off_date: '2026-11-25', reason: '调休' }] };
      return { data: [] };
    }
    return undefined;
  };
  const full = await run(fullRoutes(adminRow), 'tok-admin');
  const page0 = full.nodes['#page'].innerHTML;
  ok(page0.indexOf('排期看板') >= 0, '主界面渲染排期看板');
  ok(page0.indexOf('休 张工') >= 0, '日历格子里直接写出「谁」在休息，不只是数量');
  ok(page0.indexOf('近期休息') >= 0 && page0.indexOf('11月25日') >= 0, '看板有「近期休息」列表，全员可见');
  ok(page0.indexOf('休息（不排单）') >= 0, '日历图例里说明了休息标记');
  ok(full.nodes['#login-view'].innerHTML === '', '登录页已隐藏');

  click(full.listeners, 'nav', { nav: 'settings' });
  ok(full.nodes['#page'].innerHTML.indexOf('设置') >= 0, '能切到设置页');
  const tabs = [
    ['projects', '项目'], ['people', '人员'], ['admins', '管理员'], ['team', '团队'],
    ['notify', '通知'], ['data', '数据备份'], ['login', '微信登录'], ['me', '我的资料']
  ];
  for (const [tab, word] of tabs) {
    click(full.listeners, 'settings-tab', { tab });
    const html = full.nodes['#page'].innerHTML;
    if (process.env.DEBUG_RENDER) console.log('--- ' + tab + ' ---', html.length, html.slice(0, 160).replace(/\n/g, ' '));
    ok(html.indexOf(word) >= 0, '设置 → ' + tab + ' 渲染正常');
    if (tab === 'team') {
      ok(html.indexOf('ABC123456') >= 0, '团队页显示团队码');
      ok(html.indexOf('新同事') >= 0, '团队页显示待审申请');
    }
    if (tab === 'notify') {
      ok(html.indexOf('我的通知邮箱') >= 0, '通知页有「我的通知邮箱」（人人可自设）');
      ok(html.indexOf('发送验证码') >= 0, '邮箱要用验证码验证');
      ok(html.indexOf('邮箱服务') >= 0, '统筹能看到「邮箱服务」配置入口');
    }
    if (tab === 'data') {
      ok(html.indexOf('导出 JSON') >= 0 && html.indexOf('导入') >= 0, '数据页有导出/导入入口');
    }
    if (tab === 'me') {
      ok(html.indexOf('我的休息日') >= 0, '我的资料里有休息日');
      ok(html.indexOf('微信') >= 0, '我的资料里有微信绑定');
    }
  }

  console.log('\n[7] 预约单列表的批量选择');
  click(full.listeners, 'nav', { nav: 'list' });
  let lh = full.nodes['#page'].innerHTML;
  ok(lh.indexOf('全选') >= 0, '列表上方有批量操作条');
  ok(lh.indexOf('data-act="sel-row"') >= 0, '每行都有勾选框');
  ok(lh.indexOf('按时间选') >= 0 && lh.indexOf('选中这段时间') >= 0, '支持按时间范围整段选中');
  ok(lh.indexOf('批量改状态') >= 0 && lh.indexOf('删除选中') >= 0, '有批量改状态 / 批量删除');
  ok(lh.indexOf('<b>0</b>') >= 0, '默认一条都没选');
  click(full.listeners, 'sel-all', { checked: true });
  lh = full.nodes['#page'].innerHTML;
  ok(lh.indexOf('<b>1</b>') >= 0, '全选后已选 1 条');
  ok(lh.indexOf('row-sel') >= 0, '选中的行会高亮');
  click(full.listeners, 'sel-invert', { checked: true });
  lh = full.nodes['#page'].innerHTML;
  ok(lh.indexOf('<b>0</b>') >= 0, '反选后回到 0 条');
  click(full.listeners, 'sel-all', { checked: true });
  click(full.listeners, 'sel-clear', { checked: true });
  lh = full.nodes['#page'].innerHTML;
  ok(lh.indexOf('<b>0</b>') >= 0, '清空后回到 0 条');

  console.log('\n[8] 管理员页：统筹只能转让，管理员可以设');
  click(full.listeners, 'nav', { nav: 'settings' });
  click(full.listeners, 'settings-tab', { tab: 'admins' });
  let ah = full.nodes['#page'].innerHTML;
  ok(ah.indexOf('设为管理员') >= 0, '管理员页能把成员设为管理员');
  ok(ah.indexOf('转让统筹管理员身份') >= 0, '统筹能在这里转让身份');
  ok(ah.indexOf('全团队只有一个') < 0 && ah.indexOf('普通成员：看排期') < 0, '这一页不再放解释性文案');
  ok(ah.indexOf('统筹管理员</span>') >= 0, '统筹那一行只有标签');

  click(full.listeners, 'transfer-owner');
  const th = full.nodes['#modal-root'].innerHTML;
  ok(th.indexOf('你的登录 PIN') >= 0, '转让弹窗要输入自己的 PIN');
  ok(th.indexOf('手动输入「确认」') >= 0, '转让弹窗要手输「确认」');
  ok(th.indexOf('确认转让') >= 0, '有「确认转让」按钮');

  click(full.listeners, 'settings-tab', { tab: 'people' });
  click(full.listeners, 'edit-person', { id: 'p_9' });
  const mh = full.nodes['#modal-root'].innerHTML;
  ok(mh.indexOf('岗位身份') >= 0, '人员编辑里只有「岗位身份」');
  ok(mh.indexOf('统筹管理员') < 0 && mh.indexOf('设为管理员') < 0, '人员编辑里不再出现统筹/管理员设置');

  console.log('\n[10] 我的通知邮箱：验证后锁死，改要单独点「更改邮箱」');
  const lockedRow = Object.assign({}, adminRow, {
    email: 'boss@example.com', email_verified_at: '2026-11-24 10:00', email_pending: null, email_verified: true
  });
  const lk = await run(fullRoutes(lockedRow), 'tok-admin');
  click(lk.listeners, 'nav', { nav: 'settings' });
  click(lk.listeners, 'settings-tab', { tab: 'notify' });
  let nh = lk.nodes['#page'].innerHTML;
  ok(nh.indexOf('更改邮箱') >= 0, '已验证后出现「更改邮箱」按钮');
  ok(nh.indexOf('发一封邮件测试') >= 0, '邮箱区有「发一封邮件测试」按钮');
  ok(nh.indexOf('data-field="my_email_code"') < 0, '验证成功后验证码输入框收起来');
  ok(nh.indexOf('data-act="send-email-code"') < 0, '「发送验证码」也一起收起来');
  ok(nh.indexOf('已验证') >= 0, '标签显示「已验证」');

  click(lk.listeners, 'edit-my-email', {});
  nh = lk.nodes['#page'].innerHTML;
  ok(nh.indexOf('data-field="my_email_code"') >= 0, '点了「更改邮箱」才展开验证码输入');
  ok(nh.indexOf('取消更改') >= 0, '展开后能取消，回到锁定状态');

  click(lk.listeners, 'settings-tab', { tab: 'me' });
  const meh = lk.nodes['#page'].innerHTML;
  ok(meh.indexOf('readonly') >= 0 && meh.indexOf('已锁定') >= 0, '「我的资料」里的邮箱也锁住了，并指向通知页去改');

  console.log('\n[11] 新建预约：项目 / 维修人员必选，预约人自动带出');
  click(full.listeners, 'nav', { nav: 'list' });
  click(full.listeners, 'new-appt');
  const fh = full.nodes['#modal-root'].innerHTML;
  ok(fh.indexOf('不指定') < 0, '项目下拉不再有「不指定」');
  ok(fh.indexOf('待分配') < 0, '维修人员下拉不再有「待分配」');
  ok(fh.indexOf('请选择项目') >= 0 && fh.indexOf('请选择维修人员') >= 0, '两个必选项都换成「请选择…」占位');
  ok(fh.indexOf('req-mark') >= 0, '必选字段带红色星号');
  ok(fh.indexOf('value="王建国"') >= 0 && fh.indexOf('value="13800000001"') >= 0, '预约人和电话默认填成当前登录的人');
  ok(fh.indexOf('预约人电话') >= 0, '表单里有「预约人电话」');
  ok(fh.indexOf('可以改成业主或现场联系人') >= 0, '提示可以改成现场联系人');
  ok(fh.indexOf('维修内容') >= 0 && fh.indexOf('报修内容') < 0, '「报修内容」已改称「维修内容」');
  ok(fh.indexOf('name="contact_email"') < 0, '表单里不再有「预约人邮箱」输入框');
  ok(fh.indexOf('att-drop') >= 0, '新建预约有附件区（可点选 / 拖入 / 粘贴）');
  ok(fh.indexOf('Ctrl+V') >= 0, '附件区提示可以粘贴截图');

  click(full.listeners, 'open-appt', { id: '1' });
  const dh = full.nodes['#modal-root'].innerHTML;
  ok(dh.indexOf('预约人') >= 0, '预约详情里有「预约人」');
  ok(dh.indexOf('刘女士') >= 0 && dh.indexOf('13800000001') >= 0, '详情里预约人的姓名和电话都在');
  ok(dh.indexOf('维修内容') >= 0, '详情里也叫「维修内容」');
  ok(dh.indexOf('创建人') >= 0, '管理员能看到「创建人」');
  ok(dh.indexOf('取消这条预约') >= 0, '管理员能取消任何一条预约');

  console.log('\n[12] 维修人员看别人的单：只能标记，看不到创建人');
  const techRoutes = fullRoutes(techRow);
  const asTech = await run((p, body) => {
    if (p.split('?')[0] === '/api/db' && body && body.table === 'appointments') {
      return { data: [Object.assign({}, apptRow, { owner_id: 'p_1', creator_name: '王建国' })] };
    }
    return techRoutes(p, body);
  }, 'tok-tech');
  click(asTech.listeners, 'nav', { nav: 'list' });
  click(asTech.listeners, 'open-appt', { id: '1' });
  const th2 = asTech.nodes['#modal-root'].innerHTML;
  ok(th2.indexOf('标记为已确认') >= 0, '维修人员能标记状态');
  ok(th2.indexOf('取消这条预约') < 0, '维修人员看不到「取消这条预约」');
  ok(th2.indexOf('创建人') < 0 && th2.indexOf('最后改动') < 0, '创建人 / 改动记录只有管理员可见');
  ok(th2.indexOf('data-act="edit-appt"') < 0, '维修人员不能编辑别人的单');
  ok(th2.indexOf('data-act="del-appt"') < 0, '维修人员不能删除别人的单');

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
