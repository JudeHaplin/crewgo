'use strict';
/**
 * 团队：数据按团队隔离，注册后必须凭团队码申请、管理员同意才能看到团队数据。
 *   · 团队码：3 位大写字母 + 6 位数字（例：ABC123456），创建团队时随机生成
 *   · 角色：owner（统筹管理员，最高权限）> admin（管理员，可审批）> member（普通成员）
 */
const crypto = require('node:crypto');
const store = require('./store');
const auth = require('./auth');

const raw = () => store.raw();
const bad = store.bad;
const deny = store.deny;

const ROLE_LABEL = { owner: '统筹管理员', admin: '管理员', member: '成员' };
const TEAM_ROLES = ['owner', 'admin', 'member'];

function teamById(id) {
  if (!id) return null;
  return raw().prepare('SELECT * FROM teams WHERE id = ?').get(id) || null;
}

function teamByCode(code) {
  const c = store.normCode(code);
  if (!store.CODE_RE.test(c)) return null;
  return raw().prepare('SELECT * FROM teams WHERE code = ?').get(c) || null;
}

function publicTeam(t) {
  if (!t) return null;
  return { id: Number(t.id), name: t.name, code: t.code, owner_id: t.owner_id, allow_direct: t.allow_direct === 1, created_at: t.created_at };
}

function myRequest(profileId) {
  if (!profileId) return null;
  const row = raw().prepare(
    "SELECT r.*, t.name AS team_name, t.code AS team_code FROM team_requests r " +
    "LEFT JOIN teams t ON t.id = r.team_id WHERE r.profile_id = ? AND r.status = 'pending' " +
    "ORDER BY r.id DESC LIMIT 1"
  ).get(profileId);
  return row || null;
}

/** 创建团队：创建人自动成为 ownerd（统筹管理员），同时补一行 settings */
function createTeam(profile, name) {
  const nm = String(name || '').trim();
  if (nm.length < 2) throw bad('团队名称至少 2 个字');
  if (nm.length > 30) throw bad('团队名称最多 30 个字');
  if (profile.team_id) throw bad('你已经在「' + (teamById(profile.team_id) || {}).name + '」里了，先退出才能建新团队');

  const code = store.newTeamCode();
  const info = raw().prepare('INSERT INTO teams (name, code, owner_id) VALUES (?,?,?)').run(nm, code, profile.id);
  const teamId = Number(info.lastInsertRowid);
  raw().prepare("UPDATE profiles SET team_id = ?, team_role = 'owner', role = 'admin', active = 1 WHERE id = ?").run(teamId, profile.id);
  // 之前申请过别的团队、还在待审的，一并作废，避免管理员点通过把人抢走
  raw().prepare("UPDATE team_requests SET status = 'cancelled', decided_at = datetime('now','localtime') WHERE profile_id = ? AND status = 'pending'").run(profile.id);
  store.ensureTeamSettings(teamId);
  return { team: teamById(teamId), code };
}

/** 给团队所有管理员（统筹 + 管理员）发站内通知；发失败不影响主流程 */
function notifyTeamAdmins(teamId, title, body, exceptId) {
  try {
    const admins = raw().prepare(
      "SELECT id FROM profiles WHERE team_id = ? AND active = 1 AND team_role IN ('owner','admin')"
    ).all(teamId);
    const ins = raw().prepare('INSERT INTO notifications (team_id, owner_id, title, body) VALUES (?,?,?,?)');
    for (const a of admins) {
      if (exceptId && a.id === exceptId) continue;
      ins.run(teamId, a.id, title, body);
    }
  } catch (e) { /* 通知失败不影响入团/审批 */ }
}

/** 查团队里有没有同名档案（导入台账、老版本手建都很常见） */
function sameNameInTeam(teamId, name, exceptId) {
  if (!name) return null;
  return raw().prepare(
    'SELECT * FROM profiles WHERE team_id = ? AND id <> ? AND lower(trim(name)) = lower(trim(?))'
  ).get(teamId, exceptId || '', String(name)) || null;
}

