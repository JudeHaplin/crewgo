'use strict';
/**
 * 数据层：SQLite（Node 内置 node:sqlite）+ 极简查询执行器
 * 前端沿用原来的链式调用习惯，这里负责把「描述符」翻译成 SQL 并做权限校验。
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || '/data';
const DB_FILE = path.join(DATA_DIR, 'repair.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'tech',
  color TEXT,
  push_token TEXT,
  pin_hash TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS profiles_name_key ON profiles (lower(name));
CREATE INDEX IF NOT EXISTS profiles_user_idx ON profiles (user_id);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT,
  color TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT,
  creator_name TEXT,
  project_id INTEGER,
  project_name TEXT,
  tech_id TEXT,
  tech_name TEXT,
  visit_date TEXT NOT NULL,
  time_slot TEXT NOT NULL DEFAULT '上午',
  address TEXT,
  content TEXT,
  contact_name TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  status TEXT NOT NULL DEFAULT '待确认',
  priority TEXT NOT NULL DEFAULT '普通',
  note TEXT,
  reminded_at TEXT,
  mailed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS appt_date_idx ON appointments (visit_date);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  appointment_id INTEGER,
  title TEXT NOT NULL,
  body TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS notif_owner_idx ON notifications (owner_id);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  notify_enabled INTEGER NOT NULL DEFAULT 1,
  pushplus_token TEXT,
  email_enabled INTEGER NOT NULL DEFAULT 0,
  emailjs_service_id TEXT,
  emailjs_template_id TEXT,
  emailjs_public_key TEXT,
  digest_email TEXT,
  last_digest_date TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS email_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT,
  kind TEXT,
  to_email TEXT,
  subject TEXT,
  status TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`;

const TABLES = {
  profiles: {
    cols: ['id', 'name', 'phone', 'email', 'role', 'color', 'push_token', 'pin_hash', 'active', 'user_id', 'created_at'],
    bool: ['active']
  },
  projects: {
    cols: ['id', 'name', 'address', 'color', 'active', 'sort_order', 'created_at'],
    bool: ['active']
  },
  appointments: {
    cols: ['id', 'owner_id', 'creator_name', 'project_id', 'project_name', 'tech_id', 'tech_name', 'visit_date',
      'time_slot', 'address', 'content', 'contact_name', 'contact_phone', 'contact_email', 'status', 'priority',
      'note', 'reminded_at', 'mailed_at', 'created_at', 'updated_at'],
    bool: [],
    num: ['id', 'project_id']
  },
  notifications: {
    cols: ['id', 'owner_id', 'appointment_id', 'title', 'body', 'read_at', 'created_at'],
    bool: [],
    num: ['id', 'appointment_id']
  },
  settings: {
    cols: ['id', 'notify_enabled', 'pushplus_token', 'email_enabled', 'emailjs_service_id', 'emailjs_template_id',
      'emailjs_public_key', 'digest_email', 'last_digest_date', 'updated_at'],
    bool: ['notify_enabled', 'email_enabled'],
    num: ['id']
  },
  email_logs: {
    cols: ['id', 'owner_id', 'kind', 'to_email', 'subject', 'status', 'detail', 'created_at'],
    bool: [],
    num: ['id']
  }
};

let db = null;

function open() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  db.prepare('INSERT OR IGNORE INTO settings (id) VALUES (1)').run();
  return db;
}

const handle = () => (db || open());

/* ---------- 结果规范化：把 0/1 变成布尔，把 id 变成数字 ---------- */
function shape(table, row) {
  if (!row) return row;
  const meta = TABLES[table] || {};
  const bools = meta.bool || [];
  const nums = meta.num || [];
  const out = {};
  for (const k of Object.keys(row)) {
    if (k === 'pin_hash') continue; // 任何情况下都不对外回传
    let v = row[k];
    if (bools.includes(k)) v = v === 1 || v === true;
    else if (nums.includes(k) && v !== null) v = Number(v);
    out[k] = v;
  }
  return out;
}

