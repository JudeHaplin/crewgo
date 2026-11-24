'use strict';
/**
 * 发信调度：一个团队可以配多个邮箱服务（mail_accounts）。
 *
 * 为什么需要多个：
 *   QQ / 163 / Gmail 都有单日发信上限（QQ 约 500 封、Gmail 500、企业邮更低），
 *   一个用完就发不出去了。这里按优先级依次尝试，某个账号报「超限」就把它
 *   标记成今天不可用，自动换下一个继续发，不打扰用户。
 *
 * 兼容老配置：settings 里的单套 SMTP / EmailJS 会被 store.seedMailAccount()
 * 搬成一条账号；如果团队一条账号都没有（比如刚配完还没重启），也允许直接用
 * settings 里的那份配置当「临时账号」，保证升级不掉功能。
 */
const { raw, todayStr } = require('./store');
const smtp = require('./smtp');

const mailApi = 'https://api.emailjs.com/api/v1.0/email/send';
const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim());

/** 哪些报错算「今天的额度用完了」——换一个账号还能发出去 */
const QUOTA_RE = /quota|exceed|too many|limit|rate|452|4\.7\.0|5\.4\.5|5\.7\.1|额度|上限|超过|限制|已被限制|拒绝/i;
const looksExhausted = msg => QUOTA_RE.test(String(msg || ''));

/**
 * 网络层面的错误：换账号大概率也一样（整机断网 / DNS 挂了），
 * 继续试只会让请求卡上好几轮超时，所以遇到就立刻返回。
 * 反过来，服务器「明确回话」的错误（535 授权码错、550 超限）一定继续换下一个。
 */
const NETWORK_RE = /超时|timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up|网络/i;
const isNetworkError = msg => NETWORK_RE.test(String(msg || ''));

/** 团队的发信账号，优先级小的先用 */
function accountsOf(teamId) {
  if (!teamId) return [];
  return raw().prepare('SELECT * FROM mail_accounts WHERE team_id = ? ORDER BY priority ASC, id ASC').all(Number(teamId));
}

const ready = a => (a && a.kind === 'emailjs'
  ? !!(a.service_id && a.template_id && a.public_key)
  : !!(a && a.host && a.user && a.pass));

const labelOf = a => String((a && (a.label || a.user || a.host)) || '邮箱服务').trim();

/** 老配置兜底：settings 里那套 SMTP / EmailJS 当成 id=0 的临时账号 */
function legacyAccount(teamId) {
  const s = raw().prepare('SELECT * FROM settings WHERE team_id = ? ORDER BY id LIMIT 1').get(teamId) || {};
  const mode = String(s.mail_mode || (s.smtp_host ? 'smtp' : 'emailjs')).toLowerCase();
  if (mode !== 'emailjs' && s.smtp_host && s.smtp_user && s.smtp_pass) {
    return {
      id: 0, team_id: teamId, label: s.smtp_name || s.smtp_user, kind: 'smtp',
      host: s.smtp_host, port: Number(s.smtp_port || 465) || 465, user: s.smtp_user, pass: s.smtp_pass,
      from_addr: s.smtp_from || s.smtp_user, from_name: s.smtp_name || '速派',
      daily_limit: 0, sent_today: 0, priority: 10, enabled: 1
    };
  }
  if (mode === 'emailjs' && s.emailjs_service_id && s.emailjs_template_id && s.emailjs_public_key) {
    return {
      id: 0, team_id: teamId, label: 'EmailJS', kind: 'emailjs',
      service_id: s.emailjs_service_id, template_id: s.emailjs_template_id, public_key: s.emailjs_public_key,
      daily_limit: 0, sent_today: 0, priority: 10, enabled: 1
    };
  }
  return null;
}

/** 今天还能用的账号（按优先级） */
function usable(teamId) {
  const rows = accountsOf(teamId).filter(a => a.enabled === 1 && ready(a));
  const list = rows.length ? rows : [legacyAccount(teamId)].filter(Boolean);
  const today = todayStr();
  return list.filter(a => {
    if (a.exhausted_date === today) return false;
    const limit = Number(a.daily_limit || 0);
    if (limit > 0 && a.id) {
      const used = a.sent_date === today ? Number(a.sent_today || 0) : 0;
      if (used >= limit) return false;
    }
    return true;
  });
}

/** 团队到底配没配合法的发信账号（界面上用） */
const configured = teamId => accountsOf(teamId).some(a => a.enabled === 1 && ready(a)) || !!legacyAccount(teamId);

function bumpSent(a) {
  if (!a || !a.id) return;
  const today = todayStr();
  raw().prepare(
    'UPDATE mail_accounts SET sent_today = CASE WHEN sent_date = ? THEN sent_today + 1 ELSE 1 END, ' +
    'sent_date = ?, last_used_at = datetime(\'now\',\'localtime\'), last_error = NULL WHERE id = ?'
  ).run(today, today, a.id);
}

