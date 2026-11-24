'use strict';
/**
 * 定时任务：这是自托管版比云端版强的地方 —— 真的有人 24 小时在守。
 *   · 出发提醒：今天/次日还没提醒过的单，各推一次（PushPlus / 邮件）
 *   · 每日汇总：每天 DIGEST_HOUR 点给统筹发一封，一天只发一封
 * 两个都幂等：靠 appointments.reminded_at 和 settings.last_digest_date 去重。
 */
const { raw } = require('./store');
const smtp = require('./smtp');

const pushApi = 'https://www.pushplus.plus/send';
const mailApi = 'https://api.emailjs.com/api/v1.0/email/send';

const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const DOW = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const dayLabel = s => {
  const p = String(s).split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2]);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + DOW[(d.getDay() + 6) % 7];
};
const esc = v => String(v === null || v === undefined ? '' : v)
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const settings = teamId => raw().prepare('SELECT * FROM settings WHERE team_id = ? ORDER BY id LIMIT 1').get(teamId) || {};
/** 所有团队：定时任务要逐团队跑，谁也看不到别人的数据 */
const teamsWithSettings = () => raw().prepare(
  'SELECT t.id AS team_id, t.name AS team_name, s.* FROM teams t LEFT JOIN settings s ON s.team_id = t.id ORDER BY t.id'
).all();
const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim());

function apptText(a) {
  return [
    '【维修预约】' + (a.status || ''),
    '项目：' + (a.project_name || '未指定'),
    '人员：' + (a.tech_name || '待分配'),
    '时间：' + a.visit_date + ' ' + a.time_slot,
    '地址：' + (a.address || '未填'),
    '事项：' + (a.content || '未填'),
    '联系：' + [(a.contact_name || ''), (a.contact_phone || '')].join(' ').trim()
  ].filter(Boolean).join('\n');
}

function mailHtml(opt) {
  const rows = (opt.rows || []).filter(r => r && r.v).map(r =>
    '<tr><td style="padding:9px 0;color:#6b7280;font-size:13px;width:88px;vertical-align:top;border-bottom:1px solid #eef0f4">' + esc(r.k) +
    '</td><td style="padding:9px 0;color:#111827;font-size:14px;line-height:1.6;border-bottom:1px solid #eef0f4">' + esc(r.v) + '</td></tr>').join('');
  const body = opt.bodyHtml ? opt.bodyHtml : '<table style="width:100%;border-collapse:collapse">' + rows + '</table>';
  return '<div style="background:#f4f5f7;padding:22px 14px;font-family:-apple-system,Segoe UI,PingFang SC,Microsoft YaHei,sans-serif">' +
    '<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e6e8ee;border-radius:12px;overflow:hidden">' +
    '<div style="padding:18px 22px;border-bottom:1px solid #eef0f4">' +
    '<div style="font-size:11px;color:#9aa1ad;letter-spacing:.1em;margin-bottom:7px">速派</div>' +
    '<div style="font-size:19px;font-weight:700;color:#111827">' + esc(opt.title) + '</div></div>' +
    '<div style="padding:6px 22px 10px">' +
    (opt.intro ? '<p style="margin:14px 0 0;color:#4b5563;font-size:14px;line-height:1.7">' + esc(opt.intro) + '</p>' : '') +
    body + '</div>' +
    '<div style="padding:14px 22px;background:#fafbfc;border-top:1px solid #eef0f4;color:#9aa1ad;font-size:12px">' + esc(opt.foot || '这封邮件由「速派」自动发出。') + '</div>' +
    '</div></div>';
}

