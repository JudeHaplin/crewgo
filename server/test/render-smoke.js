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
  return Object.assign(store, {
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
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    getAttribute: () => null,
    setAttribute() {},
    appendChild() {},
    click() {},
    focus() {}
  });
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
  const full = await run((p, body) => {
    const path = p.split('?')[0];
    if (path === '/api/auth/status') return { initialized: true, wechat: { mp: true, qr: true }, version: '1.2.0' };
    if (path === '/api/auth/me') {
      return {
        user: Object.assign({}, adminRow, { wx_bound: false, need_profile: false }),
        team: { id: 1, name: '测试物业', code: 'ABC123456', owner_id: 'p_1', allow_direct: false, stats: { members: 2, pending: 1, appointments: 1, projects: 1 } },
        pending: null,
        wechat: { mp: true, qr: true }
      };
    }
    if (path === '/api/team/requests') return { data: [{ id: 3, profile_id: 'p_9', name: '新同事', phone: '13800000010', message: '我是水电' }] };
    if (path === '/api/settings/wechat') return { wx_mp_appid: 'wxaa', wx_qr_appid: 'wxbb', wx_mp_secret_set: true, wx_qr_secret_set: false, enabled: { mp: true, qr: true }, callback: 'http://x/api/auth/wechat/callback' };
    if (path === '/api/db') {
      const table = body && body.table;
      if (table === 'profiles') return { data: [adminRow, techRow] };
      if (table === 'projects') return { data: [{ id: 1, team_id: 1, name: '阳光小区', address: '3栋', color: '#2b6ef6', active: 1 }] };
      if (table === 'appointments') return { data: [apptRow] };
      if (table === 'settings') return { id: 1, team_id: 1, notify_enabled: 1, email_enabled: 0, smtp_pass_set: false };
      if (table === 'notifications') return { data: [] };
      if (table === 'time_off') return { data: [{ id: 1, team_id: 1, profile_id: 'p_9', off_date: '2026-11-25', reason: '调休' }] };
      return { data: [] };
    }
    return undefined;
  }, 'tok-admin');
  const page0 = full.nodes['#page'].innerHTML;
  ok(page0.indexOf('排期看板') >= 0, '主界面渲染排期看板');
  ok(page0.indexOf('休 1') >= 0, '日历上标出休息日');
  ok(full.nodes['#login-view'].innerHTML === '', '登录页已隐藏');

  click(full.listeners, 'nav', { nav: 'settings' });
  ok(full.nodes['#page'].innerHTML.indexOf('设置') >= 0, '能切到设置页');
  const tabs = [
    ['projects', '项目'], ['people', '人员'], ['team', '团队'],
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
    if (tab === 'data') {
      ok(html.indexOf('导出 JSON') >= 0 && html.indexOf('导入') >= 0, '数据页有导出/导入入口');
    }
    if (tab === 'me') {
      ok(html.indexOf('我的休息日') >= 0, '我的资料里有休息日');
      ok(html.indexOf('微信') >= 0, '我的资料里有微信绑定');
    }
  }

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
