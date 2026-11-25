'use strict';
/**
 * 自动备份到邮箱
 *
 * 为什么要有：自托管最常见的事故不是被攻击，是硬盘坏、误删、误恢复。
 * 每天定时把团队数据打包成附件发到指定邮箱，等于在服务端之外留了一份异地副本，
 * 而且邮箱本身就是「有账号密码就能取回」的最省事归档。
 *
 * 附件内容：
 *   · 一定带 团队 JSON（备份里的邮箱授权码 / 微信密钥 / PushPlus token 已脱敏，
 *     换机器后重新填一次即可，避免密钥跟着邮件到处跑）
 *   · 可选   整库 .db（含所有团队、含密钥，属于最高权限数据，只有统筹能开）
 *
 * 一天只发一次：settings.last_backup_date 去重（失败也记账，不反复轰炸邮箱），
 * 想立刻重来用界面上的「立即备份一次」。
 */
const fs = require('node:fs');
const store = require('./store');
const backup = require('./backup');
const mailer = require('./mailer');

const raw = () => store.raw();
const MAX_ATTACH = 15 * 1024 * 1024; // 邮件附件上限（base64 后约 20MB，主流邮箱都收得下）

const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const hhmm = d => pad(d.getHours()) + ':' + pad(d.getMinutes());
const fileStamp = d => ymd(d).replace(/-/g, '') + '-' + pad(d.getHours()) + pad(d.getMinutes());
const sizeText = n => (n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB');
const safeName = s => String(s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '').trim().slice(0, 30) || '团队';
const esc = v => String(v === null || v === undefined ? '' : v)
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const settingsOf = teamId => raw().prepare('SELECT * FROM settings WHERE team_id = ? ORDER BY id LIMIT 1').get(teamId) || {};

/** 收件邮箱：允许写多个，用逗号 / 分号 / 空格隔开，最多 3 个 */
function emailsOf(v) {
  const out = [];
  String(v || '').split(/[,，;；\s]+/).forEach(x => {
    const s = x.trim();
    if (s && mailer.isEmail(s) && out.indexOf(s) < 0) out.push(s);
  });
  return out.slice(0, 3);
}

function mailHtml(opt) {
  const rows = (opt.rows || []).filter(r => r && r.v).map(r =>
    '<tr><td style="padding:9px 0;color:#6b7280;font-size:13px;width:92px;vertical-align:top;border-bottom:1px solid #eef0f4">' + esc(r.k) +
    '</td><td style="padding:9px 0;color:#111827;font-size:14px;line-height:1.6;border-bottom:1px solid #eef0f4">' + esc(r.v) + '</td></tr>').join('');
  return '<div style="background:#f4f5f7;padding:22px 14px;font-family:-apple-system,Segoe UI,PingFang SC,Microsoft YaHei,sans-serif">' +
    '<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e6e8ee;border-radius:12px;overflow:hidden">' +
    '<div style="padding:18px 22px;border-bottom:1px solid #eef0f4">' +
    '<div style="font-size:11px;color:#9aa1ad;letter-spacing:.1em;margin-bottom:7px">速派 · 自动备份</div>' +
    '<div style="font-size:19px;font-weight:700;color:#111827">' + esc(opt.title) + '</div></div>' +
    '<div style="padding:6px 22px 10px">' +
    (opt.intro ? '<p style="margin:14px 0 0;color:#4b5563;font-size:14px;line-height:1.7">' + esc(opt.intro) + '</p>' : '') +
    '<table style="width:100%;border-collapse:collapse">' + rows + '</table>' +
    (opt.note ? '<p style="margin:14px 0 0;color:#9aa1ad;font-size:13px;line-height:1.7">' + esc(opt.note) + '</p>' : '') +
    '</div>' +
    '<div style="padding:14px 22px;background:#fafbfc;border-top:1px solid #eef0f4;color:#9aa1ad;font-size:12px">' +
    '这封邮件由「速派」定时任务自动发出，请勿直接回复。</div>' +
    '</div></div>';
}

/**
 * 立即备份并发送。返回 { ok, to, failed, files, note }
 * 配置不全 / 没有发信账号会抛错（带中文原因）。
 */
async function runTeam(teamId, opts) {
  opts = opts || {};
  teamId = Number(teamId);
  const s = settingsOf(teamId);
  const to = emailsOf(s.backup_email);
  if (!to.length) throw store.bad('还没填收件邮箱（设置 → 数据备份 → 自动备份）');
  if (!mailer.configured(teamId)) throw store.bad('还没配好发信邮箱，去「设置 → 通知 → 邮箱服务」配一个 SMTP 账号');

  const now = new Date();
  const payload = backup.exportTeam(teamId);
  const teamName = safeName(payload.team && payload.team.name);
  const base = '速派备份-' + teamName + '-' + fileStamp(now);

  const attachments = [{
    name: base + '.json',
    type: 'application/json; charset=utf-8',
    content: Buffer.from(JSON.stringify(payload, null, 2), 'utf8')
  }];

  // 可选整库文件：含所有团队与密钥，属于最高权限数据（开关只对统筹开放）
  let dbFile = '';
  let dbSkipped = '';
  if (Number(s.backup_full) === 1) {
    dbFile = store.snapshot();
    const dbBuf = fs.readFileSync(dbFile);
    const total = attachments[0].content.length + dbBuf.length;
    if (total > MAX_ATTACH) {
      dbSkipped = '整库文件 ' + sizeText(dbBuf.length) + ' 超过单封邮件上限，这次只发了团队 JSON';
    } else {
      attachments.push({ name: base + '-整库.db', type: 'application/x-sqlite3', content: dbBuf });
    }
  }

  const bytes = attachments.reduce((n, a) => n + a.content.length, 0);
  const counts = payload.counts || {};
  const html = mailHtml({
    title: ymd(now) + ' 的备份',
    intro: '「' + (payload.team && payload.team.name || '团队') + '」的数据已经打包好，附件可以直接在「设置 → 数据备份 → 导入 / 恢复」里上传还原。',
    rows: [
      { k: '备份时间', v: ymd(now) + ' ' + hhmm(now) },
      { k: '团队', v: (payload.team && payload.team.name) || '' },
      { k: '数据量', v: '人员 ' + (counts.profiles || 0) + ' · 项目 ' + (counts.projects || 0) + ' · 预约单 ' + (counts.appointments || 0) },
      { k: '附件', v: attachments.map(a => a.name + '（' + sizeText(a.content.length) + '）').join('、') },
      { k: '程序版本', v: payload.version }
    ],
    note: 'JSON 备份里的邮箱授权码、微信 AppSecret、PushPlus token 已清空（换机器后重新填一次即可）；' +
      '整库 .db 是完整快照，含所有团队的这类密钥，请妥善保管。' + (dbSkipped ? ' ' + dbSkipped : '')
  });

  const subject = '【速派备份】' + ymd(now) + ' · ' + ((payload.team && payload.team.name) || '团队');
  const sentTo = [];
  const failed = [];
  for (const addr of to) {
    const r = await mailer.send(teamId, {
      to: addr, toName: '备份', owner: 'system', teamId: teamId, kind: 'backup',
      subject: subject, html: html, attachments: attachments
    });
    if (r.ok) sentTo.push(addr);
    else failed.push(addr + '：' + (r.error || '发送失败'));
  }

  const note = sentTo.length
    ? '已发送到 ' + sentTo.join('、') + '（' + attachments.map(a => a.name).join(' + ') + '，共 ' + sizeText(bytes) + '）' +
      (dbSkipped ? '；' + dbSkipped : '')
    : '发送失败：' + (failed[0] || '未知原因');

  // 手动发的只记时间/结果，不占用「今天已经自动发过」的名额
  if (opts.manual) {
    raw().prepare('UPDATE settings SET last_backup_at = ?, last_backup_note = ? WHERE team_id = ?')
      .run(ymd(now) + ' ' + hhmm(now), note.slice(0, 400), teamId);
  } else {
    raw().prepare('UPDATE settings SET last_backup_date = ?, last_backup_at = ?, last_backup_note = ? WHERE team_id = ?')
      .run(ymd(now), ymd(now) + ' ' + hhmm(now), note.slice(0, 400), teamId);
  }
  // 发送成功就把临时快照删掉，避免 backups/ 每天多一个几 MB 的文件；失败则留着，算本地兜底
  if (dbFile && sentTo.length) {
    try { fs.unlinkSync(dbFile); } catch (e) { /* ignore */ }
  }

  return { ok: sentTo.length > 0, to: sentTo, failed: failed, note: note, files: attachments.map(a => a.name), bytes: bytes };
}

/** 这个团队此刻该不该发（纯函数，定时任务和测试都用它判断） */
function dueNow(s, now) {
  if (!s || Number(s.auto_backup) !== 1) return false;
  if (!emailsOf(s.backup_email).length) return false;
  if (s.last_backup_date === ymd(now)) return false;
  const hour = Number(s.backup_hour === null || s.backup_hour === undefined ? 3 : s.backup_hour);
  return now.getHours() >= hour;
}

/** 定时入口：每 5 分钟被 jobs 调一次，到点且今天还没发的团队才发 */
async function tick(log) {
  let rows = [];
  try {
    rows = raw().prepare('SELECT * FROM settings WHERE auto_backup = 1').all();
  } catch (e) {
    return;
  }
  if (!rows.length) return;
  const now = new Date();
  const today = ymd(now);
  for (const s of rows) {
    const teamId = Number(s.team_id);
    if (!teamId) continue;
    if (!dueNow(s, now)) continue;
    try {
      const r = await runTeam(teamId);
      if (log) log('自动备份（团队 ' + teamId + '）：' + r.note);
    } catch (e) {
      const msg = ('自动备份失败：' + (e && e.message ? e.message : e)).slice(0, 400);
      try {
        raw().prepare('UPDATE settings SET last_backup_date = ?, last_backup_at = ?, last_backup_note = ? WHERE team_id = ?')
          .run(today, today + ' ' + hhmm(new Date()), msg, teamId);
      } catch (err) { /* ignore */ }
      if (log) log('自动备份失败（团队 ' + teamId + '）：' + (e && e.message ? e.message : e));
    }
  }
}

module.exports = { runTeam, tick, dueNow, emailsOf, MAX_ATTACH };
