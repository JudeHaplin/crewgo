'use strict';
/**
 * 登录会话（设备管理）
 * ------------------------------------------------------------
 * 令牌本身是无状态的（签名 + 到期时间），单靠它没法「踢掉某台设备」。
 * 所以每次登录额外在 sessions 表里记一行，令牌里带 sid 指过来：
 *   - 单台下线：把那一行标记 revoked，令牌立刻失效
 *   - 改密码 / 全部下线：profiles.token_version +1，所有令牌（含升级前签发的）一起失效
 * 老版本签发的令牌没有 sid，仍然可用（靠 tv 兜住），90 天内自然淘汰。
 */
const crypto = require('node:crypto');
const store = require('./store');

/** 5 分钟内重复请求不重复写库，避免每张图片都 update 一次 */
const TOUCH_MS = 5 * 60 * 1000;
const lastTouch = new Map();

const raw = () => store.raw();
const newId = () => 's_' + crypto.randomBytes(9).toString('base64url');

/** 客户端 IP 去掉 IPv6 映射前缀，方便人看 */
function cleanIp(ip) {
  const v = String(ip || '').trim();
  if (!v) return '';
  return v.replace(/^::ffff:/i, '').slice(0, 64);
}

function create(profileId, req) {
  const id = newId();
  const ua = String((req && req.headers && req.headers['user-agent']) || '').slice(0, 300);
  const ip = cleanIp(req && req.socket ? req.socket.remoteAddress : '');
  raw().prepare('INSERT INTO sessions (id, profile_id, ua, ip) VALUES (?,?,?,?)').run(id, profileId, ua, ip);
  lastTouch.set(id, Date.now());
  return id;
}

/**
 * 登录时用：同一个浏览器 + 同一个 IP 再登一次，视为同一台设备，复用原来那行，
 * 免得「退出再登」或换网络前反复登录把设备列表刷成几十条。
 */
function createOrReuse(profileId, req) {
  const ua = String((req && req.headers && req.headers['user-agent']) || '').slice(0, 300);
  const ip = cleanIp(req && req.socket ? req.socket.remoteAddress : '');
  const hit = raw().prepare(
    'SELECT id FROM sessions WHERE profile_id = ? AND revoked_at IS NULL AND ua = ? AND ip = ? ' +
    "AND last_seen_at > datetime('now','localtime','-30 day') ORDER BY last_seen_at DESC LIMIT 1"
  ).get(profileId, ua, ip);
  if (hit) {
    raw().prepare("UPDATE sessions SET last_seen_at = datetime('now','localtime') WHERE id = ?").run(hit.id);
    lastTouch.set(hit.id, Date.now());
    return hit.id;
  }
  return create(profileId, req);
}

/** 只认没被撤销的会话；找不到就是失效 */function get(id) {
  if (!id) return null;
  return raw().prepare('SELECT * FROM sessions WHERE id = ? AND revoked_at IS NULL').get(String(id)) || null;
}

function touch(id) {
  if (!id) return;
  const now = Date.now();
  const prev = lastTouch.get(id) || 0;
  if (now - prev < TOUCH_MS) return;
  lastTouch.set(id, now);
  try {
    raw().prepare("UPDATE sessions SET last_seen_at = datetime('now','localtime') WHERE id = ? AND revoked_at IS NULL").run(id);
  } catch (e) { /* 会话已被清理，不打断请求 */ }
}

function revoke(profileId, id) {
  const r = raw().prepare("UPDATE sessions SET revoked_at = datetime('now','localtime') WHERE id = ? AND profile_id = ? AND revoked_at IS NULL")
    .run(String(id), profileId);
  lastTouch.delete(String(id));
  return Number(r.changes || 0) > 0;
}

/** 撤销这个人的所有会话；keepId 是「我自己这台」，可以留下来 */
function revokeAll(profileId, keepId) {
  const sql = "UPDATE sessions SET revoked_at = datetime('now','localtime') WHERE profile_id = ? AND revoked_at IS NULL";
  const r = keepId
    ? raw().prepare(sql + ' AND id <> ?').run(profileId, String(keepId))
    : raw().prepare(sql).run(profileId);
  for (const k of Array.from(lastTouch.keys())) if (k !== keepId) lastTouch.delete(k);
  return Number(r.changes || 0);
}

function listOf(profileId) {
  return raw().prepare(
    'SELECT id, ua, ip, created_at, last_seen_at FROM sessions ' +
    "WHERE profile_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC"
  ).all(profileId);
}

/**
 * 把某人所有令牌作废：版本号 +1 并清空会话记录。
 * 三处会用到：本人改密码、管理员重设密码、本人点「退出所有设备」。
 */
function invalidateAll(profileId) {
  raw().prepare('UPDATE profiles SET token_version = token_version + 1 WHERE id = ?').run(profileId);
  revokeAll(profileId);
}

/** 顺手清理：过期（90 天）和被撤销满 30 天的记录不必留着 */
function prune() {
  try {
    raw().prepare("DELETE FROM sessions WHERE created_at < datetime('now','localtime','-100 day')").run();
    raw().prepare("DELETE FROM sessions WHERE revoked_at IS NOT NULL AND revoked_at < datetime('now','localtime','-30 day')").run();
  } catch (e) { /* 清理失败不影响使用 */ }
}

module.exports = { create, createOrReuse, get, touch, revoke, revokeAll, listOf, invalidateAll, prune, cleanIp };
