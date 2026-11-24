/* 造一个「1.1.0 时代的老库」：表结构、索引、settings 的单行约束都按 v1.1.0 原样，
   再塞几条真实业务数据。用来验证升级到新版本时不会炸、数据也不会丢。
   由 run.js 在起服务之前调用（DATA_DIR 指向测试用的临时目录）。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR;
if (!DATA_DIR) { console.error('prep: 缺少 DATA_DIR'); process.exit(1); }
fs.mkdirSync(DATA_DIR, { recursive: true });
const file = path.join(DATA_DIR, 'repair.db');
fs.rmSync(file, { force: true });

/* 以下 DDL 逐字取自 v1.1.0 的 server/src/store.js（含 CHECK(id = 1) 和 profiles_name_key） */
const OLD_SCHEMA = `
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
  mail_mode TEXT NOT NULL DEFAULT 'smtp',
  smtp_host TEXT,
  smtp_port INTEGER DEFAULT 465,
  smtp_user TEXT,
  smtp_pass TEXT,
  smtp_from TEXT,
  smtp_name TEXT,
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

const db = new DatabaseSync(file);
db.exec(OLD_SCHEMA);

const auth = require('../src/auth');
const pin = p => auth.hashPin(p);

db.prepare('INSERT INTO profiles (id, name, phone, email, role, color, pin_hash, user_id) VALUES (?,?,?,?,?,?,?,?)')
  .run('p_old_admin', '王建国', '13800000001', 'boss@example.com', 'admin', '#2b6ef6', pin('1234'), 'p_old_admin');
db.prepare('INSERT INTO profiles (id, name, phone, role, color, pin_hash, user_id) VALUES (?,?,?,?,?,?,?)')
  .run('p_old_tech', '周红祥', '13800000002', 'tech', '#0f9d76', pin('5678'), 'p_old_tech');
db.prepare("INSERT INTO profiles (id, name, role, color, pin_hash, user_id, active) VALUES (?,?,?,?,?,?,0)")
  .run('p_old_gone', '已离职的张工', 'tech', '#e5484d', pin('1111'), 'p_old_gone');

db.prepare("INSERT INTO projects (name, address, color, sort_order) VALUES ('皇都花园','闵行区','#2b6ef6',2)")
  .run();
db.prepare("INSERT INTO projects (name, address, color, sort_order) VALUES ('新黄浦梅陇社区','徐汇区','#0f9d76',1)")
  .run();

const insAppt = db.prepare('INSERT INTO appointments (owner_id, creator_name, project_id, project_name, tech_id, tech_name, visit_date, time_slot, address, content, contact_name, contact_phone, status, priority) ' +
  'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
insAppt.run('p_old_admin', '王建国', 1, '皇都花园', 'p_old_tech', '周红祥', '2026-11-28', '上午', '3栋901', '台盆下沉', '王女士', '13800000009', '待确认', '普通');
insAppt.run('p_old_admin', '王建国', 1, '皇都花园', 'p_old_tech', '周红祥', '2026-11-29', '下午', '4栋101', '水管漏', '赵先生', '13800000010', '已确认', '加急');
insAppt.run('p_old_tech', '周红祥', 2, '新黄浦梅陇社区', 'p_old_tech', '周红祥', '2026-11-30', '全天', '7栋2单元', '换水表', '钱先生', '13800000011', '已完成', '普通');

db.prepare("INSERT INTO settings (id, notify_enabled, email_enabled, digest_email, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, mail_mode) VALUES (1,1,1,'boss@example.com','smtp.qq.com',465,'boss@example.com','授权码别丢','速派','smtp')")
  .run();

db.prepare('INSERT INTO notifications (owner_id, appointment_id, title, body) VALUES (?,?,?,?)')
  .run('p_old_tech', 1, '新预约', '11-28 上午 皇都花园');

db.prepare('INSERT INTO email_logs (owner_id, kind, to_email, subject, status) VALUES (?,?,?,?,?)')
  .run('p_old_tech', 'remind', 'tech@example.com', '明日有单', 'ok');

db.close();
console.log('prep: 已生成 1.1.0 老库 → ' + file);