async function sendPush(token, title, content) {
  if (!token) return false;
  try {
    const body = new URLSearchParams({ token, title, content, template: 'txt' });
    const res = await fetch(pushApi, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    const txt = await res.text().catch(() => '');
    return res.ok && /"code"\s*:\s*200/.test(txt);
  } catch (e) {
    return false;
  }
}

async function sendMail(cfg, opt) {
  if (!mailReady(cfg)) return { ok: false, error: '邮件未配置' };
  if (!isEmail(opt.to)) return { ok: false, error: '收件邮箱无效' };
  let status = 'sent', detail = '';
  try {
    if (cfg.mode === 'smtp') {
      const r = await smtp.send({
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        pass: cfg.pass,
        from: cfg.from || cfg.user,
        fromName: cfg.name,
        to: opt.to,
        toName: opt.toName || '',
        subject: opt.subject || '速派通知',
        html: opt.html || '',
        text: opt.text || ''
      });
      if (!r.ok) { status = 'failed'; detail = r.error || '发送失败'; }
    } else {
      const res = await fetch(mailApi, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_id: cfg.service,
          template_id: cfg.template,
          user_id: cfg.key,
          template_params: {
            to_email: opt.to,
            to_name: opt.toName || '',
            subject: opt.subject || '速派通知',
            message: opt.html || esc(opt.text || ''),
            plain_text: opt.text || ''
          }
        })
      });
      const txt = await res.text().catch(() => '');
      if (!res.ok) { status = 'failed'; detail = (txt || ('HTTP ' + res.status)).slice(0, 400); }
    }
  } catch (e) {
    status = 'failed';
    detail = String((e && e.message) || e).slice(0, 400);
  }
  try {
    raw().prepare('INSERT INTO email_logs (team_id, owner_id, kind, to_email, subject, status, detail) VALUES (?,?,?,?,?,?,?)')
      .run(opt.teamId || null, opt.owner || 'system', opt.kind || 'other', opt.to, opt.subject || '', status, detail || null);
  } catch (e) { /* ignore */ }
  return status === 'sent' ? { ok: true } : { ok: false, error: detail };
}

/**
 * 邮件配置。两种模式：
 *   smtp    —— 直连邮箱服务商（QQ/163/企业邮箱），填邮箱 + 授权码即可，无第三方
 *   emailjs —— 第三方中转（老的配置方式，保留兼容）
 * 没显式选模式时：填了 smtp_host 就走 smtp，否则走 emailjs。
 */
const mailCfg = s => {
  s = s || {};
  const mode = String(s.mail_mode || (s.smtp_host ? 'smtp' : 'emailjs')).toLowerCase();
  return {
    mode: mode === 'emailjs' ? 'emailjs' : 'smtp',
    host: String(s.smtp_host || '').trim(),
    port: Number(s.smtp_port || 465),
    user: String(s.smtp_user || '').trim(),
    pass: String(s.smtp_pass || ''),
    from: String(s.smtp_from || s.smtp_user || '').trim(),
    name: String(s.smtp_name || '速派').trim() || '速派',
    service: String(s.emailjs_service_id || '').trim(),
    template: String(s.emailjs_template_id || '').trim(),
    key: String(s.emailjs_public_key || '').trim()
  };
};

const mailReady = c => (c && c.mode === 'smtp'
  ? !!(c.host && c.user && c.pass)
  : !!(c && c.service && c.template && c.key));

/* ---------- 出发提醒 ---------- */
async function runReminders(teamId) {
  if (!teamId) {
    let total = 0;
    for (const t of teamsWithSettings()) total += await runReminders(t.team_id);
    return total;
  }
  const s = settings(teamId);
  if (s.notify_enabled === 0) return 0;
  const today = ymd(new Date());
  const t = new Date(); t.setDate(t.getDate() + 1);
  const tomorrow = ymd(t);

  const due = raw().prepare(
    "SELECT * FROM appointments WHERE team_id = ? AND reminded_at IS NULL AND visit_date IN (?,?) AND status NOT IN ('已完成','已取消')"
  ).all(teamId, today, tomorrow);
  if (!due.length) return 0;

  const cfg = mailCfg(s);
  const emailOn = s.email_enabled === 1 && mailReady(cfg);
  let sent = 0;

  for (const a of due) {
    const tech = a.tech_id ? raw().prepare('SELECT * FROM profiles WHERE id = ?').get(a.tech_id) : null;
    const when = a.visit_date === today ? '今天' : '明天';
    let did = false;

    const token = (tech && tech.push_token) || s.pushplus_token || '';
    if (token) {
      const ok = await sendPush(token, when + '上门 · ' + (a.tech_name || '待分配'), apptText(a));
      if (ok) did = true;
    }
    if (tech && isEmail(tech.email) && emailOn) {
      const r = await sendMail(cfg, {
        to: tech.email,
        toName: tech.name,
        owner: tech.id,
        teamId: teamId,
        kind: 'reminder',
        subject: '【出发提醒】' + when + ' ' + (a.time_slot || '') + ' · ' + (a.address || '地址待填'),
        html: mailHtml({
          title: '提醒：' + when + ' ' + (a.time_slot || '') + ' 上门',
          intro: '这单就在最近两天，别忘带工具和材料。',
          rows: [
            { k: '上门时间', v: when + ' ' + a.time_slot },
            { k: '地址', v: a.address || '待填' },
            { k: '报修内容', v: a.content || '待填' },
            { k: '联系人', v: [(a.contact_name || ''), (a.contact_phone || '')].join(' ').trim() }
          ]
        })
      });
      if (r.ok) did = true;
    }
    if (tech && tech.user_id) {
      try {
        raw().prepare('INSERT INTO notifications (team_id, owner_id, appointment_id, title, body) VALUES (?,?,?,?,?)')
          .run(teamId, tech.user_id, a.id, when + '上门 · ' + (a.tech_name || ''), apptText(a));
        did = true;
      } catch (e) { /* ignore */ }
    }
    if (!did) continue;
    raw().prepare("UPDATE appointments SET reminded_at = datetime('now','localtime') WHERE id = ?").run(a.id);
    sent++;
  }
  return sent;
}