/**
 * 把账号挂到团队上。
 * 2.0 起姓名不再唯一：团队里已经有同名的人，也只是「多了一个同名同事」，
 * 各用各的 8 位 ID、各看各的预约单，绝不自动搬数据（以前会自动合并，是个坑：
 * 顶着别人的名字注册就能继承别人的历史）。要合并只能由管理员手动「迁移数据」。
 */
function attachMember(p, teamId) {
  raw().prepare("UPDATE profiles SET team_id = ?, team_role = 'member', active = 1 WHERE id = ?").run(teamId, p.id);
  return { merged: null, duplicate: (sameNameInTeam(teamId, p.name, p.id) || {}).name || null };
}

/** 凭团队码申请加入。团队开了「免审批」就直接进，否则生成待审申请 */
function joinByCode(profile, code, message) {
  if (profile.team_id) throw bad('你已经在一个团队里了');
  const team = teamByCode(code);
  if (!team) throw bad('团队码不对，请向统筹管理员确认（3 位大写字母 + 6 位数字）');
  if (team.allow_direct === 1) {
    raw().exec('BEGIN');
    let dupName = null;
    try {
      dupName = attachMember(profile, team.id).duplicate;
      raw().exec('COMMIT');
    } catch (e) {
      raw().exec('ROLLBACK');
      throw e;
    }
    notifyTeamAdmins(team.id, '有新成员加入',
      profile.name + '（ID ' + (profile.code || '—') + '）凭团队码加入了团队。' +
      (dupName ? '团队里还有一位同名的人，是各自独立的两个账号。' : ''), profile.id);
    return { joined: true, duplicate: dupName, team: publicTeam(team) };
  }
  const exist = raw().prepare('SELECT * FROM team_requests WHERE team_id = ? AND profile_id = ?').get(team.id, profile.id);
  if (exist && exist.status === 'pending') return { joined: false, pending: true, team: publicTeam(team) };
  if (exist) {
    raw().prepare("UPDATE team_requests SET status = 'pending', message = ?, created_at = datetime('now','localtime'), decided_at = NULL, decided_by = NULL WHERE id = ?")
      .run(String(message || '').slice(0, 200) || null, exist.id);
  } else {
    raw().prepare('INSERT INTO team_requests (team_id, profile_id, message) VALUES (?,?,?)')
      .run(team.id, profile.id, String(message || '').slice(0, 200) || null);
  }
  // 有申请就得让管理员知道，否则没人会主动去翻「设置 → 团队」
  notifyTeamAdmins(team.id, '新的入团申请',
    profile.name + '（' + (profile.phone || '未填手机号') + '）申请加入团队，去「设置 → 团队」同意或拒绝。');
  return { joined: false, pending: true, team: publicTeam(team) };
}

/** 撤回自己的申请 */
function cancelRequest(profile) {
  const r = myRequest(profile.id);
  if (!r) throw bad('没有待审批的申请');
  raw().prepare("UPDATE team_requests SET status = 'cancelled', decided_at = datetime('now','localtime') WHERE id = ?").run(r.id);
  return true;
}

function requireAdmin(actor) {
  if (!actor.teamId) throw deny('请先加入团队');
  if (!store.isTeamAdmin(actor)) throw deny('只有统筹管理员和管理员能操作');
}

function listRequests(actor) {
  requireAdmin(actor);
  return raw().prepare(
    "SELECT r.id, r.profile_id, r.message, r.created_at, p.name, p.code, p.phone, p.email, p.role, p.created_at AS profile_created_at, " +
    "CASE WHEN p.team_id IS NULL THEN 0 ELSE 1 END AS already_in_team " +
    "FROM team_requests r JOIN profiles p ON p.id = r.profile_id " +
    "WHERE r.team_id = ? AND r.status = 'pending' ORDER BY r.id ASC"
  ).all(actor.teamId).map(r => Object.assign({}, r, {
    // 团队里已有同名的人：不再自动合并，只给管理员一个「有同名同事」的提示
    dup_name: (sameNameInTeam(actor.teamId, r.name, r.profile_id) || {}).name || null
  }));
}