function markFail(a, msg) {
  if (!a || !a.id) return;
  const today = todayStr();
  if (looksExhausted(msg)) {
    raw().prepare('UPDATE mail_accounts SET exhausted_date = ?, last_error = ? WHERE id = ?')
      .run(today, String(msg).slice(0, 300), a.id);
  } else {
    raw().prepare('UPDATE mail_accounts SET last_error = ? WHERE id = ?')
      .run(String(msg).slice(0, 300), a.id);
  }
}

/** 真正发一封：只走指定账号，不换 */
async function attempt(a, opt) {
  try {
    if (a.kind === 'emailjs') {
      const res = await fetch(mailApi, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_id: a.service_id,
          template_id: a.template_id,
          user_id: a.public_key,
          template_params: {
            to_email: opt.to,
            to_name: opt.toName || '',
            subject: opt.subject || '速派通知',
            message: opt.html || '',
            plain_text: opt.text || ''
          }
        })
      });
      const txt = await res.text().catch(() => '');
      if (!res.ok) return { ok: false, error: (txt || ('HTTP ' + res.status)).slice(0, 400) };
      return { ok: true };
    }
    const r = await smtp.send({
      host: a.host,
      port: Number(a.port || 465) || 465,
      user: a.user,
      pass: a.pass,
      from: a.from_addr || a.user,
      fromName: a.from_name || a.label || '速派',
      to: opt.to,
      toName: opt.toName || '',
      subject: opt.subject || '速派通知',
      html: opt.html || '',
      text: opt.text || ''
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error || '发送失败' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 400) };
  }
}

function logMail(teamId, opt, status, detail) {
  try {
    raw().prepare('INSERT INTO email_logs (team_id, owner_id, kind, to_email, subject, status, detail) VALUES (?,?,?,?,?,?,?)')
      .run(teamId || null, opt.owner || 'system', opt.kind || 'other', opt.to, opt.subject || '', status, detail || null);
  } catch (e) { /* 记日志失败不影响发信结果 */ }
}

/**
 * 发一封邮件，账号不够就依次换下一个。
 * 返回 { ok, account, error, tried: [{ label, error }] }
 */
async function send(teamId, opt) {
  if (!isEmail(opt.to)) return { ok: false, error: '收件邮箱格式不对：' + (opt.to || '（空）') };
  const list = usable(teamId);
  if (!list.length) {
    const err = '没有可用的发信邮箱：去「设置 → 通知 → 邮箱服务」配一个（或者今天的额度都用完了）';
    logMail(teamId, opt, 'failed', err);
    return { ok: false, error: err };
  }

  const tried = [];
  for (const a of list.slice(0, 5)) {
    const r = await attempt(a, opt);
    if (r.ok) {
      bumpSent(a);
      logMail(teamId, opt, 'sent', '账号：' + labelOf(a));
      return { ok: true, account: labelOf(a), tried };
    }
    tried.push({ label: labelOf(a), error: r.error });
    markFail(a, r.error);
    if (isNetworkError(r.error)) {
      logMail(teamId, opt, 'failed', labelOf(a) + '：' + r.error);
      return { ok: false, error: r.error, account: labelOf(a), tried };
    }
    // 其余情况（额度用完、授权码错）都换下一个账号继续试
  }
  const last = tried[tried.length - 1];
  const err = (last ? last.error : '发送失败') + '（' + tried.length + ' 个邮箱服务都不可用）';
  logMail(teamId, opt, 'failed', tried.map(t => t.label + '：' + t.error).join(' | ').slice(0, 400));
  return { ok: false, error: err, tried };
}

/** 只用一个指定账号发（「测试这个账号」按钮用，失败不切换，好定位问题） */
async function sendWith(teamId, accountId, opt) {
  const a = accountsOf(teamId).filter(x => Number(x.id) === Number(accountId))[0];
  if (!a) return { ok: false, error: '这个邮箱服务不存在' };
  if (!ready(a)) return { ok: false, error: '这个邮箱服务还没填全（服务器 / 账号 / 授权码）' };
  if (!isEmail(opt.to)) return { ok: false, error: '收件邮箱格式不对' };
  const r = await attempt(a, opt);
  if (r.ok) {
    bumpSent(a);
    logMail(teamId, opt, 'sent', '账号：' + labelOf(a) + '（测试）');
    return { ok: true, account: labelOf(a) };
  }
  markFail(a, r.error);
  logMail(teamId, opt, 'failed', labelOf(a) + '：' + r.error);
  return { ok: false, error: r.error, account: labelOf(a), quota: looksExhausted(r.error) };
}

/** 今天新的一天了就把「额度用尽」标记清掉（惰性，不用定时器） */
function rollover(teamId) {
  const today = todayStr();
  try {
    raw().prepare("UPDATE mail_accounts SET exhausted_date = NULL, sent_today = 0, sent_date = ? WHERE team_id = ? AND IFNULL(exhausted_date,'') <> '' AND exhausted_date <> ?")
      .run(today, Number(teamId), today);
  } catch (e) { /* ignore */ }
}

module.exports = { accountsOf, usable, configured, send, sendWith, rollover, looksExhausted, isEmail, labelOf, ready };
