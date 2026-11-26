'use strict';
/**
 * 备份与导入
 *   导出：整库 .db（统筹管理员）/ 团队 JSON（管理员）
 *   导入：.db 整库恢复、.json 按团队合并、.csv/.xlsx 表格导入（预约单或人员名单）
 * 所有写操作都带 team_id，导入的表格只会落在当前团队里。
 */
const fs = require('node:fs');
const store = require('./store');
const sheet = require('./sheet');
const team = require('./team');

const raw = () => store.raw();
const bad = store.bad;

const VERSION = (() => { try { return require('../package.json').version; } catch (e) { return '0'; } })();

const SLOTS = ['全天', '上午', '下午', '晚上'];
const STATUSES = ['待确认', '已确认', '进行中', '已完成', '已取消'];
const COLORS = ['#2b6ef6', '#e5484d', '#0f9d76', '#f59e0b', '#6d4aff', '#0891b2', '#d94690', '#65a30d'];

/* ============================ 导出 ============================ */
const TABLES_FOR_TEAM = ['profiles', 'projects', 'appointments', 'notifications', 'settings', 'email_logs'];

/* JSON 备份是给人看的、也常被转手（微信/网盘/邮件），明文密钥一律不带出去：
   邮箱授权码、微信 AppSecret、PushPlus token 属于「拿到就能冒用」，导入后重新填一次成本很低。
   密码只存 scrypt 哈希、不可逆，保留下来才能让别人用原密码直接登录。 */
const SECRET_COLS = ['smtp_pass', 'wx_mp_secret', 'wx_qr_secret', 'pushplus_token', 'push_token'];

function exportTeam(teamId) {
  const t = team.teamById(teamId);
  if (!t) throw bad('团队不存在');
  const data = {};
  for (const name of TABLES_FOR_TEAM) {
    data[name] = raw().prepare('SELECT * FROM ' + name + ' WHERE team_id = ? ORDER BY rowid').all(teamId).map(row => {
      const out = Object.assign({}, row);
      for (const c of SECRET_COLS) if (c in out) out[c] = null;
      return out;
    });
  }
  // settings 是单行对象，导成对象更好读
  const s = data.settings[0] || null;
  data.settings = s;
  return {
    app: 'crewgo',
    kind: 'team-backup',
    version: VERSION,
    exported_at: new Date().toISOString(),
    team: { name: t.name, code: t.code },
    redacted: SECRET_COLS,
    counts: {
      profiles: data.profiles.length,
      projects: data.projects.length,
      appointments: data.appointments.length,
      notifications: data.notifications.length
    },
    data
  };
}

function exportFileName(ext) {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return '速派备份-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.' + ext;
}

