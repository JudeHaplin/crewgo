'use strict';
/**
 * 排期校验
 *   1. 同一个人在同一天同一时段不能被派到两条单上（全天和任何时段都算撞）
 *   2. 维修工排了休息的日子不能被预约
 * 前端会先在本地算一遍给即时提示，服务端在写库前再算一遍兜底。
 */
const store = require('./store');

const raw = () => store.raw();
const ACTIVE = "status <> '已取消'";

/** 时段重叠：全天与任何时段都冲突，其余只有相同才冲突 */
function slotOverlap(a, b) {
  const x = a || '上午';
  const y = b || '上午';
  if (x === y) return true;
  return x === '全天' || y === '全天';
}

/* 排休可以是半天：全天 / 上午 / 下午 */
const PARTS = ['全天', '上午', '下午'];
const normPart = p => (PARTS.indexOf(String(p || '')) >= 0 ? String(p) : '全天');

/** 这天这个时段算不算休息：排全天 → 都算；排半天 → 只有同名时段算 */
function offCovers(part, slot) {
  const p = normPart(part);
  if (p === '全天') return true;
  const s = String(slot || '上午');
  if (s === '全天') return true;
  return p === s;
}

function resolveTech(teamId, techId, techName) {
  if (techId) {
    const row = raw().prepare('SELECT * FROM profiles WHERE id = ? AND team_id = ?').get(String(techId), teamId);
    if (row) return row;
  }
  if (techName) {
    return raw().prepare('SELECT * FROM profiles WHERE team_id = ? AND lower(name) = lower(?)').get(teamId, String(techName)) || null;
  }
  return null;
}

/**
 * @returns {{ conflicts: Array, off: Object|null, tech: Object|null }}
 */
function check(teamId, opt) {
  const out = { conflicts: [], off: null, tech: null };
  if (!teamId || !opt || !opt.date) return out;
  const tech = resolveTech(teamId, opt.tech_id, opt.tech_name);
  if (!tech) return out;
  out.tech = { id: tech.id, name: tech.name };

  const dayRows = raw().prepare(
    'SELECT * FROM appointments WHERE team_id = ? AND visit_date = ? AND ' + ACTIVE
  ).all(teamId, opt.date);
  const excludeId = opt.exclude_id ? Number(opt.exclude_id) : 0;
  for (const a of dayRows) {
    if (excludeId && Number(a.id) === excludeId) continue;
    const same = a.tech_id ? String(a.tech_id) === String(tech.id) : String(a.tech_name || '') === String(tech.name);
    if (!same) continue;
    if (!slotOverlap(a.time_slot, opt.slot)) continue;
    out.conflicts.push({
      id: a.id,
      visit_date: a.visit_date,
      time_slot: a.time_slot,
      project_name: a.project_name || '',
      address: a.address || '',
      content: a.content || '',
      status: a.status || ''
    });
  }

  const off = raw().prepare('SELECT * FROM time_off WHERE team_id = ? AND profile_id = ? AND off_date = ?')
    .get(teamId, tech.id, opt.date);
  if (off && offCovers(off.part, opt.slot)) {
    out.off = { id: off.id, off_date: off.off_date, part: normPart(off.part), reason: off.reason || '' };
  }
  return out;
}

/** 区间内所有人的休息日（日历上用） */
function listOff(teamId, from, to) {
  if (!teamId) return [];
  const rows = raw().prepare(
    'SELECT o.*, p.name, p.color FROM time_off o LEFT JOIN profiles p ON p.id = o.profile_id ' +
    'WHERE o.team_id = ? AND o.off_date >= ? AND o.off_date <= ? ORDER BY o.off_date, p.name'
  ).all(teamId, from || '0000-01-01', to || '9999-12-31');
  return rows.map(r => ({
    id: Number(r.id), profile_id: r.profile_id, name: r.name || '（已移除）',
    color: r.color || '#8b93a3', off_date: r.off_date, part: normPart(r.part), reason: r.reason || ''
  }));
}

/** 某天有多少人排休（看板角标用） */
function offOnDate(teamId, date) {
  return listOff(teamId, date, date);
}

/** 批量排休：把区间里每一天都写进去（已存在就跳过；同一天先排上午再排下午会合并成全天） */
/** 同一天的起止时段合起来算哪天休：上午→下午 = 全天，上午→上午 = 上午 */
function mergePart(fromPart, toPart) {
  const x = normPart(fromPart);
  const y = normPart(toPart);
  if (x === '全天' || y === '全天') return '全天';
  if (x === y) return x;
  return '全天';
}

/**
 * 排休：维修工只排单日（part），管理员可以排一段。
 *   part     起始日休哪个时段（下午 = 那天上午还上班）
 *   endPart  结束日休到哪个时段（上午 = 那天下午就上班了）
 * 中间的日子一律全天。
 */
function addOff(teamId, profileId, from, to, reason, part, endPart) {
  const start = String(from || '').slice(0, 10);
  const end = String(to || from || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw store.bad('开始日期格式不对');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) throw store.bad('结束日期格式不对');
  if (end < start) throw store.bad('结束日期不能早于开始日期');
  const member = raw().prepare('SELECT * FROM profiles WHERE id = ? AND team_id = ?').get(String(profileId), teamId);
  if (!member) throw store.bad('人员不存在');
  const days = Math.round((new Date(end) - new Date(start)) / 86400000) + 1;
  if (days > 180) throw store.bad('一次最多排 180 天');

  const fromPart = normPart(part);
  const toPart = normPart(endPart === undefined || endPart === null || endPart === '' ? part : endPart);
  if (days === 1 && fromPart === '下午' && toPart === '上午') {
    throw store.bad('同一天里结束时段不能早于开始时段');
  }

  const find = raw().prepare('SELECT id, part FROM time_off WHERE team_id = ? AND profile_id = ? AND off_date = ?');
  const widen = raw().prepare("UPDATE time_off SET part = '全天' WHERE id = ?");
  const stmt = raw().prepare('INSERT OR IGNORE INTO time_off (team_id, profile_id, off_date, part, reason) VALUES (?,?,?,?,?)');
  let added = 0, merged = 0;
  const note = String(reason || '').slice(0, 60) || null;
  const d = new Date(start + 'T00:00:00');
  for (let i = 0; i < days; i++) {
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    let want;
    if (days === 1) want = mergePart(fromPart, toPart);
    else if (i === 0) want = fromPart;
    else if (i === days - 1) want = toPart;
    else want = '全天';
    const hit = find.get(teamId, member.id, key);
    if (!hit) {
      const info = stmt.run(teamId, member.id, key, want, note);
      if (info.changes) added++;
    } else if (normPart(hit.part) !== want && normPart(hit.part) !== '全天') {
      // 上午 + 下午 = 全天；已有半天又排全天也是全天
      widen.run(hit.id);
      merged++;
    }
    d.setDate(d.getDate() + 1);
  }
  return { added, merged, days, part: fromPart, end_part: toPart, name: member.name };
}

module.exports = { slotOverlap, check, listOff, offOnDate, addOff, resolveTech, PARTS, normPart, offCovers };