function decide(actor, requestId, approve) {
  requireAdmin(actor);
  const r = raw().prepare('SELECT * FROM team_requests WHERE id = ? AND team_id = ?').get(Number(requestId), actor.teamId);
  if (!r) throw bad('申请不存在');
  if (r.status !== 'pending') throw bad('这条申请已经处理过了');
  const p = raw().prepare('SELECT * FROM profiles WHERE id = ?').get(r.profile_id);
  if (!p) throw bad('申请人账号已被删除');

  if (!approve) {
    raw().prepare("UPDATE team_requests SET status = 'rejected', decided_at = datetime('now','localtime'), decided_by = ? WHERE id = ?")
      .run(actor.id, r.id);
    return { ok: true, approved: false };
  }
  if (p.team_id) throw bad('这个人已经加入其他团队了');

  raw().exec('BEGIN');
  let dupName = null;
  try {
    dupName = attachMember(p, actor.teamId).duplicate;
    raw().prepare("UPDATE team_requests SET status = 'approved', decided_at = datetime('now','localtime'), decided_by = ? WHERE id = ?")
      .run(actor.id, r.id);
    raw().prepare("UPDATE team_requests SET status = 'cancelled', decided_at = datetime('now','localtime') WHERE profile_id = ? AND status = 'pending'")
      .run(p.id);
    raw().exec('COMMIT');
  } catch (e) {
    raw().exec('ROLLBACK');
    throw e;
  }
  try {
    raw().prepare('INSERT INTO notifications (team_id, owner_id, title, body) VALUES (?,?,?,?)')
      .run(actor.teamId, p.id, '已加入团队', '你的入团申请通过了，现在可以看到团队的排期和预约单。你的用户 ID 是 ' + (p.code || '') + '。');
  } catch (e) { /* 通知失败不影响审批 */ }
  return { ok: true, approved: true, duplicate: dupName, code: p.code || null };
}

function members(actor) {
  if (!actor.teamId) throw deny('请先加入团队');
  return raw().prepare(
    'SELECT id, name, code, phone, email, role, team_role, active, color, avatar, created_at, last_login_at ' +
    'FROM profiles WHERE team_id = ? ORDER BY CASE team_role WHEN \'owner\' THEN 0 WHEN \'admin\' THEN 1 ELSE 2 END, created_at'
  ).all(actor.teamId).map(r => Object.assign({}, r, {
    role_label: ROLE_LABEL[r.team_role] || r.team_role,
    wx_bound: !!raw().prepare('SELECT 1 AS x FROM wx_accounts WHERE profile_id = ? LIMIT 1').get(r.id)
  }));
}

function setRole(actor, profileId, role) {
  // 管理员之间权限相同：谁都能任命/降级其他人，唯独动不了统筹
  requireAdmin(actor);
  if (TEAM_ROLES.indexOf(role) < 0 || role === 'owner') throw bad('只能设为管理员或成员');
  const p = raw().prepare('SELECT * FROM profiles WHERE id = ? AND team_id = ?').get(String(profileId), actor.teamId);
  if (!p) throw bad('成员不存在');
  if (p.team_role === 'owner') throw deny('不能改动统筹管理员的身份，只能由他本人转让');
  if (p.id === actor.id) throw bad('不能修改自己的身份，让别的管理员来操作');
  raw().prepare('UPDATE profiles SET team_role = ? WHERE id = ?').run(role, p.id);
  return { ok: true, role: role };
}

function removeMember(actor, profileId) {
  requireAdmin(actor);
  const p = raw().prepare('SELECT * FROM profiles WHERE id = ? AND team_id = ?').get(String(profileId), actor.teamId);
  if (!p) throw bad('成员不存在');
  // 只有统筹不能被动：其他管理员之间权限相同，互相也能移出
  if (p.team_role === 'owner') throw deny('不能移除统筹管理员');
  raw().prepare('UPDATE profiles SET team_id = NULL, team_role = ?, role = ? WHERE id = ?').run('member', 'tech', p.id);
  return { ok: true };
}