/* ============================ JSON 导入 ============================ */
function importTeamJson(actor, payload, dry) {
  if (!payload || payload.app !== 'crewgo' || !payload.data) throw bad('这不是速派的备份文件（缺少 app/data 字段）');
  const teamId = actor.teamId;
  const d = payload.data || {};
  const report = { kind: 'json', dry: !!dry, profiles: { add: 0, update: 0 }, projects: { add: 0, update: 0 }, appointments: { add: 0, skip: 0 } };

  const byName = name => raw().prepare('SELECT * FROM profiles WHERE team_id = ? AND lower(name) = lower(?)').get(teamId, String(name || ''));
  const projByName = name => raw().prepare('SELECT * FROM projects WHERE team_id = ? AND lower(name) = lower(?)').get(teamId, String(name || ''));

  const profileRows = Array.isArray(d.profiles) ? d.profiles : [];
  const projectRows = Array.isArray(d.projects) ? d.projects : [];
  const apptRows = Array.isArray(d.appointments) ? d.appointments : [];

  if (!dry) raw().exec('BEGIN');
  try {
    for (const p of projectRows) {
      if (!p.name) continue;
      const hit = projByName(p.name);
      if (hit) {
        report.projects.update++;
        if (!dry) raw().prepare('UPDATE projects SET address = ?, color = ?, active = ?, sort_order = ? WHERE id = ?')
          .run(p.address || hit.address, p.color || hit.color, p.active === 0 ? 0 : 1, p.sort_order || 0, hit.id);
      } else {
        report.projects.add++;
        if (!dry) raw().prepare('INSERT INTO projects (team_id, name, address, color, active, sort_order) VALUES (?,?,?,?,?,?)')
          .run(teamId, p.name, p.address || null, p.color || COLORS[0], p.active === 0 ? 0 : 1, p.sort_order || 0);
      }
    }

    for (const p of profileRows) {
      if (!p.name) continue;
      const hit = byName(p.name);
      if (hit) {
        report.profiles.update++;
        if (!dry) raw().prepare('UPDATE profiles SET phone = COALESCE(?, phone), email = COALESCE(?, email), role = ?, active = ? WHERE id = ?')
          .run(p.phone || null, p.email || null, p.role || hit.role, p.active === 0 ? 0 : 1, hit.id);
      } else {
        report.profiles.add++;
        if (!dry) {
          const id = p.id && !raw().prepare('SELECT 1 AS x FROM profiles WHERE id = ?').get(p.id) ? p.id : team.newProfileId();
          raw().prepare('INSERT INTO profiles (id, team_id, name, phone, email, role, color, push_token, pin_hash, active, user_id, team_role, need_profile) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)')
            .run(id, teamId, p.name, p.phone || null, p.email || null, p.role || 'tech', p.color || COLORS[0],
              p.push_token || null, p.pin_hash || null, p.active === 0 ? 0 : 1, id, 'member');
        }
      }
    }

    for (const a of apptRows) {
      if (!a.visit_date) { report.appointments.skip++; continue; }
      const dup = raw().prepare(
        'SELECT id FROM appointments WHERE team_id = ? AND visit_date = ? AND time_slot = ? AND IFNULL(address,\'\') = ? AND IFNULL(content,\'\') = ?'
      ).get(teamId, a.visit_date, a.time_slot || '上午', a.address || '', a.content || '');
      if (dup) { report.appointments.skip++; continue; }
      report.appointments.add++;
      if (!dry) {
        const proj = a.project_name ? projByName(a.project_name) : null;
        raw().prepare(
          'INSERT INTO appointments (team_id, owner_id, creator_name, project_id, project_name, tech_id, tech_name, visit_date, time_slot, address, content, contact_name, contact_phone, contact_email, status, priority, note, created_at) ' +
          'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
        ).run(teamId, actor.id, a.creator_name || null, proj ? proj.id : null, a.project_name || null,
          a.tech_id || null, a.tech_name || null, a.visit_date, a.time_slot || '上午', a.address || null,
          a.content || null, a.contact_name || null, a.contact_phone || null, a.contact_email || null,
          STATUSES.indexOf(a.status) >= 0 ? a.status : '待确认', a.priority === '加急' ? '加急' : '普通',
          a.note || null, a.created_at || new Date().toISOString());
      }
    }
    if (!dry) raw().exec('COMMIT');
  } catch (e) {
    if (!dry) raw().exec('ROLLBACK');
    throw e;
  }
  return report;
}

/* ============================ 表格导入 ============================ */
const ALIASES = {
  // 具体写法放前面：匹配是先「完全相同」再「包含」，否则「预定维修日期」会被泛化的「日期」抢走，
  // 一列之差就落到「报修日期」上去（真实台账里这两列挨着，很容易踩）
  visit_date: ['预定维修日期', '计划维修日期', '预计维修日期', '上门维修日期', '预约维修日期',
    '日期', '上门日期', '预约日期', '服务日期', 'date', 'visit_date'],
  time_slot: ['时段', '时间段', '时间', 'time', 'time_slot'],
  finish_date: ['实际维修日期', '实际完成日期', '完工日期', '完成日期', 'finish_date'],
  project_name: ['项目名称', '项目', '小区', '楼盘', 'project'],
  tech_name: ['维修人员', '人员', '维修工', '师傅', '工程师', '负责人', 'tech'],
  address: ['地址', '上门地址', '详细地址', 'address'],
  content: ['维修项目', '报修项目', '维修内容', '报修内容', '内容', '事项', '问题', '问题描述', '故障', 'content'],
  contact_name: ['预约人', '联系人', '业主', '客户', '报修人', 'contact'],
  contact_phone: ['预约人电话', '预约电话', '联系电话', '电话', '手机号', '手机', '联系方式', 'phone'],
  status: ['状态', '进度', 'status'],
  priority: ['优先级', '紧急程度', 'priority'],
  note: ['备注', '说明', 'note'],
  creator_name: ['创建人', '录入人', '派单人', '项目经理', 'creator'],
  // 人员表
  name: ['姓名', '名字', '人员姓名', 'name'],
  phone: ['手机号', '电话', '手机', '联系电话', 'phone'],
  email: ['邮箱', '邮件', '电子邮件', 'email'],
  role: ['身份', '角色', '岗位', 'role'],
  pin: ['pin', '密码', '登录密码', '初始密码']
};

