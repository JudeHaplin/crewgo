'use strict';
/**
 * 数据层：SQLite（Node 内置 node:sqlite）+ 极简查询执行器
 * 前端沿用原来的链式调用习惯，这里负责把「描述符」翻译成 SQL 并做权限校验。
 *
 * 团队隔离是硬约束：所有业务表都带 team_id，/api/db 在服务端强制注入过滤，
 * 前端传什么都不会看到别的团队的数据。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || '/data';
const DB_FILE = path.join(DATA_DIR, 'repair.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

/* settings 单抽出来：老库里是 id=1 + CHECK(id=1)，团队化必须重建，见 rebuildSettings() */
const SETTINGS_DDL = `
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER UNIQUE,
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
  wx_mp_appid TEXT,
  wx_mp_secret TEXT,
  wx_qr_appid TEXT,
  wx_qr_secret TEXT,
  auto_backup INTEGER NOT NULL DEFAULT 0,
  backup_email TEXT,
  backup_hour INTEGER DEFAULT 3,
  backup_full INTEGER NOT NULL DEFAULT 0,
  last_backup_date TEXT,
  last_backup_at TEXT,
  last_backup_note TEXT,
  updated_at TEXT
);
`;

/* 只建表：老库升级时，索引要等 migrate() 补完列才建，否则 profiles(team_id) 这类索引会直接报“no such column” */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  owner_id TEXT,
  allow_direct INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS team_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL,
  profile_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  decided_at TEXT,
  decided_by TEXT
);

CREATE TABLE IF NOT EXISTS wx_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app TEXT NOT NULL,
  openid TEXT NOT NULL,
  unionid TEXT,
  profile_id TEXT NOT NULL,
  nickname TEXT,
  avatar TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

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
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  team_id INTEGER,
  team_role TEXT NOT NULL DEFAULT 'member',
  need_profile INTEGER NOT NULL DEFAULT 0,
  avatar TEXT,
  last_login_at TEXT,
  email_verified_at TEXT,
  email_pending TEXT,
  email_code TEXT,
  email_code_exp TEXT,
  email_code_tries INTEGER NOT NULL DEFAULT 0,
  email_code_sent_at TEXT,
  token_version INTEGER NOT NULL DEFAULT 0
);

/* 登录会话（设备）：一张表记「谁在哪台设备上登录着」，令牌里带 sid 指过来。
   改密码会把 token_version +1 并清空这里的记录，所有设备立刻失效。 */
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  ua TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER,
  name TEXT NOT NULL,
  address TEXT,
  color TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER,
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