/* ---------- 每日汇总 ---------- */
async function runDigest(teamId) {
  if (!teamId) {
    let any = false;
    for (const t of teamsWithSettings()) {
      const ok = await runDigest(t.team_id);
      if (ok) any = true;
    }
    return any;
  }
  const s = settings(teamId);
  if (s.email_enabled !== 1) return false;
  const cfg = mailCfg(s);
  if (!mailReady(cfg) || !isEmail(s.digest_email)) return false;

  const today = ymd(new Date());
  if (s.last_digest_date === today) return false;

  const list = raw().prepare(
    "SELECT * FROM appointments WHERE team_id = ? AND visit_date = ? AND status <> '已取消' ORDER BY time_slot, tech_name"
  ).all(teamId, today);
  if (!list.length) {
    raw().prepare('UPDATE settings SET last_digest_date = ? WHERE team_id = ?').run(today, teamId);
    return false;
  }

  const groups = {};
  list.forEach(a => { const k = a.tech_name || '待分配'; (groups[k] = groups[k] || []).push(a); });
  let body = '<div style="margin:14px 0 0;color:#4b5563;font-size:14px">共 <b>' + list.length + '</b> 单，' + Object.keys(groups).length + ' 人出工。</div>';
  Object.keys(groups).forEach(name => {
    body += '<div style="margin:18px 0 6px;font-size:14px;font-weight:700;color:#111827">' + esc(name) +
      '<span style="color:#9aa1ad;font-weight:400"> · ' + groups[name].length + ' 单</span></div>';
    body += groups[name].map((a, i) =>
      '<div style="padding:10px 12px;background:#f7f8fa;border-radius:8px;margin-bottom:6px">' +
      '<div style="font-size:13px;color:#111827;font-weight:600">' + (i + 1) + '. ' + esc(a.time_slot || '') + ' · ' +
      esc(a.address || '地址未填') + (a.priority === '加急' ? ' <span style="color:#e5484d">加急</span>' : '') + '</div>' +
      '<div style="font-size:13px;color:#4b5563;margin-top:3px">' + esc(a.content || '—') + '</div>' +
      (a.contact_phone ? '<div style="font-size:12px;color:#9aa1ad;margin-top:3px">' + esc([(a.contact_name || ''), a.contact_phone].join(' ').trim()) + '</div>' : '') +
      '</div>').join('');
  });

  const r = await sendMail(cfg, {
    to: s.digest_email,
    toName: '统筹',
    owner: 'system',
    teamId: teamId,
    kind: 'digest',
    subject: '【今日派单】' + today + ' · 共 ' + list.length + ' 单',
    html: mailHtml({ title: dayLabel(today) + ' 派单汇总', bodyHtml: body, foot: '每天定时发一封，由 NAS 上的速派服务自动发出。' })
  });
  if (r.ok) raw().prepare('UPDATE settings SET last_digest_date = ? WHERE team_id = ?').run(today, teamId);
  return r.ok;
}

let timer = null;
function start(log) {
  const digestHour = Number(process.env.DIGEST_HOUR || 8);
  if (timer) clearInterval(timer);
  const tick = async () => {
    try {
      const n = await runReminders();
      if (n > 0 && log) log('出发提醒已推送 ' + n + ' 条');
    } catch (e) { if (log) log('提醒任务出错：' + e.message); }
    try {
      if (new Date().getHours() >= digestHour) {
        const ok = await runDigest();
        if (ok && log) log('每日汇总已发送');
      }
    } catch (e) { if (log) log('汇总任务出错：' + e.message); }
  };
  setTimeout(tick, 20 * 1000);
  timer = setInterval(tick, 5 * 60 * 1000);
  if (log) log('定时任务已启动（汇总时间 ' + digestHour + ':00，每 5 分钟检查一次）');
}

module.exports = { start, runReminders, runDigest, sendPush, sendMail, mailHtml, mailCfg, mailReady };