/** 自己退出团队：数据留在团队里，人回到「待加入」状态 */
function leave(actor) {
  if (!actor.teamId) throw bad('你还没加入团队');
  if (store.isOwner(actor)) throw bad('你是统筹管理员，需要先把队长转给别人或解散团队');
  raw().prepare("UPDATE profiles SET team_id = NULL, team_role = 'member' WHERE id = ?").run(actor.id);
  return true;
}

/**
 * 转让统筹管理员：全团队只有一个，不能被「设置」出来，只能由现任统筹亲手交给别人。
 * 要求双重确认：输入自己的登录密码 + 手输「确认」两个字，防止误点。
 */
function transferOwner(actor, profileId, pin, confirmText) {
  if (!store.isOwner(actor)) throw deny('只有统筹管理员能转让');
  if (String(confirmText || '').trim() !== '确认') throw bad('请手动输入「确认」两个字再提交');
  const me = raw().prepare('SELECT * FROM profiles WHERE id = ?').get(actor.id) || {};
  if (!me.pin_hash) throw bad('你还没设置登录密码，不能转让');
  const typed = String(pin || '').trim();
  if (!typed) throw bad('请输入你的登录密码');
  if (!auth.verifyPin(typed, me.pin_hash)) throw deny('密码不对，转让没有执行');
  const p = raw().prepare('SELECT * FROM profiles WHERE id = ? AND team_id = ?').get(String(profileId), actor.teamId);
  if (!p) throw bad('成员不存在');
  if (p.id === actor.id) throw bad('你已经是统筹管理员了');
  if (p.active === 0) throw bad('这个账号已停用，先启用再转让');
  raw().exec('BEGIN');
  try {
    raw().prepare("UPDATE profiles SET team_role = 'owner', role = 'admin' WHERE id = ?").run(p.id);
    raw().prepare("UPDATE profiles SET team_role = 'admin' WHERE id = ?").run(actor.id);
    raw().prepare('UPDATE teams SET owner_id = ? WHERE id = ?').run(p.id, actor.teamId);
    raw().exec('COMMIT');
  } catch (e) {
    raw().exec('ROLLBACK');
    throw e;
  }
  try {
    raw().prepare('INSERT INTO notifications (team_id, owner_id, title, body) VALUES (?,?,?,?)')
      .run(actor.teamId, p.id, '你已成为统筹管理员', actor.name + ' 把统筹管理员转给了你：现在你可以配邮箱服务、导出数据、任免管理员。');
  } catch (e) { /* 通知失败不影响转让 */ }
  return { ok: true };
}

function rename(actor, name) {
  requireAdmin(actor);
  const nm = String(name || '').trim();
  if (nm.length < 2 || nm.length > 30) throw bad('团队名称 2–30 个字');
  raw().prepare('UPDATE teams SET name = ? WHERE id = ?').run(nm, actor.teamId);
  return { ok: true };
}

function setAllowDirect(actor, allow) {
  if (!store.isOwner(actor)) throw deny('只有统筹管理员能改加入方式');
  raw().prepare('UPDATE teams SET allow_direct = ? WHERE id = ?').run(allow ? 1 : 0, actor.teamId);
  return { ok: true };
}

function resetCode(actor) {
  if (!store.isOwner(actor)) throw deny('只有统筹管理员能重置团队码');
  const code = store.newTeamCode();
  raw().prepare('UPDATE teams SET code = ? WHERE id = ?').run(code, actor.teamId);
  return { code };
}

