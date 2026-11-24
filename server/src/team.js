'use strict';
/**
 * 团队：数据按团队隔离，注册后必须凭团队码申请、管理员同意才能看到团队数据。
 *   · 团队码：3 位大写字母 + 6 位数字（例：ABC123456），创建团队时随机生成
 *   · 角色：owner（团队统筹，最高权限）> admin（管理员，可审批）> member（普通成员）
 */
const crypto = require('node:crypto');
const store = require('./store');

const raw = () => store.raw();
const bad = store.bad;
const deny = store.deny;

const ROLE_LABEL = { owner: '团队统筹', admin: '管理员', member: '成员' };
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

/** 创建团队：创建人自动成为 ownerd（团队统筹），同时补一行 settings */
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

/** 凭团队码申请加入。团队开了「免审批」就直接进，否则生成待审申请 */
function joinByCode(profile, code, message) {
  if (profile.team_id) throw bad('你已经在一个团队里了');
  const team = teamByCode(code);
  if (!team) throw bad('团队码不对，请向团队统筹确认（3 位大写字母 + 6 位数字）');
  if (team.allow_direct === 1) {
    raw().prepare("UPDATE profiles SET team_id = ?, team_role = 'member' WHERE id = ?").run(team.id, profile.id);
    return { joined: true, team: publicTeam(team) };
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
  if (!store.isTeamAdmin(actor)) throw deny('只有团队统筹和管理员能操作');
}

function listRequests(actor) {
  requireAdmin(actor);
  return raw().prepare(
    "SELECT r.id, r.profile_id, r.message, r.created_at, p.name, p.phone, p.email, p.role, p.created_at AS profile_created_at, " +
    "CASE WHEN p.team_id IS NULL THEN 0 ELSE 1 END AS already_in_team " +
    "FROM team_requests r JOIN profiles p ON p.id = r.profile_id " +
    "WHERE r.team_id = ? AND r.status = 'pending' ORDER BY r.id ASC"
  ).all(actor.teamId);
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
  try {
    raw().prepare("UPDATE profiles SET team_id = ?, team_role = 'member', active = 1 WHERE id = ?").run(actor.teamId, p.id);
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
      .run(actor.teamId, p.id, '已加入团队', '你的入团申请通过了，现在可以看到团队的排期和预约单。');
  } catch (e) { /* 通知失败不影响审批 */ }
  return { ok: true, approved: true };
}

function members(actor) {
  if (!actor.teamId) throw deny('请先加入团队');
  return raw().prepare(
    'SELECT id, name, phone, email, role, team_role, active, color, avatar, created_at, last_login_at ' +
    'FROM profiles WHERE team_id = ? ORDER BY CASE team_role WHEN \'owner\' THEN 0 WHEN \'admin\' THEN 1 ELSE 2 END, created_at'
  ).all(actor.teamId).map(r => Object.assign({}, r, {
    role_label: ROLE_LABEL[r.team_role] || r.team_role,
    wx_bound: !!raw().prepare('SELECT 1 AS x FROM wx_accounts WHERE profile_id = ? LIMIT 1').get(r.id)
  }));
}

function setRole(actor, profileId, role) {
  if (!store.isOwner(actor)) throw deny('只有团队统筹能任免管理员');
  if (TEAM_ROLES.indexOf(role) < 0 || role === 'owner') throw bad('只能设为管理员或成员');
  const p = raw().prepare('SELECT * FROM profiles WHERE id = ? AND team_id = ?').get(String(profileId), actor.teamId);
  if (!p) throw bad('成员不存在');
  if (p.team_role === 'owner') throw bad('队长不能被降级，需要先转让队长');
  raw().prepare('UPDATE profiles SET team_role = ? WHERE id = ?').run(role, p.id);
  return { ok: true };
}

function removeMember(actor, profileId) {
  requireAdmin(actor);
  const p = raw().prepare('SELECT * FROM profiles WHERE id = ? AND team_id = ?').get(String(profileId), actor.teamId);
  if (!p) throw bad('成员不存在');
  if (p.team_role === 'owner') throw deny('不能移除团队统筹');
  if (p.team_role === 'admin' && !store.isOwner(actor)) throw deny('只有团队统筹能移除管理员');
  raw().prepare('UPDATE profiles SET team_id = NULL, team_role = ?, role = ? WHERE id = ?').run('member', 'tech', p.id);
  return { ok: true };
}

/** 自己退出团队：数据留在团队里，人回到「待加入」状态 */
function leave(actor) {
  if (!actor.teamId) throw bad('你还没加入团队');
  if (store.isOwner(actor)) throw bad('你是团队统筹，需要先把队长转给别人或解散团队');
  raw().prepare("UPDATE profiles SET team_id = NULL, team_role = 'member' WHERE id = ?").run(actor.id);
  return true;
}

function transferOwner(actor, profileId) {
  if (!store.isOwner(actor)) throw deny('只有团队统筹能转让');
  const p = raw().prepare('SELECT * FROM profiles WHERE id = ? AND team_id = ?').get(String(profileId), actor.teamId);
  if (!p) throw bad('成员不存在');
  if (p.id === actor.id) throw bad('你已经是队长了');
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
  if (!store.isOwner(actor)) throw deny('只有团队统筹能改加入方式');
  raw().prepare('UPDATE teams SET allow_direct = ? WHERE id = ?').run(allow ? 1 : 0, actor.teamId);
  return { ok: true };
}

function resetCode(actor) {
  if (!store.isOwner(actor)) throw deny('只有团队统筹能重置团队码');
  const code = store.newTeamCode();
  raw().prepare('UPDATE teams SET code = ? WHERE id = ?').run(code, actor.teamId);
  return { code };
}

/** 解散团队：把人踢回未加入，删掉团队数据（含业务数据） */
function dissolve(actor, confirmName) {
  if (!store.isOwner(actor)) throw deny('只有团队统筹能解散团队');
  const team = teamById(actor.teamId);
  if (!team) throw bad('团队不存在');
  if (String(confirmName || '').trim() !== team.name) throw bad('团队名称输入不对，已取消');
  raw().exec('BEGIN');
  try {
    for (const t of ['appointments', 'notifications', 'projects', 'email_logs', 'settings', 'team_requests']) {
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

/** 按姓名找账号（团队内可能重名，登录时逐条验 PIN） */
function findByName(name) {
  return raw().prepare('SELECT * FROM profiles WHERE lower(name) = lower(?) AND active = 1').all(String(name || '').trim());
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
  ROLE_LABEL, TEAM_ROLES, ROLE_VALUES, newProfileId, findByName,
  teamById, teamByCode, publicTeam, myRequest, createTeam, joinByCode, cancelRequest,
  listRequests, decide, members, setRole, removeMember, leave, transferOwner,
  rename, setAllowDirect, resetCode, dissolve, stats
};