/* 预约附件：文件本体放 DATA_DIR/files 下，这里只记元数据 */
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER,
  appointment_id INTEGER,
  owner_id TEXT,
  name TEXT NOT NULL,
  mime TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  store_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER,
  owner_id TEXT NOT NULL,
  appointment_id INTEGER,
  title TEXT NOT NULL,
  body TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS email_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER,
  owner_id TEXT,
  kind TEXT,
  to_email TEXT,
  subject TEXT,
  status TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS time_off (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER,
  profile_id TEXT NOT NULL,
  off_date TEXT NOT NULL,
  part TEXT NOT NULL DEFAULT '全天',
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

/* 发信账号：一个团队可以配多个，前一个发不出或被限额就自动换下一个 */
CREATE TABLE IF NOT EXISTS mail_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER,
  label TEXT,
  kind TEXT NOT NULL DEFAULT 'smtp',
  host TEXT,
  port INTEGER DEFAULT 465,
  user TEXT,
  pass TEXT,
  from_addr TEXT,
  from_name TEXT,
  service_id TEXT,
  template_id TEXT,
  public_key TEXT,
  daily_limit INTEGER NOT NULL DEFAULT 0,
  sent_today INTEGER NOT NULL DEFAULT 0,
  sent_date TEXT,
  exhausted_date TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`;



const INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS team_req_key ON team_requests (team_id, profile_id);
CREATE INDEX IF NOT EXISTS team_req_status_idx ON team_requests (status);
CREATE UNIQUE INDEX IF NOT EXISTS wx_app_openid_key ON wx_accounts (app, openid);
CREATE INDEX IF NOT EXISTS wx_union_idx ON wx_accounts (unionid);
CREATE INDEX IF NOT EXISTS wx_profile_idx ON wx_accounts (profile_id);
DROP INDEX IF EXISTS profiles_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_team_name_key ON profiles (team_id, lower(name));
CREATE INDEX IF NOT EXISTS profiles_user_idx ON profiles (user_id);
CREATE INDEX IF NOT EXISTS profiles_team_idx ON profiles (team_id);
CREATE INDEX IF NOT EXISTS projects_team_idx ON projects (team_id);
CREATE INDEX IF NOT EXISTS appt_date_idx ON appointments (visit_date);
CREATE INDEX IF NOT EXISTS appt_team_idx ON appointments (team_id, visit_date);
CREATE INDEX IF NOT EXISTS notif_owner_idx ON notifications (owner_id);
CREATE INDEX IF NOT EXISTS notif_team_idx ON notifications (team_id);
CREATE INDEX IF NOT EXISTS email_logs_team_idx ON email_logs (team_id);
CREATE UNIQUE INDEX IF NOT EXISTS time_off_key ON time_off (team_id, profile_id, off_date);
CREATE INDEX IF NOT EXISTS time_off_date_idx ON time_off (team_id, off_date);
CREATE INDEX IF NOT EXISTS mail_acc_team_idx ON mail_accounts (team_id, priority);
CREATE INDEX IF NOT EXISTS sessions_profile_idx ON sessions (profile_id, revoked_at);
CREATE INDEX IF NOT EXISTS attach_appt_idx ON attachments (appointment_id);
CREATE INDEX IF NOT EXISTS attach_team_idx ON attachments (team_id);
`;

const TABLES = {
  profiles: {
    cols: ['id', 'name', 'phone', 'email', 'role', 'color', 'push_token', 'pin_hash', 'active', 'user_id',
      'created_at', 'team_id', 'team_role', 'need_profile', 'avatar', 'last_login_at',
      'email_verified_at', 'email_pending', 'email_code', 'email_code_exp', 'email_code_tries', 'email_code_sent_at'],
    bool: ['active', 'need_profile'],
    num: ['team_id', 'email_code_tries']
  },
  projects: {
    cols: ['id', 'team_id', 'name', 'address', 'color', 'active', 'sort_order', 'created_at'],
    bool: ['active'],
    num: ['id', 'team_id']
  },
  appointments: {
    cols: ['id', 'team_id', 'owner_id', 'creator_name', 'project_id', 'project_name', 'tech_id', 'tech_name',
      'visit_date', 'time_slot', 'address', 'content', 'contact_name', 'contact_phone', 'contact_email', 'status',
      'priority', 'note', 'reminded_at', 'mailed_at', 'created_at', 'updated_at', 'updater_id', 'updater_name'],
    bool: [],
    num: ['id', 'project_id', 'team_id']
  },
  attachments: {
    cols: ['id', 'team_id', 'appointment_id', 'owner_id', 'name', 'mime', 'size', 'store_name', 'created_at'],
    bool: [],
    num: ['id', 'team_id', 'appointment_id', 'size']
  },
  notifications: {
    cols: ['id', 'team_id', 'owner_id', 'appointment_id', 'title', 'body', 'read_at', 'created_at'],
    bool: [],
    num: ['id', 'appointment_id', 'team_id']
  },
  settings: {
    cols: ['id', 'team_id', 'notify_enabled', 'pushplus_token', 'email_enabled', 'emailjs_service_id',
      'emailjs_template_id', 'emailjs_public_key', 'digest_email', 'last_digest_date', 'mail_mode', 'smtp_host',
      'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_name', 'wx_mp_appid', 'wx_mp_secret',
      'wx_qr_appid', 'wx_qr_secret', 'auto_backup', 'backup_email', 'backup_hour', 'backup_full',
      'last_backup_date', 'last_backup_at', 'last_backup_note', 'updated_at'],
    bool: ['notify_enabled', 'email_enabled', 'auto_backup', 'backup_full'],
    num: ['id', 'smtp_port', 'team_id', 'backup_hour']
  },
  email_logs: {
    cols: ['id', 'team_id', 'owner_id', 'kind', 'to_email', 'subject', 'status', 'detail', 'created_at'],
    bool: [],
    num: ['id', 'team_id']
  },
  time_off: {
    cols: ['id', 'team_id', 'profile_id', 'off_date', 'part', 'reason', 'created_at'],
    bool: [],
    num: ['id', 'team_id']
  },
  mail_accounts: {
    cols: ['id', 'team_id', 'label', 'kind', 'host', 'port', 'user', 'pass', 'from_addr', 'from_name',
      'service_id', 'template_id', 'public_key', 'daily_limit', 'sent_today', 'sent_date', 'exhausted_date',
      'priority', 'enabled', 'last_error', 'last_used_at', 'created_at'],
    bool: ['enabled'],
    num: ['id', 'team_id', 'port', 'daily_limit', 'sent_today', 'priority']
  }
};

/** 这些表一律按团队隔离 */
const SCOPED = ['profiles', 'projects', 'appointments', 'notifications', 'settings', 'email_logs', 'time_off', 'mail_accounts', 'attachments'];

/** 只允许团队 API 改的字段：防止有人用 /api/db 给自己换团队或提权 */
const TEAM_LOCKED_COLS = ['team_id', 'team_role'];

let db = null;

/* ---------- 团队码：3 位大写字母 + 6 位数字 ---------- */
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // 去掉 I、O，避免和 1、0 看错
function genTeamCode() {
  let out = '';
  for (let i = 0; i < 3; i++) out += CODE_LETTERS[crypto.randomInt(0, CODE_LETTERS.length)];
  for (let i = 0; i < 6; i++) out += String(crypto.randomInt(0, 10));
  return out;
}
const CODE_RE = /^[A-Z]{3}\d{6}$/;
/** 用户输入容错：空格/横线/小写都能补正 */
const normCode = v => String(v === null || v === undefined ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');

/* ---------- 手机号：中国大陆 11 位 ---------- */
function normPhone(v) {
  const raw = String(v === null || v === undefined ? '' : v).trim();
  if (!raw) return '';
  return raw.replace(/[\s\-()]/g, '').replace(/^\+?86(?=1\d{10}$)/, '');
}
const PHONE_RE = /^1[3-9]\d{9}$/;
function phoneError(v) {
  const p = normPhone(v);
  if (!p) return '请填写手机号';
  if (!PHONE_RE.test(p)) return '手机号要 11 位，以 1 开头（现在填的是 ' + p.length + ' 位）';
  return '';
}

/* ---------- 建库 / 迁移 ---------- */
const SETTINGS_MIGRATIONS = [
  ['mail_mode', "TEXT NOT NULL DEFAULT 'smtp'"],
  ['smtp_host', 'TEXT'],
  ['smtp_port', 'INTEGER DEFAULT 465'],
  ['smtp_user', 'TEXT'],
  ['smtp_pass', 'TEXT'],
  ['smtp_from', 'TEXT'],
  ['smtp_name', 'TEXT'],
  ['wx_mp_appid', 'TEXT'],
  ['wx_mp_secret', 'TEXT'],
  ['wx_qr_appid', 'TEXT'],
  ['wx_qr_secret', 'TEXT'],
  // 自动备份：每天定时把团队备份发到指定邮箱
  ['auto_backup', 'INTEGER NOT NULL DEFAULT 0'],
  ['backup_email', 'TEXT'],
  ['backup_hour', 'INTEGER DEFAULT 3'],
  ['backup_full', 'INTEGER NOT NULL DEFAULT 0'],
  ['last_backup_date', 'TEXT'],
  ['last_backup_at', 'TEXT'],
  ['last_backup_note', 'TEXT']
];

const PROFILE_MIGRATIONS = [
  ['team_id', 'INTEGER'],
  ['team_role', "TEXT NOT NULL DEFAULT 'member'"],
  ['need_profile', 'INTEGER NOT NULL DEFAULT 0'],
  ['avatar', 'TEXT'],
  ['last_login_at', 'TEXT'],
  // 邮箱验证：验证码只存 10 分钟，验证过的邮箱记 email_verified_at
  ['email_verified_at', 'TEXT'],
  // 待验证的新邮箱：验证通过才写进 email，中途取消不会把已验证的旧地址弄丢
  ['email_pending', 'TEXT'],
  ['email_code', 'TEXT'],
  ['email_code_exp', 'TEXT'],
  ['email_code_tries', 'INTEGER NOT NULL DEFAULT 0'],
  ['email_code_sent_at', 'TEXT'],
  // 令牌版本：改密码/重设密码时 +1，之前发出去的所有令牌立刻失效（换设备重新登录）
  ['token_version', 'INTEGER NOT NULL DEFAULT 0']
];

/* 预约单改动记录：谁改的、什么时候改的（详情页只给管理员看） */
const APPOINTMENT_MIGRATIONS = [
  ['updater_id', 'TEXT'],
  ['updater_name', 'TEXT'],
  ['updated_at', 'TEXT']
];

const colsOf = table => db.prepare('PRAGMA table_info(' + table + ')').all().map(c => c.name);

/** 本地时间戳（和 created_at 的格式一致），不用 SQL 的 localtime，避免容器时区坑 */
function localStamp(d) {
  const t = d || new Date();
  const p = n => String(n).padStart(2, '0');
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate()) + ' ' +
    p(t.getHours()) + ':' + p(t.getMinutes()) + ':' + p(t.getSeconds());
}

/** 老库 settings 是 id=1 单行 + CHECK(id=1)，团队化必须重建表 */
function rebuildSettings() {
  const old = db.prepare('SELECT * FROM settings LIMIT 1').get() || {};
  db.exec('ALTER TABLE settings RENAME TO settings_legacy');
  db.exec(SETTINGS_DDL);
  const target = colsOf('settings');
  const keys = Object.keys(old).filter(k => k !== 'id' && target.includes(k));
  if (keys.length) {
    db.prepare('INSERT INTO settings (' + keys.join(',') + ') VALUES (' + keys.map(() => '?').join(',') + ')')
      .run(...keys.map(k => old[k]));
  }
  db.exec('DROP TABLE settings_legacy');
}

function migrate() {
  const hasSettings = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get();
  if (!hasSettings) {
    db.exec(SETTINGS_DDL);
  } else {
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='settings'").get();
    const sql = (ddl && ddl.sql) || '';
    if (!/team_id/.test(sql) || /CHECK\s*\(\s*id\s*=\s*1\s*\)/i.test(sql)) rebuildSettings();
    else {
      const cols = colsOf('settings');
      for (const [name, type] of SETTINGS_MIGRATIONS) {
        if (!cols.includes(name)) db.exec('ALTER TABLE settings ADD COLUMN ' + name + ' ' + type);
      }
    }
  }

  // 业务表补 team_id
  for (const t of ['profiles', 'projects', 'appointments', 'notifications', 'email_logs']) {
    if (!colsOf(t).includes('team_id')) db.exec('ALTER TABLE ' + t + ' ADD COLUMN team_id INTEGER');
  }
  // 老 profiles 补团队/资料相关列
  const pcols = colsOf('profiles');
  for (const [name, type] of PROFILE_MIGRATIONS) {
    if (!pcols.includes(name)) db.exec('ALTER TABLE profiles ADD COLUMN ' + name + ' ' + type);
  }
  // 老预约单补改动记录列（附件表由 SETTINGS_DDL 里的 CREATE TABLE IF NOT EXISTS 负责）
  const acols = colsOf('appointments');
  for (const [name, type] of APPOINTMENT_MIGRATIONS) {
    if (!acols.includes(name)) db.exec('ALTER TABLE appointments ADD COLUMN ' + name + ' ' + type);
  }
  // 老 time_off 补「半天」列：全天 / 上午 / 下午（老数据一律当全天）
  if (!colsOf('time_off').includes('part')) {
    db.exec("ALTER TABLE time_off ADD COLUMN part TEXT NOT NULL DEFAULT '全天'");
  }
  // 同名唯一索引改成「团队内唯一」：不同团队可以有同名的人
  try { db.exec('DROP INDEX IF EXISTS profiles_name_key'); } catch (e) { /* ignore */ }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS profiles_team_name_key ON profiles (team_id, lower(name))');
}

/**
 * 老库升级：已经有数据但还没团队 → 建一个默认团队，把所有人/数据归进去。
 * 第一个 admin 当队长（owner），其余 admin 保持管理员。
 */
function ensureDefaultTeam() {
  const n = Number(db.prepare('SELECT COUNT(*) AS n FROM teams').get().n);
  if (n > 0) return null;
  const first = db.prepare('SELECT * FROM profiles ORDER BY created_at, rowid LIMIT 1').get();
  if (!first) return null;

  const admin = db.prepare("SELECT * FROM profiles WHERE role = 'admin' ORDER BY rowid LIMIT 1").get();
  const owner = admin || first;
  const teamName = (owner.name || '默认') + '的团队';
  const code = newTeamCode();
  const info = db.prepare('INSERT INTO teams (name, code, owner_id) VALUES (?,?,?)').run(teamName, code, owner.id);
  const teamId = Number(info.lastInsertRowid);

  db.exec('BEGIN');
  try {
    // 老库升级时别把大家都提成管理员：只有原来 role=admin 的才是管理员，其余是成员
    db.prepare("UPDATE profiles SET team_id = ?, team_role = CASE WHEN id = ? THEN 'owner' WHEN role = 'admin' THEN 'admin' ELSE 'member' END WHERE team_id IS NULL")
      .run(teamId, owner.id);
    for (const t of ['projects', 'appointments', 'notifications', 'email_logs']) {
      if (t === 'projects' || t === 'appointments') {
        db.prepare('UPDATE ' + t + ' SET team_id = ? WHERE team_id IS NULL').run(teamId);
      }
    }
    db.prepare('UPDATE settings SET team_id = ? WHERE team_id IS NULL').run(teamId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  ensureTeamSettings(teamId);
  return { id: teamId, name: teamName, code, owner: owner.id };
}

function newTeamCode() {
  for (let i = 0; i < 40; i++) {
    const code = genTeamCode();
    const hit = db.prepare('SELECT id FROM teams WHERE code = ?').get(code);
    if (!hit) return code;
  }
  throw new Error('团队码生成失败，请重试');
}

/** 每个团队一行 settings，缺了就补 */
function ensureTeamSettings(teamId) {
  if (!teamId) return null;
  const row = db.prepare('SELECT * FROM settings WHERE team_id = ?').get(teamId);
  if (row) {
    seedMailAccount(teamId);
    return row;
  }
  db.prepare('INSERT INTO settings (team_id) VALUES (?)').run(teamId);
  return db.prepare('SELECT * FROM settings WHERE team_id = ?').get(teamId);
}

const seededTeams = new Set();

/**
 * 老版本只有一套 SMTP 配置存在 settings 里。
 * 升级后搬成一条「邮箱服务」，这样界面上能继续编辑、也能再加第二个。
 * 只在团队还没有任何发信账号时搬一次，之后完全以 mail_accounts 为准。
 */
function seedMailAccount(teamId) {
  if (!teamId || seededTeams.has(teamId)) return null;
  seededTeams.add(teamId);
  try {
    const n = db.prepare('SELECT COUNT(*) AS n FROM mail_accounts WHERE team_id = ?').get(teamId);
    if (Number(n.n) > 0) return null;
    const s = db.prepare('SELECT * FROM settings WHERE team_id = ?').get(teamId) || {};
    const mode = String(s.mail_mode || (s.smtp_host ? 'smtp' : 'emailjs')).toLowerCase();
    const t = String;
    let row = null;
    if (mode !== 'emailjs' && s.smtp_host && s.smtp_user && s.smtp_pass) {
      row = {
        label: t(s.smtp_name || '').trim() || t(s.smtp_user),
        kind: 'smtp',
        host: t(s.smtp_host).trim(),
        port: Number(s.smtp_port || 465) || 465,
        user: t(s.smtp_user).trim(),
        pass: t(s.smtp_pass),
        from_addr: t(s.smtp_from || s.smtp_user).trim(),
        from_name: t(s.smtp_name || '速派').trim() || '速派'
      };
    } else if (mode === 'emailjs' && s.emailjs_service_id && s.emailjs_template_id && s.emailjs_public_key) {
      row = {
        label: 'EmailJS',
        kind: 'emailjs',
        service_id: t(s.emailjs_service_id).trim(),
        template_id: t(s.emailjs_template_id).trim(),
        public_key: t(s.emailjs_public_key).trim()
      };
    }
    if (!row) return null;
    db.prepare(
      'INSERT INTO mail_accounts (team_id, label, kind, host, port, user, pass, from_addr, from_name, service_id, template_id, public_key, priority) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,10)'
    ).run(teamId, row.label || null, row.kind, row.host || null, row.port || 465, row.user || null, row.pass || null,
      row.from_addr || null, row.from_name || null, row.service_id || null, row.template_id || null, row.public_key || null);
    return row;
  } catch (e) {
    return null;
  }
}

/**
 * 补发入团申请的站内通知。
 * 1.2.2 及更早版本只把申请写进 team_requests，管理员什么都收不到；
 * 升级后启动一次，把还挂着的待审申请补一条通知，免得没人知道有人在外面等。
 */
function backfillTeamNotices() {
  try {
    const pend = db.prepare(
      "SELECT r.team_id, p.name, p.phone FROM team_requests r JOIN profiles p ON p.id = r.profile_id WHERE r.status = 'pending'"
    ).all();
    if (!pend.length) return;
    const adminsOf = db.prepare("SELECT id FROM profiles WHERE team_id = ? AND active = 1 AND team_role IN ('owner','admin')");
    const has = db.prepare("SELECT 1 AS x FROM notifications WHERE owner_id = ? AND title = '新的入团申请' AND instr(IFNULL(body,''), ?) > 0 LIMIT 1");
    const ins = db.prepare('INSERT INTO notifications (team_id, owner_id, title, body) VALUES (?,?,?,?)');
    for (const r of pend) {
      for (const a of adminsOf.all(r.team_id)) {
        if (has.get(a.id, r.name)) continue;
        ins.run(r.team_id, a.id, '新的入团申请',
          r.name + '（' + (r.phone || '未填手机号') + '）申请加入团队，去「设置 → 团队」同意或拒绝。');
      }
    }
  } catch (e) { /* 补通知失败不影响启动 */ }
}

function open() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = OFF');
  // 顺序不能换：老库的表已经存在，CREATE TABLE IF NOT EXISTS 不会补列，
  // 所以必须先建表 → migrate() 补 team_id 等新列 → 最后才建索引。
  db.exec(SCHEMA);
  migrate();
  db.exec(INDEXES);
  ensureDefaultTeam();
  // 老版本的单一 SMTP 配置搬成「邮箱服务」，多个团队都要搬（每个团队只搬一次）
  try {
    for (const t of db.prepare('SELECT id FROM teams').all()) seedMailAccount(t.id);
  } catch (e) { /* 迁移失败不影响启动，发信时才报错 */ }
  backfillTeamNotices();
  return db;
}

const handle = () => (db || open());

/* ---------- 结果规范化：把 0/1 变成布尔，把 id 变成数字 ---------- */
const SECRET_COLS = {
  settings: ['smtp_pass', 'wx_mp_secret', 'wx_qr_secret'],
  mail_accounts: ['pass'],
  // 邮箱验证码只给本人用，谁查询都不能回传（否则同队的人能替别人验证）
  profiles: ['email_code', 'email_code_exp', 'email_code_tries', 'email_code_sent_at']
};

function shape(table, row) {
  if (!row) return row;
  const meta = TABLES[table] || {};
  const bools = meta.bool || [];
  const nums = meta.num || [];
  const secrets = SECRET_COLS[table] || [];
  const out = {};
  for (const k of Object.keys(row)) {
    if (k === 'pin_hash') continue; // 任何情况下都不对外回传
    if (k === 'token_version') continue; // 内部字段，前端用不到
    if (secrets.includes(k)) continue; // 授权码/密钥只进不出
    let v = row[k];
    if (bools.includes(k)) v = v === 1 || v === true;
    else if (nums.includes(k) && v !== null) v = Number(v);
    out[k] = v;
  }
  if (table === 'settings') {
    out.smtp_pass_set = !!row.smtp_pass;
    out.wx_mp_secret_set = !!row.wx_mp_secret;
    out.wx_qr_secret_set = !!row.wx_qr_secret;
  }
  if (table === 'mail_accounts') {
    out.pass_set = !!row.pass;
    out.has_quota = Number(row.daily_limit || 0) > 0;
    out.used_today = row.sent_date === todayStr() ? Number(row.sent_today || 0) : 0;
    out.exhausted_today = row.exhausted_date === todayStr();
  }
  return out;
}

function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function bad(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}
function deny(msg) {
  const e = new Error(msg || '没有权限');
  e.status = 403;
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
    if (TEAM_LOCKED_COLS.includes(k)) continue; // 团队归属/团队角色只能走团队接口
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
// 业务表：管理员就能改
const ADMIN_ONLY_WRITE = ['projects', 'settings'];
const ADMIN_LABEL = { projects: '项目', settings: '通知设置' };
// 涉及「系统稳定 / 数据安全」的东西：只有统筹管理员（队长，全团队唯一）能改。
// 发信账号在里面 —— 用错账号会把整个团队的通知发不出去，属于系统级配置。
const OWNER_ONLY_WRITE = ['mail_accounts'];
const OWNER_LABEL = { mail_accounts: '邮箱服务' };

function isTeamAdmin(actor) {
  return !!actor && (actor.teamRole === 'owner' || actor.teamRole === 'admin');
}
const isOwner = actor => !!actor && actor.teamRole === 'owner';

function assertCan(actor, table, action, payload, filters) {
  if (!actor) throw deny('请先登录');
  const admin = isTeamAdmin(actor);

  if (action === 'select') return;

  if (table === 'appointments') {
    const idFilter = (filters || []).find(f => f && f.col === 'id');
    const load = () => (idFilter ? handle().prepare('SELECT owner_id, tech_id, team_id FROM appointments WHERE id = ?').get(idFilter.val) : null);
    if (action === 'delete' && !admin) {
      const target = load();
      if (!target || target.team_id !== actor.teamId || target.owner_id !== actor.id) {
        throw deny('只有创建人或团队管理员能删除这条预约');
      }
    }
    // 不是自己创建的单：只有管理员能改内容；其他人（正是这单的维修人员）
    // 只能改状态做标记。维修人员可以「标记为取消」，改内容仍然只给预约人和管理员
    if (action === 'update' && !admin) {
      const target = load();
      if (!target) throw deny('只能按单号修改预约');
      if (target.team_id !== actor.teamId) throw deny();
      if (target.owner_id !== actor.id) {
        const list = Array.isArray(payload) ? payload : [payload || {}];
        const allowed = ['status', 'updated_at', 'updater_id', 'updater_name', 'reminded_at', 'mailed_at'];
        const isTech = String(target.tech_id || '') === String(actor.id);
        for (const v of list) {
          const extra = Object.keys(v || {}).filter(k => !allowed.includes(k));
          if (extra.length) throw deny('只有预约人和管理员能修改这条预约的内容');
          if (String((v || {}).status || '') === '已取消' && !isTech) {
            throw deny('只有预约人、这单的维修人员或管理员能取消预约');
          }
        }
      }
    }
    return;
  }

  if (table === 'attachments') {
    if (action === 'select') return;
    throw deny('附件请通过上传接口处理');
  }

  if (table === 'notifications') return; // 服务端按 team + owner 过滤

  if (table === 'time_off') {
    if (admin) return;
    // 普通成员只能给自己排休，也只能删自己的
    if (action === 'insert') return;
    const row = (filters || []).find(f => f.col === 'id');
    const target = row ? handle().prepare('SELECT profile_id FROM time_off WHERE id = ?').get(row.val) : null;
    if (!target || target.profile_id !== actor.id) throw deny('只能调整自己的休息日');
    return;
  }

  if (table === 'email_logs') {
    if (action === 'insert') return;
    throw deny();
  }

  if (table === 'profiles') {
    if (admin) {
      if (action === 'delete') {
        const row = (filters || []).find(f => f.col === 'id');
        const target = row ? handle().prepare('SELECT id, team_role FROM profiles WHERE id = ?').get(row.val) : null;
        // 统筹（全团队唯一）不能被删/降级；管理员之间权限相同，可以互相移出
        if (target && target.team_role === 'owner') throw deny('不能删除统筹管理员（队长）');
      }
      return;
    }
    if (action === 'update') {
      const idFilter = (filters || []).find(f => f.col === 'id' || f.col === 'user_id');
      const targetId = idFilter ? String(idFilter.val) : null;
      if (targetId && targetId !== actor.id) throw deny('只能修改自己的资料');
      const allowed = ['name', 'phone', 'email', 'color', 'pin', 'avatar', 'push_token'];
      for (const k of Object.keys(payload || {})) {
        if (!allowed.includes(k)) throw deny('这项资料只能由团队管理员修改');
      }
      return;
    }
    throw deny('只有团队管理员能维护人员名单');
  }

  if (OWNER_ONLY_WRITE.includes(table)) {
    if (!isOwner(actor)) throw deny('「' + (OWNER_LABEL[table] || table) + '」涉及系统稳定，只有统筹管理员能改');
    return;
  }

  if (ADMIN_ONLY_WRITE.includes(table)) {
    if (!admin) throw deny('只有团队管理员能改' + (ADMIN_LABEL[table] || '这些设置'));
    return;
  }

  if (!admin && action !== 'insert') throw deny();
}

/** 把前端传的过滤条件改成「当前团队」范围：前端传别的团队也没用 */
function scopeFilters(actor, table, filters) {
  let out = filters || [];
  if (SCOPED.includes(table)) {
    out = out.filter(f => f && f.col !== 'team_id');
    out.push({ op: 'eq', col: 'team_id', val: actor.teamId });
  }
  // 通知是私人的：只给自己看，别把别人的派单提醒、入团申请也摆出来
  if (table === 'notifications') {
    out = out.filter(f => f && f.col !== 'owner_id');
    out.push({ op: 'eq', col: 'owner_id', val: actor.id });
  }
  return out;
}

/* ---------- 执行 ---------- */
/** 唯一索引撞了的时候，别把 SQLite 的英文原文丢给用户 */
function friendlyError(e, q) {
  const msg = String((e && e.message) || e || '');
  if (msg.indexOf('profiles_team_name_key') >= 0) {
    const nm = (q && q.values && q.values.name) || '这个名字';
    return bad('团队里已经有叫「' + nm + '」的人了，换个名字，或先把原来那条改掉');
  }
  if (msg.indexOf('time_off_key') >= 0) return bad('这位师傅这一天已经排过休息了');
  if (msg.indexOf('team_req_key') >= 0) return bad('这个人已经提交过入团申请了');
  if (msg.indexOf('wx_app_openid_key') >= 0) return bad('这个微信号已经绑定过别的账号了');
  return e;
}

function run(actor, q) {
  try {
    return runInner(actor, q);
  } catch (e) {
    throw friendlyError(e, q);
  }
}

function runInner(actor, q) {
  const h = handle();
  const table = String(q.table || '');
  if (!TABLES[table]) throw bad('未知数据表：' + table);
  if (!actor || !actor.teamId) throw deny('请先加入团队后再操作');
  const action = q.action || 'select';
  assertCan(actor, table, action, q.values, q.filters);
  const filters = scopeFilters(actor, table, q.filters);

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
      values.team_id = actor.teamId;
      if (table === 'profiles') {
        if (values.pin_hash === undefined) values.pin_hash = null;
        if (!values.id) values.id = 'p_' + Math.random().toString(36).slice(2, 10);
        if (!values.user_id) values.user_id = values.id;
        if (values.active === undefined) values.active = 1;
        if (!values.team_role) values.team_role = 'member';
        if (values.need_profile === undefined) values.need_profile = 0;
      }
      if (table === 'appointments' && !values.owner_id) values.owner_id = actor.id;
      if (table === 'notifications') values.owner_id = values.owner_id || actor.id;
      if (table === 'email_logs') values.owner_id = values.owner_id || actor.id;
      if (table === 'time_off' && !isTeamAdmin(actor)) values.profile_id = actor.id;
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
    // 不允许「无条件更新全表」；settings 一个团队只有一行，是唯一例外
    if (!(q.filters || []).length && table !== 'settings') throw bad('拒绝无条件更新');
    const values = pick(table, q.values || {});
    // 谁改的、什么时候改的：由服务端盖章，前端传什么都不算数。
    // 只是补「已发信 / 已提醒」这类系统字段时不算人工改动，不盖改动章。
    if (table === 'appointments') {
      const auto = Object.keys(values).every(k => k === 'mailed_at' || k === 'reminded_at');
      if (!auto) {
        values.updated_at = localStamp();
        values.updater_id = actor.id;
        values.updater_name = actor.name;
      }
    }
    // 授权码留空 = 保持原来的（前端拿不到旧值，清空也没意义）
    if (table === 'mail_accounts' && !values.pass) delete values.pass;
    if (!Object.keys(values).length) return { data: [] };
    const where = buildWhere(filters);
    // 邮箱真的变了才要求重新验证：没变就保留已验证状态（否则每次保存资料都得重验一次）
    if (table === 'profiles' && Object.prototype.hasOwnProperty.call(values, 'email')) {
      const before = h.prepare(`SELECT email FROM profiles${where.sql}`).all(...where.params);
      const changed = before.some(r => String(r.email || '').trim().toLowerCase() !== String(values.email || '').trim().toLowerCase());
      if (changed) {
        values.email_verified_at = null;
        values.email_code = null;
        values.email_code_exp = null;
        values.email_code_tries = 0;
        values.email_code_sent_at = null;
      }
    }
    const sets = Object.keys(values).map(c => `${c} = ?`).join(',');
    h.prepare(`UPDATE ${table} SET ${sets}${where.sql}`).run(...Object.keys(values).map(c => values[c]), ...where.params);
    const rows = h.prepare(`SELECT * FROM ${table}${where.sql}`).all(...where.params).map(r => shape(table, r));
    return { data: rows };
  }

  if (action === 'delete') {
    // 团队过滤是后加的，这里必须看前端原本有没有带条件
    if (!(q.filters || []).length) throw bad('拒绝无条件删除');
    const where = buildWhere(filters);
    const rows = h.prepare(`SELECT * FROM ${table}${where.sql}`).all(...where.params);
    h.prepare(`DELETE FROM ${table}${where.sql}`).run(...where.params);
    return { data: rows.map(r => shape(table, r)) };
  }

  throw bad('不支持的操作：' + action);
}

/* ---------- 备份 / 恢复 ---------- */
function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/** 整库快照（含所有团队）。用 VACUUM INTO，WAL 下也是安全的 */
function snapshot() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  // 同一秒多次备份会撞名，而 VACUUM INTO 要求目标文件不存在
  let dest = '';
  for (let i = 0; i < 20; i++) {
    dest = path.join(BACKUP_DIR, 'crewgo-' + stamp() + '-' + crypto.randomBytes(3).toString('hex') + '.db');
    if (!fs.existsSync(dest)) break;
  }
  handle().exec("VACUUM INTO '" + dest.replace(/'/g, "''") + "'");
  return dest;
}

/** 用上传的 .db 替换当前库。自动先备份，失败不动原库 */
function replaceDatabase(buf) {
  if (!buf || buf.length < 1024) throw bad('文件太小，不像是数据库文件');
  if (String(buf.slice(0, 16)) !== 'SQLite format 3\u0000') throw bad('这不是 SQLite 数据库文件（.db / .sqlite）');

  const tmp = DB_FILE + '.importing';
  fs.writeFileSync(tmp, buf);
  let tables = [];
  try {
    const probe = new DatabaseSync(tmp);
    tables = probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    probe.close();
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (err) { /* ignore */ }
    throw bad('数据库文件损坏，无法读取：' + e.message);
  }
  if (!tables.includes('profiles') || !tables.includes('appointments')) {
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    throw bad('这个数据库不是速派导出的（缺少 profiles / appointments 表）');
  }

  let keep;
  try {
    keep = snapshot(); // 万一导入后不满意，还能退回去
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (err) { /* ignore */ }
    throw bad('导入前的自动备份失败，已取消：' + e.message);
  }
  try { handle().close(); } catch (e) { /* ignore */ }
  for (const f of [DB_FILE + '-wal', DB_FILE + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* ignore */ } }
  fs.renameSync(tmp, DB_FILE);
  open(); // 重新打开并把老结构迁移到新版本
  return { tables: tables.length, backup: keep };
}

/** 给定时任务 / 团队接口用的直接访问（不做团队过滤，调用方自己负责） */
function raw() { return handle(); }

module.exports = {
  open, run, raw, snapshot, replaceDatabase, shape, bad, deny,
  DATA_DIR, DB_FILE, BACKUP_DIR, TABLES, SCOPED, localStamp,
  genTeamCode, newTeamCode, normCode, CODE_RE, ensureTeamSettings, seedMailAccount,
  normPhone, phoneError, PHONE_RE, isTeamAdmin, isOwner, todayStr
};
