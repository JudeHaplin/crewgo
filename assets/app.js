/* ============================================================
   速派 · 房屋维修预约系统
   ============================================================ */
(function () {
  'use strict';

  /* ---------- 云服务配置 ---------- */
  const PUBLIC_CONFIG = {
    endpoint: 'https://crewgo.app.workbuddy.host',
    publishableKey: 'wbpk_gqUUZ2hKLCYrKZ4UyqXqA5_CIw7f3PsqR5DttPEJ3FNPRgg4HTOSevB',
    oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth'
  };

  const cloud = (function () {
    if (typeof WorkBuddyCloud === 'undefined' || !WorkBuddyCloud.createWorkBuddyCloud) return null;
    return WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: PUBLIC_CONFIG.endpoint,
      oauthRelayBaseUrl: PUBLIC_CONFIG.oauthRelayBaseUrl,
      publishableKey: PUBLIC_CONFIG.publishableKey
    });
  })();
  const db = cloud ? cloud.database : null;

  /* ---------- 常量 ---------- */
  const SLOTS = ['全天', '上午', '下午', '晚上'];
  const SLOT_ORDER = { '全天': 0, '上午': 1, '下午': 2, '晚上': 3 };
  const STATUSES = ['待确认', '已确认', '进行中', '已完成', '已取消'];
  const STATUS_NEXT = { '待确认': ['已确认', '已取消'], '已确认': ['进行中', '已完成'], '进行中': ['已完成'] };
  const ROLE_LABEL = { admin: '统筹管理员', tech: '维修人员', requester: '预约人' };
  const PALETTE = ['#2b6ef6', '#e5484d', '#0f9d76', '#f59e0b', '#6d4aff', '#0891b2', '#d94690', '#65a30d'];
  const DOW = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  /* ---------- 工具 ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.prototype.slice.call(r.querySelectorAll(s));
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const parseYmd = s => { const p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
  const todayStr = () => ymd(new Date());
  const addDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
  const inWeChat = () => /MicroMessenger/i.test(navigator.userAgent);
  // 推送到微信时点开的落地页（保留分享码，直接进「我的安排」）
  const appLink = () => location.origin + location.pathname + location.search + '#/mine';

  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function dayLabel(dateStr) {
    const d = parseYmd(dateStr);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + DOW[(d.getDay() + 6) % 7];
  }
  function relDay(dateStr) {
    const t = todayStr();
    if (dateStr === t) return '今天';
    const tm = new Date(); tm.setDate(tm.getDate() + 1);
    if (dateStr === ymd(tm)) return '明天';
    const y = new Date(); y.setDate(y.getDate() + 2);
    if (dateStr === ymd(y)) return '后天';
    return '';
  }
  let toastTimer = null;
  function toast(msg, ms) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms || 2400);
  }
  function openModal(html, opts) {
    opts = opts || {};
    const root = $('#modal-root');
    root.innerHTML = '<div class="modal-mask" data-mask><div class="modal ' + (opts.wide ? 'wide' : '') + '">' + html + '</div></div>';
    document.body.style.overflow = 'hidden';
    if (opts.onMount) opts.onMount(root.firstElementChild);
    const mask = $('.modal-mask', root);
    mask.addEventListener('mousedown', e => { if (e.target === mask && !opts.locked) closeModal(); });
  }
  function closeModal() {
    $('#modal-root').innerHTML = '';
    document.body.style.overflow = '';
  }
  function modalShell(title, bodyHtml, footHtml) {
    return '<div class="modal-head"><h3>' + esc(title) + '</h3>' +
      '<button class="close-x" data-act="close-modal" aria-label="关闭">×</button></div>' +
      '<div class="modal-body">' + bodyHtml + '</div>' +
      (footHtml ? '<div class="modal-foot">' + footHtml + '</div>' : '');
  }

  /* ---------- 状态 ---------- */
  const state = {
    session: null, user: null, uid: null, profile: null,
    profiles: [], projects: [], appointments: [], notifications: [],
    settings: null,
    view: 'board',
    board: { year: new Date().getFullYear(), month: new Date().getMonth(), day: todayStr() },
    filters: { tech: '', project: '', status: '', q: '' },
    settingsTab: 'projects',
    loginMode: 'login',
    lastNotifId: 0,
    pollTimer: null
  };

  /* ============================================================
     启动 / 登录
     ============================================================ */
  function pickUid(u) {
    if (!u) return null;
    return u.id || u.uid || u.sub || null;
  }
  async function resolveUid(user) {
    const direct = pickUid(user);
    if (direct) return String(direct);
    try {
      const r = await db.rpc('whoami');
      if (r && r.data) return String(r.data);
    } catch (e) { /* ignore */ }
    try {
      const { data } = await cloud.auth.getUser();
      const u = data && (data.user || data);
      const id = pickUid(u);
      if (id) return String(id);
    } catch (e) { /* ignore */ }
    return null;
  }
  function showLogin(msg, ok) {
    $('#boot').classList.add('hidden');
    $('#onboard-view').classList.add('hidden');
    $('#app-view').classList.add('hidden');
    const v = $('#login-view');
    v.classList.remove('hidden');
    v.innerHTML = loginHtml(msg, ok);
  }
  function showOnboarding(data) {
    $('#boot').classList.add('hidden');
    $('#login-view').classList.add('hidden');
    $('#app-view').classList.add('hidden');
    const v = $('#onboard-view');
    v.classList.remove('hidden');
    v.innerHTML = onboardHtml(data);
  }

  function loginHtml(msg, ok) {
    const setup = state.loginMode === 'setup';
    const head =
      '<div class="auth-card">' +
        '<div class="auth-brand"><span class="brand-mark">速</span><h1>速派</h1></div>' +
        '<p class="auth-sub">维修人员预约管理系统</p>' +
        '<h2 class="auth-title">' + (setup ? '初始化管理员' : '登录') + '</h2>' +
        (msg ? '<div class="msg ' + (ok ? 'msg-ok' : '') + '">' + esc(msg) + '</div>' : '') +
        '<p class="auth-desc">' + (setup
          ? '第一次使用，先建一个统筹管理员账号，PIN 就相当于密码。'
          : '输入姓名和 PIN 即可登录，不用收验证码。') + '</p>';

    if (setup) {
      return head +
        '<form data-form="setup" novalidate>' +
          '<div class="field"><label for="st-name">你的姓名</label>' +
            '<input class="input" id="st-name" name="name" placeholder="如：王建国" required maxlength="20"></div>' +
          '<div class="field"><label for="st-pin">设置 PIN</label>' +
            '<input class="input" id="st-pin" name="pin" type="password" inputmode="numeric" maxlength="12" placeholder="至少 4 位数字"></div>' +
          '<div class="field"><label for="st-pin2">再输一次</label>' +
            '<input class="input" id="st-pin2" name="pin2" type="password" inputmode="numeric" maxlength="12" placeholder="确认 PIN"></div>' +
          '<button class="btn btn-primary btn-block" type="submit">创建管理员账号</button>' +
        '</form>' +
        '<p class="auth-foot"><a href="#" data-act="login-mode" data-mode="login" style="color:var(--text-3)">已有账号，去登录</a></p>' +
      '</div>';
    }

    return head +
      '<form data-form="login" novalidate>' +
        '<div class="field"><label for="lg-name">姓名</label>' +
          '<input class="input" id="lg-name" name="name" placeholder="你的姓名" required maxlength="20" autocomplete="username"></div>' +
        '<div class="field"><label for="lg-pin">PIN</label>' +
          '<input class="input" id="lg-pin" name="pin" type="password" inputmode="numeric" maxlength="12" placeholder="4 位以上数字" autocomplete="current-password"></div>' +
        '<button class="btn btn-primary btn-block" type="submit">登录</button>' +
      '</form>' +
      '<p class="auth-foot">忘记 PIN 找统筹在「设置 → 人员」里重设<br>' +
        '<a href="#" data-act="login-mode" data-mode="setup" style="color:var(--text-3)">第一次部署？初始化管理员</a></p>' +
    '</div>';
  }

  function onboardHtml(data) {
    const unclaimed = data.unclaimed || [];
    const first = data.first;
    let body = '';
    if (first) {
      body =
        '<div class="notice" style="margin-bottom:16px">这是首次部署，你将成为<b>统筹管理员</b>，之后可以在「设置 → 人员」里添加其他同事。</div>' +
        '<form data-form="onboard-new">' +
          '<input type="hidden" name="role" value="admin">' +
          '<div class="field"><label>你的姓名</label><input class="input" name="name" placeholder="如：王建国" required maxlength="20"></div>' +
          '<div class="field"><label>手机号（可选）</label><input class="input" name="phone" type="tel" maxlength="20" placeholder="方便同事联系"></div>' +
          '<button class="btn btn-primary btn-block" type="submit">进入系统</button>' +
        '</form>';
    } else {
      body =
        (unclaimed.length
          ? '<p class="hint" style="margin:0 0 10px">名单里已有你的档案，选一个即可；没有的话新建。</p>' +
            '<div class="pick-list">' + unclaimed.map(p =>
              '<div class="pick-item" data-act="claim" data-id="' + esc(p.id) + '">' +
                '<span class="dot" style="background:' + esc(p.color || '#2b3c8f') + '"></span>' +
                '<span class="nm">' + esc(p.name) + '</span>' +
                '<span class="meta">' + esc(ROLE_LABEL[p.role] || p.role) + '</span>' +
              '</div>').join('') + '</div>'
          : '') +
        '<form data-form="onboard-new">' +
          '<div class="field"><label>我的姓名</label><input class="input" name="name" placeholder="请输入真实姓名" required maxlength="20"></div>' +
          '<div class="field"><label>手机号（可选）</label><input class="input" name="phone" type="tel" maxlength="20" placeholder="方便同事联系"></div>' +
          '<div class="field"><label>我的身份</label>' +
            '<div class="role-cards">' +
              '<div class="role-card active" data-act="pick-role" data-role="tech"><b>维修人员</b><span>接单、查看自己的安排</span></div>' +
              '<div class="role-card" data-act="pick-role" data-role="requester"><b>预约人</b><span>提交预约、查看全员排期</span></div>' +
            '</div>' +
            '<input type="hidden" name="role" value="tech">' +
          '</div>' +
          '<button class="btn btn-primary btn-block" type="submit">完成，进入系统</button>' +
        '</form>';
    }
    return '<div class="auth-card">' +
      '<div class="auth-brand"><span class="brand-mark">速</span><h1>速派</h1></div>' +
      '<p class="auth-sub">维修人员预约管理系统</p>' +
      '<h2 class="auth-title">' + (first ? '开始使用' : '绑定你的身份') + '</h2>' +
      '<p class="auth-desc">' + (first ? '只需一步，之后可随时在设置中调整。' : '绑定后，你的排期、通知都会归到这里。') + '</p>' +
      body +
      '<p class="auth-foot"><a href="#" data-act="logout" style="color:var(--text-3)">切换账号</a></p>' +
      '</div>';
  }

  /* ---------- 认证流程 ---------- */
  async function handleCallback() {
    const url = new URL(location.href);
    if (!url.searchParams.has('code') && !url.searchParams.has('error')) return;
    const provider = url.searchParams.get('provider');
    if (provider !== 'workbuddy' && provider !== 'wechat') return;
    const handler = provider === 'workbuddy' ? cloud.auth.handleWorkBuddyCallback : cloud.auth.handleWechatWebCallback;
    if (typeof handler !== 'function') {
      showLogin('当前登录组件不支持该方式，请使用手机号登录。');
      return;
    }
    const { data: session, error } = await handler.call(cloud.auth);
    if (error) { showLogin('登录失败：' + (error.message || '请重试')); return; }
    if (session) {
      ['code', 'state', 'provider'].forEach(k => url.searchParams.delete(k));
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  }

  async function boot() {
    let session = null;
    try {
      const res = await cloud.auth.getSession();
      session = res.data;
    } catch (e) { /* ignore */ }
    if (!session) { showLogin(); return; }

    state.session = session;
    state.user = session.user || {};
    state.uid = await resolveUid(state.user);
    if (!state.uid) { showLogin('无法获取账号信息，请重新登录。'); return; }

    let prof = null;
    try { prof = await fetchMyProfile(); } catch (e) { /* ignore */ }

    if (!prof) { await startOnboarding(); return; }
    state.profile = prof;
    await enterApp();
  }

  async function fetchMyProfile() {
    const { data, error } = await db.from('profiles').select('*').eq('user_id', state.uid).maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async function startOnboarding() {
    const [{ data: list }, { count }] = await Promise.all([
      db.from('profiles').select('*').is('user_id', null).order('created_at', { ascending: true }),
      db.from('profiles').select('id', { count: 'exact', head: true })
    ]);
    showOnboarding({ unclaimed: list || [], first: !count });
  }

  async function enterApp() {
    $('#boot').classList.add('hidden');
    $('#login-view').classList.add('hidden');
    $('#onboard-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');

    if (state.profile.role === 'tech') state.filters.tech = state.profile.id;
    renderUserChip();

    await loadAll();
    const home = state.profile.role === 'tech' ? '#/mine' : '#/board';
    navigate(location.hash || home, true);
    startPolling();
    // 顺带把今天/明天还没提醒过的单推出去（谁打开系统谁触发，幂等）
    runReminders().then(n => { if (n > 0) toast('已推送 ' + n + ' 条出发提醒'); }).catch(() => {});
    // 管理员当天第一次打开时补发每日汇总邮件（一天一封）
    autoDigest().catch(() => {});
  }

  /* ---------- 数据 ---------- */
  async function loadAll() {
    const [pr, pf, ap, st, nf] = await Promise.all([
      db.from('projects').select('*').order('sort_order', { ascending: true }).order('name', { ascending: true }),
      db.from('profiles').select('*').order('created_at', { ascending: true }),
      db.from('appointments').select('*').order('visit_date', { ascending: false }).limit(1000),
      db.from('settings').select('*').eq('id', 1).maybeSingle(),
      db.from('notifications').select('*').order('created_at', { ascending: false }).limit(50)
    ]);
    state.projects = pr.data || [];
    state.profiles = pf.data || [];
    state.appointments = ap.data || [];
    state.settings = st.data || null;
    state.notifications = nf.data || [];

    const me = state.profiles.filter(p => p.user_id === state.uid)[0];
    if (me) state.profile = me;

    const newest = state.notifications[0];
    if (newest && Number(newest.id) > state.lastNotifId) {
      if (state.lastNotifId > 0 && !newest.read_at) {
        desktopNotify(newest.title, newest.body || '');
        toast(newest.title);
      }
      state.lastNotifId = Number(newest.id);
    }
    renderNotifBadge();
  }

  async function loadNotifications() {
    const { data } = await db.from('notifications').select('*').order('created_at', { ascending: false }).limit(50);
    const prevNewest = state.lastNotifId;
    state.notifications = data || [];
    const newest = state.notifications[0];
    if (newest && Number(newest.id) > prevNewest && prevNewest > 0 && !newest.read_at) {
      desktopNotify(newest.title, newest.body || '');
    }
    if (newest) state.lastNotifId = Number(newest.id);
    renderNotifBadge();
  }

  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => { if (!document.hidden) loadNotifications().catch(() => {}); }, 60000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) loadNotifications().catch(() => {});
    });
  }

  /* ---------- 派生数据 ---------- */
  const activeProfiles = () => state.profiles.filter(p => p.active !== false);
  const techProfiles = () => activeProfiles().filter(p => p.role === 'tech' || p.role === 'admin');
  const projectById = id => state.projects.filter(p => String(p.id) === String(id))[0] || null;
  const profileById = id => state.profiles.filter(p => String(p.id) === String(id))[0] || null;
  function techColor(nameOrId) {
    const p = state.profiles.filter(x => x.id === nameOrId || x.name === nameOrId)[0];
    return p && p.color ? p.color : '#2b6ef6';
  }
  function slotOrder(s) { return SLOT_ORDER[s] === undefined ? 9 : SLOT_ORDER[s]; }
  function sortAppts(list) {
    return list.slice().sort((a, b) => {
      if (a.visit_date !== b.visit_date) return a.visit_date < b.visit_date ? -1 : 1;
      const d = slotOrder(a.time_slot) - slotOrder(b.time_slot);
      if (d) return d;
      return String(a.tech_name || '').localeCompare(String(b.tech_name || ''), 'zh');
    });
  }
  const isAdmin = () => state.profile && state.profile.role === 'admin';

  /* ============================================================
     导航 / 外壳
     ============================================================ */
  function navigate(hash, replace) {
    const raw = String(hash || '#/board').replace(/^#\/?/, '');
    const view = ['board', 'list', 'mine', 'settings'].indexOf(raw) >= 0 ? raw : 'board';
    state.view = view;
    $$('[data-nav]').forEach(a => a.classList.toggle('active', a.getAttribute('data-nav') === view));
    if (replace) history.replaceState(null, '', '#/' + view);
    else if (location.hash !== '#/' + view) history.replaceState(null, '', '#/' + view);
    render();
  }

  function render() {
    const page = $('#page');
    if (state.view === 'board') page.innerHTML = boardHtml();
    else if (state.view === 'list') page.innerHTML = listHtml();
    else if (state.view === 'mine') page.innerHTML = mineHtml();
    else page.innerHTML = settingsHtml();
    page.scrollTop = 0;
  }

  function renderUserChip() {
    const p = state.profile;
    if (!p) return;
    $('#user-name').textContent = p.name;
    const av = $('#user-avatar');
    av.textContent = p.name.slice(0, 1);
    av.style.background = p.color || '#2b6ef6';
  }

  function renderNotifBadge() {
    const n = state.notifications.filter(x => !x.read_at).length;
    const b = $('#notif-badge');
    if (n > 0) { b.textContent = n > 99 ? '99+' : String(n); b.classList.remove('hidden'); }
    else b.classList.add('hidden');
  }

  /* ============================================================
     视图：排期看板
     ============================================================ */
  function apptMatchesFilter(a) {
    const f = state.filters;
    if (f.tech && String(a.tech_id || '') !== String(f.tech)) return false;
    if (f.project && String(a.project_id || '') !== String(f.project)) return false;
    if (f.status && a.status !== f.status) return false;
    if (f.q) {
      const k = f.q.toLowerCase();
      const hay = [a.address, a.content, a.tech_name, a.project_name, a.contact_name, a.note].join(' ').toLowerCase();
      if (hay.indexOf(k) < 0) return false;
    }
    return true;
  }

  function boardHtml() {
    const b = state.board;
    const first = new Date(b.year, b.month, 1);
    const dow = (first.getDay() + 6) % 7;
    const days = new Date(b.year, b.month + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < dow; i++) cells.push(null);
    for (let d = 1; d <= days; d++) cells.push(new Date(b.year, b.month, d));
    while (cells.length % 7) cells.push(null);

    const list = state.appointments.filter(apptMatchesFilter);
    const byDate = {};
    list.forEach(a => { (byDate[a.visit_date] = byDate[a.visit_date] || []).push(a); });
    Object.keys(byDate).forEach(k => byDate[k] = sortAppts(byDate[k]));

    const td = todayStr();
    let rows = '';
    for (let r = 0; r < cells.length / 7; r++) {
      rows += '<div class="cal-row">';
      for (let c = 0; c < 7; c++) {
        const d = cells[r * 7 + c];
        if (!d) { rows += '<div class="cal-cell out"></div>'; continue; }
        const ds = ymd(d);
        const evts = byDate[ds] || [];
        const cls = ['cal-cell'];
        if (ds === td) cls.push('today');
        if (ds === b.day) cls.push('sel');
        if (c >= 5) cls.push('weekend');
        let inner = '<div class="cal-daynum">' + d.getDate() + '</div>';
        evts.slice(0, 3).forEach(a => {
          const stCls = a.status === '已完成' ? ' done' : (a.status === '已取消' ? ' cancel' : '');
          inner += '<div class="evt' + stCls + '" style="border-left-color:' + esc(techColor(a.tech_id || a.tech_name)) + '" data-act="open-appt" data-id="' + a.id + '">' +
            '<span class="t">' + esc(a.time_slot) + '</span>' + esc(a.tech_name || '待分配') + '</div>';
        });
        if (evts.length > 3) inner += '<div class="cal-more">+' + (evts.length - 3) + ' 项</div>';
        rows += '<div class="' + cls.join(' ') + '" data-act="select-day" data-date="' + ds + '">' + inner + '</div>';
      }
      rows += '</div>';
    }

    const dayList = byDate[b.day] || [];
    const unassignedNote = list.filter(a => !a.tech_name).length;

    return '' +
      '<div class="page-head">' +
        '<div><h1 class="page-title">排期看板</h1>' +
          '<p class="page-desc">' + esc(state.profile.name) + ' · ' + esc(ROLE_LABEL[state.profile.role] || '') +
          ' · 共 ' + list.length + ' 条预约</p></div>' +
        '<div class="page-actions">' +
          '<button class="btn btn-primary" data-act="new-appt">＋ 新建预约</button>' +
        '</div>' +
      '</div>' +

      '<div class="filterbar">' +
        '<select class="select" data-filter="project"><option value="">全部项目</option>' +
          state.projects.filter(p => p.active !== false).map(p =>
            '<option value="' + p.id + '"' + (String(state.filters.project) === String(p.id) ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') +
        '</select>' +
        '<select class="select" data-filter="tech"><option value="">全部人员</option>' +
          techProfiles().map(p =>
            '<option value="' + esc(p.id) + '"' + (String(state.filters.tech) === String(p.id) ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') +
        '</select>' +
        '<select class="select" data-filter="status"><option value="">全部状态</option>' +
          STATUSES.map(s => '<option value="' + s + '"' + (state.filters.status === s ? ' selected' : '') + '>' + s + '</option>').join('') +
        '</select>' +
        '<button class="chip' + (!state.filters.tech && !state.filters.project && !state.filters.status ? ' active' : '') + '" data-act="clear-filter">重置</button>' +
        (unassignedNote ? '<span class="hint" style="margin-left:auto">有 ' + unassignedNote + ' 条未分配人员</span>' : '') +
      '</div>' +

      '<div class="card cal-wrap">' +
        '<div class="cal-toolbar">' +
          '<div class="cal-month">' + b.year + ' 年 ' + (b.month + 1) + ' 月<small>' + list.length + ' 项</small></div>' +
          '<div class="seg">' +
            '<button data-act="prev-month">‹</button>' +
            '<button data-act="this-month">本月</button>' +
            '<button data-act="next-month">›</button>' +
          '</div>' +
          '<div style="margin-left:auto;display:flex;gap:6px">' +
            '<button class="btn btn-sm" data-act="jump-today">回到今天</button>' +
          '</div>' +
        '</div>' +
        '<div class="cal-scroll"><div class="cal-grid">' +
          '<div class="cal-headrow">' + DOW.map(d => '<div class="cal-dow">' + d + '</div>').join('') + '</div>' +
          rows +
        '</div></div>' +
        '<div class="cal-foot">' +
          techProfiles().map(p => '<span class="legend"><i style="background:' + esc(p.color || '#2b6ef6') + '"></i>' + esc(p.name) + '</span>').join('') +
        '</div>' +
      '</div>' +

      '<div class="card" style="margin-top:16px">' +
        '<div class="day-head">' +
          '<div class="day-title">' + dayLabel(b.day) + '<span>' + (relDay(b.day) ? relDay(b.day) + ' · ' : '') + dayList.length + ' 项</span></div>' +
          '<button class="btn btn-sm" data-act="new-appt-day" data-date="' + b.day + '">在这天新建</button>' +
        '</div>' +
        (dayList.length ? dayList.map(apptRowHtml).join('') : emptyHtml('这天没有安排', '点右上角可以给这天加一条预约')) +
      '</div>';
  }

  function apptRowHtml(a) {
    return '<div class="appt-row" data-act="open-appt" data-id="' + a.id + '">' +
      '<div class="appt-time">' + esc(a.time_slot) + '</div>' +
      '<div class="appt-main">' +
        '<div class="appt-top">' +
          (a.priority === '加急' ? '<span class="tag tag-加急">加急</span>' : '') +
          '<span class="appt-addr">' + esc(a.address || a.content || '（未填地址）') + '</span>' +
        '</div>' +
        '<div class="appt-meta">' +
          '<span class="person"><span class="dot" style="background:' + esc(techColor(a.tech_id || a.tech_name)) + '"></span>' + esc(a.tech_name || '待分配') + '</span>' +
          (a.project_name ? '<span>' + esc(a.project_name) + '</span>' : '') +
          (a.contact_name || a.contact_phone ? '<span>' + esc(a.contact_name || '') + ' ' + esc(a.contact_phone || '') + '</span>' : '') +
        '</div>' +
        (a.content ? '<div class="appt-content">' + esc(a.content) + '</div>' : '') +
      '</div>' +
      '<div class="appt-side"><span class="tag tag-' + esc(a.status) + '">' + esc(a.status) + '</span></div>' +
    '</div>';
  }

  function emptyHtml(title, sub) {
    return '<div class="empty">' +
      '<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#c3c9d4" stroke-width="1.6"><rect x="3" y="4" width="18" height="17" rx="3"/><path d="M8 2v4M16 2v4M3 10h18"/></svg>' +
      '<p>' + esc(title) + '</p><span>' + esc(sub) + '</span></div>';
  }

  /* ============================================================
     视图：预约单列表
     ============================================================ */
  /* 生成适合直接粘贴到微信群的派单文案（纯文本，按人分组） */
  function dispatchText(dateStr) {
    const list = sortAppts(state.appointments.filter(a =>
      a.visit_date === dateStr && a.status !== '已取消' && a.status !== '已完成'));
    if (!list.length) return '';
    const groups = [];
    const index = {};
    list.forEach(a => {
      const key = a.tech_name || '待分配';
      if (!index[key]) { index[key] = []; groups.push(key); }
      index[key].push(a);
    });
    const out = ['【' + dayLabel(dateStr) + ' 派单 · 共 ' + list.length + ' 单】'];
    groups.forEach(name => {
      out.push('');
      out.push('▍' + name + '（' + index[name].length + ' 单）');
      index[name].forEach((a, i) => {
        out.push((i + 1) + '. ' + a.time_slot + ' · ' + (a.project_name ? a.project_name + ' · ' : '') + (a.address || '地址待填'));
        if (a.content) out.push('   事项：' + a.content);
        const c = [(a.contact_name || ''), (a.contact_phone || '')].join(' ').trim();
        if (c) out.push('   联系：' + c);
        if (a.priority && a.priority !== '普通') out.push('   ⚠ ' + a.priority);
      });
    });
    out.push('');
    out.push('（改期或完成后，请点群里的系统链接更新状态）');
    return out.join('\n');
  }

  function copyDispatch(dateStr) {
    const text = dispatchText(dateStr);
    if (!text) { toast('这天没有待办的单'); return; }
    copyText(text);
  }

  function listHtml() {
    const list = sortAppts(state.appointments.filter(apptMatchesFilter)).reverse();
    const rows = list.map(a =>
      '<tr data-act="open-appt" data-id="' + a.id + '">' +
        '<td class="nowrap"><b>' + esc(a.visit_date.slice(5)) + '</b><div class="cell-sub">' + esc(a.time_slot) + '</div></td>' +
        '<td class="nowrap">' + esc(a.project_name || '—') + '</td>' +
        '<td class="nowrap"><span class="person"><span class="dot" style="background:' + esc(techColor(a.tech_id || a.tech_name)) + '"></span>' + esc(a.tech_name || '待分配') + '</span></td>' +
        '<td>' + esc(a.address || '—') + '</td>' +
        '<td style="max-width:260px"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(a.content || '—') + '</div></td>' +
        '<td class="nowrap">' + esc(a.contact_name || '') + (a.contact_phone ? '<div class="cell-sub">' + esc(a.contact_phone) + '</div>' : '') + '</td>' +
        '<td class="nowrap"><span class="tag tag-' + esc(a.status) + '">' + esc(a.status) + '</span></td>' +
      '</tr>').join('');

    return '' +
      '<div class="page-head">' +
        '<div><h1 class="page-title">预约单</h1><p class="page-desc">共 ' + list.length + ' 条，按日期倒序</p></div>' +
        '<div class="page-actions">' +
          '<button class="btn" data-act="copy-today">今日派单</button>' +
          '<button class="btn" data-act="copy-tomorrow">明日派单</button>' +
          '<button class="btn" data-act="export-csv">导出 CSV</button>' +
          '<button class="btn btn-primary" data-act="new-appt">＋ 新建预约</button>' +
        '</div>' +
      '</div>' +
      '<div class="filterbar">' +
        '<input class="input" data-filter="q" placeholder="搜索地址 / 事项 / 联系人" value="' + esc(state.filters.q) + '">' +
        '<select class="select" data-filter="project"><option value="">全部项目</option>' +
          state.projects.filter(p => p.active !== false).map(p =>
            '<option value="' + p.id + '"' + (String(state.filters.project) === String(p.id) ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') +
        '</select>' +
        '<select class="select" data-filter="tech"><option value="">全部人员</option>' +
          techProfiles().map(p =>
            '<option value="' + esc(p.id) + '"' + (String(state.filters.tech) === String(p.id) ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') +
        '</select>' +
        '<select class="select" data-filter="status"><option value="">全部状态</option>' +
          STATUSES.map(s => '<option value="' + s + '"' + (state.filters.status === s ? ' selected' : '') + '>' + s + '</option>').join('') +
        '</select>' +
      '</div>' +
      '<div class="card"><div class="table-wrap">' +
        (list.length
          ? '<table class="tbl"><thead><tr><th>日期</th><th>项目</th><th>人员</th><th>地址</th><th>事项</th><th>联系人</th><th>状态</th></tr></thead><tbody>' + rows + '</tbody></table>'
          : emptyHtml('没有符合条件的预约', '调整筛选条件，或新建一条预约')) +
      '</div></div>';
  }

  /* ============================================================
     视图：我的安排
     ============================================================ */
  function mineHtml() {
    const me = state.profile;
    const mine = sortAppts(state.appointments.filter(a => String(a.tech_id || '') === String(me.id)));
    const t = todayStr();
    const tmr = new Date(); tmr.setDate(tmr.getDate() + 1);
    const weekEnd = new Date(); weekEnd.setDate(weekEnd.getDate() + 7);

    const groups = [
      { title: '已过期未处理', items: mine.filter(a => a.visit_date < t && a.status !== '已完成' && a.status !== '已取消') },
      { title: '今天', items: mine.filter(a => a.visit_date === t && a.status !== '已取消' && a.status !== '已完成') },
      { title: '明天', items: mine.filter(a => a.visit_date === ymd(tmr) && a.status !== '已取消' && a.status !== '已完成') },
      { title: '未来一周', items: mine.filter(a => a.visit_date > ymd(tmr) && a.visit_date <= ymd(weekEnd) && a.status !== '已取消' && a.status !== '已完成') },
      { title: '更晚', items: mine.filter(a => a.visit_date > ymd(weekEnd) && a.status !== '已取消' && a.status !== '已完成') },
      { title: '已完成', items: mine.filter(a => a.status === '已完成').sort((x, y) => x.visit_date < y.visit_date ? 1 : -1).slice(0, 20) }
    ];

    const pending = mine.filter(a => a.status === '待确认' || a.status === '已确认').length;
    const done = mine.filter(a => a.status === '已完成').length;

    let html = '<div class="page-head"><div>' +
      '<h1 class="page-title">我的安排</h1>' +
      '<p class="page-desc">待办 ' + pending + ' 项 · 已完成 ' + done + ' 项 · 全部 ' + mine.length + ' 项</p></div>' +
      '<div class="page-actions"><button class="btn btn-primary" data-act="new-appt">＋ 新建预约</button></div></div>';

    if (!mine.length) {
      html += '<div class="card">' + emptyHtml('还没有派给你的工作', '预约人给你排了活，这里就会出现') + '</div>';
      return html;
    }
    groups.forEach(g => {
      if (!g.items.length) return;
      html += '<div class="group-title">' + esc(g.title) + ' <span class="count">' + g.items.length + ' 项</span></div>';
      html += '<div class="stack">' + g.items.map(a => {
        const d = parseYmd(a.visit_date);
        return '<div class="mini-card" data-act="open-appt" data-id="' + a.id + '">' +
          '<div class="mini-date"><b>' + d.getDate() + '</b><span>' + (d.getMonth() + 1) + '月</span></div>' +
          '<div class="mini-body">' +
            '<h4>' + esc(a.address || a.content || '（未填地址）') + '</h4>' +
            '<div class="appt-meta">' +
              '<span>' + esc(a.time_slot) + '</span>' +
              (a.project_name ? '<span>' + esc(a.project_name) + '</span>' : '') +
              (a.contact_name || a.contact_phone ? '<span>' + esc(a.contact_name || '') + ' ' + esc(a.contact_phone || '') + '</span>' : '') +
            '</div>' +
            (a.content ? '<div class="appt-content">' + esc(a.content) + '</div>' : '') +
          '</div>' +
          '<div class="appt-side"><span class="tag tag-' + esc(a.status) + '">' + esc(a.status) + '</span></div>' +
        '</div>';
      }).join('') + '</div>';
    });
    return html;
  }

  /* ============================================================
     视图：设置
     ============================================================ */
  function settingsHtml() {
    const tabs = [
      { k: 'projects', t: '项目' },
      { k: 'people', t: '人员' },
      { k: 'notify', t: '通知' },
      { k: 'me', t: '我的资料' }
    ];
    return '<div class="page-head"><div><h1 class="page-title">设置</h1>' +
      '<p class="page-desc">' + esc(ROLE_LABEL[state.profile.role] || '') + ' · ' + (isAdmin() ? '可管理项目与人员' : '项目与人员由统筹管理员维护') + '</p></div></div>' +
      '<div class="settings-grid">' +
        '<div class="settings-nav">' + tabs.map(x =>
          '<button class="' + (state.settingsTab === x.k ? 'active' : '') + '" data-act="settings-tab" data-tab="' + x.k + '">' + x.t + '</button>').join('') +
        '</div>' +
        '<div>' + settingsPane() + '</div>' +
      '</div>';
  }

  function settingsPane() {
    if (state.settingsTab === 'projects') return projectsPane();
    if (state.settingsTab === 'people') return peoplePane();
    if (state.settingsTab === 'notify') return notifyPane();
    return mePane();
  }

  function projectsPane() {
    const rows = state.projects.map(p =>
      '<div class="list-row">' +
        '<span class="color-dot" style="background:' + esc(p.color || '#2b6ef6') + '"></span>' +
        '<div class="grow"><div class="nm">' + esc(p.name) + (p.active === false ? ' <span class="tag tag-已取消">停用</span>' : '') + '</div>' +
          '<div class="sub">' + esc(p.address || '未填地址') + '</div></div>' +
        (isAdmin()
          ? '<button class="btn btn-sm" data-act="edit-project" data-id="' + p.id + '">编辑</button>' +
            '<button class="btn btn-sm btn-danger" data-act="del-project" data-id="' + p.id + '">删除</button>'
          : '') +
      '</div>').join('');
    return '<div class="card">' +
      '<div class="card-head"><h3 class="card-title">项目（' + state.projects.length + '）</h3>' +
        (isAdmin() ? '<button class="btn btn-sm btn-primary" data-act="add-project">＋ 新增项目</button>' : '') + '</div>' +
      (state.projects.length ? rows : '<div class="empty"><p>还没有项目</p><span>先建一个项目，预约时就能归类</span></div>') +
      '</div>' +
      '<div class="card" style="margin-top:14px"><div class="card-body"><p class="hint">' +
        '项目用来区分不同楼盘/小区。预约单可以关联项目，看板和列表都支持按项目筛选。' +
      '</p></div></div>';
  }

  function peoplePane() {
    const rows = state.profiles.map(p =>
      '<div class="list-row">' +
        '<span class="avatar" style="background:' + esc(p.color || '#2b6ef6') + ';width:30px;height:30px;font-size:12px">' + esc(String(p.name).slice(0, 1)) + '</span>' +
        '<div class="grow"><div class="nm">' + esc(p.name) +
          (p.id === state.profile.id ? ' <span class="tag tag-已确认">我</span>' : '') +
          (p.user_id ? '' : ' <span class="tag tag-待确认">未绑定</span>') +
          (p.active === false ? ' <span class="tag tag-已取消">停用</span>' : '') + '</div>' +
          '<div class="sub">' + esc(p.phone || '无手机号') + ' · ' + esc(ROLE_LABEL[p.role] || p.role) + '</div></div>' +
        (isAdmin()
          ? '<button class="btn btn-sm" data-act="edit-person" data-id="' + esc(p.id) + '">编辑</button>' +
            (p.id === state.profile.id ? '' : '<button class="btn btn-sm btn-danger" data-act="del-person" data-id="' + esc(p.id) + '">删除</button>')
          : '') +
      '</div>').join('');
    return '<div class="card">' +
      '<div class="card-head"><h3 class="card-title">人员（' + state.profiles.length + '）</h3>' +
        (isAdmin() ? '<button class="btn btn-sm btn-primary" data-act="add-person">＋ 添加人员</button>' : '') + '</div>' +
      rows +
      '</div>' +
      '<div class="card" style="margin-top:14px"><div class="card-body"><p class="hint">' +
        '<b>未绑定</b>表示这个人还没登录过。你可以先把维修工的姓名录进来并直接派单，' +
        '他登录后从名单里认领自己即可，历史派单自动归到他名下。' +
      '</p></div></div>';
  }

  function emailCard(s) {
    s = s || {};
    const v = k => String(s[k] || '').trim();
    const ready = !!(v('emailjs_service_id') && v('emailjs_template_id') && v('emailjs_public_key'));
    const on = s.email_enabled === true;
    return '<div class="card" style="margin-top:14px"><div class="card-head"><h3 class="card-title">邮件通知</h3>' +
        '<span class="tag ' + (ready ? (on ? 'tag-已确认' : 'tag-待确认') : 'tag-已取消') + '">' +
          (ready ? (on ? '已启用' : '已配置 · 未启用') : '未配置') + '</span></div>' +
      '<div class="card-body">' +
        '<div class="list-row" style="padding:0 0 12px;border:0">' +
          '<div class="grow"><div class="nm">启用邮件</div><div class="sub">派单通知维修工、预约确认给业主、每日汇总</div></div>' +
          '<label class="switch"><input type="checkbox" data-act="toggle-email"' + (on ? ' checked' : '') + '><i></i></label>' +
        '</div>' +
        '<div class="field"><label>Service ID</label><input class="input" data-field="emailjs_service_id" value="' + esc(v('emailjs_service_id')) + '" placeholder="service_xxxxxxx"></div>' +
        '<div class="field"><label>Template ID</label><input class="input" data-field="emailjs_template_id" value="' + esc(v('emailjs_template_id')) + '" placeholder="template_xxxxxxx"></div>' +
        '<div class="field"><label>Public Key</label><input class="input" data-field="emailjs_public_key" value="' + esc(v('emailjs_public_key')) + '" placeholder="公钥，可公开"></div>' +
        '<div class="field"><label>每日汇总收件邮箱</label><input class="input" type="email" data-field="digest_email" value="' + esc(v('digest_email')) + '" placeholder="每天一封派单汇总，可留空"></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          '<button class="btn btn-primary btn-sm" data-act="save-email">保存</button>' +
          '<button class="btn btn-sm" data-act="test-mail">发一封测试</button>' +
          '<button class="btn btn-sm" data-act="send-digest">发今日汇总</button>' +
          '<button class="btn btn-sm" data-act="mail-logs">发送记录</button>' +
        '</div>' +
      '</div></div>' +
      '<div class="card" style="margin-top:14px"><div class="card-head"><h3 class="card-title">怎么配（一次性，约 10 分钟）</h3></div><div class="card-body">' +
        '<p class="hint" style="margin:0 0 10px">' +
          '① 打开 <b>emailjs.com</b> 用邮箱注册（免费，不用信用卡）→「Email Services」添加你的邮箱（QQ/163 要填授权码，不是登录密码）→ 记下 <b>Service ID</b>；<br>' +
          '②「Email Templates」新建模板，三个变量必须出现在模板里：收件人填 <b>{{to_email}}</b>，主题填 <b>{{subject}}</b>，正文切到 HTML 模式粘贴 <b>{{{message}}}</b>；<br>' +
          '③「Account → General」复制 <b>Public Key</b>；<br>' +
          '④ 三个值填到上面保存，点「发一封测试」，收到就通了。' +
        '</p>' +
        '<p class="hint" style="margin:0">免费额度 <b>200 封/月</b>。一单大约 2 封（派单 + 出发提醒），所以免费版约等于<b>每天 3-4 单</b>；' +
        '量再大就得 $9/月（2000 封），或者只开「每日汇总」这一种。' +
        '</p>' +
      '</div></div>';
  }

  function notifyPane() {
    const s = state.settings || {};
    const adminPart = isAdmin()
      ? '<div class="card"><div class="card-head"><h3 class="card-title">全局通知</h3></div><div class="card-body">' +
          '<div class="list-row" style="padding:0 0 12px;border:0">' +
            '<div class="grow"><div class="nm">启用微信推送</div><div class="sub">新建预约后立即推给对应维修工</div></div>' +
            '<label class="switch"><input type="checkbox" data-act="toggle-notify"' + (s.notify_enabled === false ? '' : ' checked') + '><i></i></label>' +
          '</div>' +
          '<div class="list-row" style="padding:0 0 12px;border:0">' +
            '<div class="grow"><div class="nm">出发提醒</div><div class="sub">有人打开系统时，自动把今天/次日还没提醒过的单推出去</div></div>' +
            '<button class="btn btn-sm" data-act="run-reminders">立即检查</button>' +
          '</div>' +
          '<div class="field"><label>备用 PushPlus Token（群推，可留空）</label>' +
            '<input class="input" data-field="pushplus_token" value="' + esc(s.pushplus_token || '') + '" placeholder="维修工自己没有 token 时，用它推到群里">' +
          '</div>' +
          '<button class="btn btn-primary btn-sm" data-act="save-notify">保存</button>' +
        '</div></div>' +
        '<div class="notice-warn notice" style="margin-top:14px">' +
          '微信推送用的是 PushPlus：维修工关注它的公众号后，消息会直接以微信消息弹出，不用装 App，点开消息能跳回系统。' +
          '如果维修工不想关注，系统里的<b>站内通知</b>和<b>一键复制文案</b>照样可用。' +
        '</div>' +
        emailCard(s)
      : '';

    const myToken = state.profile.push_token || '';
    return adminPart +
      '<div class="card" style="margin-top:14px"><div class="card-head"><h3 class="card-title">我的推送设置</h3></div><div class="card-body">' +
        '<div class="field"><label>我的邮箱</label>' +
          '<input class="input" type="email" data-field="my_email" value="' + esc(state.profile.email || '') + '" placeholder="派单和出发提醒会发到这个邮箱"></div>' +
        '<div class="field"><label>我的 PushPlus Token（选填）</label>' +
          '<input class="input" data-field="my_push_token" value="' + esc(myToken) + '" placeholder="留空则收不到微信推送"></div>' +
        '<p class="hint" style="margin:-6px 0 12px">Token 获取方式：手机打开 <b>pushplus.plus</b> → 微信扫码登录 → 完成实名 → 复制 token → 关注它的公众号。' +
        '邮箱和 Token 填一个就够，两个都填就两边都收。</p>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          '<button class="btn btn-primary btn-sm" data-act="save-my-push">保存</button>' +
          '<button class="btn btn-sm" data-act="test-push">发一条微信测试</button>' +
          '<button class="btn btn-sm" data-act="enable-desktop">开启电脑弹窗通知</button>' +
        '</div>' +
      '</div></div>' +
      '<div class="card" style="margin-top:14px"><div class="card-head"><h3 class="card-title">微信里怎么用最顺手</h3></div><div class="card-body"><p class="hint" style="margin:0">' +
        '① 在微信里打开本链接，右上角 <b>···</b> → <b>收藏</b>，下次从「我 → 收藏」一步进来；<br>' +
        '② 想更快的话，<b>···</b> → <b>浮窗</b>，聊天时会挂一个悬浮球；<br>' +
        '③ 登录一次后浏览器会记住，下次点开直接进，不用再输验证码。' +
      '</p></div></div>' +
      '<div class="card" style="margin-top:14px"><div class="card-body"><p class="hint">' +
        '通知分五层，互不影响，哪个通了就用哪个：<br>' +
        '① <b>站内通知</b>：右上角铃铛，登录后在系统里就能看到；<br>' +
        '② <b>电脑弹窗</b>：页面开着时弹系统通知（点上面的按钮授权）；<br>' +
        '③ <b>微信推送</b>：填了 token 才会发，走 PushPlus 公众号，点开能跳回系统；<br>' +
        '④ <b>邮件</b>：维修工填了邮箱就发派单和出发提醒，业主填了邮箱就发预约确认，统筹可收每日汇总；<br>' +
        '⑤ <b>出发提醒</b>：出发前一天/当天自动补发一次，避免漏单。' +
      '</p></div></div>';
  }

  function mePane() {
    const p = state.profile;
    return '<div class="card"><div class="card-head"><h3 class="card-title">我的资料</h3></div><div class="card-body">' +
      '<form data-form="save-me">' +
        '<div class="form-row">' +
          '<div class="field"><label>姓名</label><input class="input" name="name" value="' + esc(p.name) + '" required maxlength="20"></div>' +
          '<div class="field"><label>手机号</label><input class="input" name="phone" value="' + esc(p.phone || '') + '" maxlength="20"></div>' +
        '</div>' +
        '<div class="field"><label>邮箱</label><input class="input" type="email" name="email" value="' + esc(p.email || '') + '" placeholder="用于收派单和出发提醒"></div>' +
        '<div class="field"><label>我的排期颜色</label><div style="display:flex;gap:8px;flex-wrap:wrap">' +
          PALETTE.map(c => '<label style="cursor:pointer"><input type="radio" name="color" value="' + c + '"' + ((p.color || '') === c ? ' checked' : '') + ' style="display:none">' +
            '<span class="color-dot" style="width:24px;height:24px;background:' + c + ';display:inline-block;border-radius:50%;outline:' + ((p.color || '') === c ? '2px solid ' + c : 'none') + ';outline-offset:2px"></span></label>').join('') +
        '</div></div>' +
        '<button class="btn btn-primary btn-sm" type="submit">保存</button>' +
      '</form>' +
      '<div class="kv" style="margin-top:18px"><span>我的身份</span><b>' + esc(ROLE_LABEL[p.role] || p.role) + '</b></div>' +
      '<div class="kv"><span>账号状态</span><b>' + (p.active === false ? '已停用' : '正常') + '</b></div>' +
      '<div class="kv"><span>参与排期</span><b>' + (p.role === 'tech' ? '是' : '否（可被指派）') + '</b></div>' +
      '</div></div>' +
      '<div class="card" style="margin-top:14px"><div class="card-head"><h3 class="card-title">修改登录 PIN</h3></div><div class="card-body">' +
        '<div class="form-row">' +
          '<div class="field"><label>原 PIN</label><input class="input" data-field="pin_old" type="password" inputmode="numeric" maxlength="12" placeholder="当前 PIN"></div>' +
          '<div class="field"><label>新 PIN</label><input class="input" data-field="pin_new" type="password" inputmode="numeric" maxlength="12" placeholder="至少 4 位"></div>' +
        '</div>' +
        '<button class="btn btn-sm btn-primary" data-act="change-pin">保存新 PIN</button>' +
      '</div></div>' +
      '<div class="card" style="margin-top:14px"><div class="card-body" style="display:flex;justify-content:space-between;align-items:center">' +
        '<div><div class="nm" style="font-weight:550">退出登录</div><div class="sub">换一个账号登录</div></div>' +
        '<button class="btn btn-danger btn-sm" data-act="logout">退出</button>' +
      '</div></div>';
  }

  /* ============================================================
     预约表单 / 详情
     ============================================================ */
  function apptFormHtml(a) {
    a = a || {};
    const projectOpts = state.projects.filter(p => p.active !== false);
    const techOpts = techProfiles();
    return modalShell((a.id ? '编辑预约' : '新建预约'),
      '<form data-form="appt" data-id="' + (a.id || '') + '">' +
        '<div class="form-row">' +
          '<div class="field"><label>项目</label><select class="select" name="project_id" data-act="on-project">' +
            '<option value="">不指定</option>' +
            projectOpts.map(p => '<option value="' + p.id + '"' + (String(a.project_id) === String(p.id) ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') +
          '</select></div>' +
          '<div class="field"><label>维修人员</label><select class="select" name="tech_id">' +
            '<option value="">待分配</option>' +
            techOpts.map(p => '<option value="' + esc(p.id) + '"' + (String(a.tech_id) === String(p.id) ? ' selected' : '') + '>' + esc(p.name) + '（' + esc(ROLE_LABEL[p.role] || '') + '）</option>').join('') +
          '</select></div>' +
        '</div>' +
        '<div class="form-row">' +
          '<div class="field"><label>上门日期</label><input class="input" type="date" name="visit_date" value="' + esc(a.visit_date || state.board.day || todayStr()) + '" required></div>' +
          '<div class="field"><label>时段</label><select class="select" name="time_slot">' +
            SLOTS.map(s => '<option' + ((a.time_slot || '上午') === s ? ' selected' : '') + '>' + s + '</option>').join('') +
          '</select></div>' +
        '</div>' +
        '<div class="field"><label>维修地址</label><input class="input" name="address" value="' + esc(a.address || '') + '" placeholder="小区 / 楼栋 / 门牌"></div>' +
        '<div class="field"><label>报修内容</label><textarea class="textarea" name="content" placeholder="哪里坏了，需要带什么材料">' + esc(a.content || '') + '</textarea></div>' +
        '<div class="form-row">' +
          '<div class="field"><label>联系人</label><input class="input" name="contact_name" value="' + esc(a.contact_name || '') + '"></div>' +
          '<div class="field"><label>联系电话</label><input class="input" name="contact_phone" type="tel" value="' + esc(a.contact_phone || '') + '"></div>' +
        '</div>' +
        '<div class="field"><label>联系邮箱（选填，用于给业主发预约确认）</label><input class="input" type="email" name="contact_email" value="' + esc(a.contact_email || '') + '" placeholder="业主的邮箱，填了才会发确认邮件"></div>' +
        '<div class="form-row">' +
          '<div class="field"><label>优先级</label><select class="select" name="priority">' +
            ['普通', '加急'].map(s => '<option' + ((a.priority || '普通') === s ? ' selected' : '') + '>' + s + '</option>').join('') +
          '</select></div>' +
          '<div class="field"><label>状态</label><select class="select" name="status">' +
            STATUSES.map(s => '<option' + ((a.status || '待确认') === s ? ' selected' : '') + '>' + s + '</option>').join('') +
          '</select></div>' +
        '</div>' +
        '<div class="field"><label>备注</label><input class="input" name="note" value="' + esc(a.note || '') + '" placeholder="选填"></div>' +
      '</form>',
      '<button class="btn" data-act="close-modal">取消</button>' +
      '<button class="btn btn-primary" data-act="submit-appt" data-id="' + (a.id || '') + '">保存</button>'
    );
  }

  function openApptModal(a) {
    if (!a) {
      openModal(apptFormHtml(null));
      return;
    }
    const canDel = isAdmin() || a.owner_id === state.uid;
    const next = STATUS_NEXT[a.status] || [];
    const body =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap">' +
        '<span class="tag tag-' + esc(a.status) + '">' + esc(a.status) + '</span>' +
        (a.priority === '加急' ? '<span class="tag tag-加急">加急</span>' : '') +
        '<span class="hint" style="margin-left:auto">#' + a.id + '</span>' +
      '</div>' +
      '<div style="font-size:16px;font-weight:650;margin-bottom:12px">' + esc(a.address || '（未填地址）') + '</div>' +
      line('项目', a.project_name || '—') +
      line('维修人员', a.tech_name || '待分配') +
      line('上门时间', a.visit_date + ' ' + a.time_slot) +
      line('报修内容', a.content || '—') +
      line('联系人', (a.contact_name || '') + (a.contact_phone ? '　' + (a.contact_phone) : '')) +
      (a.contact_email ? line('联系邮箱', a.contact_email) : '') +
      (a.note ? line('备注', a.note) : '') +
      line('创建人', (a.creator_name || '—') + ' · ' + String(a.created_at || '').slice(0, 16).replace('T', ' ')) +
      (next.length ? '<div class="status-quick">' + next.map(s =>
        '<button class="btn btn-sm" data-act="set-status" data-id="' + a.id + '" data-status="' + s + '">标记为' + s + '</button>').join('') + '</div>' : '') +
      (a.status !== '已取消' && a.status !== '已完成'
        ? '<div class="status-quick"><button class="btn btn-sm" data-act="set-status" data-id="' + a.id + '" data-status="已取消">取消这条预约</button></div>'
        : '');

    openModal(modalShell('预约详情', body,
      '<button class="btn" data-act="copy-appt" data-id="' + a.id + '">复制通知文案</button>' +
      (mailReady() ? '<button class="btn btn-sm" data-act="mail-appt" data-id="' + a.id + '" data-kind="assign">发派单邮件</button>' : '') +
      (mailReady() && a.contact_email ? '<button class="btn btn-sm" data-act="mail-appt" data-id="' + a.id + '" data-kind="confirm">发预约确认</button>' : '') +
      '<button class="btn" data-act="edit-appt" data-id="' + a.id + '">编辑</button>' +
      (canDel ? '<button class="btn btn-danger" data-act="del-appt" data-id="' + a.id + '">删除</button>' : '')
    ));
  }

  function line(k, v) {
    return '<div class="detail-line"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>';
  }
  function lineRaw(k, html) {
    return '<div class="detail-line"><span class="k">' + esc(k) + '</span><span class="v">' + html + '</span></div>';
  }

  function readApptForm() {
    const f = $('form[data-form="appt"]');
    const g = n => { const el = f.elements[n]; return el ? String(el.value || '').trim() : ''; };
    const projectId = g('project_id');
    const proj = projectId ? projectById(projectId) : null;
    const techId = g('tech_id');
    const tp = techId ? profileById(techId) : null;
    return {
      project_id: projectId ? Number(projectId) : null,
      project_name: proj ? proj.name : null,
      tech_id: techId || null,
      tech_name: tp ? tp.name : null,
      visit_date: g('visit_date'),
      time_slot: g('time_slot') || '上午',
      address: g('address'),
      content: g('content'),
      contact_name: g('contact_name'),
      contact_phone: g('contact_phone'),
      contact_email: g('contact_email') || null,
      priority: g('priority') || '普通',
      status: g('status') || '待确认',
      note: g('note')
    };
  }

  async function saveAppt(id) {
    const payload = readApptForm();
    if (!payload.visit_date) { toast('请选择上门日期'); return; }
    if (!payload.address && !payload.content) { toast('请填写地址或报修内容'); return; }

    const btn = $('[data-act="submit-appt"]');
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }

    try {
      let created = null;
      if (id) {
        payload.updated_at = new Date().toISOString();
        const { data, error } = await db.from('appointments').update(payload).eq('id', Number(id)).select();
        if (error) throw error;
        if (!data || !data.length) throw new Error('没有权限修改这条预约');
      } else {
        payload.creator_name = state.profile.name;
        const { data, error } = await db.from('appointments').insert(payload).select();
        if (error) throw error;
        created = data && data[0];
      }
      closeModal();
      await loadAll();
      render();
      if (created) {
        await notifyAssignment(created);
        toast('已创建，并已通知 ' + (created.tech_name || '相关人员'));
      } else {
        toast('已保存');
      }
    } catch (e) {
      toast('保存失败：' + (e.message || '请重试'));
      if (btn) { btn.disabled = false; btn.textContent = '保存'; }
    }
  }

  async function notifyAssignment(a) {
    const text = apptText(a);
    const tp = a.tech_id ? profileById(a.tech_id) : null;
    // 站内通知
    if (tp && tp.user_id && tp.user_id !== state.uid) {
      try {
        await db.from('notifications').insert({
          owner_id: tp.user_id,
          appointment_id: a.id,
          title: '新维修预约：' + a.visit_date + ' ' + a.time_slot,
          body: text
        });
      } catch (e) { /* 通知失败不阻断主流程 */ }
    }
    // 微信推送
    const enabled = !state.settings || state.settings.notify_enabled !== false;
    if (enabled) {
      const token = (tp && tp.push_token) || (state.settings && state.settings.pushplus_token) || '';
      if (token) pushWeChat(token, '新维修预约 · ' + (a.tech_name || '待分配'), text, appLink());
    }
    // 邮件：派单给维修工、预约确认给业主（各自有邮箱才发，失败不阻断）
    await mailAssignment(a).catch(() => false);
    await mailConfirm(a).catch(() => false);
  }

  function apptText(a) {
    return [
      '【维修预约】' + (a.status || ''),
      '项目：' + (a.project_name || '未指定'),
      '人员：' + (a.tech_name || '待分配'),
      '时间：' + a.visit_date + ' ' + a.time_slot,
      '地址：' + (a.address || '未填'),
      '事项：' + (a.content || '未填'),
      '联系：' + [(a.contact_name || ''), (a.contact_phone || '')].join(' ').trim(),
      a.note ? '备注：' + a.note : ''
    ].filter(Boolean).join('\n');
  }

  function pushWeChat(token, title, content, link) {
    if (!token) return false;
    try {
      const body = new URLSearchParams();
      body.set('token', token);
      body.set('title', title);
      if (link) {
        body.set('template', 'html');
        body.set('content', String(content).split('\n').filter(Boolean)
          .map(l => '<p style="margin:4px 0">' + esc(l) + '</p>').join('') +
          '<p style="margin:16px 0 0"><a href="' + esc(link) + '">打开速派 →</a></p>');
      } else {
        body.set('template', 'txt');
        body.set('content', content);
      }
      fetch('https://www.pushplus.plus/send', {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        keepalive: true
      }).catch(() => {});
      return true;
    } catch (e) { return false; }
  }

  /* ============================================================
     邮件（EmailJS）
     · 浏览器直连 EmailJS，不需要自建服务端，也不需要邮箱密码；
     · 只用一个邮件模板，正文在本地拼成 HTML，塞进模板变量 {{{message}}}；
     · 每一封都写 email_logs，成功失败都能查，便于排查“没收到”。
     ============================================================ */
  const MAIL_API = 'https://api.emailjs.com/api/v1.0/email/send';

  const mailCfg = () => {
    const s = state.settings || {};
    return {
      enabled: s.email_enabled === true,
      service: String(s.emailjs_service_id || '').trim(),
      template: String(s.emailjs_template_id || '').trim(),
      key: String(s.emailjs_public_key || '').trim(),
      digestTo: String(s.digest_email || '').trim()
    };
  };
  // 三个参数齐了才算配好；enabled 只是“要不要自动发”的开关
  const mailReady = () => { const c = mailCfg(); return !!(c.service && c.template && c.key); };
  const mailOn = () => { const c = mailCfg(); return c.enabled && !!(c.service && c.template && c.key); };
  const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim());

  function mailHtml(opt) {
    const rows = (opt.rows || []).filter(r => r && r.v !== undefined && r.v !== null && r.v !== '')
      .map(r =>
        '<tr>' +
          '<td style="padding:9px 0;color:#6b7280;font-size:13px;width:88px;vertical-align:top;border-bottom:1px solid #eef0f4">' + esc(r.k) + '</td>' +
          '<td style="padding:9px 0;color:#111827;font-size:14px;line-height:1.6;border-bottom:1px solid #eef0f4">' + esc(r.v) + '</td>' +
        '</tr>').join('');
    const badge = opt.badge
      ? '<span style="display:inline-block;padding:3px 10px;border-radius:999px;background:' + (opt.badgeBg || '#e8f0fe') +
        ';color:' + (opt.badgeColor || '#2b6ef6') + ';font-size:12px;font-weight:600">' + esc(opt.badge) + '</span>'
      : '';
    const body = opt.bodyHtml
      ? '<div style="padding:4px 0 0">' + opt.bodyHtml + '</div>'
      : '<table style="width:100%;border-collapse:collapse;margin-top:4px">' + rows + '</table>';
    return '<div style="margin:0;padding:0;background:#f4f5f7">' +
      '<div style="max-width:560px;margin:0 auto;padding:22px 14px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,PingFang SC,Microsoft YaHei,sans-serif">' +
        '<div style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e6e8ee">' +
          '<div style="padding:18px 22px 16px;border-bottom:1px solid #eef0f4">' +
            '<div style="font-size:11px;color:#9aa1ad;letter-spacing:.1em;margin-bottom:7px">速派</div>' +
            '<div style="font-size:19px;font-weight:700;color:#111827;line-height:1.4">' + esc(opt.title) + '</div>' +
            (badge ? '<div style="margin-top:9px">' + badge + '</div>' : '') +
          '</div>' +
          '<div style="padding:6px 22px 8px">' +
            (opt.intro ? '<p style="margin:14px 0 0;color:#4b5563;font-size:14px;line-height:1.7">' + esc(opt.intro) + '</p>' : '') +
            body +
            (opt.tip ? '<p style="margin:16px 0 0;padding:10px 12px;background:#fff8e6;border-radius:8px;color:#8a5a00;font-size:13px;line-height:1.6">' + esc(opt.tip) + '</p>' : '') +
          '</div>' +
          (opt.action
            ? '<div style="padding:10px 22px 20px"><a href="' + esc(opt.action.url) + '" style="display:inline-block;padding:11px 18px;background:#2b6ef6;color:#ffffff;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600">' + esc(opt.action.text) + '</a></div>'
            : '') +
          '<div style="padding:14px 22px;background:#fafbfc;border-top:1px solid #eef0f4;color:#9aa1ad;font-size:12px;line-height:1.7">' +
            esc(opt.foot || '这封邮件由「速派」自动发出，请勿直接回复。') +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  // EmailJS 限流 1 请求/秒，串行排队，避免批量发信时被 429
  let mailChain = Promise.resolve();
  let lastMailAt = 0;
  function mailSlot() {
    mailChain = mailChain.then(async () => {
      const wait = 1100 - (Date.now() - lastMailAt);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      lastMailAt = Date.now();
    });
    return mailChain;
  }

  async function logMail(kind, to, subject, status, detail) {
    try {
      await db.from('email_logs').insert({
        kind: kind,
        to_email: to,
        subject: subject,
        status: status,
        detail: detail ? String(detail).slice(0, 500) : null
      });
    } catch (e) { /* 日志失败不影响发信 */ }
  }

  // 返回 { ok, error }。所有发信都走这里，便于统一处理失败原因
  async function sendMail(opt) {
    const c = mailCfg();
    if (!(c.service && c.template && c.key)) return { ok: false, error: '邮件服务未配置' };
    const to = String(opt.to || '').trim();
    if (!isEmail(to)) return { ok: false, error: '收件邮箱格式不对：' + (to || '（空）') };

    const payload = {
      service_id: c.service,
      template_id: c.template,
      user_id: c.key,
      template_params: {
        to_email: to,
        to_name: opt.toName || '',
        subject: opt.subject || '速派通知',
        message: opt.html || esc(opt.text || ''),
        plain_text: opt.text || ''
      }
    };

    let status = 'sent', detail = '';
    try {
      await mailSlot();
      const res = await fetch(MAIL_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const txt = await res.text().catch(() => '');
      if (!res.ok) {
        status = 'failed';
        detail = (txt || ('HTTP ' + res.status)).slice(0, 400);
      }
    } catch (e) {
      status = 'failed';
      detail = String((e && e.message) || e).slice(0, 400);
    }
    logMail(opt.kind || 'other', to, opt.subject || '', status, detail);
    return status === 'sent' ? { ok: true } : { ok: false, error: detail };
  }

  /* 派单邮件：发给被指派的维修工。mode='remind' 时改为出发提醒文案 */
  async function mailAssignment(a, mode) {
    if (!mailOn()) return false;
    const tp = a.tech_id ? profileById(a.tech_id) : null;
    const to = tp && tp.email ? String(tp.email).trim() : '';
    if (!isEmail(to)) return false;
    const isRemind = mode === 'remind';
    const when = dayLabel(a.visit_date) + ' ' + (a.time_slot || '');
    const r = await sendMail({
      to: to,
      toName: tp.name,
      subject: isRemind ? '【出发提醒】' + when + ' 有你的单' : '【新派单】' + when + ' · ' + (a.address || '地址待填'),
      kind: isRemind ? 'reminder' : 'assignment',
      html: mailHtml({
        title: isRemind ? '提醒：' + when + ' 上门' : (a.tech_name || tp.name) + '，你有新的上门任务',
        badge: when,
        badgeBg: a.priority === '加急' ? '#fdeaea' : '#e8f0fe',
        badgeColor: a.priority === '加急' ? '#e5484d' : '#2b6ef6',
        intro: isRemind ? '这单就在最近两天，别忘带工具和材料。' : '请按下面信息上门，完成后回系统把状态改成「已完成」。',
        rows: [
          { k: '项目', v: a.project_name || '未指定' },
          { k: '上门时间', v: when },
          { k: '地址', v: a.address || '待填' },
          { k: '报修内容', v: a.content || '待填' },
          { k: '联系人', v: [(a.contact_name || ''), (a.contact_phone || '')].join(' ').trim() },
          { k: '备注', v: a.note || '' },
          { k: '单号', v: '#' + a.id }
        ],
        tip: a.priority === '加急' ? '这单是加急，请优先安排。' : '',
        action: { text: '打开我的安排', url: appLink() }
      })
    });
    a.mailed_at = new Date().toISOString();
    return r.ok;
  }

  /* 预约确认：发给业主/报修人，比微信消息正式，可留档可转发 */
  async function mailConfirm(a) {
    if (!mailOn()) return false;
    const to = String(a.contact_email || '').trim();
    if (!isEmail(to)) return false;
    const when = dayLabel(a.visit_date) + ' ' + (a.time_slot || '');
    const r = await sendMail({
      to: to,
      toName: a.contact_name || '',
      subject: '【预约确认】' + when + ' 上门维修',
      kind: 'confirm',
      html: mailHtml({
        title: '你的上门维修已安排',
        badge: when,
        intro: (a.contact_name ? a.contact_name + '，你好：' : '你好：') +
          '我们已安排维修人员在上述时间上门，请留意来电。如需改期，请联系对接人。',
        rows: [
          { k: '上门时间', v: when },
          { k: '维修人员', v: a.tech_name || '待安排' },
          { k: '地址', v: a.address || '' },
          { k: '维修事项', v: a.content || '' },
          { k: '项目', v: a.project_name || '' },
          { k: '单号', v: '#' + a.id }
        ],
        tip: '如果这个时间不方便，请提前告知，我们可以改期。',
        foot: '如需改期或取消，直接回复对接人电话即可。'
      })
    });
    if (r.ok) {
      try { await db.from('appointments').update({ mailed_at: new Date().toISOString() }).eq('id', Number(a.id)); } catch (e) { /* ignore */ }
    }
    return r.ok;
  }

  /* 每日汇总：一天一封，靠 settings.last_digest_date 去重 */
  async function mailDigest(dateStr, force) {
    const c = mailCfg();
    if (!(c.service && c.template && c.key)) return { ok: false, error: '邮件服务未配置' };
    if (!isEmail(c.digestTo)) return { ok: false, error: '还没填汇总收件邮箱' };
    const s = state.settings || {};
    if (!force && s.last_digest_date === dateStr) return { ok: false, error: 'already' };

    const list = sortAppts(state.appointments.filter(a =>
      a.visit_date === dateStr && a.status !== '已取消'));
    if (!list.length) return { ok: false, error: 'empty' };

    const groups = {};
    list.forEach(a => { const k = a.tech_name || '待分配'; (groups[k] = groups[k] || []).push(a); });

    let body = '<div style="margin:14px 0 0;color:#4b5563;font-size:14px;line-height:1.7">共 <b>' + list.length + '</b> 单，' +
      Object.keys(groups).length + ' 人出工。</div>';
    Object.keys(groups).forEach(name => {
      body += '<div style="margin:18px 0 6px;font-size:14px;font-weight:700;color:#111827">' + esc(name) +
        '<span style="color:#9aa1ad;font-weight:400"> · ' + groups[name].length + ' 单</span></div>';
      body += groups[name].map((a, i) =>
        '<div style="padding:10px 12px;background:#f7f8fa;border-radius:8px;margin-bottom:6px">' +
          '<div style="font-size:13px;color:#111827;font-weight:600">' + (i + 1) + '. ' + esc(a.time_slot || '') + ' · ' +
            esc(a.address || '地址未填') + (a.priority === '加急' ? ' <span style="color:#e5484d">加急</span>' : '') + '</div>' +
          '<div style="font-size:13px;color:#4b5563;margin-top:3px;line-height:1.6">' + esc(a.content || '—') + '</div>' +
          (a.contact_phone ? '<div style="font-size:12px;color:#9aa1ad;margin-top:3px">' +
            esc([(a.contact_name || ''), a.contact_phone].join(' ').trim()) + '</div>' : '') +
        '</div>').join('');
    });

    const r = await sendMail({
      to: c.digestTo,
      toName: '统筹',
      subject: '【今日派单】' + dateStr + ' · 共 ' + list.length + ' 单',
      kind: 'digest',
      html: mailHtml({
        title: dateStr + ' ' + (DOW[(parseYmd(dateStr).getDay() + 6) % 7] || '') + ' 派单汇总',
        badge: list.length + ' 单',
        bodyHtml: body,
        foot: '这封汇总每天第一次有管理员打开系统时自动发出，一天只发一封。'
      })
    });

    if (r.ok) {
      try {
        const { data } = await db.from('settings').update({ last_digest_date: dateStr }).eq('id', 1).select();
        if (data && data[0]) state.settings = data[0];
      } catch (e) { /* 非管理员更新失败则下次再发 */ }
    }
    return r;
  }

  // 打开系统时顺带补发（谁先打开谁触发，一天一封）
  async function autoDigest() {
    if (window.__LOCAL__) return; // 同上，服务端自己会发
    if (!mailOn() || !isAdmin()) return;
    const c = mailCfg();
    if (!isEmail(c.digestTo)) return;
    if (new Date().getHours() < 8) return;
    const today = todayStr();
    if ((state.settings || {}).last_digest_date === today) return;
    await mailDigest(today, false).catch(() => {});
  }

  /* 出发提醒：客户端触发、幂等去重。
     没有常驻服务端，无法定时跑；换成一有人打开系统就补发当天/次日尚未提醒的单。 */
  async function runReminders() {
    if (window.__LOCAL__) return 0; // 自托管版由服务端定时任务负责，避免重复推送
    const s = state.settings || {};
    if (s.notify_enabled === false) return 0;
    if (state.reminderRunning) return 0;
    const today = todayStr(), tomorrow = addDays(1);
    const due = state.appointments.filter(a =>
      !a.reminded_at &&
      a.status !== '已完成' && a.status !== '已取消' &&
      (a.visit_date === today || a.visit_date === tomorrow)
    );
    if (!due.length) return 0;

    state.reminderRunning = true;
    let sent = 0;
    try {
      for (const a of due) {
        const tp = a.tech_id ? profileById(a.tech_id) : null;
        const token = (tp && tp.push_token) || s.pushplus_token || '';
        let did = false;
        if (token) {
          const when = a.visit_date === today ? '今天' : '明天';
          pushWeChat(token, when + '上门 · ' + (a.tech_name || '待分配'), apptText(a), appLink());
          did = true;
        }
        if (mailOn() && tp && isEmail(tp.email)) {
          const ok = await mailAssignment(a, 'remind').catch(() => false);
          if (ok) did = true;
        }
        if (!did) continue; // 没有任何可用渠道就先不标记，等有人填了邮箱/Token 再补
        sent++;
        const stamp = new Date().toISOString();
        try {
          await db.from('appointments').update({ reminded_at: stamp }).eq('id', Number(a.id));
          a.reminded_at = stamp;
        } catch (e) { /* 无权限则下次再试 */ }
      }
    } finally {
      state.reminderRunning = false;
    }
    return sent;
  }

  function desktopNotify(title, body) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try { new Notification(title, { body: body }); } catch (e) { /* ignore */ }
  }

  /* ============================================================
     事件绑定
     ============================================================ */
  function bindGlobal() {
    document.addEventListener('click', onClick);
    document.addEventListener('submit', onSubmit);
    document.addEventListener('change', onChange);
    document.addEventListener('input', onInput);
    window.addEventListener('hashchange', () => navigate(location.hash, true));
  }

  function onClick(e) {
    const nav = e.target.closest('[data-nav]');
    if (nav) { e.preventDefault(); navigate('#/' + nav.getAttribute('data-nav')); return; }

    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.getAttribute('data-act');
    const id = el.getAttribute('data-id');

    switch (act) {
      case 'close-modal': closeModal(); break;
      case 'new-appt': openModal(apptFormHtml(null)); break;
      case 'new-appt-day': state.board.day = el.getAttribute('data-date'); openModal(apptFormHtml(null)); break;
      case 'open-appt': {
        const a = state.appointments.filter(x => String(x.id) === String(id))[0];
        if (a) openApptModal(a);
        break;
      }
      case 'edit-appt': {
        const a = state.appointments.filter(x => String(x.id) === String(id))[0];
        if (a) openModal(apptFormHtml(a));
        break;
      }
      case 'submit-appt': saveAppt(el.getAttribute('data-id')); break;
      case 'set-status': setStatus(Number(id), el.getAttribute('data-status')); break;
      case 'del-appt': delAppt(Number(id)); break;
      case 'copy-appt': copyAppt(Number(id)); break;
      case 'mail-appt': mailFromDetail(id, el.getAttribute('data-kind')); break;
      case 'copy-today': copyDispatch(todayStr()); break;
      case 'copy-tomorrow': copyDispatch(addDays(1)); break;
      case 'select-day': state.board.day = el.getAttribute('data-date'); render(); break;
      case 'prev-month': shiftMonth(-1); break;
      case 'next-month': shiftMonth(1); break;
      case 'this-month': state.board.year = new Date().getFullYear(); state.board.month = new Date().getMonth(); render(); break;
      case 'jump-today': {
        const n = new Date();
        state.board.year = n.getFullYear(); state.board.month = n.getMonth(); state.board.day = todayStr();
        render(); break;
      }
      case 'clear-filter':
        state.filters = { tech: '', project: '', status: '', q: '' };
        render(); break;
      case 'export-csv': exportCsv(); break;
      case 'settings-tab': state.settingsTab = el.getAttribute('data-tab'); render(); break;
      case 'logout': doLogout(); break;
      case 'login-mode': e.preventDefault(); state.loginMode = el.getAttribute('data-mode'); showLogin(); break;
      case 'oauth': startOAuth(el.getAttribute('data-provider')); break;
      case 'send-code': sendCode(el); break;
      case 'claim': claimProfile(el.getAttribute('data-id')); break;
      case 'pick-role': {
        $$('.role-card').forEach(c => c.classList.remove('active'));
        el.classList.add('active');
        const f = $('form[data-form="onboard-new"]');
        if (f) f.elements.role.value = el.getAttribute('data-role');
        break;
      }
      case 'add-project': openProjectModal(null); break;
      case 'edit-project': openProjectModal(projectById(id)); break;
      case 'del-project': delProject(id); break;
      case 'add-person': openPersonModal(null); break;
      case 'edit-person': openPersonModal(profileById(id)); break;
      case 'del-person': delPerson(id); break;
      case 'save-notify': saveNotify(); break;
      case 'save-my-push': saveMyPush(); break;
      case 'test-push': testPush(); break;
      case 'save-email': saveEmail(); break;
      case 'test-mail': testMail(); break;
      case 'send-digest': sendDigestNow(el); break;
      case 'mail-logs': openMailLogs(); break;
      case 'run-reminders': manualReminders(el); break;
      case 'enable-desktop': enableDesktop(); break;
      case 'change-pin': changeMyPin(); break;
      case 'open-notifs': openNotifPanel(); break;
      case 'mark-all-read': markAllRead(); break;
      case 'notif-open': openNotifById(id); break;
      case 'user-menu': openUserMenu(); break;
      case 'copy-text': copyText(el.getAttribute('data-text')); break;
    }
  }

  function onChange(e) {
    const t = e.target;
    if (t.getAttribute('data-filter')) {
      const k = t.getAttribute('data-filter');
      state.filters[k] = t.value;
      if (state.view === 'board' && k === 'q') return;
      render();
      return;
    }
    if (t.getAttribute('data-act') === 'toggle-notify') { saveNotify(t.checked); return; }
    if (t.getAttribute('data-act') === 'toggle-email') { saveEmail(t.checked); return; }
    if (t.getAttribute('data-act') === 'on-project') {
      const pid = t.value;
      const f = $('form[data-form="appt"]');
      const proj = pid ? projectById(pid) : null;
      if (f && proj && proj.address && !f.elements.address.value) f.elements.address.value = proj.address;
      return;
    }
  }

  let searchTimer = null;
  function onInput(e) {
    const t = e.target;
    if (t.getAttribute('data-filter') === 'q') {
      clearTimeout(searchTimer);
      const v = t.value;
      searchTimer = setTimeout(() => {
        state.filters.q = v;
        const pos = t.selectionStart;
        render();
        const n = $('[data-filter="q"]');
        if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (err) {} }
      }, 220);
    }
  }

  function onSubmit(e) {
    const f = e.target;
    const kind = f.getAttribute('data-form');
    if (!kind) return;
    e.preventDefault();
    if (kind === 'login') submitLogin(f);
    else if (kind === 'setup') submitSetup(f);
    else if (kind === 'appt') saveAppt(f.getAttribute('data-id'));
    else if (kind === 'onboard-new') submitOnboardNew(f);
    else if (kind === 'save-me') saveMe(f);
    else if (kind === 'project') saveProject(f);
    else if (kind === 'person') savePerson(f);
  }

  /* ---------- 登录动作（本地账号：姓名 + PIN） ---------- */
  async function submitLogin(f) {
    const name = (f.elements.name.value || '').trim();
    const pin = (f.elements.pin.value || '').trim();
    if (!name) { toast('请填写姓名'); return; }
    if (!pin) { toast('请填写 PIN'); return; }

    const btn = f.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = '登录中…'; }
    const { data, error } = await cloud.auth.signIn(name, pin);
    if (error) {
      if (btn) { btn.disabled = false; btn.textContent = '登录'; }
      toast('登录失败：' + (error.message || '请重试'), 3600);
      return;
    }
    await afterAuth(data);
  }

  async function submitSetup(f) {
    const name = (f.elements.name.value || '').trim();
    const pin = (f.elements.pin.value || '').trim();
    const pin2 = (f.elements.pin2.value || '').trim();
    if (!name) { toast('请填写姓名'); return; }
    if (pin.length < 4) { toast('PIN 至少 4 位'); return; }
    if (pin !== pin2) { toast('两次输入的 PIN 不一致'); return; }

    const btn = f.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = '创建中…'; }
    const { data, error } = await cloud.auth.setup(name, pin);
    if (error) {
      if (btn) { btn.disabled = false; btn.textContent = '创建管理员账号'; }
      toast('创建失败：' + (error.message || '请重试'), 4000);
      return;
    }
    state.loginMode = 'login';
    await afterAuth(data);
    toast('欢迎，' + name + '。你是统筹管理员');
  }

  // 本地版没有短信，保留同名占位，避免旧引用报错
  async function sendCode() { toast('本地版不支持短信登录，请用姓名 + PIN'); }

  async function startOAuth(provider) {
    const { data, error } = await cloud.auth.signInWithOAuth({
      provider: provider,
      redirectTo: location.origin
    });
    if (error) { showLogin('无法发起登录：' + (error.message || '该登录方式暂不可用')); return; }
    location.assign(data.url);
  }

  async function afterAuth(result) {
    let session = result && result.session ? result.session : result;
    if (!session || !session.user) {
      const r = await cloud.auth.getSession();
      session = r.data;
    }
    if (!session) { showLogin('登录状态获取失败，请重试'); return; }
    state.session = session;
    state.user = session.user || {};
    state.uid = await resolveUid(state.user);
    const prof = await fetchMyProfile().catch(() => null);
    if (!prof) { await startOnboarding(); return; }
    state.profile = prof;
    await enterApp();
  }

  async function claimProfile(id) {
    const p = profileById(id);
    if (!p) return;
    const { data, error } = await db.from('profiles').update({ user_id: state.uid }).eq('id', id).is('user_id', null).select();
    if (error) { toast('绑定失败：' + (error.message || '请重试')); return; }
    if (!data || !data.length) { toast('这条档案已被占用，请刷新后重试'); return; }
    const prof = await fetchMyProfile();
    if (!prof) { toast('绑定失败，请重试'); return; }
    state.profile = prof;
    await enterApp();
    toast('已绑定到 ' + prof.name);
  }

  async function submitOnboardNew(f) {
    const name = (f.elements.name.value || '').trim();
    const phone = (f.elements.phone.value || '').trim();
    const role = (f.elements.role.value || 'tech').trim();
    if (!name) { toast('请填写姓名'); return; }
    const btn = f.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = '处理中…'; }
    const { data, error } = await db.from('profiles').insert({
      id: 'p_' + Math.random().toString(36).slice(2, 10),
      user_id: state.uid,
      name: name,
      phone: phone || null,
      role: role,
      color: PALETTE[state.profiles.length % PALETTE.length]
    }).select();
    if (error) {
      if (btn) { btn.disabled = false; btn.textContent = '完成，进入系统'; }
      toast('创建失败：' + (error.message || '请重试'));
      return;
    }
    state.profile = data && data[0];
    await enterApp();
    toast('欢迎，' + name);
  }

  async function doLogout() {
    try { await cloud.auth.signOut(); } catch (e) { /* ignore */ }
    state.session = null; state.user = null; state.uid = null; state.profile = null;
    state.notifications = []; state.lastNotifId = 0;
    if (state.pollTimer) clearInterval(state.pollTimer);
    showLogin('已退出登录', true);
  }

  /* ---------- 预约动作 ---------- */
  async function setStatus(id, status) {
    const { data, error } = await db.from('appointments').update({ status: status, updated_at: new Date().toISOString() }).eq('id', id).select();
    if (error) { toast('操作失败：' + (error.message || '')); return; }
    if (!data || !data.length) { toast('没有权限修改这条预约'); return; }
    closeModal();
    await loadAll(); render();
    toast('已标记为' + status);
  }

  async function delAppt(id) {
    const a = state.appointments.filter(x => Number(x.id) === Number(id))[0];
    if (!a) return;
    const ok = await confirmDialog('删除预约', '「' + (a.address || a.content || ('#' + id)) + '」这一条会被永久删除，无法恢复。');
    if (!ok) return;
    const { data, error } = await db.from('appointments').delete().eq('id', id).select();
    if (error) { toast('删除失败：' + (error.message || '')); return; }
    if (!data || !data.length) { toast('没有权限删除这条预约'); return; }
    closeModal();
    await loadAll(); render();
    toast('已删除');
  }

  function copyAppt(id) {
    const a = state.appointments.filter(x => String(x.id) === String(id))[0];
    if (!a) return;
    copyText(apptText(a));
  }

  async function mailFromDetail(id, kind) {
    const a = state.appointments.filter(x => String(x.id) === String(id))[0];
    if (!a) return;
    if (!mailReady()) { toast('邮件还没配置，去 设置 → 通知 里填三个参数'); return; }
    toast('正在发送…');
    const ok = kind === 'confirm' ? await mailConfirm(a).catch(() => false) : await mailAssignment(a).catch(() => false);
    if (ok) { toast('已发出'); return; }
    const who = kind === 'confirm' ? '这条单没填联系邮箱' : '被指派的维修工没填邮箱';
    toast('没发出去：' + who + '，或邮件配置有误。可在「发送记录」里看具体原因', 5000);
  }

  function copyText(text) {
    const done = () => toast('已复制，去微信粘贴发送');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  }
  function fallbackCopy(text, cb) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); cb(); } catch (e) { toast('复制失败，请手动选择文本'); }
    document.body.removeChild(ta);
  }

  function exportCsv() {
    const list = sortAppts(state.appointments.filter(apptMatchesFilter));
    const head = ['日期', '时段', '项目', '维修人员', '地址', '报修内容', '联系人', '联系电话', '状态', '优先级', '备注', '创建人'];
    const rows = list.map(a => [a.visit_date, a.time_slot, a.project_name, a.tech_name, a.address, a.content, a.contact_name, a.contact_phone, a.status, a.priority, a.note, a.creator_name]);
    const csv = [head].concat(rows).map(r => r.map(v => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"').join(',')).join('\r\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '维修预约_' + todayStr() + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('已导出 ' + list.length + ' 条');
  }

  function shiftMonth(delta) {
    const b = state.board;
    let y = b.year, m = b.month + delta;
    if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; }
    b.year = y; b.month = m;
    const cur = parseYmd(b.day);
    if (cur.getFullYear() !== y || cur.getMonth() !== m) b.day = ymd(new Date(y, m, 1));
    render();
  }

  function paintColorPickers() {
    $$('input[name="color"]').forEach(x => {
      const s = x.nextElementSibling;
      if (!s) return;
      s.style.outline = x.checked ? '2px solid ' + x.value : 'none';
      s.style.outlineOffset = '2px';
    });
  }

  /* ---------- 设置动作 ---------- */
  function openProjectModal(p) {
    const colors = PALETTE;
    openModal(modalShell(p ? '编辑项目' : '新增项目',
      '<form data-form="project" data-id="' + (p ? p.id : '') + '">' +
        '<div class="field"><label>项目名称</label><input class="input" name="name" value="' + esc(p ? p.name : '') + '" placeholder="如：阳光小区" required maxlength="30"></div>' +
        '<div class="field"><label>默认地址（可选）</label><input class="input" name="address" value="' + esc(p ? p.address || '' : '') + '" placeholder="填了之后新建预约会自动带出"></div>' +
        '<div class="field"><label>颜色</label><div style="display:flex;gap:8px;flex-wrap:wrap">' +
          colors.map(c => '<label style="cursor:pointer"><input type="radio" name="color" value="' + c + '"' + ((p && p.color === c) || (!p && c === colors[0]) ? ' checked' : '') + ' style="display:none">' +
            '<span class="color-dot" style="width:24px;height:24px;background:' + c + ';display:inline-block;border-radius:50%"></span></label>').join('') +
        '</div></div>' +
        '<div class="list-row" style="padding:0;border:0"><div class="grow"><div class="nm">启用</div><div class="sub">停用后不再出现在新建预约的下拉里</div></div>' +
          '<label class="switch"><input type="checkbox" name="active"' + (!p || p.active !== false ? ' checked' : '') + '><i></i></label></div>' +
      '</form>',
      '<button class="btn" data-act="close-modal">取消</button>' +
      '<button class="btn btn-primary" data-act="save-project-form">保存</button>'
    ));
    const btn = $('[data-act="save-project-form"]');
    if (btn) btn.onclick = () => { const f = $('form[data-form="project"]'); if (f) saveProject(f); };
    $$('input[name="color"]').forEach(r => r.addEventListener('change', paintColorPickers));
    paintColorPickers();
  }

  async function saveProject(f) {
    const name = (f.elements.name.value || '').trim();
    if (!name) { toast('请填写项目名称'); return; }
    const payload = {
      name: name,
      address: (f.elements.address.value || '').trim() || null,
      color: f.elements.color.value,
      active: f.elements.active.checked
    };
    const id = f.getAttribute('data-id');
    const res = id
      ? await db.from('projects').update(payload).eq('id', Number(id)).select()
      : await db.from('projects').insert(payload).select();
    if (res.error) { toast('保存失败：' + (res.error.message || '')); return; }
    if (!res.data || !res.data.length) { toast('没有权限，只有统筹管理员能管理项目'); return; }
    closeModal(); await loadAll(); render();
    toast('已保存');
  }

  async function delProject(id) {
    const p = projectById(id);
    const ok = await confirmDialog('删除项目', '「' + (p ? p.name : id) + '」会被删除。已关联的预约单会保留，但不再显示项目名。');
    if (!ok) return;
    const { data, error } = await db.from('projects').delete().eq('id', Number(id)).select();
    if (error) { toast('删除失败：' + (error.message || '')); return; }
    if (!data || !data.length) { toast('没有权限删除'); return; }
    await loadAll(); render();
    toast('已删除');
  }

  function openPersonModal(p) {
    openModal(modalShell(p ? '编辑人员' : '添加人员',
      '<form data-form="person" data-id="' + (p ? esc(p.id) : '') + '">' +
        '<div class="form-row">' +
          '<div class="field"><label>姓名</label><input class="input" name="name" value="' + esc(p ? p.name : '') + '" required maxlength="20"></div>' +
          '<div class="field"><label>手机号</label><input class="input" name="phone" type="tel" value="' + esc(p ? p.phone || '' : '') + '" maxlength="20"></div>' +
        '</div>' +
        '<div class="field"><label>邮箱（选填）</label><input class="input" type="email" name="email" value="' + esc(p ? p.email || '' : '') + '" placeholder="派单和出发提醒会发到这里"></div>' +
        '<div class="field"><label>登录 PIN' + (p ? '（留空则不修改）' : '（至少 4 位）') + '</label><input class="input" name="pin" type="text" inputmode="numeric" maxlength="12" value="" placeholder="' + (p ? '重设 PIN 时填这里' : '员工用姓名 + PIN 登录') + '"></div>' +
        '<div class="field"><label>身份</label><select class="select" name="role">' +
          ['tech', 'requester', 'admin'].map(r => '<option value="' + r + '"' + ((p ? p.role : 'tech') === r ? ' selected' : '') + '>' + ROLE_LABEL[r] + '</option>').join('') +
        '</select></div>' +
        '<div class="field"><label>颜色</label><div style="display:flex;gap:8px;flex-wrap:wrap">' +
          PALETTE.map(c => '<label style="cursor:pointer"><input type="radio" name="color" value="' + c + '"' + ((p && p.color === c) || (!p && c === PALETTE[0]) ? ' checked' : '') + ' style="display:none">' +
            '<span class="color-dot" style="width:24px;height:24px;background:' + c + ';display:inline-block;border-radius:50%"></span></label>').join('') +
        '</div></div>' +
        '<div class="list-row" style="padding:0;border:0"><div class="grow"><div class="nm">在职</div><div class="sub">停用后不再出现在派单下拉里</div></div>' +
          '<label class="switch"><input type="checkbox" name="active"' + (!p || p.active !== false ? ' checked' : '') + '><i></i></label></div>' +
      '</form>',
      '<button class="btn" data-act="close-modal">取消</button>' +
      '<button class="btn btn-primary" data-act="save-person-form">保存</button>'
    ));
    const btn = $('[data-act="save-person-form"]');
    if (btn) btn.onclick = () => { const f = $('form[data-form="person"]'); if (f) savePerson(f); };
    $$('input[name="color"]').forEach(r => r.addEventListener('change', paintColorPickers));
    paintColorPickers();
  }

  async function savePerson(f) {
    const name = (f.elements.name.value || '').trim();
    if (!name) { toast('请填写姓名'); return; }
    const id = f.getAttribute('data-id');
    const email = (f.elements.email ? String(f.elements.email.value || '') : '').trim();
    if (email && !isEmail(email)) { toast('邮箱格式不对：' + email); return; }
    const pin = (f.elements.pin ? String(f.elements.pin.value || '') : '').trim();
    if (pin && pin.length < 4) { toast('PIN 至少 4 位'); return; }
    const payload = {
      name: name,
      phone: (f.elements.phone.value || '').trim() || null,
      email: email || null,
      role: f.elements.role.value,
      color: f.elements.color.value,
      active: f.elements.active.checked
    };
    let initPin = false;
    if (pin) payload.pin = pin;
    else if (!id) { payload.pin = '1234'; initPin = true; }
    if (!id) payload.user_id = null;
    const res = id
      ? await db.from('profiles').update(payload).eq('id', id).select()
      : await db.from('profiles').insert(Object.assign({ id: 'p_' + Math.random().toString(36).slice(2, 10) }, payload)).select();
    if (res.error) { toast('保存失败：' + (res.error.message || '')); return; }
    if (!res.data || !res.data.length) { toast('没有权限'); return; }
    closeModal(); await loadAll(); render();
    toast(initPin ? '已添加，初始 PIN 是 1234，让对方登录后自己改' : '已保存', initPin ? 4200 : undefined);
  }

  async function delPerson(id) {
    const p = profileById(id);
    const ok = await confirmDialog('删除人员', '「' + (p ? p.name : id) + '」会从名单里移除。已派给他的预约单会保留，显示为原来的人名。');
    if (!ok) return;
    const { data, error } = await db.from('profiles').delete().eq('id', id).select();
    if (error) { toast('删除失败：' + (error.message || '')); return; }
    if (!data || !data.length) { toast('没有权限删除'); return; }
    await loadAll(); render();
    toast('已删除');
  }

  async function saveNotify(forceEnabled) {
    const el = $('[data-field="pushplus_token"]');
    const enabled = typeof forceEnabled === 'boolean'
      ? forceEnabled
      : ($('[data-act="toggle-notify"]') ? $('[data-act="toggle-notify"]').checked : true);
    const payload = { notify_enabled: enabled, updated_at: new Date().toISOString() };
    if (el) payload.pushplus_token = el.value.trim() || null;
    const { data, error } = await db.from('settings').update(payload).eq('id', 1).select();
    if (error) { toast('保存失败：' + (error.message || '')); return; }
    if (!data || !data.length) { toast('没有权限，只有统筹管理员能改全局通知'); return; }
    state.settings = data[0];
    toast('通知设置已保存');
  }

  async function saveMyPush() {
    const el = $('[data-field="my_push_token"]');
    const em = $('[data-field="my_email"]');
    if (!el && !em) return;
    const token = el ? (el.value.trim() || null) : (state.profile.push_token || null);
    const email = em ? (em.value.trim() || null) : (state.profile.email || null);
    if (email && !isEmail(email)) { toast('邮箱格式不对：' + email); return; }
    const patch = { push_token: token, email: email };
    const { data, error } = await db.from('profiles').update(patch).eq('id', state.profile.id).select();
    if (error) { toast('保存失败：' + (error.message || '')); return; }
    if (!data || !data.length) { toast('保存失败'); return; }
    state.profile = data[0];
    await loadAll(); render();
    const has = [];
    if (email) has.push('邮箱');
    if (token) has.push('微信');
    toast(has.length ? '已保存，之后会发到你的' + has.join('和') : '已清空，不会再主动通知你');
  }

  async function saveEmail(forceEnabled) {
    const has = f => !!$('[data-field="' + f + '"]');
    const get = f => { const el = $('[data-field="' + f + '"]'); return el ? el.value.trim() : ''; };
    const enabled = typeof forceEnabled === 'boolean'
      ? forceEnabled
      : !!($('[data-act="toggle-email"]') && $('[data-act="toggle-email"]').checked);
    const payload = { email_enabled: enabled, updated_at: new Date().toISOString() };
    ['emailjs_service_id', 'emailjs_template_id', 'emailjs_public_key', 'digest_email'].forEach(k => {
      if (has(k)) payload[k] = get(k) || null;
    });
    if (payload.digest_email && !isEmail(payload.digest_email)) { toast('汇总邮箱格式不对'); return; }
    const { data, error } = await db.from('settings').update(payload).eq('id', 1).select();
    if (error) { toast('保存失败：' + (error.message || '')); return; }
    if (!data || !data.length) { toast('没有权限，只有统筹管理员能改邮件设置'); return; }
    state.settings = data[0];
    render();
    toast(enabled ? '邮件已保存并启用' : '邮件设置已保存（当前未启用）');
  }

  async function testMail() {
    if (!mailReady()) { toast('请先填写并保存 Service ID / Template ID / Public Key'); return; }
    const c = mailCfg();
    const to = isEmail(state.profile.email) ? state.profile.email.trim()
      : (isEmail(c.digestTo) ? c.digestTo : '');
    if (!to) { toast('先给自己填个邮箱：设置 → 通知 → 我的推送设置，或填汇总邮箱'); return; }
    toast('正在发送…');
    const r = await sendMail({
      to: to,
      toName: state.profile.name,
      subject: '【测试】速派邮件通道正常',
      kind: 'test',
      html: mailHtml({
        title: '邮件通道已通',
        badge: '测试',
        intro: state.profile.name + '，你好：收到这封说明配置正确。之后的派单、出发提醒、每日汇总都会按这个模板发出。',
        rows: [
          { k: '发送时间', v: new Date().toLocaleString('zh-CN') },
          { k: '收件人', v: to },
          { k: '发送方式', v: 'EmailJS（浏览器直连）' }
        ],
        tip: '如果没在收件箱看到，翻一下垃圾邮件，并把发件地址加入白名单。'
      })
    });
    toast(r.ok ? '已发出，去收件箱看看（可能进垃圾箱）' : '发送失败：' + r.error, 4600);
  }

  async function sendDigestNow(btn) {
    if (btn) { btn.disabled = true; btn.textContent = '发送中…'; }
    const r = await mailDigest(todayStr(), true).catch(e => ({ ok: false, error: String((e && e.message) || e) }));
    if (btn) { btn.disabled = false; btn.textContent = '发今日汇总'; }
    if (r.ok) toast('今日汇总已发送');
    else if (r.error === 'empty') toast('今天没有未取消的预约，不用发');
    else toast('没发出去：' + (r.error || '未知原因'), 4600);
  }

  async function openMailLogs() {
    const { data } = await db.from('email_logs').select('*').order('created_at', { ascending: false }).limit(30);
    const rows = (data || []).map(l =>
      '<div class="list-row">' +
        '<div class="grow"><div class="nm">' + esc(l.subject || '(无主题)') +
          ' <span class="tag tag-' + (l.status === 'sent' ? '已完成' : '已取消') + '">' + (l.status === 'sent' ? '成功' : '失败') + '</span></div>' +
          '<div class="sub">' + esc(l.to_email || '') + ' · ' + esc(String(l.created_at || '').slice(0, 16).replace('T', ' ')) +
            (l.detail ? ' · ' + esc(String(l.detail).slice(0, 120)) : '') + '</div></div>' +
      '</div>').join('');
    openModal(modalShell('邮件发送记录',
      (data && data.length) ? rows : '<div class="empty"><p>还没有记录</p><span>发出第一封后这里会显示结果</span></div>',
      '<button class="btn" data-act="close-modal">关闭</button>'));
  }

  function testPush() {
    const token = (state.profile.push_token || '').trim();
    if (!token) { toast('请先填写并保存你的 Token'); return; }
    const ok = pushWeChat(token, '速派 · 测试消息', '这条是测试，能收到说明配置成功。\n时间：' + new Date().toLocaleString('zh-CN'), appLink());

    toast(ok ? '已发送，稍等几秒看微信' : '发送失败，请检查 Token');
  }

  async function manualReminders(btn) {
    if (btn) { btn.disabled = true; btn.textContent = '检查中…'; }
    let n = 0;
    try { n = await runReminders(); } catch (e) { /* ignore */ }
    if (btn) { btn.disabled = false; btn.textContent = '立即检查'; }
    if (n > 0) toast('已推送 ' + n + ' 条出发提醒', 3200);
    else toast('没有需要提醒的单（已提醒过，或相关人还没填 token）', 3200);
  }

  async function changeMyPin() {
    const oldEl = $('[data-field="pin_old"]');
    const newEl = $('[data-field="pin_new"]');
    if (!oldEl || !newEl) return;
    const oldPin = oldEl.value.trim();
    const newPin = newEl.value.trim();
    if (!oldPin) { toast('请填写原 PIN'); return; }
    if (newPin.length < 4) { toast('新 PIN 至少 4 位'); return; }
    const { error } = await cloud.auth.changePin(oldPin, newPin);
    if (error) { toast('修改失败：' + error.message, 3600); return; }
    oldEl.value = ''; newEl.value = '';
    toast('PIN 已修改，下次用新 PIN 登录');
  }

  async function enableDesktop() {
    if (!('Notification' in window)) { toast('当前浏览器不支持桌面通知'); return; }
    const perm = await Notification.requestPermission();
    if (perm === 'granted') { toast('已开启，新派单会弹窗提醒'); desktopNotify('通知已开启', '有新预约时会在这里提醒你'); }
    else toast('未授权，浏览器地址栏左侧可以重新允许');
  }

  async function saveMe(f) {
    const email = (f.elements.email ? String(f.elements.email.value || '') : '').trim();
    if (email && !isEmail(email)) { toast('邮箱格式不对：' + email); return; }
    const payload = {
      name: (f.elements.name.value || '').trim(),
      phone: (f.elements.phone.value || '').trim() || null,
      email: email || null,
      color: f.elements.color.value
    };
    if (!payload.name) { toast('请填写姓名'); return; }
    const { data, error } = await db.from('profiles').update(payload).eq('id', state.profile.id).select();
    if (error) { toast('保存失败：' + (error.message || '')); return; }
    if (!data || !data.length) { toast('保存失败'); return; }
    state.profile = data[0];
    renderUserChip(); await loadAll(); render();
    toast('已保存');
  }

  /* ---------- 通知 ---------- */
  function openNotifPanel() {
    const list = state.notifications;
    const body = list.length
      ? list.map(n =>
        '<div class="notif-item' + (n.read_at ? '' : ' unread') + '" data-act="notif-open" data-id="' + n.id + '">' +
          '<h5>' + (n.read_at ? '' : '<i></i>') + esc(n.title) + '</h5>' +
          '<p>' + esc(String(n.body || '').slice(0, 160)) + '</p>' +
          '<p style="margin-top:4px;opacity:.7">' + String(n.created_at || '').slice(5, 16).replace('T', ' ') + '</p>' +
        '</div>').join('')
      : '<div class="empty" style="padding:36px"><p>没有新通知</p><span>有人给你派单时会出现在这里</span></div>';

    openModal(modalShell('通知',
      body,
      '<button class="btn" data-act="mark-all-read">全部标记已读</button>'
    ));
  }

  async function markAllRead() {
    const unread = state.notifications.filter(n => !n.read_at);
    if (!unread.length) { toast('没有未读通知'); return; }
    const now = new Date().toISOString();
    for (const n of unread) {
      await db.from('notifications').update({ read_at: now }).eq('id', n.id);
    }
    await loadNotifications();
    openNotifPanel();
    toast('已全部标记为已读');
  }

  async function openNotifById(id) {
    const n = state.notifications.filter(x => String(x.id) === String(id))[0];
    if (!n) return;
    if (!n.read_at) {
      await db.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', n.id);
      await loadNotifications();
    }
    if (n.appointment_id) {
      const a = state.appointments.filter(x => String(x.id) === String(n.appointment_id))[0];
      if (a) { openApptModal(a); return; }
    }
    openNotifPanel();
  }

  function openUserMenu() {
    const p = state.profile;
    openModal(modalShell('账号',
      '<div style="display:flex;gap:12px;align-items:center;margin-bottom:16px">' +
        '<span class="avatar" style="width:44px;height:44px;font-size:16px;background:' + esc(p.color || '#2b6ef6') + '">' + esc(p.name.slice(0, 1)) + '</span>' +
        '<div><div style="font-weight:650;font-size:15px">' + esc(p.name) + '</div>' +
        '<div class="hint">' + esc(ROLE_LABEL[p.role] || '') + (p.phone ? ' · ' + esc(p.phone) : '') + '</div></div>' +
      '</div>' +
      '<div class="kv"><span>我的预约</span><b>' + state.appointments.filter(a => String(a.tech_id) === String(p.id)).length + ' 条</b></div>' +
      '<div class="kv"><span>未读通知</span><b>' + state.notifications.filter(n => !n.read_at).length + ' 条</b></div>',
      '<button class="btn" data-act="close-modal">关闭</button>' +
      '<button class="btn btn-danger" data-act="logout">退出登录</button>'
    ));
  }

  function confirmDialog(title, message) {
    return new Promise(resolve => {
      openModal(modalShell(title, '<p style="margin:0;font-size:13.5px;line-height:1.7">' + esc(message) + '</p>',
        '<button class="btn" data-act="close-modal">取消</button>' +
        '<button class="btn btn-danger" data-act="confirm-yes">确认</button>'
      ));
      const btn = $('[data-act="confirm-yes"]');
      if (btn) btn.onclick = () => { closeModal(); resolve(true); };
      const mask = $('.modal-mask');
      if (mask) mask.addEventListener('click', ev => { if (ev.target === mask) resolve(false); });
      const closeBtn = $('[data-act="close-modal"]');
      if (closeBtn) closeBtn.addEventListener('click', () => resolve(false));
    });
  }

  /* ============================================================
     启动
     ============================================================ */
  async function init() {
    bindGlobal();
    $('#notif-btn').addEventListener('click', () => openNotifPanel());
    $('#user-btn').addEventListener('click', () => openUserMenu());
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

    if (!cloud || !db) { showLogin('组件加载失败，请检查网络后刷新页面'); return; }

    try {
      await handleCallback();
      await boot();
    } catch (e) {
      console.error('[速派] 启动失败', e && e.message);
      showLogin('加载失败：' + ((e && e.message) || '请刷新页面重试'));
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