function normKey(s) { return String(s || '').toLowerCase().replace(/[\s\-_()（）]/g, ''); }

/* 宽松匹配（包含关系）时容易误伤：台账里的「创建时间」「最后修改时间」含「时间」，
   一不留神就被当成「时段」。这类系统列一律排除。 */
const LOOSE_SKIP = {
  time_slot: /创建|修改|更新|录入|日期|date/i,
  visit_date: /创建|修改|更新|录入/i,
  content: /创建|修改/,
  // 「预约人电话」不能被当成「预约人」姓名列
  contact_name: /电话|手机|联系方式|号码|phone/i
};

function pickCol(header, field) {
  const alias = ALIASES[field] || [];
  const skip = LOOSE_SKIP[field];
  const norm = header.map(h => ({ raw: h, k: normKey(h) }));
  for (const a of alias) {
    const key = normKey(a);
    const hit = norm.find(x => x.k === key);
    if (hit) return hit.raw;
  }
  // 再宽松一点：包含关系（「联系电话（手机）」也能命中）
  for (const a of alias) {
    const key = normKey(a);
    if (key.length < 2) continue;
    const hit = norm.find(x => x.k.indexOf(key) >= 0 && !(skip && skip.test(x.k)));
    if (hit) return hit.raw;
  }
  return null;
}

function detectKind(header) {
  const has = f => !!pickCol(header, f);
  if (has('visit_date') && (has('address') || has('content') || has('tech_name'))) return 'appointments';
  if (has('name') && (has('phone') || has('role') || has('email'))) return 'profiles';
  if (has('visit_date')) return 'appointments';
  if (has('name')) return 'profiles';
  return null;
}

const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

/** 各种写法都尽量认出来，认不出返回 '' */
function normDate(v) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  if (!s) return '';
  // Excel 日期序列号（1900 起算，实际从 1899-12-30 加天数）
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 20000 && n < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
      return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
    }
  }
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  let m = s.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/);
  if (m) return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
  m = s.match(/^(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/);
  if (m) return new Date().getFullYear() + '-' + pad(m[1]) + '-' + pad(m[2]);
  const d = new Date(s);
  if (!isNaN(d.getTime()) && d.getFullYear() > 1990 && d.getFullYear() < 2100) return ymd(d);
  return '';
}

function normSlot(v) {
  const s = String(v || '').trim();
  if (!s) return '上午';
  if (SLOTS.indexOf(s) >= 0) return s;
  if (/全天|整日|all/i.test(s)) return '全天';
  if (/晚|夜|pm\s*[6-9]|1[89]:|2[0-3]:/i.test(s)) return '晚上';
  if (/下午|中午|午后|pm|1[2-7]:/i.test(s)) return '下午';
  if (/上午|早上|早晨|am|0?[6-9]:|1[01]:/i.test(s)) return '上午';
  return '上午';
}

function normStatus(v) {
  const s = String(v || '').trim();
  if (STATUSES.indexOf(s) >= 0) return s;
  if (/完成|done|完结/i.test(s)) return '已完成';
  if (/取消|cancel|作废/i.test(s)) return '已取消';
  if (/进行|processing|on\s*way|上门中/i.test(s)) return '进行中';
  if (/确认|confirm/i.test(s)) return '已确认';
  return '待确认';
}

function attr(val) {
  const s = String(val || '').trim();
  if (!s) return null;
  if (s.length > 40) return s.slice(0, 40);
  return s;
}