/** 解散团队：把人踢回未加入，删掉团队数据（含业务数据） */
function dissolve(actor, confirmName) {
  if (!store.isOwner(actor)) throw deny('只有统筹管理员能解散团队');
  const team = teamById(actor.teamId);
  if (!team) throw bad('团队不存在');
  if (String(confirmName || '').trim() !== team.name) throw bad('团队名称输入不对，已取消');
  raw().exec('BEGIN');
  try {
    for (const t of ['appointments', 'notifications', 'projects', 'email_logs', 'settings', 'team_requests', 'mail_accounts', 'time_off']) {
      raw().prepare('DELETE FROM ' + t + ' WHERE team_id = ?').run(team.id);
    }
    raw().prepare('UPDATE profiles SET team_id = NULL, team_role = ?, role = ? WHERE team_id = ?').run('member', 'tech', team.id);
    raw().prepare('DELETE FROM teams WHERE id = ?').run(team.id);
    raw().exec('COMMIT');
  } catch (e) {
    raw().exec('ROLLBACK');
    throw e;
  }
  return { ok: true };
}

/* ---------- 注册 / 账号 ---------- */
const ROLE_VALUES = ['admin', 'tech', 'requester'];

function newProfileId() {
  return 'p_' + crypto.randomBytes(5).toString('hex');
}

/** 按姓名找账号（团队内可能重名，登录时逐条验密码） */
function findByName(name) {
  return raw().prepare('SELECT * FROM profiles WHERE lower(name) = lower(?) AND active = 1').all(String(name || '').trim());
}

/** 按 8 位用户 ID 找账号（全局唯一，登录 / 找回密码都能用它精确定位到人） */
function findByCode(code) {
  const c = String(code || '').trim();
  if (!store.MEMBER_CODE_RE.test(c)) return null;
  return raw().prepare('SELECT * FROM profiles WHERE code = ? AND active = 1').get(c) || null;
}

/** 兜底查人：先按 8 位 ID，再按姓名（同名多于一个就报错，让用户改用 ID） */
function lookup(ident) {
  const key = String(ident || '').trim();
  if (!key) return { error: '请输入姓名或 8 位用户 ID' };
  if (store.MEMBER_CODE_RE.test(key)) {
    const row = findByCode(key);
    return row ? { row } : { error: '没有这个用户 ID：' + key };
  }
  const rows = findByName(key);
  if (!rows.length) return { error: '没找到「' + key + '」这个账号，换 8 位用户 ID 再试' };
  if (rows.length > 1) return { error: '有 ' + rows.length + ' 位同名的同事，请改用 8 位用户 ID' };
  return { row: rows[0] };
}

/**
 * 把一个人的业务数据整体迁到另一个账号上（管理员操作，同名重复账号靠它收拾）。
 * 迁完源账号删除：预约单（派单/负责人）、休息日、站内通知、发信记录、附件归属、微信绑定。
 * 目标账号缺手机号/邮箱时，用源账号的补上（本来就是同一个人）。
 */