function bad(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

function pick(table, values) {
  const meta = TABLES[table];
  if (!meta) throw bad('未知数据表：' + table);
  const bools = meta.bool || [];
  const out = {};
  for (const k of Object.keys(values || {})) {
    if (k === 'pin') continue;
    if (!meta.cols.includes(k)) continue;
    let v = values[k];
    if (v === undefined) v = null;
    // node:sqlite 只接受 string / number / null / Buffer
    if (typeof v === 'boolean') v = v ? 1 : 0;
    else if (v !== null && bools.includes(k)) v = v ? 1 : 0;
    else if (v !== null && typeof v === 'object') v = JSON.stringify(v);
    out[k] = v;
  }
  return out;
}

function buildWhere(filters) {
  const parts = [];
  const params = [];
  for (const f of filters || []) {
    if (!f || !f.col) continue;
    if (!/^[a-z_]+$/.test(f.col)) throw bad('非法字段');
    const col = f.col;
    switch (f.op) {
      case 'eq':
        if (f.val === null || f.val === undefined) { parts.push(`${col} IS NULL`); }
        else { parts.push(`${col} = ?`); params.push(f.val); }
        break;
      case 'neq': parts.push(`${col} <> ?`); params.push(f.val); break;
      case 'is':
        parts.push(f.val === null || f.val === undefined ? `${col} IS NULL` : `${col} = ?`);
        if (!(f.val === null || f.val === undefined)) params.push(f.val);
        break;
      case 'gt': parts.push(`${col} > ?`); params.push(f.val); break;
      case 'gte': parts.push(`${col} >= ?`); params.push(f.val); break;
      case 'lt': parts.push(`${col} < ?`); params.push(f.val); break;
      case 'lte': parts.push(`${col} <= ?`); params.push(f.val); break;
      default: throw bad('不支持的过滤操作：' + f.op);
    }
  }
  return { sql: parts.length ? ' WHERE ' + parts.join(' AND ') : '', params };
}

function buildOrder(orders) {
  const parts = [];
  for (const o of orders || []) {
    if (!o || !/^[a-z_]+$/.test(o.col || '')) continue;
    parts.push(`${o.col} ${o.asc === false ? 'DESC' : 'ASC'}`);
  }
  return parts.length ? ' ORDER BY ' + parts.join(', ') : '';
}

/* ---------- 权限：这里取代了云端的 RLS ---------- */
const ADMIN_ONLY_WRITE = ['projects', 'settings'];

function deny(msg) {
  const e = new Error(msg || '没有权限');
  e.status = 403;
  return e;
}

function assertCan(actor, table, action, payload, filters) {
  if (!actor) throw deny('请先登录');
  const isAdmin = actor.role === 'admin';

  if (action === 'select') return;

  if (table === 'appointments') {
    if (action === 'delete' && !isAdmin) {
      const row = filters && filters.find(f => f.col === 'id');
      const target = row ? handle().prepare('SELECT owner_id FROM appointments WHERE id = ?').get(row.val) : null;
      if (!target || target.owner_id !== actor.id) throw deny('只有创建人或统筹能删除这条预约');
    }
    return;
  }

  if (table === 'notifications') {
    if (action === 'insert') return;
    return; // 只在 UI 里改自己那几条，服务端按 owner 过滤
  }

  if (table === 'email_logs') {
    if (action === 'insert') return;
    throw deny();
  }

  if (table === 'profiles') {
    if (isAdmin) return;
    if (action === 'update') {
      const idFilter = (filters || []).find(f => f.col === 'id' || f.col === 'user_id');
      const targetId = idFilter ? String(idFilter.val) : null;
      if (targetId && targetId !== actor.id) throw deny('只能修改自己的资料');
      const allowed = ['name', 'phone', 'email', 'color', 'pin'];
      for (const k of Object.keys(payload || {})) {
        if (!allowed.includes(k)) throw deny('这项资料只能由统筹修改');
      }
      return;
    }
    throw deny('只有统筹管理员能维护人员名单');
  }

  if (ADMIN_ONLY_WRITE.includes(table)) {
    if (!isAdmin) throw deny('只有统筹管理员能改' + (table === 'projects' ? '项目' : '通知设置'));
    return;
  }

  if (!isAdmin && action !== 'insert') throw deny();
}

/* ---------- 执行 ---------- */
function run(actor, q) {
  const h = handle();
  const table = String(q.table || '');
  if (!TABLES[table]) throw bad('未知数据表：' + table);
  const action = q.action || 'select';
  const filters = q.filters || [];
  assertCan(actor, table, action, q.values, filters);

  if (action === 'select') {
    const cols = q.columns && q.columns !== '*' && /^[a-z_,\s]+$/.test(q.columns) ? q.columns : '*';
    const where = buildWhere(filters);
    if (q.head) {
      const row = h.prepare(`SELECT COUNT(*) AS n FROM ${table}${where.sql}`).get(...where.params);
      return { data: null, count: Number(row ? row.n : 0) };
    }
    let sql = `SELECT ${cols} FROM ${table}${where.sql}${buildOrder(q.order)}`;
    if (q.limit) sql += ` LIMIT ${Math.max(1, Math.min(5000, Number(q.limit) || 100))}`;
    const rows = h.prepare(sql).all(...where.params).map(r => shape(table, r));
    return { data: rows };
  }

  if (action === 'insert') {
    const list = Array.isArray(q.values) ? q.values : [q.values || {}];
    const out = [];
    for (const raw of list) {
      const values = pick(table, raw);
      if (table === 'profiles') {
        if (values.pin_hash === undefined) values.pin_hash = null;
        if (!values.id) values.id = 'p_' + Math.random().toString(36).slice(2, 10);
        if (!values.user_id) values.user_id = values.id;
        if (values.active === undefined) values.active = 1;
      }
      if (table === 'appointments' && !values.owner_id) values.owner_id = actor.id;
      if (table === 'notifications') values.owner_id = values.owner_id || actor.id;
      if (table === 'email_logs') values.owner_id = values.owner_id || actor.id;
      const cols = Object.keys(values);
      const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
      const info = h.prepare(sql).run(...cols.map(c => values[c]));
      const id = info.lastInsertRowid;
      const row = h.prepare(`SELECT * FROM ${table} WHERE rowid = ?`).get(id);
      out.push(shape(table, row));
    }
    return { data: out };
  }

  if (action === 'update') {
    const values = pick(table, q.values || {});
    if (!Object.keys(values).length) return { data: [] };
    const where = buildWhere(filters);
    const sets = Object.keys(values).map(c => `${c} = ?`).join(',');
    h.prepare(`UPDATE ${table} SET ${sets}${where.sql}`).run(...Object.keys(values).map(c => values[c]), ...where.params);
    const rows = h.prepare(`SELECT * FROM ${table}${where.sql}`).all(...where.params).map(r => shape(table, r));
    return { data: rows };
  }

  if (action === 'delete') {
    const where = buildWhere(filters);
    if (!where.sql) throw bad('拒绝无条件删除');
    const rows = h.prepare(`SELECT * FROM ${table}${where.sql}`).all(...where.params);
    h.prepare(`DELETE FROM ${table}${where.sql}`).run(...where.params);
    return { data: rows.map(r => shape(table, r)) };
  }

  throw bad('不支持的操作：' + action);
}

/* ---------- 给定时任务用的直接访问 ---------- */
function raw() { return handle(); }

module.exports = { open, run, raw, DATA_DIR, DB_FILE, TABLES };
