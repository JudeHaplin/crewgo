/* ============================================================
   本地后端适配层
   ------------------------------------------------------------
   把原来云端 SDK 的调用形态（cloud.database.from(...) 链式 /
   cloud.auth.*）映射到本机 /api/*。app.js 里其余代码不用改。
   ============================================================ */
(function () {
  'use strict';

  const TOKEN_KEY = 'repair_scheduler_token';
  window.__LOCAL__ = true; // app.js 用它关掉「谁打开谁补发」的旧逻辑

  const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } };
  const setToken = t => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ } };

  async function call(path, opts) {
    const init = Object.assign({ headers: {} }, opts || {});
    init.headers = Object.assign({ 'Content-Type': 'application/json' }, (opts && opts.headers) || {});
    const token = getToken();
    if (token) init.headers.Authorization = 'Bearer ' + token;
    const res = await fetch(path, init);
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!res.ok) {
      const msg = (body && body.error) || ('请求失败（' + res.status + '）');
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  /* ---------- 查询构造器：形状与 supabase-js 一致 ---------- */
  function Query(table) {
    this.table = table;
    this._action = 'select';
    this._columns = '*';
    this._values = null;
    this._filters = [];
    this._order = [];
    this._limit = null;
    this._head = false;
    this._one = null;
  }

  Query.prototype.select = function (columns, opts) {
    if (this._action === 'select') {
      this._columns = columns || '*';
      if (opts && opts.head) this._head = true;
      if (opts && opts.count) this._count = true;
    }
    return this;
  };
  Query.prototype.insert = function (values) { this._action = 'insert'; this._values = values; return this; };
  Query.prototype.update = function (values) { this._action = 'update'; this._values = values; return this; };
  Query.prototype.delete = function () { this._action = 'delete'; return this; };
  Query.prototype.eq = function (col, val) { this._filters.push({ op: 'eq', col: col, val: val }); return this; };
  Query.prototype.neq = function (col, val) { this._filters.push({ op: 'neq', col: col, val: val }); return this; };
  Query.prototype.is = function (col, val) { this._filters.push({ op: 'is', col: col, val: val }); return this; };
  Query.prototype.gt = function (col, val) { this._filters.push({ op: 'gt', col: col, val: val }); return this; };
  Query.prototype.gte = function (col, val) { this._filters.push({ op: 'gte', col: col, val: val }); return this; };
  Query.prototype.lt = function (col, val) { this._filters.push({ op: 'lt', col: col, val: val }); return this; };
  Query.prototype.lte = function (col, val) { this._filters.push({ op: 'lte', col: col, val: val }); return this; };
  Query.prototype.order = function (col, opts) {
    this._order.push({ col: col, asc: !(opts && opts.ascending === false) });
    return this;
  };
  Query.prototype.limit = function (n) { this._limit = n; return this; };
  Query.prototype.maybeSingle = function () { this._one = 'maybe'; return this; };
  Query.prototype.single = function () { this._one = 'single'; return this; };

  Query.prototype._exec = async function () {
    const body = {
      table: this.table,
      action: this._action,
      columns: this._columns,
      values: this._values,
      filters: this._filters,
      order: this._order,
      limit: this._limit,
      head: this._head
    };
    try {
      const out = await call('/api/db', { method: 'POST', body: JSON.stringify(body) });
      let data = out ? out.data : null;
      let count = out ? out.count : undefined;
      if (this._head) return { data: null, count: count, error: null };
      if (this._one && Array.isArray(data)) {
        if (!data.length) {
          if (this._one === 'single') return { data: null, count: count, error: { message: '没有找到记录' } };
          return { data: null, count: count, error: null };
        }
        return { data: data[0], count: count, error: null };
      }
      return { data: data, count: count, error: null };
    } catch (e) {
      return { data: null, count: undefined, error: { message: e.message || '请求失败', status: e.status } };
    }
  };

  // 让 await 直接拿到结果（与 SDK 的 thenable 一致）
  Query.prototype.then = function (onOk, onErr) { return this._exec().then(onOk, onErr); };
  Query.prototype.catch = function (fn) { return this._exec().catch(fn); };

  /* ---------- 认证 ---------- */
  let cachedUser = null;

  async function fetchMe() {
    const token = getToken();
    if (!token) return null;
    try {
      const out = await call('/api/auth/me');
      cachedUser = (out && out.user) || null;
      return cachedUser;
    } catch (e) {
      if (e.status === 401) { setToken(''); cachedUser = null; }
      return null;
    }
  }

  const cloud = {
    database: {
      from: table => new Query(table),
      rpc: async () => ({ data: cachedUser ? cachedUser.id : null, error: null })
    },
    auth: {
      async getSession() {
        const user = await fetchMe();
        return { data: user ? { user: user, access_token: getToken() } : null, error: null };
      },
      async getUser() {
        const user = await fetchMe();
        return { data: user ? { user: user } : null, error: null };
      },
      async signIn(name, pin) {
        try {
          const out = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ name: name, pin: pin }) });
          setToken(out.token);
          cachedUser = out.user;
          return { data: { user: out.user, access_token: out.token }, error: null };
        } catch (e) {
          return { data: null, error: { message: e.message } };
        }
      },
      async setup(name, pin, phone) {
        try {
          const out = await call('/api/auth/setup', { method: 'POST', body: JSON.stringify({ name: name, pin: pin, phone: phone }) });
          setToken(out.token);
          cachedUser = out.user;
          return { data: { user: out.user, access_token: out.token }, error: null };
        } catch (e) {
          return { data: null, error: { message: e.message } };
        }
      },
      async changePin(oldPin, newPin) {
        try {
          await call('/api/auth/pin', { method: 'POST', body: JSON.stringify({ oldPin: oldPin, newPin: newPin }) });
          return { error: null };
        } catch (e) {
          return { error: { message: e.message } };
        }
      },
      async status() {
        try { return await call('/api/auth/status'); } catch (e) { return { initialized: true }; }
      },
      async signOut() {
        setToken('');
        cachedUser = null;
        try { await call('/api/auth/logout', { method: 'POST', body: '{}' }); } catch (e) { /* ignore */ }
        return { error: null };
      },
      // 本地版没有短信和第三方登录，保留占位以免旧代码报错
      async sendOtp() { return { data: null, error: { message: '本地版不支持短信登录，请用姓名 + PIN' } }; },
      async verifyOtp() { return { data: null, error: { message: '本地版不支持短信登录，请用姓名 + PIN' } }; },
      async signInWithOAuth() { return { data: null, error: { message: '本地版不支持第三方登录' } }; }
    }
  };

  window.WorkBuddyCloud = {
    createWorkBuddyCloud: function () { return cloud; }
  };
})();