function migrateMember(actor, fromId, toId) {
  requireAdmin(actor);
  const from = raw().prepare('SELECT * FROM profiles WHERE id = ? AND team_id = ?').get(String(fromId || ''), actor.teamId);
  const to = raw().prepare('SELECT * FROM profiles WHERE id = ? AND team_id = ?').get(String(toId || ''), actor.teamId);
  if (!from || !to) throw bad('两个账号都要在本团队里');
  if (from.id === to.id) throw bad('源账号和目标账号不能是同一个人');
  if (from.team_role === 'owner') throw deny('统筹管理员的数据不能迁移，先把统筹身份转让出去');

  const n = r => Number((r && r.changes) || 0);
  const counts = { appointments: 0, owned: 0, timeOff: 0, notifications: 0, mails: 0, attachments: 0, wx: 0 };
  raw().exec('BEGIN');
  try {
    counts.appointments = n(raw().prepare('UPDATE appointments SET tech_id = ?, tech_name = ? WHERE team_id = ? AND tech_id = ?')
      .run(to.id, to.name, actor.teamId, from.id));
    counts.owned = n(raw().prepare('UPDATE appointments SET owner_id = ? WHERE team_id = ? AND owner_id = ?')
      .run(to.id, actor.teamId, from.id));
    // 休息日：两边同一天都休会撞 (team_id, profile_id, off_date)，源账号重复的那些天先删掉
    raw().prepare('DELETE FROM time_off WHERE profile_id = ? AND off_date IN (SELECT off_date FROM time_off WHERE profile_id = ?)').run(from.id, to.id);
    counts.timeOff = n(raw().prepare('UPDATE time_off SET profile_id = ? WHERE profile_id = ?').run(to.id, from.id));
    counts.notifications = n(raw().prepare('UPDATE notifications SET owner_id = ? WHERE owner_id = ?').run(to.id, from.id));
    counts.mails = n(raw().prepare('UPDATE email_logs SET owner_id = ? WHERE owner_id = ?').run(to.id, from.id));
    counts.attachments = n(raw().prepare('UPDATE attachments SET owner_id = ? WHERE owner_id = ?').run(to.id, from.id));
    // 微信绑定：目标已绑过就以目标的为准（一个微信号只能对一个账号）
    const toWx = raw().prepare('SELECT 1 AS x FROM wx_accounts WHERE profile_id = ? LIMIT 1').get(to.id);
    if (toWx) raw().prepare('DELETE FROM wx_accounts WHERE profile_id = ?').run(from.id);
    else counts.wx = n(raw().prepare('UPDATE wx_accounts SET profile_id = ? WHERE profile_id = ?').run(to.id, from.id));
    raw().prepare('DELETE FROM team_requests WHERE profile_id = ?').run(from.id);
    raw().prepare('DELETE FROM sessions WHERE profile_id = ?').run(from.id);
    if (!String(to.phone || '').trim() && from.phone) {
      raw().prepare('UPDATE profiles SET phone = ? WHERE id = ?').run(from.phone, to.id);
    }
    if (!String(to.email || '').trim() && from.email) {
      raw().prepare('UPDATE profiles SET email = ?, email_verified_at = ? WHERE id = ?').run(from.email, from.email_verified_at || null, to.id);
    }
    raw().prepare('DELETE FROM profiles WHERE id = ?').run(from.id);
    raw().exec('COMMIT');
  } catch (e) {
    raw().exec('ROLLBACK');
    throw e;
  }
  try {
    raw().prepare('INSERT INTO notifications (team_id, owner_id, title, body) VALUES (?,?,?,?)')
      .run(actor.teamId, to.id, '有数据迁入你的账号',
        actor.name + ' 把「' + from.name + '（ID ' + (from.code || '—') + '）」的数据并到了你的账号（ID ' + (to.code || '—') + '）：预约单 ' +
        counts.appointments + ' 条、休息日 ' + counts.timeOff + ' 天。');
  } catch (e) { /* 通知失败不影响迁移结果 */ }
  return {
    ok: true,
    from: { id: from.id, name: from.name, code: from.code || null },
    to: { id: to.id, name: to.name, code: to.code || null },
    counts: counts
  };
}

function stats(teamId) {
  const t = teamById(teamId);
  if (!t) return null;
  const count = sql => Number(raw().prepare(sql).get(teamId).n);
  return {
    members: count('SELECT COUNT(*) AS n FROM profiles WHERE team_id = ?'),
    pending: count("SELECT COUNT(*) AS n FROM team_requests WHERE team_id = ? AND status = 'pending'"),
    appointments: count('SELECT COUNT(*) AS n FROM appointments WHERE team_id = ?'),
    projects: count('SELECT COUNT(*) AS n FROM projects WHERE team_id = ?')
  };
}

module.exports = {
  ROLE_LABEL, TEAM_ROLES, ROLE_VALUES, newProfileId, findByName, findByCode, lookup, migrateMember,
  teamById, teamByCode, publicTeam, myRequest, createTeam, joinByCode, cancelRequest,
  listRequests, decide, members, setRole, removeMember, leave, transferOwner,
  rename, setAllowDirect, resetCode, dissolve, stats
};
