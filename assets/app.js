/* ============================================================
   速派 · crewgo（维修人员预约管理系统）
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
  // 「取消」不走快捷标记：只有预约人自己和管理员能取消，见 openApptModal
  const STATUS_NEXT = { '待确认': ['已确认'], '已确认': ['进行中', '已完成'], '进行中': ['已完成'] };
  const ROLE_LABEL = { admin: '管理员', tech: '维修人员', requester: '预约人' };
  const teamRoleLabel = r => ({ owner: '统筹管理员', admin: '管理员', member: '成员' }[r] || '成员');
  const PALETTE = ['#2b6ef6', '#e5484d', '#0f9d76', '#f59e0b', '#6d4aff', '#0891b2', '#d94690', '#65a30d'];
  const DOW = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  /* PIN 规则：字母、数字、符号都允许，只限长度；后端同规则校验 */
  const PIN_MIN = 4;
  const PIN_MAX = 32;
  const PIN_TIP = '至少 ' + PIN_MIN + ' 位，字母、数字、符号都行，区分大小写';

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

  /* 手机号：大陆 11 位，允许用户带 +86 / 空格 / 横线 */
  const normPhone = v => String(v === null || v === undefined ? '' : v).trim()
    .replace(/[\s\-()]/g, '').replace(/^\+?86(?=1\d{10}$)/, '');
  function phoneError(v) {
    const p = normPhone(v);
    if (!p) return '请填写手机号';
    if (!/^1[3-9]\d{9}$/.test(p)) return '手机号要 11 位、以 1 开头（现在 ' + p.length + ' 位）';
    return '';
  }
  /** 时段重叠：全天和任何时段都算撞，其余只有相同才撞 */
  const slotOverlap = (a, b) => {
    const x = a || '上午', y = b || '上午';
    if (x === y) return true;
    return x === '全天' || y === '全天';
  };

  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  /** 登录凭证统一处理：去掉首尾空格（中间的空格保留），避免手机键盘尾随空格导致登录失败 */
  const normPin = v => String(v === null || v === undefined ? '' : v).trim();
  /** 返回错误文案，空串表示通过；规则与服务端一致 */
  function pinError(pin) {
    const p = normPin(pin);
    if (p.length < PIN_MIN) return 'PIN 至少 ' + PIN_MIN + ' 位';
    if (p.length > PIN_MAX) return 'PIN 最多 ' + PIN_MAX + ' 位';
    return '';
  }
  /** PIN 输入框公共属性：不用数字键盘，关掉首字母大写与自动纠错（否则字母 PIN 会被改掉） */
  const PIN_ATTRS = ' inputmode="text" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="' + PIN_MAX + '"';
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
    profiles: [], projects: [], appointments: [], notifications: [], timeOff: [], attachments: [],
    settings: null,
    team: null, pending: null, wechat: { mp: false, qr: false },
    teamRequests: [], wxSettings: null, teamMode: 'join',
    mailAccounts: [], mail: { ready: false },
    emailEdit: false,   // 已验证的邮箱是锁住的，点了「更改邮箱」才进入编辑态
    view: 'board',
    board: { year: new Date().getFullYear(), month: new Date().getMonth(), day: todayStr() },
    filters: { tech: '', project: '', status: '', q: '' },
    settingsTab: 'projects',
    loginMode: 'login',
    authView: 'login',
    wxBannerHidden: false,
    lastNotifId: 0,
    pollTimer: null,
    sel: {} // 预约单列表里勾选的 id（批量删除/改状态用）
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
  /* ============================================================
     登录 / 注册 / 完善资料 / 团队门
     ============================================================ */
  const msgHtml = (msg, ok) => msg ? '<div class="msg ' + (ok ? 'msg-ok' : '') + '">' + esc(msg) + '</div>' : '';

  function authCard(title, desc, body, foot) {
    return '<div class="auth-card">' +
      '<div class="auth-brand"><span class="brand-mark">速</span><h1>速派<span class="brand-en"> · crewgo</span></h1></div>' +
      '<p class="auth-sub">维修人员预约管理系统</p>' +
      '<h2 class="auth-title">' + esc(title) + '</h2>' +
      (desc ? '<p class="auth-desc">' + desc + '</p>' : '') +
      body +
      (foot ? '<p class="auth-foot">' + foot + '</p>' : '') +
    '</div>';
  }

  function showAuth(view, msg, ok) {
    state.authView = view || 'login';
    const gate = ['profile', 'team', 'pending'].indexOf(state.authView) >= 0;
    $('#boot').classList.add('hidden');
    $('#app-view').classList.add('hidden');
    const host = gate ? $('#onboard-view') : $('#login-view');
    (gate ? $('#login-view') : $('#onboard-view')).classList.add('hidden');
    host.classList.remove('hidden');
    if (state.authView === 'login') host.innerHTML = loginHtml(msg, ok);
    else if (state.authView === 'setup') host.innerHTML = setupHtml(msg, ok);
    else if (state.authView === 'register') host.innerHTML = registerHtml(msg, ok);
    else if (state.authView === 'profile') host.innerHTML = profileGateHtml(msg, ok);
    else if (state.authView === 'team') host.innerHTML = teamGateHtml(msg, ok);
    else host.innerHTML = pendingGateHtml();
  }
  function showLogin(msg, ok) { showAuth(state.loginMode === 'setup' ? 'setup' : 'login', msg, ok); }

  /** 微信按钮：微信里直接用公众号授权，电脑上用开放平台扫码 */
  function wechatButtons() {
    const wx = state.wechat || {};
    const mp = !!wx.mp;
    const qr = !!wx.qr;
    if (!mp && !qr) return '';
    const inApp = inWeChat();
    let btn = '';
    if (inApp && mp) btn = '<button type="button" class="btn oauth-wechat" data-act="wx-login" data-mode="mp">微信一键登录</button>';
    else if (qr) btn = '<button type="button" class="btn oauth-wechat" data-act="wx-login" data-mode="qr">微信扫码登录</button>';
    else if (mp) btn = '<button type="button" class="btn oauth-wechat" data-act="wx-login" data-mode="mp">微信登录</button>';
    if (!btn) return '';
    const tip = (!qr && !inApp)
      ? '<p class="hint" style="text-align:center;margin:8px 0 0">在电脑上想扫码登录，需要先在「设置 → 登录方式」里配置微信开放平台网站应用</p>'
      : '';
    return '<div class="divider">或</div><div class="oauth-row">' + btn + '</div>' + tip;
  }

  function loginHtml(msg, ok) {
    return authCard('登录', '输入姓名和 PIN 即可登录，不用收验证码。',
      msgHtml(msg, ok) +
      '<form data-form="login" novalidate>' +
        '<div class="field"><label for="lg-name">姓名</label>' +
          '<input class="input" id="lg-name" name="name" placeholder="你的姓名" required maxlength="20" autocomplete="username"></div>' +
        '<div class="field"><label for="lg-pin">PIN</label>' +
          '<div class="pin-wrap"><input class="input" id="lg-pin" name="pin" type="password"' + PIN_ATTRS + ' placeholder="你的 PIN" autocomplete="current-password">' +
          '<button type="button" class="pin-eye" data-act="peek" aria-label="显示或隐藏 PIN">显示</button></div></div>' +
        '<button class="btn btn-primary btn-block" type="submit">登录</button>' +
      '</form>' +
      wechatButtons(),
      '还没有账号？<a href="#" data-act="auth-view" data-view="register" style="color:var(--primary)">注册一个</a><br>' +
      '忘记 PIN 找团队管理员在「设置 → 人员」里重设<br>' +
      '<a href="#" data-act="auth-view" data-view="setup" style="color:var(--text-3)">第一次部署？初始化管理员</a>');
  }

  function setupHtml(msg, ok) {
    return authCard('初始化', '第一次使用，先建一个统筹账号；系统会同时给你建一个团队，之后别人凭团队码申请加入。',
      msgHtml(msg, ok) +
      '<form data-form="setup" novalidate>' +
        '<div class="field"><label for="st-name">你的姓名</label>' +
          '<input class="input" id="st-name" name="name" placeholder="如：王建国" required maxlength="20"></div>' +
        '<div class="field"><label for="st-phone">手机号</label>' +
          '<input class="input" id="st-phone" name="phone" type="tel" inputmode="numeric" maxlength="20" placeholder="11 位手机号"></div>' +
        '<div class="field"><label for="st-team">团队名称</label>' +
          '<input class="input" id="st-team" name="teamName" maxlength="30" placeholder="如：某某物业维修组（可留空）"></div>' +
        '<div class="field"><label for="st-pin">设置 PIN</label>' +
          '<div class="pin-wrap"><input class="input" id="st-pin" name="pin" type="password"' + PIN_ATTRS + ' placeholder="至少 4 位" autocomplete="new-password">' +
          '<button type="button" class="pin-eye" data-act="peek" aria-label="显示或隐藏 PIN">显示</button></div>' +
          '<div class="hint">' + PIN_TIP + '</div></div>' +
        '<div class="field"><label for="st-pin2">再输一次</label>' +
          '<input class="input" id="st-pin2" name="pin2" type="password"' + PIN_ATTRS + ' placeholder="确认 PIN" autocomplete="new-password"></div>' +
        '<button class="btn btn-primary btn-block" type="submit">创建团队并进入</button>' +
      '</form>',
      '<a href="#" data-act="auth-view" data-view="login" style="color:var(--text-3)">已有账号，去登录</a>');
  }

  function registerHtml(msg, ok) {
    return authCard('注册', '注册后还需要用团队码申请加入，管理员同意了才能看到团队数据。',
      msgHtml(msg, ok) +
      '<form data-form="register" novalidate>' +
        '<div class="field"><label for="rg-name">姓名</label>' +
          '<input class="input" id="rg-name" name="name" placeholder="真实姓名，同事一眼能认出" required maxlength="20"></div>' +
        '<div class="field"><label for="rg-phone">手机号（选填）</label>' +
          '<input class="input" id="rg-phone" name="phone" type="tel" inputmode="numeric" maxlength="20" placeholder="11 位手机号"></div>' +
        '<div class="field"><label for="rg-pin">设置 PIN</label>' +
          '<div class="pin-wrap"><input class="input" id="rg-pin" name="pin" type="password"' + PIN_ATTRS + ' placeholder="至少 4 位" autocomplete="new-password">' +
          '<button type="button" class="pin-eye" data-act="peek" aria-label="显示或隐藏 PIN">显示</button></div>' +
          '<div class="hint">' + PIN_TIP + '</div></div>' +
        '<div class="field"><label for="rg-pin2">再输一次</label>' +
          '<input class="input" id="rg-pin2" name="pin2" type="password"' + PIN_ATTRS + ' placeholder="确认 PIN" autocomplete="new-password"></div>' +
        '<button class="btn btn-primary btn-block" type="submit">注册</button>' +
      '</form>' +
      wechatButtons(),
      '已经有账号？<a href="#" data-act="auth-view" data-view="login" style="color:var(--primary)">去登录</a>');
  }

  /** 微信注册的账号：登录后必须补齐姓名和手机号才放行 */
  function profileGateHtml(msg, ok) {
    const u = state.user || {};
    return authCard('完善资料', '用微信登录的账号还缺姓名和手机号，填完才能进入团队。',
      msgHtml(msg, ok) +
      '<form data-form="profile-setup" novalidate>' +
        '<div class="field"><label for="pf-name">姓名</label>' +
          '<input class="input" id="pf-name" name="name" value="' + esc(u.name || '') + '" placeholder="真实姓名" required maxlength="20"></div>' +
        '<div class="field"><label for="pf-phone">手机号</label>' +
          '<input class="input" id="pf-phone" name="phone" type="tel" inputmode="numeric" maxlength="20" value="' + esc(u.phone || '') + '" placeholder="11 位手机号"></div>' +
          '<div class="hint">手机号要 11 位。同事要靠它联系你，团队管理员也用它核对身份。</div>' +
        '<button class="btn btn-primary btn-block" type="submit">保存并继续</button>' +
      '</form>',
      '<a href="#" data-act="logout" style="color:var(--text-3)">换个账号</a>');
  }

  function teamGateHtml(msg, ok) {
    const mode = state.teamMode || 'join';
    const tab = (k, label) => '<button class="' + (mode === k ? 'active' : '') + '" data-act="team-mode" data-mode="' + k + '">' + label + '</button>';
    const joinForm =
      '<form data-form="team-join" novalidate>' +
        '<div class="field"><label for="tj-code">团队码</label>' +
          '<input class="input code-input" id="tj-code" name="code" placeholder="ABC123456" maxlength="12" autocapitalize="characters" autocomplete="off" spellcheck="false">' +
          '<div class="hint">3 位大写字母 + 6 位数字，找统筹管理员或管理员要。</div></div>' +
        '<div class="field"><label for="tj-msg">说明（选填）</label>' +
          '<input class="input" id="tj-msg" name="message" maxlength="60" placeholder="如：水电组 张工"></div>' +
        '<button class="btn btn-primary btn-block" type="submit">提交申请</button>' +
      '</form>';
    const createForm =
      '<form data-form="team-create" novalidate>' +
        '<div class="field"><label for="tc-name">团队名称</label>' +
          '<input class="input" id="tc-name" name="name" maxlength="30" placeholder="如：某某物业维修组"></div>' +
        '<p class="hint" style="margin:-6px 0 12px">创建后你就是<b>统筹管理员</b>（最高权限），系统会随机生成团队码，别人凭码申请加入。</p>' +
        '<button class="btn btn-primary btn-block" type="submit">创建团队</button>' +
      '</form>';
    return authCard('加入团队', '数据按团队隔离：没有加入团队前，看不到任何预约和人员资料。',
      msgHtml(msg, ok) +
      '<div class="seg seg-block" style="margin-bottom:18px">' + tab('join', '我有团队码') + tab('create', '创建新团队') + '</div>' +
      (mode === 'join' ? joinForm : createForm) +
      '<div class="notice" style="margin-top:16px">团队管理员收到申请后会审批，通过后你才能看到团队内部的排期和预约单。</div>',
      '<a href="#" data-act="logout" style="color:var(--text-3)">换个账号登录</a>');
  }

  function pendingGateHtml() {
    const p = state.pending || {};
    return authCard('等待审批', '',
      '<div class="notice" style="margin-bottom:16px">' +
        '你申请加入 <b>' + esc(p.team_name || p.team_code || '团队') + '</b>，正在等管理员审批。<br>' +
        '通过后刷新本页就能进入；如果迟迟没人处理，直接催一下统筹管理员。' +
      '</div>' +
      '<div style="display:flex;gap:8px">' +
        '<button class="btn btn-primary" style="flex:1" data-act="team-refresh">刷新看看</button>' +
        '<button class="btn" data-act="team-cancel">撤回申请</button>' +
      '</div>',
      '<a href="#" data-act="logout" style="color:var(--text-3)">换个账号登录</a>');
  }

  /* ---------- 认证流程 ---------- */
  /** 微信授权回来：用一次性票据换 token，票据不会留在地址栏 */
  async function handleWechatReturn() {
    const url = new URL(location.href);
    const ticket = url.searchParams.get('wx_ticket');
    const bind = url.searchParams.get('wx_bind');
    const err = url.searchParams.get('wx_error');
    if (!ticket && !bind && !err) return false;
    const clean = () => {
      ['wx_ticket', 'wx_bind', 'wx_error'].forEach(k => url.searchParams.delete(k));
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    };
    if (ticket) {
      clean();
      const r = await cloud.auth.wechatTicket(ticket);
      if (r.error) { showLogin('微信登录失败：' + r.error.message); return true; }
      toast('微信登录成功');
      return true;
    }
    if (bind) {
      clean();
      const r = await cloud.auth.wechatTicket(bind);
      if (r.error) toast('绑定失败：' + r.error.message, 4200);
      else { toast('微信已绑定，下次点一下就能进'); state.wxBannerHidden = true; }
      return true;
    }
    clean();
    showLogin('微信登录失败：' + err);
    return true;
  }

  function startWechat(mode, bind) {
    cloud.auth.wechatUrl(mode || 'qr', !!bind).then(r => {
      if (r.error) { toast(r.error.message, 4600); return; }
      if (r.data && r.data.url) location.assign(r.data.url);
    });
  }

  /** 微信里打开时直接拉起授权（一次会话只自动跳一次，避免死循环） */
  function maybeAutoWechat() {
    if (!inWeChat()) return;
    if (!(state.wechat && state.wechat.mp)) return;
    if (location.search.indexOf('wx_error') >= 0) return;
    try {
      if (sessionStorage.getItem('wx_auto') === '1') return;
      sessionStorage.setItem('wx_auto', '1');
    } catch (e) { /* 隐私模式下忽略 */ }
    setTimeout(() => startWechat('mp', false), 700);
  }

  async function boot() {
    await handleWechatReturn();
    let session = null;
    try {
      const res = await cloud.auth.getSession();
      session = res.data;
    } catch (e) { /* ignore */ }
    if (!session) {
      // 全新部署（一个人都还没建）时直接进「初始化」
      try {
        const st = await cloud.auth.status();
        if (st) {
          state.wechat = st.wechat || state.wechat;
          if (st.initialized === false) state.loginMode = 'setup';
        }
      } catch (e) { /* 忽略 */ }
      showLogin();
      maybeAutoWechat();
      return;
    }

    state.session = session;
    state.user = session.user || {};
    state.uid = state.user.id || await resolveUid(state.user);
    state.team = session.team || null;
    state.pending = session.pending || null;
    state.wechat = session.wechat || state.wechat;
    state.mail = session.mail || { ready: false };
    if (!state.uid) { showLogin('无法获取账号信息，请重新登录。'); return; }

    if (state.user.need_profile) { showAuth('profile'); return; }
    if (!state.team) { showAuth(state.pending ? 'pending' : 'team'); return; }

    let prof = null;
    try { prof = await fetchMyProfile(); } catch (e) { /* ignore */ }
    if (!prof) { showAuth('team', '这个账号还没有团队内的资料，请重新加入团队'); return; }
    state.profile = prof;
    await enterApp();
  }

  async function fetchMyProfile() {
    const { data, error } = await db.from('profiles').select('*').eq('user_id', state.uid).maybeSingle();
    if (error) throw error;
    return data || null;
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
    const [pr, pf, ap, st, nf, to, at] = await Promise.all([
      db.from('projects').select('*').order('sort_order', { ascending: true }).order('name', { ascending: true }),
      db.from('profiles').select('*').order('created_at', { ascending: true }),
      db.from('appointments').select('*').order('visit_date', { ascending: false }).limit(1000),
      // 服务端按团队过滤，一个团队只有一行 settings
      db.from('settings').select('*').maybeSingle(),
      db.from('notifications').select('*').order('created_at', { ascending: false }).limit(50),
      db.from('time_off').select('*').limit(2000),
      // 附件元数据（文件本体走 /api/files/:id，要点开才下载）
      db.from('attachments').select('*').order('id', { ascending: true }).limit(5000)
    ]);
    state.projects = pr.data || [];
    state.profiles = pf.data || [];
    state.appointments = ap.data || [];
    // 列表变了（删了/导入了）就把已不存在的勾选清掉
    const alive = {};
    state.appointments.forEach(a => { alive[String(a.id)] = 1; });
    Object.keys(state.sel || {}).forEach(k => { if (!alive[k]) delete state.sel[k]; });
    state.settings = st.data || null;
    state.notifications = nf.data || [];
    state.timeOff = to.data || [];
    state.attachments = at.data || [];

    const me = state.profiles.filter(p => p.user_id === state.uid)[0];
    if (me) {
      // profiles 表里没有微信绑定状态，用 /api/auth/me 的结果补上
      me.wx_bound = !!(state.user && state.user.wx_bound);
      state.profile = me;
    }

    // 管理员顺带拉一下待审申请和微信配置（页面要显示条数/状态）
    if (state.profile && (state.profile.team_role === 'owner' || state.profile.team_role === 'admin')) {
      try {
        const r = await window.__api('/api/team/requests');
        state.teamRequests = (r && r.data) || [];
      } catch (e) { state.teamRequests = []; }
      try {
        state.wxSettings = await window.__api('/api/settings/wechat');
      } catch (e) { state.wxSettings = null; }
      try {
        const ma = await db.from('mail_accounts').select('*').order('priority', { ascending: true }).order('id', { ascending: true });
        state.mailAccounts = ma.data || [];
      } catch (e) { state.mailAccounts = []; }
    }

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
  const isAdmin = () => !!state.profile && (state.profile.team_role === 'owner' || state.profile.team_role === 'admin');
  // 统筹管理员全团队只有一个：任命管理员、发信邮箱、数据导入导出、微信登录这些
  // 涉及「系统稳定 / 数据安全」的事只有他能做
  const isOwnerTeam = () => !!state.profile && state.profile.team_role === 'owner';

  /* 纯维修人员：只做单，不建单。页面上把「新建预约」换成「设置休息」 */
  const isTechOnly = () => !!state.profile && state.profile.role === 'tech' && !isAdmin();
  const newOrOffBtn = () => isTechOnly()
    ? '<button class="btn btn-primary" data-act="my-time-off">设置休息</button>'
    : '<button class="btn btn-primary" data-act="new-appt">＋ 新建预约</button>';

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
    let html = '';
    if (state.view === 'board') html = boardHtml();
    else if (state.view === 'list') html = listHtml();
    else if (state.view === 'mine') html = mineHtml();
    else html = settingsHtml();
    page.innerHTML = wxBannerHtml() + html;
    page.scrollTop = 0;
  }

  /** 没绑微信的提示条（登录后提示一次，可关掉） */
  function wxBannerHtml() {
    if (state.wxBannerHidden) return '';
    if (!state.profile || state.profile.wx_bound) return '';
    const wx = state.wechat || {};
    if (!wx.mp && !wx.qr) return '';
    return '<div class="wx-banner">' +
      '<span class="grow">还没绑定微信。绑定之后，下次在微信里打开可以一键登录，不用再输 PIN。</span>' +
      '<button class="btn btn-sm btn-primary" data-act="wx-bind">去绑定</button>' +
      '<button class="btn btn-sm btn-ghost" data-act="wx-banner-hide">以后再说</button>' +
    '</div>';
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

    // 休息日按天索引，日历格子和小字提示都用它
    const offByDate = {};
    state.timeOff.forEach(o => {
      // 按人员筛选时只标这个人的休息日，否则「休 2」会让人以为别人也在休
      if (state.filters.tech && String(o.profile_id) !== String(state.filters.tech)) return;
      (offByDate[o.off_date] = offByDate[o.off_date] || []).push(o);
    });
    const nameOf = o => (profileById(o.profile_id) || {}).name || '已离开的成员';
    // 半天休（上午 / 下午）名字后面缀一下，日历格子里能看出是哪半天
    const nameOfDay = o => nameOf(o) + (o.part && o.part !== '全天' ? '·' + o.part : '');
    const offNames = ds => (offByDate[ds] || []).map(nameOfDay);

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
        const offList = offNames(ds);
        if (offList.length) {
          inner += '<div class="cal-off" title="' + esc(offList.join('、')) + ' 休息，这段时间不排单">休 ' + esc(offList.join('、')) + '</div>';
        }
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
          newOrOffBtn() +
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
          '<span class="legend"><i style="background:#fdf6e3;border:1px solid #e7d7a8"></i>休息（不排单）</span>' +
        '</div>' +
      '</div>' +

      '<div class="card" style="margin-top:16px">' +
        '<div class="day-head">' +
          '<div class="day-title">' + dayLabel(b.day) + '<span>' + (relDay(b.day) ? relDay(b.day) + ' · ' : '') + dayList.length + ' 项</span></div>' +
          (isTechOnly()
            ? '<button class="btn btn-sm" data-act="off-day" data-date="' + b.day + '">设置休息</button>'
            : '<button class="btn btn-sm" data-act="new-appt-day" data-date="' + b.day + '">在这天新建</button>') +
        '</div>' +
        (dayList.length ? dayList.map(apptRowHtml).join('') : emptyHtml('这天没有安排', isTechOnly() ? '这天还没有派给你的活' : '点右上角可以给这天加一条预约')) +
        (offNames(b.day).length
          ? '<div class="off-note">这天休息：' + esc(offNames(b.day).join('、')) + '（休息的时段不排单）</div>' : '') +
      '</div>' +
      soonOffHtml();
  }

  /** 未来两周的休息日：不用翻月历也能看到谁哪天休，全员可见 */
  function soonOffHtml() {
    const from = todayStr(), to = addDays(14);
    const map = {};
    state.timeOff.forEach(o => {
      if (o.off_date < from || o.off_date > to) return;
      if (state.filters.tech && String(o.profile_id) !== String(state.filters.tech)) return;
      const nm = (profileById(o.profile_id) || {}).name || '已离开的成员';
      (map[o.off_date] = map[o.off_date] || []).push(nm + (o.part && o.part !== '全天' ? '·' + o.part : ''));
    });
    const days = Object.keys(map).sort();
    if (!days.length) return '';
    return '<div class="card" style="margin-top:16px">' +
        '<div class="card-head"><h3 class="card-title">近期休息</h3><span class="hint">未来两周，这几天不会给人排单</span></div>' +
        days.map(d => '<div class="list-row">' +
          '<div class="grow"><div class="nm">' + esc(dayLabel(d)) +
            (relDay(d) ? ' <span class="tag tag-待确认">' + esc(relDay(d)) + '</span>' : '') + '</div>' +
            '<div class="sub">' + esc(map[d].join('、')) + '</div></div>' +
        '</div>').join('') +
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

  /* 预约单列表的批量选择：勾选后可以一次删掉 / 一次改状态，也能按时间范围整段选 */
  const selectedApptIds = () => Object.keys(state.sel || {}).filter(k => state.sel[k]).map(Number);
  // 只对「当前列表里看得见」的单子动手，避免筛选后误删被藏起来的
  const selectedVisibleIds = () => {
    const vis = new Set(sortAppts(state.appointments.filter(apptMatchesFilter)).map(a => String(a.id)));
    return selectedApptIds().filter(id => vis.has(String(id)));
  };

  function listHtml() {
    const list = sortAppts(state.appointments.filter(apptMatchesFilter)).reverse();
    const sel = state.sel || {};
    const ids = list.map(a => String(a.id));
    const selCount = ids.filter(id => sel[id]).length;
    const allSel = !!ids.length && selCount === ids.length;

    const rows = list.map(a =>
      '<tr data-act="open-appt" data-id="' + a.id + '"' + (sel[a.id] ? ' class="row-sel"' : '') + '>' +
        '<td class="sel-cell"><input type="checkbox" data-act="sel-row" data-id="' + a.id + '"' + (sel[a.id] ? ' checked' : '') + ' aria-label="选择这条"></td>' +
        '<td class="nowrap"><b>' + esc(a.visit_date.slice(5)) + '</b><div class="cell-sub">' + esc(a.time_slot) + '</div></td>' +
        '<td class="nowrap">' + esc(a.project_name || '—') + '</td>' +
        '<td class="nowrap"><span class="person"><span class="dot" style="background:' + esc(techColor(a.tech_id || a.tech_name)) + '"></span>' + esc(a.tech_name || '待分配') + '</span></td>' +
        '<td>' + esc(a.address || '—') + '</td>' +
        '<td style="max-width:260px"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(a.content || '—') + '</div></td>' +
        '<td class="nowrap">' + esc(a.contact_name || '') + (a.contact_phone ? '<div class="cell-sub">' + esc(a.contact_phone) + '</div>' : '') + '</td>' +
        '<td class="nowrap"><span class="tag tag-' + esc(a.status) + '">' + esc(a.status) + '</span></td>' +
      '</tr>').join('');

    const selBar = '<div class="selbar">' +
        '<label class="sel-check"><input type="checkbox" data-act="sel-all"' + (allSel ? ' checked' : '') + '>' +
          '<span>全选（当前 ' + ids.length + ' 条）</span></label>' +
        '<span class="sel-count">已选 <b>' + selCount + '</b> 条</span>' +
        '<button class="btn btn-sm" data-act="sel-clear"' + (selCount ? '' : ' disabled') + '>清空</button>' +
        '<button class="btn btn-sm" data-act="sel-invert"' + (ids.length ? '' : ' disabled') + '>反选</button>' +
        '<span class="sel-sep"></span>' +
        '<select class="select" data-field="sel-status">' +
          STATUSES.map(s => '<option value="' + s + '">改为「' + s + '」</option>').join('') +
        '</select>' +
        '<button class="btn btn-sm" data-act="sel-status"' + (selCount ? '' : ' disabled') + '>批量改状态</button>' +
        '<button class="btn btn-sm btn-danger" data-act="sel-delete"' + (selCount ? '' : ' disabled') + '>删除选中</button>' +
        '<span class="sel-sep"></span>' +
        '<span class="hint" style="margin:0">按时间选</span>' +
        '<input class="input input-date" type="date" data-field="sel-from">' +
        '<span class="hint" style="margin:0">至</span>' +
        '<input class="input input-date" type="date" data-field="sel-to">' +
        '<button class="btn btn-sm" data-act="sel-range">选中这段时间</button>' +
      '</div>';

    return '' +
      '<div class="page-head">' +
        '<div><h1 class="page-title">预约单</h1><p class="page-desc">共 ' + list.length + ' 条，按日期倒序' +
          (selCount ? ' · 已选 ' + selCount + ' 条' : '') + '</p></div>' +
        '<div class="page-actions">' +
          '<button class="btn" data-act="copy-today">今日派单</button>' +
          '<button class="btn" data-act="copy-tomorrow">明日派单</button>' +
          '<button class="btn" data-act="export-csv">导出 CSV</button>' +
          newOrOffBtn() +
        '</div>' +
      '</div>' +
      '<div class="filterbar">' +
        '<input class="input" data-filter="q" placeholder="搜索地址 / 事项 / 预约人" value="' + esc(state.filters.q) + '">' +
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
      '<div class="card">' + selBar + '<div class="table-wrap">' +
        (list.length
          ? '<table class="tbl"><thead><tr><th class="sel-cell"></th><th>日期</th><th>项目</th><th>人员</th><th>地址</th><th>事项</th><th>预约人</th><th>状态</th></tr></thead><tbody>' + rows + '</tbody></table>'
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
      '<div class="page-actions">' + newOrOffBtn() + '</div></div>';

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
      { k: 'admins', t: '管理员' },
      { k: 'team', t: '团队' },
      { k: 'notify', t: '通知' },
      { k: 'data', t: '数据备份' },
      { k: 'me', t: '我的资料' }
    ];
    if (isOwnerTeam()) tabs.splice(6, 0, { k: 'login', t: '登录方式' });
    return '<div class="page-head"><div><h1 class="page-title">设置</h1>' +
      '<p class="page-desc">' + esc(teamRoleLabel(state.profile.team_role)) + ' · ' +
        (isOwnerTeam() ? '管理员能做的事你都能做，另外独占发信邮箱、微信登录、导入导出'
          : (isAdmin() ? '可管理项目、人员、排期与通知，也可任免管理员（系统级配置由统筹负责）' : '项目与人员由管理员维护')) +
        (state.team ? ' · 团队「' + esc(state.team.name) + '」' : '') + '</p></div></div>' +
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
    if (state.settingsTab === 'admins') return adminsPane();
    if (state.settingsTab === 'team') return teamPane();
    if (state.settingsTab === 'notify') return notifyPane();
    if (state.settingsTab === 'data') return dataPane();
    if (state.settingsTab === 'login') return loginPane();
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

  /** 某个人接下来的休息日（只列今天及以后，最多 5 条） */
  function upcomingOff(profileId) {
    const t = todayStr();
    return state.timeOff
      .filter(o => o.profile_id === profileId && o.off_date >= t)
      .sort((a, b) => a.off_date < b.off_date ? -1 : 1);
  }

  function peoplePane() {
    const rows = state.profiles.map(p => {
      const offs = upcomingOff(p.id);
      return '<div class="list-row">' +
        '<span class="avatar" style="background:' + esc(p.color || '#2b6ef6') + ';width:30px;height:30px;font-size:12px">' + esc(String(p.name).slice(0, 1)) + '</span>' +
        '<div class="grow"><div class="nm">' + esc(p.name) +
          (p.id === state.profile.id ? ' <span class="tag tag-已确认">我</span>' : '') +
          (p.team_role === 'owner' ? ' <span class="tag tag-加急">统筹管理员</span>'
            : (p.team_role === 'admin' ? ' <span class="tag tag-已确认">管理员</span>' : '')) +
          (p.wx_bound ? ' <span class="tag tag-已确认">微信</span>' : '') +
          (p.active === false ? ' <span class="tag tag-已取消">停用</span>' : '') +
          (offs.length ? ' <span class="tag tag-待确认">休 ' + offs.length + ' 天</span>' : '') + '</div>' +
          '<div class="sub">' + esc(p.phone || '无手机号') + ' · ' + esc(ROLE_LABEL[p.role] || p.role) +
            (offs.length ? ' · 最近休息 ' + esc(offs[0].off_date.slice(5)) + (offs[0].part && offs[0].part !== '全天' ? ' ' + esc(offs[0].part) : '') : '') + '</div></div>' +
        ((isAdmin() || p.id === state.profile.id)
          ? '<button class="btn btn-sm" data-act="time-off" data-id="' + esc(p.id) + '">排休</button>' : '') +
        (isAdmin()
          ? '<button class="btn btn-sm" data-act="edit-person" data-id="' + esc(p.id) + '">编辑</button>' +
            (p.id === state.profile.id ? '' : '<button class="btn btn-sm btn-danger" data-act="del-person" data-id="' + esc(p.id) + '">删除</button>')
          : '') +
      '</div>';
    }).join('');

    const allOff = state.timeOff.slice().filter(o => o.off_date >= addDays(-1)).sort((a, b) => a.off_date < b.off_date ? -1 : 1);
    const offRows = allOff.slice(0, 30).map(o => {
      const p = profileById(o.profile_id);
      return '<div class="list-row">' +
        '<div class="grow"><div class="nm">' + esc(o.off_date) + (o.part && o.part !== '全天' ? ' ' + esc(o.part) : '') + ' · ' + esc(p ? p.name : o.name || '（已移除）') +
          (o.reason ? ' <span class="hint">' + esc(o.reason) + '</span>' : '') + '</div>' +
          '<div class="sub">' + (o.part && o.part !== '全天' ? '只休 ' + esc(o.part) + '，另一半天照常' : '这天不排单') + '</div></div>' +
        ((isAdmin() || o.profile_id === state.profile.id)
          ? '<button class="btn btn-sm btn-danger" data-act="del-time-off" data-id="' + o.id + '">取消</button>' : '') +
      '</div>';
    }).join('');

    return '<div class="card">' +
      '<div class="card-head"><h3 class="card-title">人员（' + state.profiles.length + '）</h3>' +
        (isAdmin() ? '<button class="btn btn-sm btn-primary" data-act="add-person">＋ 添加人员</button>' : '') + '</div>' +
      rows +
      '</div>' +
      '<div class="card" style="margin-top:14px">' +
        '<div class="card-head"><h3 class="card-title">休息日</h3>' +
          '<span class="hint">排了休息的人，那天不能被预约</span></div>' +
        (offRows || '<div class="empty" style="padding:26px"><p>还没有排休</p><span>点人员行上的「排休」可以给他设几天休息</span></div>') +
      '</div>' +
      '<div class="card" style="margin-top:14px"><div class="card-body"><p class="hint">' +
        '人员就是登录账号：<b>姓名 + PIN</b> 登录，登录后自动归到这个团队。<br>' +
        '想临时加个临时工，直接「添加人员」并派单即可；对方要自己登录时，用「注册」再用团队码申请。<br>' +
        '<b>排休</b>会给这个人写上休息日，日历和派单都会拦住这段时间。<br>' +
        '要让人当<b>管理员</b>，去「设置 → 管理员」里点「设为管理员」——这里只管岗位身份，不管权限。' +
      '</p></div></div>';
  }

  /* 发信账号：一个团队可以配多个，前一个额度用完自动换下一个 */
  const accountTag = a => {
    if (!a.enabled) return ['已停用', 'tag-已取消'];
    if (a.exhausted_today) return ['今天额度用完', 'tag-已取消'];
    if (a.daily_limit > 0 && a.used_today >= a.daily_limit) return ['今天额度用完', 'tag-已取消'];
    if (a.last_error) return ['上次失败', 'tag-加急'];
    return ['正常', 'tag-已完成'];
  };

  const accountLine = (a, canEdit) => {
    const t = accountTag(a);
    const ready = a.kind === 'emailjs'
      ? !!(a.service_id && a.template_id && a.public_key)
      : !!(a.host && a.user && a.pass_set);
    const quota = a.daily_limit > 0
      ? '今日 ' + a.used_today + '/' + a.daily_limit
      : '今日 ' + a.used_today + ' 封（不限量）';
    return '<div class="list-row">' +
      '<div class="grow"><div class="nm">' + esc(a.label || a.user || a.host || '邮箱服务') +
        ' <span class="tag ' + t[1] + '">' + t[0] + '</span>' +
        (ready ? '' : ' <span class="tag tag-待确认">没填全</span>') + '</div>' +
        '<div class="sub">' + (a.kind === 'emailjs'
          ? 'EmailJS 中转 · ' + esc(a.service_id || '') + ' · ' + quota
          : esc((a.user || '') + ' @ ' + (a.host || '') + ':' + (a.port || 465)) + ' · ' + quota) +
          (a.last_error ? '<br>上次错误：' + esc(String(a.last_error).slice(0, 80)) : '') +
        '</div></div>' +
      (canEdit
        ? '<label class="switch" title="启用 / 停用"><input type="checkbox" data-act="mail-acc-toggle" data-id="' + a.id + '"' + (a.enabled ? ' checked' : '') + '><i></i></label>' +
          '<button class="btn btn-sm" data-act="mail-acc-test" data-id="' + a.id + '" data-label="' + esc(a.label || '') + '">测试</button>' +
          '<button class="btn btn-sm" data-act="mail-acc-edit" data-id="' + a.id + '">编辑</button>' +
          '<button class="btn btn-sm btn-danger" data-act="mail-acc-del" data-id="' + a.id + '">删除</button>'
        : '') +
      '</div>';
  };

  function emailCard(s) {
    s = s || {};
    const v = k => String(s[k] || '').trim();
    const on = s.email_enabled === true;
    const list = state.mailAccounts || [];
    const usableCount = list.filter(a => a.enabled).length;
    const owner = isOwnerTeam();

    return '<div class="card" style="margin-top:14px"><div class="card-head"><h3 class="card-title">邮件通知</h3>' +
        '<span class="tag ' + (on && usableCount ? 'tag-已确认' : (usableCount ? 'tag-待确认' : 'tag-已取消')) + '">' +
          (usableCount ? (on ? '已启用' : '已配置 · 未启用') : '未配置') + '</span></div>' +
      '<div class="card-body">' +
        '<div class="list-row" style="padding:0 0 12px;border:0">' +
          '<div class="grow"><div class="nm">启用邮件</div><div class="sub">派单通知维修工、维修通知业主/租客、每日汇总</div></div>' +
          '<label class="switch"><input type="checkbox" data-act="toggle-email"' + (on ? ' checked' : '') + '><i></i></label>' +
        '</div>' +
        '<div class="field"><label>每日汇总收件邮箱</label><input class="input" type="email" data-field="digest_email" value="' + esc(v('digest_email')) + '" placeholder="每天一封派单汇总，可留空"></div>' +
        '<button class="btn btn-primary btn-sm" data-act="save-email">保存</button>' +
      '</div></div>' +

      '<div class="card" style="margin-top:14px"><div class="card-head"><h3 class="card-title">邮箱服务（' + list.length + '）</h3>' +
        (owner ? '<button class="btn btn-sm btn-primary" data-act="mail-acc-new">＋ 新增</button>' : '') + '</div>' +
        '<div class="card-body" style="padding-top:0">' +
          '<p class="hint" style="margin:0 0 10px">从上往下依次使用：<b>某个邮箱当天额度用完（或报错）就自动换下一个</b>，' +
            '没人会漏收通知。建议配两个 —— QQ 邮箱单日约 500 封，超了就用备用。</p>' +
          (list.length
            ? list.map(a => accountLine(a, owner)).join('')
            : '<div class="empty" style="padding:26px"><p>还没有邮箱服务</p><span>' +
              (owner ? '点右上角「＋ 新增」，填一个 QQ 邮箱 + 授权码就能发信' : '需要统筹管理员去配一个（发信额度属于系统级配置）') +
              '</span></div>') +
          (owner
            ? '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">' +
                '<button class="btn btn-sm" data-act="test-mail">发一封测试</button>' +
                '<button class="btn btn-sm" data-act="send-digest">发今日汇总</button>' +
                '<button class="btn btn-sm" data-act="mail-logs">发送记录</button>' +
              '</div>'
            : '<p class="hint" style="margin:12px 0 0">发信账号属于系统级配置，只有<b>统筹管理员</b>能增删改；' +
              '你可以在上面「我的通知邮箱」里设置并验证自己的收件邮箱。</p>') +
        '</div></div>' +

      '<div class="card" style="margin-top:14px"><div class="card-head"><h3 class="card-title">QQ 邮箱怎么拿授权码（约 3 分钟）</h3></div><div class="card-body">' +
        '<p class="hint" style="margin:0 0 10px">' +
          '① 浏览器打开 <b>mail.qq.com</b> 登录 → 顶部「设置」→「账号」；<br>' +
          '② 往下找到「POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV 服务」，点 <b>开启</b> SMTP 服务；<br>' +
          '③ 按提示用手机发一条短信验证，页面会显示一串 <b>16 位授权码</b>（只显示一次，复制下来）；<br>' +
          '④ 回到这里点「＋ 新增」：邮箱填 <b>完整地址</b>，授权码粘贴进去，保存 → 点「测试」。' +
        '</p>' +
        '<p class="hint" style="margin:0">QQ 是 <b>smtp.qq.com:465</b>，163 是 <b>smtp.163.com:465</b>，腾讯企业邮是 <b>smtp.exmail.qq.com:465</b>。' +
        '想要第三方中转就新增时选 EmailJS（免费 200 封/月）。</p>' +
      '</div></div>';
  }

  /* ============================================================
     设置：管理员（统筹唯一且只能转让；管理员可多个，由统筹/管理员任免）
     ============================================================ */
  function adminsPane() {
    const actor = state.profile || {};
    const owner = isOwnerTeam();
    const canEdit = isAdmin();
    const rank = r => (r === 'owner' ? 0 : r === 'admin' ? 1 : 2);
    const list = state.profiles.slice().sort((a, b) =>
      rank(a.team_role) - rank(b.team_role) || String(a.name).localeCompare(String(b.name), 'zh'));

    const rows = list.map(p => {
      const me = p.id === actor.id;
      const role = p.team_role || 'member';
      const tag = role === 'owner'
        ? '<span class="tag tag-加急">统筹管理员</span>'
        : (role === 'admin' ? '<span class="tag tag-已确认">管理员</span>' : '<span class="tag tag-待确认">成员</span>');
      let actions = '';
      if (role === 'owner') {
        actions = owner ? '<button class="btn btn-sm" data-act="transfer-owner">转让统筹管理员身份</button>' : '';
      } else if (canEdit && !me) {
        actions = role === 'admin'
          ? '<button class="btn btn-sm" data-act="admins-role" data-id="' + esc(p.id) + '" data-role="member">取消管理员</button>'
          : '<button class="btn btn-sm btn-primary" data-act="admins-role" data-id="' + esc(p.id) + '" data-role="admin">设为管理员</button>';
      }
      return '<div class="list-row">' +
        '<span class="avatar" style="background:' + esc(p.color || '#2b6ef6') + ';width:30px;height:30px;font-size:12px">' + esc(String(p.name).slice(0, 1)) + '</span>' +
        '<div class="grow"><div class="nm">' + esc(p.name) + ' ' + tag +
          (me ? ' <span class="tag tag-已确认">我</span>' : '') +
          (p.active === false ? ' <span class="tag tag-已取消">停用</span>' : '') + '</div>' +
          '<div class="sub">' + esc(p.phone || '无手机号') + '</div></div>' +
        actions +
      '</div>';
    }).join('');

    const adminCount = list.filter(p => p.team_role === 'admin').length;

    return '<div class="card">' +
        '<div class="card-head"><h3 class="card-title">管理员（' + adminCount + '）</h3>' +
          '<span class="tag tag-加急">统筹管理员 1</span></div>' +
        (rows || '<div class="empty"><p>还没有成员</p><span>先用团队码把人拉进来</span></div>') +
      '</div>';
  }

  /* 转让统筹：选人 + 自己的 PIN + 手输「确认」，三重确认防误点 */
  function openTransferOwnerModal() {
    const cands = state.profiles.filter(p => p.team_role !== 'owner' && p.active !== false);
    if (!cands.length) { toast('团队里还没有可以接手的人'); return; }
    const body =
      '<p class="hint" style="margin:0 0 12px">转让后<b>你变成管理员</b>，对方成为新的统筹管理员（全团队只能有一个）。' +
      '对方会收到一条站内通知，这个操作立刻生效。</p>' +
      '<div class="field"><label>转给谁</label><select class="select" data-field="transfer-to">' +
        cands.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + '（' + esc(teamRoleLabel(p.team_role)) + '）</option>').join('') +
      '</select></div>' +
      '<div class="field"><label>你的登录 PIN</label>' +
        '<input class="input" type="password" data-field="transfer-pin" autocomplete="current-password" placeholder="确认是你本人在操作"></div>' +
      '<div class="field"><label>手动输入「确认」两个字</label>' +
        '<input class="input" data-field="transfer-confirm" autocomplete="off" placeholder="确认">' +
        '<div class="hint">防误点：请原样输入「确认」，不要多加字。</div></div>';
    openModal(modalShell('转让统筹管理员身份', body,
      '<button class="btn" data-act="close-modal">取消</button>' +
      '<button class="btn btn-danger" data-act="transfer-owner-do">确认转让</button>'));
  }

  /* ============================================================
     设置：团队
     ============================================================ */

  function teamPane() {
    const t = state.team || {};
    const owner = state.profile.team_role === 'owner';
    const admin = isAdmin();
    const members = state.profiles.length;
    const reqs = state.teamRequests || [];
    const pending = reqs.length;

    const reqRows = reqs.map(r =>
      '<div class="list-row">' +
        '<span class="avatar" style="background:#8b93a3;width:30px;height:30px;font-size:12px">' + esc(String(r.name || '?').slice(0, 1)) + '</span>' +
        '<div class="grow"><div class="nm">' + esc(r.name) +
          ' <span class="hint">' + esc(r.phone || '未填手机号') + '</span></div>' +
          '<div class="sub">' + esc(r.message || '申请加入') + ' · ' + esc(String(r.created_at || '').slice(0, 16)) + '</div>' +
          (r.dup_name ? '<div class="hint">团队里已有同名成员「' + esc(r.dup_name) + '」，同意后会合并到那一行的历史记录</div>' : '') +
        '</div>' +
        '<button class="btn btn-sm btn-primary" data-act="req-approve" data-id="' + r.id + '">同意</button>' +
        '<button class="btn btn-sm" data-act="req-reject" data-id="' + r.id + '">拒绝</button>' +
      '</div>').join('');

    const memberRows = state.profiles.map(p => {
      const me = p.id === state.profile.id;
      return '<div class="list-row">' +
        '<span class="avatar" style="background:' + esc(p.color || '#2b6ef6') + ';width:30px;height:30px;font-size:12px">' + esc(String(p.name).slice(0, 1)) + '</span>' +
        '<div class="grow"><div class="nm">' + esc(p.name) + (me ? ' <span class="tag tag-已确认">我</span>' : '') +
          ' <span class="tag ' + (p.team_role === 'owner' ? 'tag-加急' : (p.team_role === 'admin' ? 'tag-已确认' : 'tag-待确认')) + '">' +
          esc(teamRoleLabel(p.team_role)) + '</span></div>' +
          '<div class="sub">' + esc(p.phone || '无手机号') + ' · ' + esc(ROLE_LABEL[p.role] || p.role) + '</div></div>' +
        (admin && !me && p.team_role !== 'owner'
          ? '<button class="btn btn-sm btn-danger" data-act="member-remove" data-id="' + esc(p.id) + '">移出</button>' : '') +
      '</div>';
    }).join('');

    return '<div class="card">' +
        '<div class="card-head"><h3 class="card-title">团队</h3>' +
          '<span class="tag tag-已确认">' + esc(teamRoleLabel(state.profile.team_role)) + '</span></div>' +
        '<div class="card-body">' +
          '<div class="kv"><span>团队名称</span><b>' + esc(t.name || '—') + '</b></div>' +
          '<div class="kv"><span>成员</span><b>' + members + ' 人</b></div>' +
          '<div class="kv"><span>待审申请</span><b>' + pending + ' 条</b></div>' +
          '<div class="field" style="margin-top:16px"><label>团队码（发给同事，让他们凭码申请）</label>' +
            '<div class="team-code-row"><code class="team-code" id="team-code">' + esc(t.code || '—') + '</code>' +
            '<button class="btn btn-sm" data-act="copy-team-code">复制</button>' +
            (owner ? '<button class="btn btn-sm" data-act="team-code-reset">重置</button>' : '') + '</div>' +
            '<div class="hint">3 位大写字母 + 6 位数字。重置后旧码立刻失效。</div></div>' +
          (admin ? '<div class="list-row" style="padding:10px 0 0;border:0">' +
            '<div class="grow"><div class="nm">允许凭码直接加入</div><div class="sub">' +
              (t.allow_direct ? '已开启：拿到团队码的人不用审批就能进' : '已关闭：需要管理员审批（推荐）') + '</div></div>' +
            '<label class="switch"><input type="checkbox" data-act="team-allow-direct"' + (t.allow_direct ? ' checked' : '') + (owner ? '' : ' disabled') + '><i></i></label>' +
          '</div>' : '') +
          (admin ? '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">' +
            '<button class="btn btn-sm" data-act="team-rename">改团队名</button>' +
            '</div>' : '') +
        '</div>' +
      '</div>' +

      (admin
        ? '<div class="card" style="margin-top:14px"><div class="card-head"><h3 class="card-title">加入申请（' + pending + '）</h3>' +
            (pending ? '' : '<span class="hint">暂时没人申请</span>') + '</div>' +
            (pending ? reqRows : '<div class="empty" style="padding:26px"><p>没有待审申请</p><span>同事提交申请后会出现在这里</span></div>') +
          '</div>'
        : '') +

      '<div class="card" style="margin-top:14px"><div class="card-head"><h3 class="card-title">成员（' + members + '）</h3></div>' +
        memberRows +
      '</div>' +

      '<div class="card" style="margin-top:14px"><div class="card-head"><h3 class="card-title">退出 / 解散</h3></div><div class="card-body">' +
        '<p class="hint" style="margin:0 0 12px">退出后你就看不到这个团队的数据了；你的预约单会留在团队里。</p>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          (owner ? '' : '<button class="btn btn-sm" data-act="team-leave">退出团队</button>') +
          (owner ? '<button class="btn btn-sm btn-danger" data-act="team-dissolve">解散团队</button>' : '') +
        '</div>' +
        (owner ? '<p class="hint" style="margin:12px 0 0">解散会删除这个团队的全部预约、项目、人员和设置，且不可恢复。建议先导出备份。</p>' : '') +
      '</div></div>';
  }

  /* ============================================================
     自动备份卡片（读态锁定，点「更改」才可编辑）
     ============================================================ */
  let autoEdit = false;   // 是否处于编辑态
  let autoFlash = '';     // 保存/切换后的成功提示，下一次操作即清掉

  function autoHourOf(st) {
    const h = Number(st && st.backup_hour !== null && st.backup_hour !== undefined ? st.backup_hour : 3);
    return Number.isFinite(h) ? Math.max(0, Math.min(23, Math.round(h))) : 3;
  }
  function hhmm(h) { return (h < 10 ? '0' + h : String(h)) + ':00'; }

  function autoBackupCardHtml() {
    const st = state.settings || {};
    const on = Number(st.auto_backup) === 1;
    const hour = autoHourOf(st);
    const email = String(st.backup_email || '').trim();
    const full = Number(st.backup_full) === 1;
    // 没配过邮箱就一直停在表单，避免「开了开关却发不出去」
    const form = autoEdit || !email;

    const head =
      '<div class="card-head"><h3 class="card-title">自动备份到邮箱</h3>' +
        '<div style="display:flex;align-items:center;gap:10px">' +
          '<span class="hint" style="font-size:12px;margin:0">' + (on ? '已开启' : '已关闭') + '</span>' +
          '<label class="switch" title="' + (form ? '先保存或取消，再切换开关' : (on ? '关闭自动备份' : '开启自动备份')) + '">' +
            '<input type="checkbox" data-act="toggle-auto-backup"' + (on ? ' checked' : '') + (form ? ' disabled' : '') + '>' +
            '<i></i></label>' +
        '</div>' +
      '</div>';

    const intro =
      '<p class="hint" style="margin:0 0 12px">每天定时把本团队的数据打包成附件，发到你指定的邮箱。' +
        '硬盘坏了、误删了、换机器，都能从邮箱里把备份取回来。' +
        '发信要用 <b>「设置 → 通知 → 邮箱服务」里的 SMTP 账号</b>（EmailJS 不支持附件）。</p>';

    const flash = autoFlash
      ? '<div class="notice notice-ok" style="margin:0 0 12px">' + esc(autoFlash) + '</div>'
      : '';

    const hourOpts = [];
    for (let h = 0; h < 24; h++) {
      hourOpts.push('<option value="' + h + '"' + (h === hour ? ' selected' : '') + '>' + hhmm(h) + '</option>');
    }

    const formHtml =
      '<div class="field"><label>收件邮箱（多个用逗号隔开，最多 3 个）</label>' +
        '<input class="input" id="auto-backup-email" value="' + esc(email) + '" placeholder="例如 123456@qq.com" autocomplete="off"></div>' +
      '<div class="form-row">' +
        '<div class="field"><label>每天几点发</label><select class="select" id="auto-backup-hour">' + hourOpts.join('') + '</select></div>' +
        '<div class="field"><label>备份内容</label>' +
          '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-top:8px">' +
            '<input type="checkbox" id="auto-backup-full"' + (full ? ' checked' : '') + '> 同时附上整库 .db</label>' +
          '<div class="hint" style="margin-top:4px">整库含所有团队与密钥，只给统筹开</div>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:2px">' +
        '<button class="btn btn-primary btn-sm" data-act="save-auto-backup">保存</button>' +
        (email ? '<button class="btn btn-sm" data-act="cancel-auto-backup">取消</button>' : '') +
      '</div>';

    const summaryHtml =
      '<div style="display:flex;align-items:center;gap:8px;margin:2px 0 2px">' +
        '<div class="grow" style="font-size:13px;font-weight:600">当前设置</div>' +
        '<button class="btn btn-sm" data-act="edit-auto-backup">更改</button>' +
      '</div>' +
      '<div>' +
        '<div class="kv"><span>收件邮箱</span><b style="text-align:right;overflow-wrap:anywhere;max-width:62%">' + esc(email) + '</b></div>' +
        '<div class="kv"><span>发送时间</span><b>每天 ' + hhmm(hour) + '</b></div>' +
        '<div class="kv"><span>备份内容</span><b>团队 JSON' + (full ? ' + 整库 .db' : '') + '</b></div>' +
      '</div>';

    const last = st.last_backup_at
      ? '<div class="notice' + (/失败/.test(String(st.last_backup_note || '')) ? ' notice-warn' : '') + '" style="margin:12px 0 0">' +
          '上次备份：' + esc(st.last_backup_at) + '　' + esc(st.last_backup_note || '') + '</div>'
      : '';

    // 读态才给「立即备份一次」，锁着的时候人看得清「现在的配置就是这样」
    const runBtn = form
      ? ''
      : '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">' +
          '<button class="btn btn-sm" data-act="run-auto-backup">立即备份一次</button>' +
        '</div>';

    return '<div class="card" id="auto-backup-card" style="margin-top:14px">' + head + '<div class="card-body">' +
        intro + flash + (form ? formHtml : summaryHtml) + last + runBtn +
        '<p class="hint" style="margin:12px 0 0">附件上限 15MB。JSON 备份不含邮箱授权码 / 微信密钥 / PushPlus token（导入后重填一次即可）；' +
          '整库 .db 是完整快照，请妥善保管。</p>' +
      '</div></div>';
  }

  /** 只换这张卡片，别整页重绘（否则会滚回顶部、闪一下） */
  function refreshAutoBackupCard() {
    const page = $('#page');
    const old = $('#auto-backup-card');
    if (!old) { render(); return; }
    const y = page ? page.scrollTop : 0;
    const box = document.createElement('div');
    box.innerHTML = autoBackupCardHtml();
    const next = box.firstElementChild;
    if (next && typeof old.replaceWith === 'function') {
      old.replaceWith(next);
      if (page) page.scrollTop = y;
    } else {
      render();
    }
  }

  /* ============================================================
     设置：数据备份
     ============================================================ */
  function dataPane() {
    const owner = isOwnerTeam();
    const cnt = {
      profiles: state.profiles.length,
      projects: state.projects.length,
      appointments: state.appointments.length,
      off: state.timeOff.length
    };
    const stats =
      '<div class="kv"><span>人员</span><b>' + cnt.profiles + ' 条</b></div>' +
      '<div class="kv"><span>项目</span><b>' + cnt.projects + ' 条</b></div>' +
      '<div class="kv"><span>预约单</span><b>' + cnt.appointments + ' 条</b></div>' +
      '<div class="kv"><span>休息日</span><b>' + cnt.off + ' 条</b></div>';

    // 备份/恢复会让数据整体搬走或被覆盖，属于「数据安全」，只有统筹能做
    if (!owner) {
      return '<div class="card"><div class="card-head"><h3 class="card-title">数据备份</h3></div><div class="card-body">' +
          stats +
          '<div class="notice notice-warn" style="margin-top:14px">' +
            '导出/导入会动到整个团队的数据（属于数据安全），只有<b>统筹管理员</b>能操作。' +
            '需要备份时找统筹导出；他自己的入口在同一个页面。' +
          '</div>' +
        '</div></div>';
    }

    const autoCard = autoBackupCardHtml();

    return '<div class="card"><div class="card-head"><h3 class="card-title">导出备份</h3></div><div class="card-body">' +
        stats +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px">' +
          '<button class="btn btn-primary btn-sm" data-act="export-json">导出 JSON（本团队）</button>' +
          '<button class="btn btn-sm" data-act="export-db">导出整库 .db</button>' +
        '</div>' +
        '<p class="hint" style="margin:12px 0 0">' +
          'JSON 只含本团队的数据，适合换服务器、换团队时搬数据；.db 是完整数据库文件（含所有团队），适合整机备份。' +
        '</p>' +
      '</div></div>' +

      autoCard +

      '<div class="card" style="margin-top:14px"><div class="card-head"><h3 class="card-title">导入 / 恢复</h3></div><div class="card-body">' +
        '<p class="hint" style="margin:0 0 12px">' +
          '支持 <b>JSON 备份</b>（合并进本团队，不会删已有数据）、<b>.db</b>（整库恢复，覆盖全部数据，仅统筹管理员）、' +
          '<b>.xlsx / .csv</b>（表格导入预约单或人员名单）。上传后先给预览，确认了才写库。' +
        '</p>' +
        '<input type="file" id="import-file" class="input" accept=".json,.db,.sqlite,.sqlite3,.csv,.tsv,.txt,.xlsx" style="padding:9px">' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">' +
          '<button class="btn btn-primary btn-sm" data-act="import-preview">上传并预览</button>' +
        '</div>' +
        '<div id="import-result" style="margin-top:14px"></div>' +
      '</div></div>' +

      '<div class="card" style="margin-top:14px"><div class="card-head"><h3 class="card-title">表格怎么填</h3></div><div class="card-body">' +
        '<p class="hint" style="margin:0 0 8px"><b>预约单表</b>（第一行是表头，列名认这些）：<br>' +
          '日期（必填，2026-11-24 / 2026/11/24 / 11月24日 都行）、时段（上午/下午/晚上/全天）、项目、维修人员、地址、维修内容（旧表头「报修内容」也认）、预约人（旧表头「联系人」也认）、预约人电话、状态、优先级、备注</p>' +
        '<p class="hint" style="margin:0 0 8px"><b>人员表</b>：姓名（必填）、手机号（11 位）、邮箱、身份（维修人员/预约人/统筹管理员）、PIN（留空默认 1234）</p>' +
        '<p class="hint" style="margin:0">表格里出现的新项目、新维修人员会自动建档；同一个人同一天同一时段重复的行会被跳过。</p>' +
      '</div></div>' +

      '<div class="card" style="margin-top:14px"><div class="card-body"><p class="hint" style="margin:0">' +
        '服务端每次导出/恢复都会在数据目录的 <b>backups/</b> 里留一份快照，恢复失败也不会丢原库。' +
      '</p></div></div>';
  }

  /* ============================================================
     设置：登录方式（微信）
     ============================================================ */
  function loginPane() {
    const s = state.wxSettings || {};
    const wx = state.wechat || {};
    const setMark = v => v ? ' <span class="tag tag-已确认">已保存</span>' : '';
    return '<div class="card"><div class="card-head"><h3 class="card-title">微信登录</h3>' +
        '<span class="tag ' + ((wx.mp || wx.qr) ? 'tag-已确认' : 'tag-已取消') + '">' +
          ((wx.mp || wx.qr) ? '已启用' : '未配置') + '</span></div>' +
      '<div class="card-body">' +
        '<p class="hint" style="margin:0 0 14px">' +
          '两种入口用两套 AppID：<b>公众号网页授权</b>用于「在微信里打开直接登录」，<b>开放平台网站应用</b>用于「电脑上扫码登录」。' +
          '两边绑到同一个开放平台账号后，同一个人用哪种方式进来都是同一个账号。' +
        '</p>' +

        '<h4 style="margin:18px 0 10px;font-size:13.5px">① 公众号（微信内一键登录）</h4>' +
        '<div class="field"><label>公众号 AppID</label>' +
          '<input class="input" id="wx-mp-appid" value="' + esc(s.wx_mp_appid || '') + '" placeholder="wx开头的 18 位"></div>' +
        '<div class="field"><label>AppSecret' + setMark(s.wx_mp_secret_set) + '</label>' +
          '<input class="input" type="password" id="wx-mp-secret" value="" autocomplete="new-password" placeholder="' +
            (s.wx_mp_secret_set ? '已保存，留空则不修改' : '公众号后台 → 开发 → 基本配置') + '"></div>' +

        '<h4 style="margin:18px 0 10px;font-size:13.5px">② 开放平台网站应用（电脑扫码）</h4>' +
        '<div class="field"><label>网站应用 AppID</label>' +
          '<input class="input" id="wx-qr-appid" value="' + esc(s.wx_qr_appid || '') + '" placeholder="wx开头的 18 位"></div>' +
        '<div class="field"><label>AppSecret' + setMark(s.wx_qr_secret_set) + '</label>' +
          '<input class="input" type="password" id="wx-qr-secret" value="" autocomplete="new-password" placeholder="' +
            (s.wx_qr_secret_set ? '已保存，留空则不修改' : '开放平台 → 网站应用 → 开发信息') + '"></div>' +

        '<div class="field"><label>授权回调地址（填到微信后台，必须完全一致）</label>' +
          '<div class="team-code-row"><code class="team-code" style="font-size:12.5px">' + esc((state.wxSettings && state.wxSettings.callback) || (location.origin + '/api/auth/wechat/callback')) + '</code>' +
          '<button class="btn btn-sm" data-act="copy-callback">复制</button></div></div>' +

        '<button class="btn btn-primary btn-sm" data-act="save-wechat">保存</button>' +
      '</div></div>' +

      '<div class="card" style="margin-top:14px"><div class="card-head"><h3 class="card-title">怎么申请（大约 1–3 天）</h3></div><div class="card-body">' +
        '<p class="hint" style="margin:0 0 8px"><b>扫码登录：</b>打开 <b>open.weixin.qq.com</b> → 管理中心 → 网站应用 → 创建应用（要企业主体，需 300 元认证费）→ 审核通过后拿到 AppID / AppSecret → 把上面的回调地址填到「授权回调域」（只填域名，如 <b>crewgo.cn</b>）。</p>' +
        '<p class="hint" style="margin:0 0 8px"><b>微信内登录：</b>需要一个<b>已认证的服务号</b> → 公众号后台 → 设置与开发 → 基本配置（拿 AppID/AppSecret）→ 公众号设置 → 功能设置 → 「网页授权域名」填同一个域名。</p>' +
        '<p class="hint" style="margin:0">没配置也能用：姓名 + PIN 登录一直可用，微信只是更省事。域名必须已备案且能公网访问，微信回调不支持内网地址。</p>' +
      '</div></div>' +

      '<div class="card" style="margin-top:14px"><div class="card-body" style="display:flex;justify-content:space-between;align-items:center;gap:12px">' +
        '<div><div class="nm" style="font-weight:550">我的微信</div><div class="sub">' +
          (state.profile.wx_bound ? '已绑定，可以在微信里一键登录' : '还没绑定') + '</div></div>' +
        (state.profile.wx_bound
          ? '<button class="btn btn-sm btn-danger" data-act="wx-unbind">解除绑定</button>'
          : '<button class="btn btn-sm btn-primary" data-act="wx-bind">去绑定</button>') +
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
    const myEmail = String(state.profile.email || '');
    const pendingEmail = String(state.profile.email_pending || '');
    const verified = !!(state.profile.email_verified_at || state.profile.email_verified);
    // 已验证就锁住：不点「更改邮箱」不给改，避免误改把已经能收信的地址弄丢
    const locked = verified && !state.emailEdit;
    const emailTag = verified
      ? '<span class="tag tag-已完成">已验证</span>'
      : (pendingEmail || myEmail
        ? '<span class="tag tag-待确认">未验证</span>'
        : '<span class="tag tag-已取消">未填</span>');

    // 已锁定：只读展示 + 更改邮箱 + 发测试信
    const lockedBody =
      '<div class="field"><label>我的邮箱</label>' +
        '<div class="team-code-row">' +
          '<input class="input" value="' + esc(myEmail) + '" readonly data-field="my_email_locked">' +
          '<button class="btn btn-sm" data-act="edit-my-email">更改邮箱</button>' +
        '</div>' +
        '<div class="hint">已验证。派单、出发提醒、每日汇总都发到这个地址；要换地址点「更改邮箱」，改完需要重新验证。</div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">' +
        '<button class="btn btn-sm" data-act="test-my-email">发一封邮件测试</button>' +
      '</div>';

    // 编辑中（首次设置，或点了「更改邮箱」）
    const editBody =
      '<div class="field"><label>我的邮箱</label>' +
        '<div class="team-code-row"><input class="input" type="email" data-field="my_email" value="' + esc(pendingEmail || myEmail) + '" placeholder="your@qq.com">' +
        '<button class="btn btn-sm" data-act="send-email-code">发送验证码</button></div></div>' +
      '<div class="field"><label>验证码（6 位数字，10 分钟内有效）</label>' +
        '<div class="team-code-row"><input class="input code-input" data-field="my_email_code" inputmode="numeric" maxlength="6" placeholder="123456">' +
        '<button class="btn btn-sm" data-act="verify-email-code">验证</button></div>' +
        (pendingEmail ? '<div class="hint">正在验证 <b>' + esc(pendingEmail) + '</b>，验证通过后才会替换现在的邮箱。</div>' : '') +
      '</div>' +
      (verified ? '<div style="margin-bottom:14px"><button class="btn btn-sm" data-act="cancel-my-email">取消更改</button></div>' : '');

    const myCard = '<div class="card" style="margin-top:14px"><div class="card-head"><h3 class="card-title">我的通知邮箱</h3>' + emailTag + '</div><div class="card-body">' +
        (locked
          ? lockedBody
          : '<p class="hint" style="margin:0 0 12px">派单、出发提醒、每日汇总都会发到这个邮箱。<b>填完点「发送验证码」，收到验证码填进来验证一下</b>，确保地址没写错、也确实能收到。</p>' + editBody) +
        '<div class="field"><label>我的 PushPlus Token（选填）</label>' +
          '<input class="input" data-field="my_push_token" value="' + esc(myToken) + '" placeholder="留空则收不到微信推送"></div>' +
        '<p class="hint" style="margin:-6px 0 12px">Token 获取方式：手机打开 <b>pushplus.plus</b> → 微信扫码登录 → 完成实名 → 复制 token → 关注它的公众号。' +
        '邮箱和 Token 填一个就够，两个都填就两边都收。</p>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          '<button class="btn btn-primary btn-sm" data-act="save-my-push">保存 Token</button>' +
          '<button class="btn btn-sm" data-act="test-push">发一条微信测试</button>' +
          '<button class="btn btn-sm" data-act="enable-desktop">开启电脑弹窗通知</button>' +
        '</div>' +
      '</div></div>';

    return adminPart + myCard +
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
        '④ <b>邮件</b>：维修工填了邮箱就发派单和出发提醒，预约单里填了业主/租客邮箱就能一键通知业主，统筹可收每日汇总；<br>' +
        '⑤ <b>出发提醒</b>：出发前一天/当天自动补发一次，避免漏单。' +
      '</p></div></div>';
  }

  function mePane() {
    const p = state.profile;
    const emailLocked = !!(p.email_verified_at || p.email_verified) && !!p.email;
    return '<div class="card"><div class="card-head"><h3 class="card-title">我的资料</h3></div><div class="card-body">' +
      '<form data-form="save-me">' +
        '<div class="form-row">' +
          '<div class="field"><label>姓名</label><input class="input" name="name" value="' + esc(p.name) + '" required maxlength="20"></div>' +
          '<div class="field"><label>手机号</label><input class="input" name="phone" type="tel" inputmode="numeric" value="' + esc(p.phone || '') + '" maxlength="20" placeholder="11 位"></div>' +
        '</div>' +
        '<div class="field"><label>邮箱</label>' +
          (emailLocked
            ? '<input class="input" type="email" value="' + esc(p.email || '') + '" readonly>' +
              '<div class="hint">已验证，这个地址已锁定。要换邮箱请到「设置 → 通知 → 我的通知邮箱」点「更改邮箱」。</div>'
            : '<input class="input" type="email" name="email" value="' + esc(p.email || '') + '" placeholder="用于收派单和出发提醒">' +
              '<div class="hint">填完要去「设置 → 通知 → 我的通知邮箱」点「发送验证码」验证，验证通过才算生效。</div>') +
        '</div>' +
        '<div class="field"><label>我的排期颜色</label><div style="display:flex;gap:8px;flex-wrap:wrap">' +
          PALETTE.map(c => '<label style="cursor:pointer"><input type="radio" name="color" value="' + c + '"' + ((p.color || '') === c ? ' checked' : '') + ' style="display:none">' +
            '<span class="color-dot" style="width:24px;height:24px;background:' + c + ';display:inline-block;border-radius:50%;outline:' + ((p.color || '') === c ? '2px solid ' + c : 'none') + ';outline-offset:2px"></span></label>').join('') +
        '</div></div>' +
        '<button class="btn btn-primary btn-sm" type="submit">保存</button>' +
      '</form>' +
      '<div class="kv" style="margin-top:18px"><span>团队身份</span><b>' + esc(teamRoleLabel(p.team_role)) + '</b></div>' +
      '<div class="kv"><span>岗位身份</span><b>' + esc(ROLE_LABEL[p.role] || p.role) + '</b></div>' +
      '<div class="kv"><span>账号状态</span><b>' + (p.active === false ? '已停用' : '正常') + '</b></div>' +
      '<div class="kv"><span>参与排期</span><b>' + (p.role === 'tech' || p.role === 'admin' ? '是' : '否（可被指派）') + '</b></div>' +
      '</div></div>' +
      '<div class="card" style="margin-top:14px"><div class="card-head"><h3 class="card-title">修改登录 PIN</h3></div><div class="card-body">' +
        '<div class="form-row">' +
          '<div class="field"><label>原 PIN</label><input class="input" data-field="pin_old" type="password"' + PIN_ATTRS + ' placeholder="当前 PIN"></div>' +
          '<div class="field"><label>新 PIN</label><input class="input" data-field="pin_new" type="password"' + PIN_ATTRS + ' placeholder="至少 4 位"></div>' +
        '</div>' +
        '<div class="hint" style="margin-bottom:10px">' + PIN_TIP + '</div>' +
        '<button class="btn btn-sm btn-primary" data-act="change-pin">保存新 PIN</button>' +
      '</div></div>' +
      myOffCard(p) +
      wxBindCard(p) +
      '<div class="card" style="margin-top:14px"><div class="card-body" style="display:flex;justify-content:space-between;align-items:center">' +
        '<div><div class="nm" style="font-weight:550">退出登录</div><div class="sub">换一个账号登录</div></div>' +
        '<button class="btn btn-danger btn-sm" data-act="logout">退出</button>' +
      '</div></div>';
  }

  /** 我的休息日：自己就能排，排了那天不会被派单 */
  function myOffCard(p) {
    const list = upcomingOff(p.id);
    const rows = list.slice(0, 12).map(o =>
      '<div class="list-row">' +
        '<div class="grow"><div class="nm">' + esc(o.off_date) + ' · ' + esc(dayLabel(o.off_date).split(' ')[1] || '') +
          (o.part && o.part !== '全天' ? ' ' + esc(o.part) : '') +
          (o.reason ? ' <span class="hint">' + esc(o.reason) + '</span>' : '') + '</div>' +
          '<div class="sub">' + (o.part && o.part !== '全天' ? '这半天不接单，另一半照常' : '这天不接单') + '</div></div>' +
        '<button class="btn btn-sm btn-danger" data-act="del-time-off" data-id="' + o.id + '">取消</button>' +
      '</div>').join('');
    return '<div class="card" style="margin-top:14px"><div class="card-head"><h3 class="card-title">我的休息日</h3>' +
        '<button class="btn btn-sm" data-act="time-off" data-id="' + esc(p.id) + '">＋ 设置休息</button></div>' +
      (rows || '<div class="card-body"><p class="hint" style="margin:0">还没排休。休息日里团队不会把你排进预约单。</p></div>') +
      '</div>';
  }

  /** 微信绑定状态 */
  function wxBindCard(p) {
    const wx = state.wechat || {};
    if (!wx.mp && !wx.qr) return '';
    return '<div class="card" style="margin-top:14px"><div class="card-body" style="display:flex;justify-content:space-between;align-items:center;gap:12px">' +
      '<div><div class="nm" style="font-weight:550">微信' + (p.wx_bound ? '（已绑定）' : '') + '</div>' +
        '<div class="sub">' + (p.wx_bound ? '在微信里打开可以一键登录' : '绑定后不用记 PIN，微信里点一下就进来') + '</div></div>' +
      (p.wx_bound
        ? '<button class="btn btn-sm btn-danger" data-act="wx-unbind">解除绑定</button>'
        : '<button class="btn btn-sm btn-primary" data-act="wx-bind">去绑定</button>') +
    '</div></div>';
  }

  /* ============================================================
     预约表单 / 详情
     ============================================================ */
  /* ---------- 附件 ---------- */
  const authToken = () => (window.__auth && window.__auth.getToken ? window.__auth.getToken() : '') || '';
  // 图片用 <img src> 直接显示，带不了 Authorization 头，所以令牌走查询参数
  const fileUrl = (id, dl) => '/api/files/' + id + '?t=' + encodeURIComponent(authToken()) + (dl ? '&dl=1' : '');
  const isImgMime = m => /^image\//.test(String(m || ''));
  const sizeLabel = n => {
    const b = Number(n) || 0;
    if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + 'MB';
    if (b >= 1024) return Math.max(1, Math.round(b / 1024)) + 'KB';
    return b + 'B';
  };
  const ATT_MAX_MB = 20;
  const attOf = apptId => state.attachments.filter(x => String(x.appointment_id) === String(apptId));
  let attPending = [];   // 还没上传的本机文件：保存时才传，中途取消不会在服务器上留垃圾
  let attRemoved = [];   // 编辑时标记要删掉的已上传附件

  /** 表单里那一排附件小卡片（已上传的 + 待上传的） */
  function attChipsHtml() {
    const form = $('form[data-form="appt"]');
    const apptId = form ? form.getAttribute('data-id') : '';
    const saved = apptId ? attOf(apptId).filter(x => attRemoved.indexOf(Number(x.id)) < 0) : [];
    const parts = saved.map(x =>
      '<span class="att-chip">' +
        (isImgMime(x.mime) ? '<img class="att-mini" src="' + fileUrl(x.id) + '" alt="">' : '<i class="att-ico">📄</i>') +
        '<span class="att-nm">' + esc(x.name) + '</span><span class="att-sz">' + sizeLabel(x.size) + '</span>' +
        '<button type="button" class="att-x" data-act="rm-att" data-id="' + x.id + '" aria-label="移除">×</button>' +
      '</span>').concat(attPending.map((f, i) =>
      '<span class="att-chip att-chip-new">' +
        '<i class="att-ico">' + (isImgMime(f.type) ? '🖼' : '📄') + '</i>' +
        '<span class="att-nm">' + esc(f.name || '粘贴的图片') + '</span><span class="att-sz">' + sizeLabel(f.size) + '</span>' +
        '<button type="button" class="att-x" data-act="rm-att" data-key="' + i + '" aria-label="移除">×</button>' +
      '</span>'));
    return parts.length ? '<div class="att-list" style="margin-top:8px">' + parts.join('') + '</div>' : '';
  }

  function renderAtts() {
    const host = $('#att-host');
    if (host) host.innerHTML = attChipsHtml();
  }

  /** 选好 / 拖进来 / 粘贴进来的文件先进待传队列 */
  function addAttFiles(list) {
    const arr = Array.prototype.slice.call(list || []);
    let big = 0, added = 0;
    arr.forEach(f => {
      if (!f || !f.size) return;
      if (f.size > ATT_MAX_MB * 1024 * 1024) { big++; return; }
      attPending.push(f);
      added++;
    });
    if (big) toast('有 ' + big + ' 个文件超过 ' + ATT_MAX_MB + 'MB，没加上');
    if (added) renderAtts();
    return added;
  }

  async function uploadAttachment(file, apptId) {
    const headers = {
      Authorization: 'Bearer ' + authToken(),
      'X-File-Name': encodeURIComponent(file.name || 'file'),
      'Content-Type': file.type || 'application/octet-stream'
    };
    const res = await fetch('/api/files' + (apptId ? '?appointment_id=' + encodeURIComponent(apptId) : ''), {
      method: 'POST', headers: headers, body: file
    });
    if (!res.ok) {
      let msg = '上传失败（' + res.status + '）';
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    return res.json();
  }

  async function deleteAttachment(id) {
    const res = await fetch('/api/files/' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + authToken() }
    });
    if (!res.ok) {
      let msg = '删除失败（' + res.status + '）';
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    return true;
  }

  /** 保存预约后把附件落盘：先删掉被移除的，再把待传的传上去；返回失败个数 */
  async function flushAttachments(apptId) {
    let failed = 0;
    for (const id of attRemoved) {
      try { await deleteAttachment(id); } catch (e) { failed++; }
    }
    attRemoved = [];
    for (const f of attPending) {
      try { await uploadAttachment(f, apptId); } catch (e) { failed++; }
    }
    attPending = [];
    return failed;
  }

  function openApptForm(a) {
    attPending = []; attRemoved = [];
    openModal(apptFormHtml(a || null), { onMount: mountApptForm });
  }

  function apptFormHtml(a) {
    a = a || {};
    const projectOpts = state.projects.filter(p => p.active !== false);
    const techOpts = techProfiles();
    // 项目和维修人员都是必选项：只留一个禁用的占位项，没选就提交不了（不再有「不指定 / 待分配」）
    const projPlaceholder = projectOpts.length ? '请选择项目' : '还没有项目，先去「设置 → 项目」建一个';
    const techPlaceholder = techOpts.length ? '请选择维修人员' : '还没有维修人员，先去「设置 → 人员」添加';
    // 「预约人」= 项目负责人（给维修人员派活的那个人），新建时默认就是当前登录的人；
    // 电话不再自动带出，要用的人自己填
    const cName = a.contact_name || (a.id ? '' : (state.profile.name || ''));
    const cPhone = a.contact_phone || '';
    return modalShell((a.id ? '编辑预约' : '新建预约'),
      '<form data-form="appt" data-id="' + (a.id || '') + '">' +
        '<div class="form-row">' +
          '<div class="field"><label>项目 <i class="req-mark">*</i></label><select class="select" name="project_id" data-act="on-project" required>' +
            '<option value="" disabled' + (a.project_id ? '' : ' selected') + '>' + esc(projPlaceholder) + '</option>' +
            projectOpts.map(p => '<option value="' + p.id + '"' + (String(a.project_id) === String(p.id) ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') +
          '</select></div>' +
          '<div class="field"><label>维修人员 <i class="req-mark">*</i></label><select class="select" name="tech_id" required>' +
            '<option value="" disabled' + (a.tech_id ? '' : ' selected') + '>' + esc(techPlaceholder) + '</option>' +
            techOpts.map(p => '<option value="' + esc(p.id) + '"' + (String(a.tech_id) === String(p.id) ? ' selected' : '') + '>' + esc(p.name) + '（' + esc(ROLE_LABEL[p.role] || '') + '）</option>').join('') +
          '</select></div>' +
        '</div>' +
        '<div class="form-row">' +
          '<div class="field"><label>上门日期</label><input class="input" type="date" name="visit_date" value="' + esc(a.visit_date || state.board.day || todayStr()) + '" required></div>' +
          '<div class="field"><label>时段</label><select class="select" name="time_slot">' +
            SLOTS.map(s => '<option' + ((a.time_slot || '上午') === s ? ' selected' : '') + '>' + s + '</option>').join('') +
          '</select></div>' +
        '</div>' +
        '<div id="appt-check" class="notice hidden" style="margin:0 0 14px"></div>' +
        '<div class="field"><label>维修地址</label><input class="input" name="address" value="' + esc(a.address || '') + '" placeholder="小区 / 楼栋 / 门牌"></div>' +
        '<div class="field"><label>维修内容</label><textarea class="textarea" name="content" placeholder="哪里坏了，需要带什么材料">' + esc(a.content || '') + '</textarea></div>' +
        '<div class="form-row">' +
          '<div class="field"><label>预约人</label><input class="input" name="contact_name" value="' + esc(cName) + '" placeholder="姓名"></div>' +
          '<div class="field"><label>预约人电话</label><input class="input" name="contact_phone" type="tel" value="' + esc(cPhone) + '" placeholder="上门前会打这个号码"></div>' +
        '</div>' +
        '<div class="field"><label>业主/租客邮箱</label><input class="input" type="email" name="contact_email" value="' + esc(a.contact_email || '') + '" placeholder="选填，填了才能给业主/租客发维修通知"></div>' +
        '<div class="field"><label>附件</label>' +
          '<div class="att-drop" id="att-drop" data-act="pick-att">' +
            '<div class="att-drop-t">点击选择文件，或把图片/文件拖到这里，也可以直接 Ctrl+V 粘贴截图</div>' +
            '<div class="att-drop-s">单个文件最大 ' + ATT_MAX_MB + 'MB，图片、PDF、Office 文档都行</div>' +
          '</div>' +
          '<input type="file" id="att-input" multiple style="display:none">' +
          '<div id="att-host">' + attChipsHtml() + '</div>' +
        '</div>' +
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

  /* 当前这个人对这条预约能做什么：
     管理员不受约束；预约人（创建人）能改能取消；被指派的维修人员只能标记状态 */
  function apptCaps(a) {
    const admin = isAdmin();
    const mine = String(a.owner_id || '') === String(state.uid || '');
    const myTech = String(a.tech_id || '') === String((state.profile && state.profile.id) || '');
    return {
      admin: admin,
      mine: mine,
      myTech: myTech,
      canEdit: admin || mine,
      canCancel: admin || mine,
      canMark: admin || mine || myTech
    };
  }

  /** 业主/租客的收件邮箱：新建预约时填的那个，没填就只能给预约人自己发站内通知 */
  function apptOwnerEmail(a) {
    return String((a && a.contact_email) || '').trim();
  }

  function apptAttsHtml(a) {
    const list = attOf(a.id);
    if (!list.length) return '';
    const imgs = list.filter(x => isImgMime(x.mime));
    const files = list.filter(x => !isImgMime(x.mime));
    return '<div class="att-view">' +
      (imgs.length ? '<div class="att-thumbs">' + imgs.map(x =>
        '<a class="att-thumb" href="' + fileUrl(x.id) + '" target="_blank" rel="noopener" title="' + esc(x.name) + '">' +
          '<img src="' + fileUrl(x.id) + '" alt="' + esc(x.name) + '" loading="lazy">' +
        '</a>').join('') + '</div>' : '') +
      (files.length ? '<div class="att-files">' + files.map(x =>
        '<a class="att-file" href="' + fileUrl(x.id, true) + '">' +
          '<span class="att-nm">' + esc(x.name) + '</span><span class="att-sz">' + sizeLabel(x.size) + '</span>' +
        '</a>').join('') + '</div>' : '') +
      '<div class="hint" style="margin:6px 0 0">共 ' + list.length + ' 个附件</div>' +
    '</div>';
  }

  function openApptModal(a) {
    if (!a) {
      openApptForm(null);
      return;
    }
    const caps = apptCaps(a);
    const canDel = caps.admin || caps.mine;
    const next = caps.canMark ? (STATUS_NEXT[a.status] || []) : [];
    const attHtml = apptAttsHtml(a);
    const stamp = v => String(v || '').slice(0, 16).replace('T', ' ');
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
      line('维修内容', a.content || '—') +
      line('预约人', [a.contact_name, a.contact_phone].filter(Boolean).join('　') || '—') +
      (a.contact_email ? line('业主/租客邮箱', a.contact_email) : '') +
      (a.note ? line('备注', a.note) : '') +
      (attHtml ? lineRaw('附件', attHtml) : '') +
      // 创建人 / 改动记录只给管理员看
      (caps.admin
        ? line('创建人', (a.creator_name || '—') + ' · ' + stamp(a.created_at)) +
          (a.updated_at ? line('最后改动', (a.updater_name || '—') + ' · ' + stamp(a.updated_at)) : '')
        : '') +
      (next.length ? '<div class="status-quick">' + next.map(s =>
        '<button class="btn btn-sm" data-act="set-status" data-id="' + a.id + '" data-status="' + s + '">标记为' + s + '</button>').join('') + '</div>' : '') +
      (caps.canCancel && a.status !== '已取消' && a.status !== '已完成'
        ? '<div class="status-quick"><button class="btn btn-sm btn-danger" data-act="set-status" data-id="' + a.id + '" data-status="已取消">取消这条预约</button></div>'
        : '') +
      // 维修人员不能「取消」别人的单，但能标记这条单做不了（取消的由预约人确认）
      (!caps.canCancel && caps.myTech && a.status !== '已取消' && a.status !== '已完成'
        ? '<div class="status-quick"><button class="btn btn-sm" data-act="mark-cancel" data-id="' + a.id + '">标记为取消</button></div>'
        : '');

    openModal(modalShell('预约详情', body,
      '<button class="btn btn-sm" data-act="mail-owner" data-id="' + a.id + '">通知业主/租客</button>' +
      (caps.canEdit ? '<button class="btn" data-act="edit-appt" data-id="' + a.id + '">编辑</button>' : '') +
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

  /* 排休可能是半天：全天全挡，半天只挡同名时段 */
  const offCovers = (part, slot) => {
    const p = part && part !== '全天' ? part : '全天';
    if (p === '全天') return true;
    return String(slot || '上午') === '全天' || String(slot || '上午') === p;
  };

  /* ---------- 冲突检测：同一人同一时段只能有一单，休息日不能派 ---------- */
  function apptConflictNow() {
    const f = $('form[data-form="appt"]');
    if (!f) return null;
    const g = n => (f.elements[n] ? String(f.elements[n].value || '').trim() : '');
    const date = g('visit_date');
    const slot = g('time_slot') || '上午';
    const techId = g('tech_id');
    const tech = techId ? profileById(techId) : null;
    if (!date || !tech) return null;
    const excludeId = Number(f.getAttribute('data-id')) || 0;
    const conflicts = state.appointments.filter(a =>
      a.visit_date === date &&
      a.status !== '已取消' &&
      Number(a.id) !== excludeId &&
      (a.tech_id ? String(a.tech_id) === String(tech.id) : a.tech_name === tech.name) &&
      slotOverlap(a.time_slot, slot));
    const off = state.timeOff.filter(o => o.profile_id === tech.id && o.off_date === date && offCovers(o.part, slot))[0] || null;
    return { tech: tech, date: date, slot: slot, conflicts: conflicts, off: off };
  }

  function refreshApptCheck() {
    const el = $('#appt-check');
    if (!el) return;
    const r = apptConflictNow();
    if (!r || (!r.off && !r.conflicts.length)) {
      el.className = 'notice hidden';
      el.innerHTML = '';
      return;
    }
    if (r.off) {
      el.className = 'notice notice-warn';
      el.innerHTML = '<b>' + esc(r.tech.name) + '</b> 在 ' + esc(dayLabel(r.date)) + ' ' + esc(r.slot) + ' 排了休息' +
        (r.off.part && r.off.part !== '全天' ? '（只休' + esc(r.off.part) + '）' : '') +
        (r.off.reason ? '（' + esc(r.off.reason) + '）' : '') + '，这个时段不能给他排单。';
      return;
    }
    el.className = 'notice notice-warn';
    el.innerHTML = '<b>时间冲突</b>：' + esc(r.tech.name) + ' 在 ' + esc(dayLabel(r.date)) + ' ' + esc(r.slot) + ' 已经有 ' +
      r.conflicts.length + ' 单：<br>' +
      r.conflicts.map(c => '· ' + esc(c.time_slot) + ' ' + esc(c.project_name || '') + ' ' + esc(c.address || c.content || '')).join('<br>');
  }

  let pasteBound = false;
  /** 复制粘贴截图：表单开着的时候，Ctrl+V 直接把剪贴板里的图片/文件加进附件 */
  function bindPasteOnce() {
    if (pasteBound) return;
    pasteBound = true;
    document.addEventListener('paste', e => {
      if (!$('form[data-form="appt"]')) return;
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const files = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind !== 'file') continue;
        const f = items[i].getAsFile();
        if (f) files.push(f);
      }
      if (!files.length) return;
      e.preventDefault();
      if (addAttFiles(files)) toast('已粘贴 ' + files.length + ' 个附件');
    });
  }

  function mountApptForm() {
    const f = $('form[data-form="appt"]');
    if (!f) return;
    ['tech_id', 'visit_date', 'time_slot'].forEach(n => {
      const el = f.elements[n];
      if (!el) return;
      el.addEventListener('change', refreshApptCheck);
      el.addEventListener('input', refreshApptCheck);
    });
    refreshApptCheck();

    // 附件：点击选择 / 拖进虚线框 / 拖到表单任意位置都算
    const drop = $('#att-drop');
    const input = $('#att-input');
    if (input) {
      input.addEventListener('change', () => { addAttFiles(input.files); input.value = ''; });
    }
    const over = on => {
      if (!drop) return;
      drop.classList[on ? 'add' : 'remove']('over');
    };
    ['dragenter', 'dragover'].forEach(t => {
      f.addEventListener(t, e => { e.preventDefault(); over(true); });
      if (drop) drop.addEventListener(t, e => { e.preventDefault(); over(true); });
    });
    ['dragleave', 'dragend'].forEach(t => {
      f.addEventListener(t, e => { if (e.target === f) over(false); });
      if (drop) drop.addEventListener(t, () => over(false));
    });
    f.addEventListener('drop', e => {
      e.preventDefault();
      over(false);
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) addAttFiles(files);
    });
    bindPasteOnce();
  }

  /** 校验没通过时把光标送到出问题的那个下拉，省得自己找 */
  function focusField(name) {
    const f = $('form[data-form="appt"]');
    const el = f && f.elements ? f.elements[name] : null;
    if (el && typeof el.focus === 'function') el.focus();
  }

  /** 冲突确认文案：把已有单列清楚，让人知道自己在覆盖什么 */
  function conflictText(r) {
    if (r.off) {
      return r.tech.name + ' 在 ' + dayLabel(r.date) + ' ' + r.slot + ' 排了休息' +
        (r.off.part && r.off.part !== '全天' ? '（只休' + r.off.part + '）' : '') +
        (r.off.reason ? '（' + r.off.reason + '）' : '') + '。\n\n确定要强制安排吗？';
    }
    return r.tech.name + ' 在 ' + dayLabel(r.date) + ' ' + r.slot + ' 已经有：\n' +
      r.conflicts.map(c => '· ' + c.time_slot + ' ' + (c.project_name || '') + ' ' + (c.address || c.content || '')).join('\n') +
      '\n\n同一时段安排两单可能会跑不过来，确定继续吗？';
  }

  async function saveAppt(id) {
    const payload = readApptForm();
    // 项目和维修人员是必选，不能是「不指定 / 待分配」
    if (!payload.project_id) { toast('请选择项目（必选）'); focusField('project_id'); return; }
    if (!payload.tech_id) { toast('请选择维修人员（必选）'); focusField('tech_id'); return; }
    if (!payload.visit_date) { toast('请选择上门日期'); return; }
    if (!payload.address && !payload.content) { toast('请填写地址或维修内容'); return; }
    // 预约人留空时兜底用当前登录的人，保证详情和通知里一定有联系人
    if (!id && !payload.contact_name) payload.contact_name = state.profile.name || null;

    // 先在本地算一遍（数据都在手上，不用等网络）
    const local = apptConflictNow();
    let force = false;
    if (local && (local.off || local.conflicts.length)) {
      if (local.off && !isAdmin()) {
        toast(local.tech.name + ' 在 ' + dayLabel(local.date) + ' ' + local.slot + ' 休息，不能排单', 4600);
        return;
      }
      const ok = await confirmDialog(local.off ? '这天在休息' : '时间冲突', conflictText(local));
      if (!ok) return;
      force = true;
    }

    const btn = $('[data-act="submit-appt"]');
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }

    const send = async withForce => {
      const body = {
        table: 'appointments',
        action: id ? 'update' : 'insert',
        values: payload,
        filters: id ? [{ op: 'eq', col: 'id', val: Number(id) }] : [],
        force: !!withForce
      };
      return window.__api('/api/db', { method: 'POST', body: JSON.stringify(body) });
    };

    try {
      if (id) payload.updated_at = new Date().toISOString();
      else payload.creator_name = state.profile.name;

      let out;
      try {
        out = await send(force);
      } catch (e) {
        // 服务端兜底拦下了（比如别人刚抢了同一时段），把明细说清楚再决定
        const detail = (e && e.body) || {};
        if (e && e.status === 409 && !force) {
          if (btn) { btn.disabled = false; btn.textContent = '保存'; }
          const ok = await confirmDialog(detail.off ? '这天在休息' : '时间冲突',
            detail.error + (detail.conflicts && detail.conflicts.length
              ? '\n\n已有：' + detail.conflicts.map(c => c.time_slot + ' ' + (c.address || c.project_name || '')).join('，')
              : '') + '\n\n确定要继续吗？');
          if (!ok) return;
          if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
          out = await send(true);
        } else throw e;
      }

      const rows = (out && out.data) || [];
      if (!rows.length) throw new Error('没有权限修改这条预约');
      const created = id ? null : rows[0];
      const savedId = Number(id || (created && created.id) || 0);
      // 附件最后落盘：预约单存下来了才有 id 可以挂
      let attFailed = 0;
      if (savedId && (attPending.length || attRemoved.length)) {
        if (btn) btn.textContent = '上传附件…';
        attFailed = await flushAttachments(savedId);
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
      if (attFailed) toast('有 ' + attFailed + ' 个附件没传上去，可以进「编辑」重试', 4600);
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
    // 邮件：派单给维修工（他有邮箱才发，失败不阻断）。
    // 业主/租客的通知不自动发，由详情里的「通知业主/租客」手动触发。
    await mailAssignment(a).catch(() => false);
  }

  function apptText(a) {
    return [
      '【维修预约】' + (a.status || ''),
      '项目：' + (a.project_name || '未指定'),
      '人员：' + (a.tech_name || '待分配'),
      '时间：' + a.visit_date + ' ' + a.time_slot,
      '地址：' + (a.address || '未填'),
      '事项：' + (a.content || '未填'),
      '预约人：' + [(a.contact_name || ''), (a.contact_phone || '')].join(' ').trim(),
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
     邮件
     · 发信一律交给服务端：账号 / 授权码不下发到浏览器；
     · 服务端可以配多个邮箱服务，某个额度用完会自动换下一个再发；
     · 每一封都写 email_logs，成功失败都能查，便于排查“没收到”。
     ============================================================ */

  const mailCfg = () => {
    const s = state.settings || {};
    return {
      enabled: s.email_enabled === true,
      digestTo: String(s.digest_email || '').trim()
    };
  };
  /**
   * 能不能发信：以服务端 /api/auth/me 的 mail.ready 为准（它知道有几个可用账号）。
   * 管理员还额外拿到账号列表，本地判断一次更及时（刚加完账号不用重登）。
   */
  const mailReady = () => {
    if (state.mail && state.mail.ready) return true;
    return (state.mailAccounts || []).some(a => {
      if (!a.enabled) return false;
      return a.kind === 'emailjs'
        ? !!(a.service_id && a.template_id && a.public_key)
        : !!(a.host && a.user && a.pass_set);
    });
  };
  const mailOn = () => mailCfg().enabled && mailReady();
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

  // 返回 { ok, error }。所有发信都走这里，便于统一处理失败原因
  async function sendMail(opt) {
    if (!mailReady()) return { ok: false, error: '邮件服务未配置' };
    const to = String(opt.to || '').trim();
    if (!isEmail(to)) return { ok: false, error: '收件邮箱格式不对：' + (to || '（空）') };

    // 一律交给服务端发：账号/授权码不下发到浏览器，服务端还会在多个邮箱
    // 之间自动切换（某个额度用完就换下一个），定时任务也用同一套账号。
    try {
      const r = await window.__api('/api/mail/send', {
        method: 'POST',
        body: JSON.stringify({
          to: to,
          toName: opt.toName || '',
          subject: opt.subject || '速派通知',
          html: opt.html || '',
          text: opt.text || '',
          kind: opt.kind || 'other'
        })
      });
      return r && r.ok ? { ok: true, account: r.account } : { ok: false, error: (r && r.error) || '发送失败' };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }; // 服务端已写 email_logs
    }
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
          { k: '维修内容', v: a.content || '待填' },
          { k: '预约人', v: [(a.contact_name || ''), (a.contact_phone || '')].join(' ').trim() },
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

  /* 通知业主/租客：发到新建预约时填的「业主/租客邮箱」，没填就不发 */
  async function mailOwnerNotify(a) {
    if (!mailOn()) return false;
    const to = apptOwnerEmail(a);
    if (!isEmail(to)) return false;
    const when = dayLabel(a.visit_date) + ' ' + (a.time_slot || '');
    const r = await sendMail({
      to: to,
      toName: '',
      subject: '【维修通知】' + when + ' 上门维修',
      kind: 'owner',
      html: mailHtml({
        title: '上门维修已安排',
        badge: when,
        intro: '你好：我们已安排维修人员在上述时间上门，请留意来电。如需改期，请联系下面的对接人。',
        rows: [
          { k: '上门时间', v: when },
          { k: '维修人员', v: a.tech_name || '待安排' },
          { k: '地址', v: a.address || '' },
          { k: '维修事项', v: a.content || '' },
          { k: '项目', v: a.project_name || '' },
          { k: '对接人', v: [(a.contact_name || ''), (a.contact_phone || '')].join(' ').trim() },
          { k: '单号', v: '#' + a.id }
        ],
        tip: '如果这个时间不方便，请提前告知，我们可以改期。',
        foot: '如需改期或取消，直接联系对接人即可。'
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
    if (!mailReady()) return { ok: false, error: '还没配发信邮箱' };
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
        const { data } = await db.from('settings').update({ last_digest_date: dateStr }).select();
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
      case 'new-appt': openApptForm(null); break;
      case 'new-appt-day': state.board.day = el.getAttribute('data-date'); openApptForm(null); break;
      case 'open-appt': {
        const a = state.appointments.filter(x => String(x.id) === String(id))[0];
        if (a) openApptModal(a);
        break;
      }
      case 'edit-appt': {
        const a = state.appointments.filter(x => String(x.id) === String(id))[0];
        if (a) openApptForm(a);
        break;
      }
      case 'submit-appt': saveAppt(el.getAttribute('data-id')); break;
      case 'pick-att': {
        const input = $('#att-input');
        if (input) input.click();
        break;
      }
      case 'rm-att': {
        const savedId = el.getAttribute('data-id');
        const key = el.getAttribute('data-key');
        if (savedId) {
          if (attRemoved.indexOf(Number(savedId)) < 0) attRemoved.push(Number(savedId));
        } else if (key !== null) {
          attPending.splice(Number(key), 1);
        }
        renderAtts();
        break;
      }
      case 'set-status': setStatus(Number(id), el.getAttribute('data-status')); break;
      case 'mark-cancel': setStatus(Number(id), '已取消'); break;
      case 'del-appt': delAppt(Number(id)); break;
      case 'mail-owner': mailFromDetail(id); break;
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
      case 'sel-row': {
        const sid = String(el.getAttribute('data-id'));
        if (el.checked) state.sel[sid] = true; else delete state.sel[sid];
        render(); break;
      }
      case 'sel-all': {
        const ids = sortAppts(state.appointments.filter(apptMatchesFilter)).map(a => String(a.id));
        state.sel = {};
        if (el.checked) ids.forEach(x => { state.sel[x] = true; });
        render(); break;
      }
      case 'sel-clear': state.sel = {}; render(); break;
      case 'sel-invert': {
        const ids = sortAppts(state.appointments.filter(apptMatchesFilter)).map(a => String(a.id));
        const next = {};
        ids.forEach(x => { if (!state.sel[x]) next[x] = true; });
        state.sel = next; render(); break;
      }
      case 'sel-range': {
        const fromEl = $('[data-field="sel-from"]');
        const toEl = $('[data-field="sel-to"]');
        const from = fromEl ? fromEl.value : '';
        const to = toEl ? toEl.value : '';
        if (!from || !to) { toast('先选起止日期'); return; }
        if (from > to) { toast('起始日期不能晚于结束日期'); return; }
        const pick = state.appointments.filter(a => apptMatchesFilter(a) && a.visit_date >= from && a.visit_date <= to);
        if (!pick.length) { toast('这段时间里没有预约单'); return; }
        state.sel = {};
        pick.forEach(a => { state.sel[String(a.id)] = true; });
        render();
        toast('已选中 ' + from + ' 至 ' + to + ' 的 ' + pick.length + ' 条', 3000);
        break;
      }
      case 'sel-delete': batchDeleteAppts(); break;
      case 'sel-status': batchStatusAppts(); break;
      case 'settings-tab': state.settingsTab = el.getAttribute('data-tab'); render(); break;
      case 'logout': doLogout(); break;
      case 'auth-view': e.preventDefault(); state.loginMode = el.getAttribute('data-view') === 'setup' ? 'setup' : 'login'; showAuth(el.getAttribute('data-view')); break;
      case 'wx-login': startWechat(el.getAttribute('data-mode') || 'qr', false); break;
      case 'wx-bind': startWechat(inWeChat() && state.wechat.mp ? 'mp' : 'qr', true); break;
      case 'wx-banner-hide': state.wxBannerHidden = true; render(); break;
      case 'wx-unbind': unbindWechat(); break;
      case 'team-mode': state.teamMode = el.getAttribute('data-mode'); showAuth('team'); break;
      case 'team-refresh': refreshTeamGate(); break;
      case 'team-cancel': cancelTeamRequest(); break;
      case 'team-rename': renameTeam(); break;
      case 'team-code-reset': resetTeamCode(); break;
      case 'copy-team-code': copyText((state.team && state.team.code) || ''); break;
      case 'copy-callback': copyText((state.wxSettings && state.wxSettings.callback) || (location.origin + '/api/auth/wechat/callback')); break;
      case 'req-approve': decideRequest(el.getAttribute('data-id'), true); break;
      case 'req-reject': decideRequest(el.getAttribute('data-id'), false); break;
      case 'admins-role': setMemberRole(el.getAttribute('data-id'), el.getAttribute('data-role')); break;
      case 'transfer-owner': openTransferOwnerModal(); break;
      case 'transfer-owner-do': doTransferOwner(); break;
      case 'member-remove': removeMember(el.getAttribute('data-id')); break;
      case 'team-leave': leaveTeam(); break;
      case 'team-dissolve': dissolveTeam(); break;
      case 'time-off': openTimeOffModal(el.getAttribute('data-id')); break;
      // 维修人员没有「新建预约」，这两个入口都落到自己的排休上
      case 'my-time-off': openTimeOffModal(); break;
      case 'off-day': openTimeOffModal(null, el.getAttribute('data-date')); break;
      case 'save-time-off': saveTimeOff(el.getAttribute('data-id')); break;
      case 'del-time-off': removeTimeOff(el.getAttribute('data-id')); break;
      case 'save-wechat': saveWechatCfg(); break;
      case 'export-json': downloadBackup('json'); break;
      case 'export-db': downloadBackup('db'); break;
      case 'save-auto-backup': saveAutoBackup(); break;
      case 'run-auto-backup': runAutoBackup(); break;
      case 'toggle-auto-backup': toggleAutoBackup(el); break;
      case 'edit-auto-backup': {
        autoEdit = true; autoFlash = '';
        refreshAutoBackupCard();
        const box = $('#auto-backup-email');
        if (box && box.focus) box.focus();
        break;
      }
      case 'cancel-auto-backup': autoEdit = false; autoFlash = ''; refreshAutoBackupCard(); break;
      case 'import-preview': previewImport(); break;
      case 'import-commit': commitImport(el.getAttribute('data-file')); break;
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
      case 'send-email-code': sendMyEmailCode(); break;
      case 'verify-email-code': verifyMyEmail(); break;
      case 'edit-my-email': startEditMyEmail(); break;
      case 'cancel-my-email': state.emailEdit = false; render(); break;
      case 'test-my-email': testMyEmail(); break;
      case 'mail-acc-new': openMailAccountModal(null); break;
      case 'mail-acc-edit': {
        const acc = (state.mailAccounts || []).filter(x => String(x.id) === String(el.getAttribute('data-id')))[0];
        openMailAccountModal(acc || null); break;
      }
      case 'mail-acc-save': saveMailAccount(el.getAttribute('data-id')); break;
      case 'mail-acc-del': delMailAccount(el.getAttribute('data-id')); break;
      case 'mail-acc-test': testMailAccount(el.getAttribute('data-id'), el.getAttribute('data-label')); break;
      case 'mail-acc-preset': {
        const h = $('[data-field="acc_host"]'); const p = $('[data-field="acc_port"]');
        if (h) h.value = el.getAttribute('data-host') || '';
        if (p) p.value = el.getAttribute('data-port') || '465';
        break;
      }
      case 'mail-acc-kind': {
        const k = el.getAttribute('data-kind') === 'emailjs' ? 'emailjs' : 'smtp';
        const wrap = $('#acc-kind');
        if (wrap) wrap.setAttribute('data-kind', k);
        const smtpBox = $('#acc-smtp'), jsBox = $('#acc-emailjs');
        if (smtpBox) smtpBox.style.display = k === 'smtp' ? '' : 'none';
        if (jsBox) jsBox.style.display = k === 'emailjs' ? '' : 'none';
        $$('[data-act="mail-acc-kind"]').forEach(b => {
          b.className = 'btn btn-sm' + (b.getAttribute('data-kind') === k ? ' btn-primary' : '');
        });
        break;
      }
      case 'test-mail': testMail(); break;
      case 'send-digest': sendDigestNow(el); break;
      case 'mail-logs': openMailLogs(); break;
      case 'run-reminders': manualReminders(el); break;
      case 'enable-desktop': enableDesktop(); break;
      case 'change-pin': changeMyPin(); break;
      case 'peek': togglePeek(el); break;
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
      if (state.view === 'list') state.sel = {}; // 换筛选就重新开始选，避免选到看不见的单子
      render();
      return;
    }
    if (t.getAttribute('data-act') === 'team-allow-direct') { setAllowDirect(t.checked); return; }
    if (t.getAttribute('data-act') === 'toggle-notify') { saveNotify(t.checked); return; }
    if (t.getAttribute('data-act') === 'toggle-email') { saveEmail(t.checked); return; }
    if (t.getAttribute('data-act') === 'mail-acc-toggle') { toggleMailAccount(t.getAttribute('data-id'), t.checked); return; }
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
        if (state.view === 'list') state.sel = {};
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
    else if (kind === 'register') submitRegister(f);
    else if (kind === 'profile-setup') submitProfileSetup(f);
    else if (kind === 'team-join') submitTeamJoin(f);
    else if (kind === 'team-create') submitTeamCreate(f);
    else if (kind === 'appt') saveAppt(f.getAttribute('data-id'));
    else if (kind === 'save-me') saveMe(f);
    else if (kind === 'project') saveProject(f);
    else if (kind === 'person') savePerson(f);
  }

  /* ---------- 登录动作（本地账号：姓名 + PIN） ---------- */
  /* ---------- 登录 / 注册 / 团队门动作 ---------- */
  const normCodeInput = v => String(v === null || v === undefined ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');

  async function submitLogin(f) {
    const name = (f.elements.name.value || '').trim();
    const pin = normPin(f.elements.pin.value);
    if (!name) { toast('请填写姓名'); return; }
    if (!pin) { toast('请填写 PIN'); return; }

    const btn = f.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = '登录中…'; }
    const { data, error } = await cloud.auth.signIn(name, pin);
    if (error) {
      if (btn) { btn.disabled = false; btn.textContent = '登录'; }
      try {
        const st = await cloud.auth.status();
        if (st && st.initialized === false) {
          state.loginMode = 'setup';
          showLogin('系统里还没有任何账号，请先创建统筹管理员。');
          return;
        }
      } catch (e) { /* 忽略 */ }
      toast('登录失败：' + (error.message || '请重试'), 3600);
      return;
    }
    await boot();
  }

  async function submitSetup(f) {
    const name = (f.elements.name.value || '').trim();
    const phone = (f.elements.phone ? String(f.elements.phone.value || '') : '').trim();
    const teamName = (f.elements.teamName ? String(f.elements.teamName.value || '') : '').trim();
    const pin = normPin(f.elements.pin.value);
    const pin2 = normPin(f.elements.pin2.value);
    if (!name) { toast('请填写姓名'); return; }
    const pe = pinError(pin);
    if (pe) { toast(pe); return; }
    if (pin !== pin2) { toast('两次输入的 PIN 不一致'); return; }
    if (phone) { const ph = phoneError(phone); if (ph) { toast(ph); return; } }

    const btn = f.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = '创建中…'; }
    const { data, error } = await cloud.auth.setup(name, pin, phone, teamName);
    if (error) {
      if (btn) { btn.disabled = false; btn.textContent = '创建团队并进入'; }
      toast('创建失败：' + (error.message || '请重试'), 4200);
      return;
    }
    state.loginMode = 'login';
    await boot();
    toast('欢迎，' + name + '。你是统筹管理员', 3200);
    if (data && data.team) setTimeout(() => toast('团队码 ' + data.team.code + '，发给同事即可加入', 5200), 1600);
  }

  async function submitRegister(f) {
    const name = (f.elements.name.value || '').trim();
    const phone = (f.elements.phone ? String(f.elements.phone.value || '') : '').trim();
    const pin = normPin(f.elements.pin.value);
    const pin2 = normPin(f.elements.pin2.value);
    if (!name) { toast('请填写姓名'); return; }
    const pe = pinError(pin);
    if (pe) { toast(pe); return; }
    if (pin !== pin2) { toast('两次输入的 PIN 不一致'); return; }
    if (phone) { const ph = phoneError(phone); if (ph) { toast(ph); return; } }

    const btn = f.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = '注册中…'; }
    const { error } = await cloud.auth.register(name, pin, phone);
    if (error) {
      if (btn) { btn.disabled = false; btn.textContent = '注册'; }
      toast('注册失败：' + (error.message || '请重试'), 4200);
      return;
    }
    await boot();
    toast('注册成功，接着用团队码申请加入', 3600);
  }

  /** 微信账号补资料：姓名 + 手机号，必须填完 */
  async function submitProfileSetup(f) {
    const name = (f.elements.name.value || '').trim();
    const phone = (f.elements.phone.value || '').trim();
    if (!name) { toast('请填写姓名'); return; }
    const ph = phoneError(phone);
    if (ph) { toast(ph); return; }
    const btn = f.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    const { data, error } = await cloud.auth.updateProfile(name, phone);
    if (error) {
      if (btn) { btn.disabled = false; btn.textContent = '保存并继续'; }
      toast('保存失败：' + (error.message || '请重试'), 4200);
      return;
    }
    if (data && data.user) state.user = data.user;
    await boot();
    toast('资料已补全');
  }

  async function submitTeamJoin(f) {
    const code = normCodeInput(f.elements.code.value);
    const message = (f.elements.message ? String(f.elements.message.value || '') : '').trim();
    if (!code) { toast('请填写团队码'); return; }
    if (code.length !== 9) { toast('团队码是 3 位字母 + 6 位数字，共 9 位'); return; }
    const btn = f.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = '提交中…'; }
    try {
      const out = await window.__api('/api/team/join', { method: 'POST', body: JSON.stringify({ code, message }) });
      if (out && out.joined) {
        await boot();
        toast('已加入「' + (out.team ? out.team.name : '团队') + '」');
        return;
      }
      state.pending = { team_name: out.team ? out.team.name : '', team_code: out.team ? out.team.code : '' };
      showAuth('pending');
      toast('申请已提交，等管理员同意');
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = '提交申请'; }
      toast('加入失败：' + e.message, 4200);
    }
  }

  async function submitTeamCreate(f) {
    const name = (f.elements.name.value || '').trim();
    if (name.length < 2) { toast('团队名称至少 2 个字'); return; }
    const btn = f.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = '创建中…'; }
    try {
      const out = await window.__api('/api/team/create', { method: 'POST', body: JSON.stringify({ name }) });
      await boot();
      const code = out && out.team ? out.team.code : '';
      toast('团队已创建' + (code ? '，团队码 ' + code : ''), 4600);
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = '创建团队'; }
      toast('创建失败：' + e.message, 4200);
    }
  }

  async function refreshTeamGate() {
    try {
      const me = await window.__api('/api/auth/me');
      state.pending = me.pending || null;
      if (me.user && me.user.team_id) { await boot(); return; }
      if (!state.pending) { showAuth('team', '申请已经不在了，重新输入团队码试试'); return; }
      showAuth('pending');
      toast('还没通过，稍后再试或催一下管理员');
    } catch (e) { toast('刷新失败：' + e.message); }
  }

  async function cancelTeamRequest() {
    try {
      await window.__api('/api/team/cancel', { method: 'POST', body: '{}' });
      state.pending = null;
      showAuth('team', '申请已撤回', true);
    } catch (e) { toast(e.message); }
  }

  async function unbindWechat() {
    const ok = await confirmDialog('解除微信绑定', '解除后就不能用微信一键登录了，仍然可以用姓名 + PIN 登录。');
    if (!ok) return;
    try {
      await window.__api('/api/auth/wechat/unbind', { method: 'POST', body: '{}' });
      await loadAll(); render();
      toast('已解除绑定');
    } catch (e) { toast('解绑失败：' + e.message); }
  }

  /* ---------- 团队管理动作 ---------- */
  async function teamPost(path, body) {
    return window.__api(path, { method: 'POST', body: JSON.stringify(body || {}) });
  }

  async function decideRequest(id, approve) {
    try {
      const r = await teamPost('/api/team/requests/decide', { id: Number(id), approve: !!approve });
      await loadAll(); render();
      if (!r.approved) toast('已拒绝');
      else if (r.merged) toast('已同意，并合并到同名成员「' + r.merged + '」的历史记录', 3600);
      else toast('已同意，对方刷新就能进来');
    } catch (e) { toast('操作失败：' + e.message, 4200); }
  }

  async function setMemberRole(id, role) {
    const label = role === 'admin' ? '设为管理员' : '取消管理员';
    const ok = await confirmDialog(label, role === 'admin'
      ? '设为管理员后，对方能审批入团申请、管理项目/人员/排期和通知，也能任免其他管理员（统筹管理员除外）。'
      : '取消后对方变回普通成员：能看排期、提预约、改状态，不能再管项目和人员。');
    if (!ok) return;
    try {
      await teamPost('/api/team/members/role', { id, role });
      await loadAll(); render();
      toast('已' + label);
    } catch (e) { toast('操作失败：' + e.message, 4200); }
  }

  async function doTransferOwner() {
    const toEl = $('[data-field="transfer-to"]');
    const pinEl = $('[data-field="transfer-pin"]');
    const cfEl = $('[data-field="transfer-confirm"]');
    const id = toEl ? toEl.value : '';
    const pin = pinEl ? String(pinEl.value || '').trim() : '';
    const typed = cfEl ? String(cfEl.value || '').trim() : '';
    if (!id) { toast('先选一个接手的人'); return; }
    if (!pin) { toast('请输入你的登录 PIN'); return; }
    if (typed !== '确认') { toast('请手动输入「确认」两个字（原样，不要多字）'); return; }
    try {
      await teamPost('/api/team/owner', { id, pin, confirm: typed });
      closeModal();
      await boot(); // 自己变成管理员，权限和菜单都要重算
      toast('已转让，你现在是管理员');
    } catch (e) { toast('转让失败：' + e.message, 5200); }
  }

  async function removeMember(id) {
    const p = profileById(id);
    const ok = await confirmDialog('移出团队', '「' + (p ? p.name : id) + '」会离开团队，看不到团队数据。他的预约单会留在团队里。');
    if (!ok) return;
    try {
      await teamPost('/api/team/members/remove', { id });
      await loadAll(); render();
      toast('已移出');
    } catch (e) { toast('移除失败：' + e.message, 4200); }
  }

  async function leaveTeam() {
    const ok = await confirmDialog('退出团队', '退出后你就看不到这个团队的数据了，需要用团队码重新申请才能回来。');
    if (!ok) return;
    try {
      await teamPost('/api/team/leave');
      await boot();
    } catch (e) { toast('退出失败：' + e.message, 4200); }
  }

  async function dissolveTeam() {
    const name = (state.team && state.team.name) || '';
    const ok = await confirmDialog('解散团队', '这会删除「' + name + '」的全部预约、项目、人员和设置，且无法恢复。\n建议先去「数据备份」导出。确定解散吗？');
    if (!ok) return;
    const typed = window.prompt('输入团队名称以确认解散：' + name);
    if (typed === null) return;
    try {
      await teamPost('/api/team/dissolve', { name: typed });
      await boot();
      toast('团队已解散');
    } catch (e) { toast('解散失败：' + e.message, 4600); }
  }

  async function renameTeam() {
    const cur = (state.team && state.team.name) || '';
    const name = window.prompt('团队名称', cur);
    if (!name || name.trim() === cur) return;
    try {
      await teamPost('/api/team/rename', { name: name.trim() });
      state.team.name = name.trim();
      render();
      toast('已改名');
    } catch (e) { toast('改名失败：' + e.message, 4200); }
  }

  async function resetTeamCode() {
    const ok = await confirmDialog('重置团队码', '重置后旧团队码立刻失效，已经发出去的码就加不进来了。确定吗？');
    if (!ok) return;
    try {
      const r = await teamPost('/api/team/code/reset');
      if (state.team) state.team.code = r.code;
      render();
      toast('新团队码：' + r.code, 6000);
    } catch (e) { toast('重置失败：' + e.message, 4200); }
  }

  async function setAllowDirect(allow) {
    try {
      await teamPost('/api/team/allow-direct', { allow: !!allow });
      if (state.team) state.team.allow_direct = !!allow;
      render();
      toast(allow ? '已开启：有团队码就能直接加入' : '已关闭：需要管理员审批');
    } catch (e) {
      toast('保存失败：' + e.message, 4200);
      await loadAll(); render();
    }
  }

  async function saveWechatCfg() {
    const val = id => { const el = $('#' + id); return el ? el.value.trim() : ''; };
    const payload = {
      wx_mp_appid: val('wx-mp-appid'),
      wx_mp_secret: val('wx-mp-secret'),
      wx_qr_appid: val('wx-qr-appid'),
      wx_qr_secret: val('wx-qr-secret')
    };
    try {
      const r = await teamPost('/api/settings/wechat', payload);
      state.wechat = r.enabled || state.wechat;
      await loadAll(); render();
      toast('微信登录配置已保存');
    } catch (e) { toast('保存失败：' + e.message, 4200); }
  }

  /* ---------- 休息日 ---------- */
  const offPartSelect = (id, val) => '<select class="select" id="' + id + '">' +
    ['全天', '上午', '下午'].map(x =>
      '<option' + (x === (val || '全天') ? ' selected' : '') + '>' + x + '</option>').join('') +
    '</select>';

  /* 排休：维修人员只能一天一天排（当天选全天 / 上午 / 下午）；
     管理员按区间排（从某天上午/下午 到 某天上午/下午） */
  function openTimeOffModal(profileId, day) {
    const p = profileById(profileId) || state.profile;
    const t = day || todayStr();
    const list = upcomingOff(p.id);
    const admin = isAdmin();
    const partLabel = o => (o.part && o.part !== '全天' ? ' ' + o.part : '');
    const rows = list.map(o =>
      '<div class="list-row">' +
        '<div class="grow"><div class="nm">' + esc(o.off_date) + esc(partLabel(o)) + (o.reason ? ' <span class="hint">' + esc(o.reason) + '</span>' : '') + '</div></div>' +
        '<button class="btn btn-sm btn-danger" data-act="del-time-off" data-id="' + o.id + '">取消</button>' +
      '</div>').join('');

    const single =
      '<div class="form-row">' +
        '<div class="field"><label>日期</label><input class="input" type="date" id="off-date" value="' + esc(t) + '"></div>' +
        '<div class="field"><label>时段</label>' + offPartSelect('off-part', '全天') + '</div>' +
      '</div>';

    const range =
      '<div class="form-row">' +
        '<div class="field"><label>从</label><input class="input" type="date" id="off-from" value="' + esc(t) + '"></div>' +
        '<div class="field"><label>起始时段</label>' + offPartSelect('off-part-from', '全天') + '</div>' +
      '</div>' +
      '<div class="form-row">' +
        '<div class="field"><label>到</label><input class="input" type="date" id="off-to" value="' + esc(t) + '"></div>' +
        '<div class="field"><label>结束时段</label>' + offPartSelect('off-part-to', '全天') + '</div>' +
      '</div>';

    const tip = admin
      ? '休息日里不会被排进预约单，日历上会标出来。可以排一段：起始日选「下午」那天上午还照常上班，结束日选「上午」那天下午就回来上班。'
      : '休息日里不会被排进预约单，日历上会标出来。一天一天排，选「上午 / 下午」只空出半天，另一半天照常可以排单。';

    openModal(modalShell('设置休息 · ' + p.name,
      (admin ? range : single) +
      '<div class="field"><label>原因（选填）</label><input class="input" id="off-reason" maxlength="30" placeholder="如：调休 / 病假 / 年假"></div>' +
      '<p class="hint" style="margin:-4px 0 12px">' + tip + '</p>' +
      (rows ? '<div class="group-title">已排的休息日<span class="count">' + list.length + ' 天</span></div>' + rows : ''),
      '<button class="btn" data-act="close-modal">关闭</button>' +
      '<button class="btn btn-primary" data-act="save-time-off" data-id="' + esc(p.id) + '">保存</button>'
    ));
  }

  async function saveTimeOff(profileId) {
    const reason = ($('#off-reason') || {}).value || '';
    let payload;
    if (isAdmin()) {
      // 管理员：从某天的某个时段，到某天的某个时段
      const from = ($('#off-from') || {}).value;
      const to = ($('#off-to') || {}).value || from;
      const part = ($('#off-part-from') || {}).value || '全天';
      const endPart = ($('#off-part-to') || {}).value || part;
      if (!from) { toast('请选择开始日期'); return; }
      if (to < from) { toast('结束日期不能早于开始日期'); return; }
      if (from === to && part === '下午' && endPart === '上午') { toast('同一天里结束时段不能早于开始时段'); return; }
      payload = { profile_id: profileId, from, to, reason, part, end_part: endPart };
    } else {
      // 维修人员：一次只排一天
      const d = ($('#off-date') || {}).value;
      const part = ($('#off-part') || {}).value || '全天';
      if (!d) { toast('请选择日期'); return; }
      payload = { profile_id: profileId, from: d, to: d, reason, part, end_part: part };
    }
    try {
      const r = await teamPost('/api/schedule/time-off', payload);
      closeModal();
      await loadAll(); render();
      if (!r.added && !r.merged) { toast('这几天本来就排了休息'); return; }
      if (payload.from === payload.to) {
        toast((r.added ? '已排休 ' : '已改成全天 ') + dayLabel(payload.from) + (r.added && r.part !== '全天' ? ' ' + r.part : ''));
      } else {
        toast('已排休 ' + r.days + ' 天：' + dayLabel(payload.from) + ' ' + r.part + ' → ' + dayLabel(payload.to) + ' ' + r.end_part +
          (r.added < r.days ? '（其余已经排过）' : ''), 4600);
      }
    } catch (e) { toast('排休失败：' + e.message, 4200); }
  }

  async function removeTimeOff(id) {
    try {
      await teamPost('/api/schedule/time-off/remove', { id: Number(id) });
      await loadAll();
      render();
      toast('已取消这天的休息');
    } catch (e) { toast('取消失败：' + e.message, 4200); }
  }

  /* ---------- 备份 / 导入 ---------- */
  let pendingImportFile = null;

  async function downloadBackup(fmt) {
    toast('正在打包…');
    try {
      const res = await fetch('/api/backup/export?format=' + fmt, {
        headers: { Authorization: 'Bearer ' + window.__auth.getToken() }
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error((j && j.error) || ('HTTP ' + res.status));
      }
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') || '';
      const m = cd.match(/filename\*=UTF-8''([^;]+)/);
      const name = m ? decodeURIComponent(m[1]) : ('速派备份.' + (fmt === 'db' ? 'db' : 'json'));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      toast('已下载 ' + name);
    } catch (e) { toast('导出失败：' + e.message, 4600); }
  }

  /* 自动备份：每天定时把团队备份发到指定邮箱 */
  function autoBackupForm() {
    const emailEl = $('#auto-backup-email');
    if (!emailEl) return null;   // 读态没有表单
    return {
      email: String(emailEl.value || '').trim(),
      hour: Number(($('#auto-backup-hour') || {}).value || 3),
      full: !!($('#auto-backup-full') || {}).checked
    };
  }

  async function saveAutoBackup() {
    const f = autoBackupForm();
    if (!f) { autoEdit = true; refreshAutoBackupCard(); return; }
    if (!f.email) { toast('请先填一个收件邮箱'); return; }

    const st = state.settings || {};
    // 第一次填邮箱（之前是空的）就顺手打开，省得用户再点一次开关
    const firstTime = !String(st.backup_email || '').trim();
    const enabled = firstTime ? true : Number(st.auto_backup) === 1;

    const btn = $('[data-act="save-auto-backup"]');
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    try {
      const r = await window.__api('/api/backup/auto', {
        method: 'POST',
        body: JSON.stringify({ enabled: enabled, email: f.email, hour: f.hour, full: f.full })
      });
      await loadAll();
      autoEdit = false;
      autoFlash = enabled
        ? '已保存并生效：每天 ' + hhmm(Number(r.hour)) + ' 自动备份到 ' + String(r.email || f.email).split(',').join('、')
        : '已保存。自动备份现在是关闭的，打开右上角开关就会按时发。';
      refreshAutoBackupCard();
      toast(enabled ? '已保存并开启' : '已保存', 3200);
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = '保存'; }
      toast('保存失败：' + e.message, 4600);
    }
  }

  async function toggleAutoBackup(input) {
    const st = state.settings || {};
    const email = String(st.backup_email || '').trim();
    const want = !!(input && input.checked);

    // 还没配邮箱：别让开关空转，直接把人带到表单里
    if (!email) {
      if (input) input.checked = false;
      autoEdit = true; autoFlash = '';
      refreshAutoBackupCard();
      toast('先填一个收件邮箱，再打开自动备份');
      return;
    }

    if (input) input.disabled = true;
    try {
      await window.__api('/api/backup/auto', {
        method: 'POST',
        body: JSON.stringify({ enabled: want, email: email, hour: autoHourOf(st), full: Number(st.backup_full) === 1 })
      });
      await loadAll();
      autoFlash = want
        ? '已开启：每天 ' + hhmm(autoHourOf(state.settings || {})) + ' 自动备份到 ' + email.split(',').join('、')
        : '已关闭自动备份。邮箱和时间都留着，随时可以再打开。';
      refreshAutoBackupCard();
      toast(want ? '自动备份已开启' : '自动备份已关闭');
    } catch (e) {
      if (input) { input.checked = !want; input.disabled = false; }
      toast('切换失败：' + e.message, 4600);
    }
  }

  async function runAutoBackup() {
    const st = state.settings || {};
    const email = String(st.backup_email || '').trim();
    if (!email) {
      autoEdit = true; autoFlash = '';
      refreshAutoBackupCard();
      toast('先填收件邮箱再发');
      return;
    }
    const btn = $('[data-act="run-auto-backup"]');
    if (btn) { btn.disabled = true; btn.textContent = '发送中…'; }
    toast('正在打包并发送，稍等…', 3000);
    try {
      const r = await window.__api('/api/backup/auto/run', { method: 'POST', body: '{}' });
      await loadAll();
      autoFlash = '已发送：' + (r.note || '备份邮件已发出');
      refreshAutoBackupCard();
      toast(r.note || '已发送', 6000);
    } catch (e) {
      await loadAll();
      refreshAutoBackupCard();
      if (btn) { btn.disabled = false; btn.textContent = '立即备份一次'; }
      toast('备份失败：' + e.message, 8000);
    }
  }

  async function previewImport() {
    const input = $('#import-file');
    const file = input && input.files && input.files[0];
    const out = $('#import-result');
    if (!file) { toast('先选一个文件'); return; }
    if (file.size > 64 * 1024 * 1024) { toast('文件太大，单次最多 64MB'); return; }
    pendingImportFile = file;
    if (out) out.innerHTML = '<p class="hint">正在解析 ' + esc(file.name) + '…</p>';
    try {
      const res = await fetch('/api/backup/import?filename=' + encodeURIComponent(file.name) + '&dry=1', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + window.__auth.getToken() },
        body: file
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error((j && j.error) || ('HTTP ' + res.status));
      if (out) out.innerHTML = importReportHtml(j, file.name);
    } catch (e) {
      pendingImportFile = null;
      if (out) out.innerHTML = '<div class="notice notice-warn">解析失败：' + esc(e.message) + '</div>';
    }
  }

  function importReportHtml(r, filename) {
    const head = '<div class="notice" style="margin-bottom:12px"><b>' + esc(filename) + '</b> 解析结果</div>';
    if (r.kind === 'db') {
      const mb = (r.size / 1024 / 1024).toFixed(2);
      return head +
        '<div class="kv"><span>类型</span><b>SQLite 整库文件（' + mb + ' MB）</b></div>' +
        '<div class="notice notice-warn" style="margin:12px 0">整库恢复会覆盖服务器上<b>所有团队</b>的数据，恢复前会自动备份当前库。恢复后需要重新登录。</div>' +
        '<button class="btn btn-primary btn-sm" data-act="import-commit" data-file="' + esc(filename) + '">确认整库恢复</button>';
    }
    const rows = [];
    if (r.kind === 'appointments') {
      rows.push(['总行数', r.total], ['将新增', r.add], ['重复跳过', r.skip], ['认不出日期', r.bad]);
    } else if (r.kind === 'profiles') {
      rows.push(['总行数', r.total], ['将新增', r.add], ['将更新', r.update], ['跳过', r.bad]);
    } else if (r.kind === 'json') {
      return head +
        '<div class="kv"><span>人员</span><b>新增 ' + r.profiles.add + ' · 更新 ' + r.profiles.update + '</b></div>' +
        '<div class="kv"><span>项目</span><b>新增 ' + r.projects.add + ' · 更新 ' + r.projects.update + '</b></div>' +
        '<div class="kv"><span>预约单</span><b>新增 ' + (r.appointments ? r.appointments.add : 0) + ' · 跳过 ' + (r.appointments ? r.appointments.skip : 0) + '</b></div>' +
        '<div class="notice" style="margin:12px 0">JSON 是合并导入：不会删除现有数据，同名的人和项目会更新。</div>' +
        '<button class="btn btn-primary btn-sm" data-act="import-commit" data-file="' + esc(filename) + '">确认导入</button>';
    } else {
      return head + '<div class="notice notice-warn">认不出这个表格，检查一下表头。</div>';
    }

    const table = '<table class="tbl" style="margin:10px 0"><tbody>' +
      rows.map(x => '<tr><td style="width:180px;color:var(--text-2)">' + esc(x[0]) + '</td><td><b>' + esc(String(x[1])) + '</b></td></tr>').join('') +
      '</tbody></table>';

    const sample = (r.sample && r.sample.length)
      ? '<div class="group-title">前几行预览</div><div class="table-wrap"><table class="tbl"><thead><tr>' +
          Object.keys(r.sample[0]).map(k => '<th>' + esc(k) + '</th>').join('') + '</tr></thead><tbody>' +
          r.sample.map(row => '<tr>' + Object.keys(r.sample[0]).map(k => '<td>' + esc(row[k] || '') + '</td>').join('') + '</tr>').join('') +
        '</tbody></table></div>'
      : '';

    const errs = (r.errorRows && r.errorRows.length)
      ? '<div class="notice notice-warn" style="margin-top:10px">有 ' + r.bad + ' 行没能导入：<br>' +
        r.errorRows.map(e => '· 第 ' + e.row + ' 行：' + esc(e.why)).join('<br>') + '</div>'
      : '';

    const created = [];
    if (r.created) {
      if (r.created.projects && r.created.projects.length) created.push('新项目：' + r.created.projects.join('、'));
      if (r.created.techs && r.created.techs.length) created.push('新人员：' + r.created.techs.join('、'));
    }

    return head + table + sample + errs +
      (created.length ? '<p class="hint">' + esc(created.join('；')) + '（确认后自动建档）</p>' : '') +
      ((r.add || r.update) ? '<button class="btn btn-primary btn-sm" data-act="import-commit" data-file="' + esc(filename) + '">确认导入</button>' : '<p class="hint">没有可导入的新内容。</p>');
  }

  async function commitImport(filename) {
    const file = pendingImportFile;
    const out = $('#import-result');
    if (!file) { toast('文件已失效，请重新选择'); return; }
    const isDb = /\.(db|sqlite|sqlite3)$/i.test(filename);
    if (isDb) {
      const ok = await confirmDialog('整库恢复', '这会用上传的文件覆盖服务器上的全部数据（所有团队）。\n系统会先自动备份当前库。确定继续吗？');
      if (!ok) return;
    }
    if (out) out.innerHTML = '<p class="hint">正在写入…</p>';
    try {
      const res = await fetch('/api/backup/import?filename=' + encodeURIComponent(filename) + '&dry=0', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + window.__auth.getToken() },
        body: file
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error((j && j.error) || ('HTTP ' + res.status));
      pendingImportFile = null;
      const input = $('#import-file');
      if (input) input.value = '';

      if (j.kind === 'db') {
        alert('整库恢复完成。当前登录状态可能失效，请重新登录。\n恢复前的备份：' + j.backup);
        try { await cloud.auth.signOut(); } catch (e) { /* ignore */ }
        location.reload();
        return;
      }
      await loadAll();
      render();
      toast('导入完成', 3200);
      if ($('#import-result')) {
        $('#import-result').innerHTML = '<div class="notice">导入完成：' +
          (j.kind === 'appointments' ? '新增 ' + j.add + ' 条预约，跳过 ' + j.skip + ' 条'
            : j.kind === 'profiles' ? '新增 ' + j.add + ' 人，更新 ' + j.update + ' 人'
              : '人员 +' + j.profiles.add + '，项目 +' + j.projects.add + '，预约 +' + (j.appointments ? j.appointments.add : 0)) +
          '</div>';
      }
    } catch (e) {
      if (out) out.innerHTML = '<div class="notice notice-warn">导入失败：' + esc(e.message) + '</div>';
      else toast('导入失败：' + e.message, 4600);
    }
  }

    async function doLogout() {
    try { await cloud.auth.signOut(); } catch (e) { /* ignore */ }
    state.session = null; state.user = null; state.uid = null; state.profile = null;
    state.team = null; state.pending = null; state.teamRequests = []; state.wxSettings = null;
    state.timeOff = []; state.appointments = []; state.profiles = [];
    state.notifications = []; state.lastNotifId = 0;
    if (state.pollTimer) clearInterval(state.pollTimer);
    showLogin('已退出登录', true);
  }

  /* ---------- 预约动作 ---------- */
  async function setStatus(id, status) {
    const a = state.appointments.filter(x => Number(x.id) === Number(id))[0];
    if (!a) return;
    if (status === '已取消') {
      const caps = apptCaps(a);
      const ok = caps.canCancel
        ? await confirmDialog('取消这条预约', '取消后维修人员会收到通知，这条单也不再出现在排期里。确定取消吗？')
        : await confirmDialog('标记为取消', '标记后这条预约会显示为「已取消」，预约人会收到通知。');
      if (!ok) return;
    }
    // updated_at / 改动人由服务端盖章，前端不用传
    const { data, error } = await db.from('appointments').update({ status: status }).eq('id', id).select();
    if (error) { toast('操作失败：' + (error.message || '')); return; }
    if (!data || !data.length) { toast('没有权限修改这条预约'); return; }
    closeModal();
    const updated = Object.assign({}, a, data[0]);
    await loadAll(); render();
    toast('已标记为' + status);
    // 维修人员（或管理员）替别人改状态时，主动告诉预约人一声
    notifyStatusChange(updated, status).catch(() => false);
  }

  /** 状态改动通知预约人：站内通知 + 微信（有 token）+ 邮件（设置里填了邮箱才发） */
  async function notifyStatusChange(a, status) {
    if (!a || String(a.owner_id || '') === String(state.uid || '')) return false;
    const p = a.owner_id ? profileById(a.owner_id) : null;
    const when = dayLabel(a.visit_date) + ' ' + (a.time_slot || '');
    const title = '预约「' + (a.address || '#' + a.id) + '」已' + status;
    const text = apptText(Object.assign({}, a, { status: status }));
    if (p && p.user_id) {
      try {
        await db.from('notifications').insert({
          owner_id: p.user_id,
          appointment_id: Number(a.id),
          title: title,
          body: text
        });
      } catch (e) { /* 通知失败不阻断 */ }
    }
    if (p && p.push_token) pushWeChat(p.push_token, title, when, appLink());
    const to = p && isEmail(p.email) ? String(p.email).trim() : '';
    if (to && mailOn()) {
      await sendMail({
        to: to,
        toName: p.name || '',
        subject: '【预约' + status + '】' + when,
        kind: 'status',
        html: mailHtml({
          title: '预约状态：' + status,
          badge: when,
          intro: (p.name ? p.name + '，' : '') + '你预约的这条维修单状态更新为「' + status + '」。',
          rows: [
            { k: '项目', v: a.project_name || '' },
            { k: '维修人员', v: a.tech_name || '' },
            { k: '上门时间', v: when },
            { k: '地址', v: a.address || '' },
            { k: '维修内容', v: a.content || '' },
            { k: '单号', v: '#' + a.id }
          ],
          action: { text: '打开速派看详情', url: appLink() }
        })
      }).catch(() => false);
    }
    return true;
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

  /* 详情里的「通知业主/租客」：没填业主/租客邮箱就直接提示，不硬发 */
  async function mailFromDetail(id) {
    const a = state.appointments.filter(x => String(x.id) === String(id))[0];
    if (!a) return;
    const to = apptOwnerEmail(a);
    if (!isEmail(to)) { toast('未填写业主/租客邮箱', 4000); return; }
    if (!mailReady()) { toast('邮件还没配置，去 设置 → 通知 里填邮箱账号和授权码'); return; }
    toast('正在发送…');
    const ok = await mailOwnerNotify(a).catch(() => false);
    if (ok) { toast('已通知 ' + to); return; }
    toast('没发出去：邮件配置可能有误，可在「发送记录」里看具体原因', 5000);
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
    // 创建人只给管理员导出（其他人看不到这一列）
    const withCreator = isAdmin();
    const head = ['日期', '时段', '项目', '维修人员', '地址', '维修内容', '预约人', '预约人电话', '状态', '优先级', '备注'].concat(withCreator ? ['创建人'] : []);
    const rows = list.map(a => [a.visit_date, a.time_slot, a.project_name, a.tech_name, a.address, a.content, a.contact_name, a.contact_phone, a.status, a.priority, a.note].concat(withCreator ? [a.creator_name] : []));
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
    if (!res.data || !res.data.length) { toast('没有权限，只有管理员能管理项目'); return; }
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
    // 岗位身份只分「维修人员 / 预约人」；团队里的管理员身份在「设置 → 管理员」里设。
    // 老数据里 role='admin' 的人保留原值（置灰不能再选），避免编辑手机号时被悄悄改掉。
    const legacyAdmin = !!p && p.role === 'admin';
    const preRole = p && p.role === 'requester' ? 'requester' : 'tech';
    openModal(modalShell(p ? '编辑人员' : '添加人员',
      '<form data-form="person" data-id="' + (p ? esc(p.id) : '') + '">' +
        '<div class="form-row">' +
          '<div class="field"><label>姓名</label><input class="input" name="name" value="' + esc(p ? p.name : '') + '" required maxlength="20"></div>' +
          '<div class="field"><label>手机号</label><input class="input" name="phone" type="tel" value="' + esc(p ? p.phone || '' : '') + '" maxlength="20"></div>' +
        '</div>' +
        '<div class="field"><label>邮箱（选填）</label><input class="input" type="email" name="email" value="' + esc(p ? p.email || '' : '') + '" placeholder="派单和出发提醒会发到这里"></div>' +
        '<div class="field"><label>登录 PIN' + (p ? '（留空则不修改）' : '（至少 4 位）') + '</label><input class="input" name="pin" type="text"' + PIN_ATTRS + ' value="" placeholder="' + (p ? '重设 PIN 时填这里' : '员工用姓名 + PIN 登录') + '">' +
          '<div class="hint">' + PIN_TIP + (p ? '；留空保持原 PIN 不变' : '；留空则用默认 PIN：1234') + '</div></div>' +
        '<div class="field"><label>岗位身份</label><select class="select" name="role">' +
          (legacyAdmin ? '<option value="admin" selected disabled>管理员（旧身份）</option>' : '') +
          ['tech', 'requester'].map(r => '<option value="' + r + '"' + (!legacyAdmin && preRole === r ? ' selected' : '') + '>' + ROLE_LABEL[r] + '</option>').join('') +
        '</select><div class="hint">决定他会不会出现在派单下拉里。<b>管理员身份不在这里设</b>，去「设置 → 管理员」。</div></div>' +
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
    if (pin) { const pe = pinError(pin); if (pe) { toast(pe); return; } }
    const phoneRaw = (f.elements.phone.value || '').trim();
    if (phoneRaw) { const ph = phoneError(phoneRaw); if (ph) { toast(ph); return; } }
    const payload = {
      name: name,
      phone: phoneRaw ? normPhone(phoneRaw) : null,
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

  /* ---------- 预约单批量操作 ---------- */
  async function batchDeleteAppts() {
    const ids = selectedVisibleIds();
    if (!ids.length) { toast('先勾选要删的预约单'); return; }
    const ok = await confirmDialog('删除 ' + ids.length + ' 条预约',
      '删掉就找不回来了（可以先用「导出 CSV」留一份）。只能删自己创建的，管理员可以删本团队的；没权限的会被跳过。');
    if (!ok) return;
    let done = 0, fail = 0;
    for (const id of ids) {
      const { data, error } = await db.from('appointments').delete().eq('id', id).select();
      if (error || !data || !data.length) fail++;
      else done++;
    }
    state.sel = {};
    await loadAll(); render();
    toast('已删除 ' + done + ' 条' + (fail ? '，' + fail + ' 条没权限或已不存在' : ''), 3600);
  }

  async function batchStatusAppts() {
    const ids = selectedVisibleIds();
    if (!ids.length) { toast('先勾选要改的预约单'); return; }
    const sel = $('[data-field="sel-status"]');
    const status = sel ? sel.value : '';
    if (STATUSES.indexOf(status) < 0) { toast('请选择一个状态'); return; }
    let done = 0, fail = 0;
    for (const id of ids) {
      const { data, error } = await db.from('appointments').update({ status: status }).eq('id', id).select();
      if (error || !data || !data.length) fail++;
      else done++;
    }
    state.sel = {};
    await loadAll(); render();
    toast('已把 ' + done + ' 条改成「' + status + '」' + (fail ? '，' + fail + ' 条失败' : ''), 3200);
  }

  async function saveNotify(forceEnabled) {
    const el = $('[data-field="pushplus_token"]');
    const enabled = typeof forceEnabled === 'boolean'
      ? forceEnabled
      : ($('[data-act="toggle-notify"]') ? $('[data-act="toggle-notify"]').checked : true);
    const payload = { notify_enabled: enabled, updated_at: new Date().toISOString() };
    if (el) payload.pushplus_token = el.value.trim() || null;
    const { data, error } = await db.from('settings').update(payload).select();
    if (error) { toast('保存失败：' + (error.message || '')); return; }
    if (!data || !data.length) { toast('没有权限，只有管理员能改团队通知设置'); return; }
    state.settings = data[0];
    toast('通知设置已保存');
  }

  async function saveMyPush() {
    const el = $('[data-field="my_push_token"]');
    const em = $('[data-field="my_email"]');
    if (!el && !em) return;
    const token = el ? (el.value.trim() || null) : (state.profile.push_token || null);
    const typed = em ? em.value.trim() : '';
    if (typed && !isEmail(typed)) { toast('邮箱格式不对：' + typed); return; }
    // 邮箱只在真的改了的时候才提交（改了要重新验证，别让「保存」把已验证状态清掉）
    const patch = { push_token: token };
    const emailChanged = typed && typed.toLowerCase() !== String(state.profile.email || '').toLowerCase();
    if (emailChanged) patch.email = typed;
    const { data, error } = await db.from('profiles').update(patch).eq('id', state.profile.id).select();
    if (error) { toast('保存失败：' + (error.message || '')); return; }
    if (!data || !data.length) { toast('保存失败'); return; }
    state.profile = data[0];
    await loadAll(); render();
    if (emailChanged) { toast('邮箱已保存，点「发送验证码」验证一下才算生效'); return; }
    toast(token ? '已保存，之后微信也会推给你' : (state.profile.email ? '已保存' : '已清空，不会再主动通知你'));
  }

  /* ---------- 邮箱验证：先发验证码，再填回来验证 ---------- */
  async function sendMyEmailCode() {
    const em = $('[data-field="my_email"]');
    const email = em ? em.value.trim() : String(state.profile.email || '');
    if (!email) { toast('先填一个邮箱'); return; }
    if (!isEmail(email)) { toast('邮箱格式不对：' + email); return; }
    toast('正在发送验证码…');
    try {
      const r = await window.__api('/api/auth/email/code', { method: 'POST', body: JSON.stringify({ email: email }) });
      await loadAll();
      render(); // 邮箱已落库（未验证），把卡片上的「未填」换成「未验证」
      const codeEl = $('[data-field="my_email_code"]');
      if (codeEl) codeEl.focus();
      toast('验证码已发到 ' + r.email + (r.account ? '（通过「' + r.account + '」）' : '') + '，10 分钟内有效', 5200);
    } catch (e) {
      toast('没发出去：' + String((e && e.message) || e), 6000);
    }
  }

  function startEditMyEmail() {
    state.emailEdit = true;
    render();
    const el = $('[data-field="my_email"]');
    if (el) { el.focus(); try { el.select(); } catch (e) {} }
  }

  /* 给自己已验证的地址发一封测试信（收件人由服务端取，前端传不了） */
  async function testMyEmail() {
    toast('正在发送测试邮件…');
    try {
      const r = await window.__api('/api/auth/email/test', { method: 'POST' });
      toast('测试邮件已发到 ' + r.to + (r.account ? '（经「' + r.account + '」）' : '') +
        '，没收到的话翻一下垃圾箱', 6500);
    } catch (e) {
      toast('没发出去：' + String((e && e.message) || e), 7000);
    }
  }

  async function verifyMyEmail() {
    const codeEl = $('[data-field="my_email_code"]');
    const code = codeEl ? codeEl.value.replace(/\s/g, '') : '';
    if (!/^\d{6}$/.test(code)) { toast('验证码是 6 位数字'); return; }
    if (codeEl) codeEl.disabled = true;
    try {
      const r = await window.__api('/api/auth/email/verify', { method: 'POST', body: JSON.stringify({ code: code }) });
      state.emailEdit = false;            // 验证通过就锁回去
      await loadAll();
      render();
      toast('✓ 邮箱已验证：' + r.email + '，派单和提醒会发到这里', 5000);
    } catch (e) {
      if (codeEl) codeEl.disabled = false;
      toast(String((e && e.message) || '验证失败'), 4200);
    }
  }

  async function saveEmail(forceEnabled) {
    const has = f => !!$('[data-field="' + f + '"]');
    const get = f => { const el = $('[data-field="' + f + '"]'); return el ? el.value.trim() : ''; };
    const enabled = typeof forceEnabled === 'boolean'
      ? forceEnabled
      : !!($('[data-act="toggle-email"]') && $('[data-act="toggle-email"]').checked);
    const payload = { email_enabled: enabled, updated_at: new Date().toISOString() };
    if (has('digest_email')) payload.digest_email = get('digest_email') || null;
    if (payload.digest_email && !isEmail(payload.digest_email)) { toast('汇总邮箱格式不对'); return; }

    const { data, error } = await db.from('settings').update(payload).select();
    if (error) { toast('保存失败：' + (error.message || '')); return; }
    if (!data || !data.length) { toast('没有权限，只有团队管理员能改邮件设置'); return; }
    state.settings = data[0];
    render();
    toast(enabled ? '邮件已保存并启用' : '邮件设置已保存（当前未启用）');
    if (enabled && !mailReady()) {
      setTimeout(() => toast('还差发信邮箱：下面的「邮箱服务」点「＋ 新增」，填 QQ 邮箱 + 授权码', 4200), 2200);
    }
  }

  /* ---------- 邮箱服务（可配多个，前一个额度用完自动换下一个） ---------- */
  function openMailAccountModal(acc) {
    const a = acc || {};
    const isEdit = !!a.id;
    const kind = a.kind === 'emailjs' ? 'emailjs' : 'smtp';
    const preset = (label, host, port) =>
      '<button class="btn btn-sm" type="button" data-act="mail-acc-preset" data-host="' + host + '" data-port="' + port + '">' + label + '</button>';
    const body =
      '<div class="form-row">' +
        '<div class="field"><label>名称（自己认得出就行）</label>' +
          '<input class="input" data-field="acc_label" value="' + esc(a.label || '') + '" placeholder="主邮箱 / 备用邮箱" maxlength="30"></div>' +
        '<div class="field"><label>类型</label>' +
          '<div id="acc-kind" data-kind="' + kind + '" style="display:flex;gap:6px">' +
            '<button class="btn btn-sm' + (kind === 'smtp' ? ' btn-primary' : '') + '" type="button" data-act="mail-acc-kind" data-kind="smtp">邮箱直连</button>' +
            '<button class="btn btn-sm' + (kind === 'emailjs' ? ' btn-primary' : '') + '" type="button" data-act="mail-acc-kind" data-kind="emailjs">EmailJS</button>' +
          '</div></div>' +
      '</div>' +
      '<div id="acc-smtp"' + (kind === 'smtp' ? '' : ' style="display:none"') + '>' +
        '<div class="field"><label>快捷选择</label><div style="display:flex;gap:6px;flex-wrap:wrap">' +
          preset('QQ 邮箱', 'smtp.qq.com', 465) + preset('163 邮箱', 'smtp.163.com', 465) + preset('腾讯企业邮', 'smtp.exmail.qq.com', 465) +
        '</div></div>' +
        '<div class="form-row">' +
          '<div class="field"><label>SMTP 服务器</label><input class="input" data-field="acc_host" value="' + esc(a.host || 'smtp.qq.com') + '" placeholder="smtp.qq.com"></div>' +
          '<div class="field"><label>端口</label><input class="input" data-field="acc_port" value="' + esc(a.port || 465) + '" inputmode="numeric" placeholder="465"></div>' +
        '</div>' +
        '<div class="field"><label>邮箱账号（完整地址）</label><input class="input" type="email" data-field="acc_user" value="' + esc(a.user || '') + '" placeholder="你的QQ号@qq.com"></div>' +
        '<div class="field"><label>授权码' + (isEdit && a.pass_set ? '（已保存，留空不修改）' : '') + '</label>' +
          '<input class="input" type="password" data-field="acc_pass" value="" autocomplete="new-password" placeholder="' +
            (isEdit && a.pass_set ? '••••••••  留空保持原来的' : '16 位授权码，不是登录密码') + '"></div>' +
        '<div class="field"><label>发件人显示名</label><input class="input" data-field="acc_from_name" value="' + esc(a.from_name || '速派') + '" placeholder="速派"></div>' +
      '</div>' +
      '<div id="acc-emailjs"' + (kind === 'emailjs' ? '' : ' style="display:none"') + '>' +
        '<div class="field"><label>Service ID</label><input class="input" data-field="acc_service" value="' + esc(a.service_id || '') + '" placeholder="service_xxxxxxx"></div>' +
        '<div class="field"><label>Template ID</label><input class="input" data-field="acc_template" value="' + esc(a.template_id || '') + '" placeholder="template_xxxxxxx"></div>' +
        '<div class="field"><label>Public Key</label><input class="input" data-field="acc_public" value="' + esc(a.public_key || '') + '" placeholder="公钥，可公开"></div>' +
      '</div>' +
      '<div class="form-row">' +
        '<div class="field"><label>每天最多发多少封（0 = 不限）</label>' +
          '<input class="input" data-field="acc_limit" value="' + esc(a.daily_limit || 0) + '" inputmode="numeric" placeholder="500"></div>' +
        '<div class="field"><label>顺序（小的先用）</label>' +
          '<input class="input" data-field="acc_priority" value="' + esc(a.priority || 100) + '" inputmode="numeric" placeholder="10"></div>' +
      '</div>' +
      '<p class="hint" style="margin:0">超限后会自动跳过这个账号，换下一个继续发；第二天自动恢复。' +
      (isEdit ? '上次使用：' + esc(String(a.last_used_at || '还没用过').slice(0, 16)) : '') + '</p>';

    openModal(modalShell(isEdit ? '编辑邮箱服务' : '新增邮箱服务', body,
      '<button class="btn" data-act="close-modal">取消</button>' +
      '<button class="btn btn-primary" data-act="mail-acc-save" data-id="' + (a.id || '') + '">保存</button>'));
  }

  async function saveMailAccount(id) {
    const get = f => { const el = $('[data-field="' + f + '"]'); return el ? el.value.trim() : ''; };
    const kindEl = $('#acc-kind');
    const kind = kindEl && kindEl.getAttribute('data-kind') === 'emailjs' ? 'emailjs' : 'smtp';
    const payload = {
      label: get('acc_label') || null,
      kind: kind,
      daily_limit: Number(get('acc_limit') || 0) || 0,
      priority: Number(get('acc_priority') || 100) || 100,
      enabled: true
    };
    if (kind === 'smtp') {
      payload.host = get('acc_host') || null;
      payload.port = Number(get('acc_port') || 465) || 465;
      payload.user = get('acc_user') || null;
      payload.from_addr = payload.user;
      payload.from_name = get('acc_from_name') || '速派';
      const pass = get('acc_pass');
      if (pass) payload.pass = pass;
      if (!payload.host) { toast('请填 SMTP 服务器，QQ 邮箱是 smtp.qq.com'); return; }
      if (!payload.user || !isEmail(payload.user)) { toast('请填完整的邮箱地址'); return; }
      const cur = (state.mailAccounts || []).filter(x => String(x.id) === String(id))[0];
      if (!pass && !(cur && cur.pass_set)) { toast('请填授权码（QQ 邮箱在「设置 → 账号」里生成，不是登录密码）'); return; }
    } else {
      payload.service_id = get('acc_service') || null;
      payload.template_id = get('acc_template') || null;
      payload.public_key = get('acc_public') || null;
      if (!payload.service_id || !payload.template_id || !payload.public_key) { toast('EmailJS 三个参数都要填'); return; }
    }

    const res = id
      ? await db.from('mail_accounts').update(payload).eq('id', Number(id)).select()
      : await db.from('mail_accounts').insert(Object.assign({ label: get('acc_label') || '邮箱服务' }, payload)).select();
    if (res.error) { toast('保存失败：' + (res.error.message || '')); return; }
    if (!res.data || !res.data.length) { toast('没有权限'); return; }
    closeModal();
    // 邮箱服务变了，重新问一次服务端「现在能不能发信」
    await refreshMailMeta();
    await loadAll(); render();
    toast('已保存' + (res.data[0].enabled ? '' : '（未启用）') + '，建议点「测试」确认能收到');
  }

  async function delMailAccount(id) {
    const a = (state.mailAccounts || []).filter(x => String(x.id) === String(id))[0] || {};
    const ok = await confirmDialog('删除邮箱服务', '「' + (a.label || a.user || id) + '」会被删掉，之后不再用它发信。已发出的邮件记录不受影响。');
    if (!ok) return;
    const { data, error } = await db.from('mail_accounts').delete().eq('id', Number(id)).select();
    if (error) { toast('删除失败：' + (error.message || '')); return; }
    if (!data || !data.length) { toast('没有权限'); return; }
    await refreshMailMeta(); await loadAll(); render();
    toast('已删除');
  }

  async function toggleMailAccount(id, on) {
    const { error } = await db.from('mail_accounts').update({ enabled: !!on }).eq('id', Number(id)).select();
    if (error) { toast('保存失败：' + (error.message || '')); return; }
    await refreshMailMeta(); await loadAll(); render();
    toast(on ? '已启用这个账号' : '已停用，发信会跳过它');
  }

  async function refreshMailMeta() {
    try {
      const me = await window.__api('/api/auth/me');
      state.mail = me.mail || { ready: false };
    } catch (e) { /* ignore */ }
  }

  async function testMail() {
    if (!mailReady()) {
      toast('还没配发信邮箱：去「设置 → 通知 → 邮箱服务」点「＋ 新增」，填 QQ 邮箱 + 授权码');
      return;
    }
    const c = mailCfg();
    const to = isEmail(state.profile.email) ? state.profile.email.trim()
      : (isEmail(c.digestTo) ? c.digestTo : '');
    if (!to) { toast('先给自己填个邮箱：设置 → 通知 → 我的通知邮箱，或填汇总邮箱'); return; }
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
          { k: '发出账号', v: r.account || '自动选择' }
        ],
        tip: '如果没在收件箱看到，翻一下垃圾邮件，并把发件地址加入白名单。'
      })
    });
    toast(r.ok ? '已发出，去收件箱看看（可能进垃圾箱）' : '发送失败：' + r.error, 5200);
  }

  /* 只测某个账号：失败不切换，好定位是哪个邮箱的问题 */
  async function testMailAccount(id, label) {
    const c = mailCfg();
    const to = isEmail(state.profile.email) ? state.profile.email.trim() : (isEmail(c.digestTo) ? c.digestTo : '');
    if (!to) { toast('先给自己填个通知邮箱（设置 → 通知 → 我的通知邮箱），再点测试'); return; }
    toast('正在用「' + (label || '这个账号') + '」发送…');
    try {
      const r = await window.__api('/api/mail/accounts/test', {
        method: 'POST',
        body: JSON.stringify({ id: Number(id), label: label || '', to: to })
      });
      toast(r.ok ? '已通过「' + (r.account || label) + '」发到 ' + r.to + '，去收件箱（含垃圾箱）看看' : '发送失败', r.ok ? 5200 : 2400);
    } catch (e) {
      toast('发送失败：' + String((e && e.message) || e), 6000);
    }
    await loadAll(); render();
  }

  async function sendDigestNow(btn) {
    if (btn) { btn.disabled = true; btn.textContent = '发送中…'; }
    // 自托管版让服务端发（和定时任务同一套逻辑、同一批发信账号）
    const run = window.__LOCAL__
      ? window.__api('/api/mail/digest', { method: 'POST', body: '{}' })
      : mailDigest(todayStr(), true);
    const r = await Promise.resolve(run).catch(e => ({ ok: false, error: String((e && e.message) || e) }));
    if (btn) { btn.disabled = false; btn.textContent = '发今日汇总'; }
    if (r && r.ok) toast('今日汇总已发送');
    else if (r && r.error === 'empty') toast('今天没有未取消的预约，不用发');
    else if (r && r.error === 'already') toast('今天已经发过了');
    else toast('没发出去：' + ((r && r.error) || '未知原因'), 4600);
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

  /** 切换 PIN 明文/密文，含符号的 PIN 可以核对一下再提交 */
  function togglePeek(btn) {
    const wrap = btn.closest('.pin-wrap');
    const input = wrap && wrap.querySelector('input');
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? '隐藏' : '显示';
    btn.classList.toggle('on', show);
    try { input.focus({ preventScroll: true }); } catch (e) { /* 老浏览器忽略 */ }
  }

  async function changeMyPin() {
    const oldEl = $('[data-field="pin_old"]');
    const newEl = $('[data-field="pin_new"]');
    if (!oldEl || !newEl) return;
    const oldPin = normPin(oldEl.value);
    const newPin = normPin(newEl.value);
    if (!oldPin) { toast('请填写原 PIN'); return; }
    const pe = pinError(newPin);
    if (pe) { toast(pe); return; }
    if (newPin === oldPin) { toast('新 PIN 和原 PIN 一样，换个别的吧'); return; }
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
    // 已验证的邮箱在资料页是只读展示、不参与提交，否则「保存」会把锁定的地址清空
    const emailEl = f.elements.email;
    const hasEmailField = !!emailEl;
    const email = hasEmailField ? String(emailEl.value || '').trim() : String(state.profile.email || '');
    if (hasEmailField && email && !isEmail(email)) { toast('邮箱格式不对：' + email); return; }
    const oldEmail = String(state.profile.email || '');
    const emailChanged = hasEmailField && email !== oldEmail;
    const payload = {
      name: (f.elements.name.value || '').trim(),
      phone: (f.elements.phone.value || '').trim() || null,
      color: f.elements.color.value
    };
    if (hasEmailField) payload.email = email || null;
    if (!payload.name) { toast('请填写姓名'); return; }
    if (payload.phone) {
      const ph = phoneError(payload.phone);
      if (ph) { toast(ph); return; }
      payload.phone = normPhone(payload.phone);
    }
    const { data, error } = await db.from('profiles').update(payload).eq('id', state.profile.id).select();
    if (error) { toast('保存失败：' + (error.message || '')); return; }
    if (!data || !data.length) { toast('保存失败'); return; }
    state.profile = data[0];
    renderUserChip(); await loadAll(); render();
    toast(emailChanged && email
      ? '邮箱已改：去「设置 → 通知 → 我的通知邮箱」点「发送验证码」验证一下才算数'
      : '已保存', emailChanged && email ? 5200 : 2400);
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
      await boot();
    } catch (e) {
      console.error('[速派] 启动失败', e && e.message);
      showLogin('加载失败：' + ((e && e.message) || '请刷新页面重试'));
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