/** 干跑只解析不落库；commit 时才写 */
function importTable(actor, buf, filename, dry) {
  const teamId = actor.teamId;
  const parsed = sheet.parseTable(buf, filename);
  const { header, list } = sheet.toObjects(parsed.rows);
  if (!list.length) throw bad('表格里没有数据行（第一行应该是表头）');
  const kind = detectKind(header);
  if (!kind) {
    throw bad('认不出这是什么表。预约单表头需要「日期」，人员表头需要「姓名」+「手机号」。当前表头：' + header.slice(0, 8).join(' / '));
  }

  if (kind === 'profiles') return importProfiles(actor, list, header, dry);

  const c = {};
  for (const f of ['visit_date', 'time_slot', 'finish_date', 'project_name', 'tech_name', 'address', 'content',
    'contact_name', 'contact_phone', 'status', 'priority', 'note', 'creator_name']) {
    c[f] = pickCol(header, f);
  }

  const report = {
    kind: 'appointments', dry: !!dry, file: filename, sheet: parsed.kind,
    total: list.length, add: 0, skip: 0, bad: 0, errorRows: [],
    created: { projects: [], techs: [] }, sample: []
  };
  const projCache = {};
  const techCache = {};
  // 预览时库里还没有新行，靠这个集合模拟「同一份表里的重复」，让预览数字和真跑一致
  const drySeen = new Set();

  const findProject = name => {
    if (!name) return null;
    if (projCache[name] !== undefined) return projCache[name];
    let row = raw().prepare('SELECT * FROM projects WHERE team_id = ? AND lower(name) = lower(?)').get(teamId, name);
    if (!row) {
      // 预览（dry）也要如实报告「将会新建哪些」，否则用户以为不用建项目
      report.created.projects.push(name);
      if (!dry) {
        const info = raw().prepare('INSERT INTO projects (team_id, name, color, active) VALUES (?,?,?,1)')
          .run(teamId, attr(name), COLORS[Object.keys(projCache).length % COLORS.length]);
        row = raw().prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid);
      }
    }
    projCache[name] = row || null;
    return projCache[name];
  };

  const findTech = name => {
    if (!name) return null;
    if (techCache[name] !== undefined) return techCache[name];
    let row = raw().prepare('SELECT * FROM profiles WHERE team_id = ? AND lower(name) = lower(?)').get(teamId, name);
    if (!row) {
      report.created.techs.push(name);
      if (!dry) {
        const id = team.newProfileId();
        raw().prepare("INSERT INTO profiles (id, team_id, name, role, color, active, user_id, team_role, need_profile) VALUES (?,?,?,?,?,1,?,'member',0)")
          .run(id, teamId, attr(name), 'tech', COLORS[Object.keys(techCache).length % COLORS.length], id);
        row = raw().prepare('SELECT * FROM profiles WHERE id = ?').get(id);
      }
    }
    techCache[name] = row || null;
    return techCache[name];
  };

  if (!dry) raw().exec('BEGIN');
  try {
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const date = normDate(r[c.visit_date]);
      if (!date) {
        report.bad++;
        if (report.errorRows.length < 8) report.errorRows.push({ row: i + 2, why: '日期认不出：' + String(r[c.visit_date] || '(空)') });
        continue;
      }
      const slot = c.time_slot ? normSlot(r[c.time_slot]) : '全天'; // 台账常常只有日期、没有时段
      const address = attr(r[c.address]);
      const content = attr(r[c.content]);
      const projName = attr(r[c.project_name]);
      const techName = attr(r[c.tech_name]);

      // 「实际维修日期」有值就当已完成，否则待确认；表里明确写了状态则以表为准
      const statusRaw = c.status ? attr(r[c.status]) : '';
      let status = normStatus(statusRaw);
      if (!statusRaw || statusRaw === '待确认') {
        const fin = c.finish_date ? normDate(r[c.finish_date]) : '';
        if (fin) status = '已完成';
      }

      const dupKey = date + '|' + slot + '|' + (address || '') + '|' + (content || '');
      const dup = raw().prepare(
        "SELECT id FROM appointments WHERE team_id = ? AND visit_date = ? AND time_slot = ? AND IFNULL(address,'') = ? AND IFNULL(content,'') = ?"
      ).get(teamId, date, slot, address || '', content || '');
      if (dup || drySeen.has(dupKey)) { report.skip++; continue; }
      drySeen.add(dupKey);

      const proj = findProject(projName);
      const tech = findTech(techName);
      report.add++;
      if (report.sample.length < 5) {
        report.sample.push({ 日期: date, 时段: slot, 项目: projName || '', 人员: techName || '', 地址: address || '', 内容: content || '' });
      }
      if (!dry) {
        raw().prepare(
          'INSERT INTO appointments (team_id, owner_id, creator_name, project_id, project_name, tech_id, tech_name, visit_date, time_slot, address, content, contact_name, contact_phone, status, priority, note) ' +
          'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
        ).run(teamId, actor.id, attr(r[c.creator_name]) || actor.name, proj ? proj.id : null, projName || null,
          tech ? tech.id : null, techName || null, date, slot, address, content,
          attr(r[c.contact_name]), attr(r[c.contact_phone]),
          status, /加急|urgent|急/i.test(String(r[c.priority] || '')) ? '加急' : '普通',
          attr(r[c.note]));
      }
    }
    if (!dry) raw().exec('COMMIT');
  } catch (e) {
    if (!dry) raw().exec('ROLLBACK');
    throw e;
  }
  return report;
}

function importProfiles(actor, list, header, dry) {
  const teamId = actor.teamId;
  const c = {};
  for (const f of ['name', 'phone', 'email', 'role', 'pin']) c[f] = pickCol(header, f);
  if (!c.name) throw bad('人员表必须有「姓名」列');

  const report = {
    kind: 'profiles', dry: !!dry, total: list.length, add: 0, update: 0, skip: 0, bad: 0, errorRows: [],
    defaultPin: '1234', sample: []
  };

  if (!dry) raw().exec('BEGIN');
  try {
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const name = attr(r[c.name]);
      if (!name) { report.bad++; continue; }
      const phoneRaw = c.phone ? String(r[c.phone] || '').trim() : '';
      const phone = phoneRaw ? store.normPhone(phoneRaw) : '';
      if (phoneRaw && !store.PHONE_RE.test(phone)) {
        report.bad++;
        if (report.errorRows.length < 8) report.errorRows.push({ row: i + 2, why: name + ' 的手机号不是 11 位：' + phoneRaw });
        continue;
      }
      const email = c.email ? String(r[c.email] || '').trim() : '';
      const roleRaw = c.role ? String(r[c.role] || '').trim() : '';
      const role = /统筹|管理|admin/i.test(roleRaw) ? 'admin' : (/预约|客户|requester/i.test(roleRaw) ? 'requester' : 'tech');
      // 表格里是密码。新手设的至少 6 位，但老表格里可能还有 4 位的老 PIN，
      // 这里放宽到 4–64 只为了让历史表格能导入，界面上的新密码仍然要求 6 位起。
      const pinRaw = c.pin ? String(r[c.pin] || '').trim() : '';
      if (pinRaw && (pinRaw.length < 4 || pinRaw.length > 64)) {
        report.bad++;
        if (report.errorRows.length < 8) report.errorRows.push({ row: i + 2, why: name + ' 的密码长度不对（6–64 位）' });
        continue;
      }

      const hit = raw().prepare('SELECT * FROM profiles WHERE team_id = ? AND lower(name) = lower(?)').get(teamId, name);
      if (hit) {
        report.update++;
        if (!dry) {
          raw().prepare('UPDATE profiles SET phone = COALESCE(?, phone), email = COALESCE(?, email), role = ? WHERE id = ?')
            .run(phone || null, email || null, role, hit.id);
          if (pinRaw) {
            const auth = require('./auth');
            raw().prepare('UPDATE profiles SET pin_hash = ? WHERE id = ?').run(auth.hashPin(pinRaw), hit.id);
          }
        }
      } else {
        report.add++;
        if (report.sample.length < 5) report.sample.push({ 姓名: name, 手机号: phone, 身份: role });
        if (!dry) {
          const auth = require('./auth');
          const id = team.newProfileId();
          raw().prepare('INSERT INTO profiles (id, team_id, name, phone, email, role, color, pin_hash, active, user_id, team_role, need_profile) VALUES (?,?,?,?,?,?,?,?,1,?,\'member\',0)')
            .run(id, teamId, name, phone || null, email || null, role, COLORS[report.add % COLORS.length], auth.hashPin(pinRaw || '1234'), id);
        }
      }
    }
    if (!dry) raw().exec('COMMIT');
  } catch (e) {
    if (!dry) raw().exec('ROLLBACK');
    throw e;
  }
  return report;
}

/** 统一入口：按扩展名/魔数分派 */
function preview(actor, buf, filename, dry) {
  const name = String(filename || '').toLowerCase();
  if (/\.(db|sqlite|sqlite3)$/.test(name) || (buf.length > 16 && String(buf.slice(0, 15)) === 'SQLite format 3')) {
    if (!dry) throw bad('数据库文件请直接点「恢复整库」，不需要预览');
    const magicOk = String(buf.slice(0, 15)) === 'SQLite format 3';
    if (!magicOk) throw bad('这不是 SQLite 数据库文件');
    return { kind: 'db', file: filename, size: buf.length, requiresOwner: true };
  }
  if (/\.json$/.test(name)) {
    let payload = null;
    try { payload = JSON.parse(buf.toString('utf8')); } catch (e) { throw bad('JSON 解析失败：' + e.message); }
    return importTeamJson(actor, payload, dry);
  }
  return importTable(actor, buf, filename, dry);
}

module.exports = { exportTeam, exportFileName, preview, importTeamJson, importTable, importProfiles, normDate, normSlot, normStatus };
