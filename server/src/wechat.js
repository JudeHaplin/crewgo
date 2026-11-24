'use strict';
/**
 * 微信登录（零依赖，只用官方 OAuth2 接口）
 *
 * 两种入口，用的 AppID 不是同一个：
 *   qr —— 微信开放平台「网站应用」，电脑浏览器扫码登录（scope=snsapi_login）
 *   mp —— 微信公众号「网页授权」，微信内打开直接拉起授权（scope=snsapi_userinfo）
 *
 * 同一个微信在两种 AppID 下的 openid 不同，靠 unionid 打通（需要绑定到同一开放平台账号）。
 * 配置存在 settings 里，密钥只进不出，前端只知道「配没配」。
 */
const crypto = require('node:crypto');

const AUTH_QR = 'https://open.weixin.qq.com/connect/qrconnect';
const AUTH_MP = 'https://open.weixin.qq.com/connect/oauth2/authorize';
const API_TOKEN = 'https://api.weixin.qq.com/sns/oauth2/access_token';
const API_USER = 'https://api.weixin.qq.com/sns/userinfo';

const STATE_TTL = 10 * 60 * 1000;
const TICKET_TTL = 5 * 60 * 1000;

const states = new Map();
const tickets = new Map();

const cfgOf = s => {
  s = s || {};
  return {
    mp: { appid: String(s.wx_mp_appid || '').trim(), secret: String(s.wx_mp_secret || '').trim() },
    qr: { appid: String(s.wx_qr_appid || '').trim(), secret: String(s.wx_qr_secret || '').trim() }
  };
};

/** 给登录页用：只告诉前端哪种方式可用 */
const publicCfg = s => {
  const c = cfgOf(s);
  return { mp: !!(c.mp.appid && c.mp.secret), qr: !!(c.qr.appid && c.qr.secret) };
};

function sweep() {
  const now = Date.now();
  for (const [k, v] of states) if (now - v.t > STATE_TTL) states.delete(k);
  for (const [k, v] of tickets) if (now - v.t > TICKET_TTL) tickets.delete(k);
}

function makeState(payload) {
  sweep();
  const state = crypto.randomBytes(16).toString('hex');
  states.set(state, Object.assign({ t: Date.now() }, payload));
  return state;
}

function readState(state) {
  sweep();
  const v = states.get(String(state || ''));
  if (!v) return null;
  states.delete(String(state));
  if (Date.now() - v.t > STATE_TTL) return null;
  return v;
}

function buildUrl(app, appid, redirectUri, state) {
  const q = new URLSearchParams({
    appid: appid,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: app === 'mp' ? 'snsapi_userinfo' : 'snsapi_login',
    state: state
  });
  const base = app === 'mp' ? AUTH_MP : AUTH_QR;
  // 微信要求 #wechat_redirect 结尾，且不能被 URL 编码
  return base + '?' + q.toString() + (app === 'mp' ? '#wechat_redirect' : '#wechat_redirect');
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const txt = await res.text();
  try { return JSON.parse(txt); } catch (e) {
    throw new Error('微信接口返回异常：' + txt.slice(0, 120));
  }
}

const WX_ERR = {
  '-1': '微信服务繁忙，请稍后再试',
  40003: 'AppID 不对',
  40013: 'AppID 不对',
  40029: '授权码已失效，请重新扫码',
  40125: 'AppSecret 不对',
  40163: '这个授权码已经用过了，请重新扫码',
  41008: '缺少授权码',
  42001: 'access_token 过期，请重新扫码',
  48001: '这个公众号没有网页授权权限（需要认证的服务号）',
  50001: '公众号未授权该网页，请在公众号后台配置「网页授权域名」'
};
const explain = (r, app) => {
  const code = r && (r.errcode || r.errmsg && r.errcode);
  if (WX_ERR[code]) return WX_ERR[code];
  if (app === 'mp' && /redirect_uri/i.test(String(r && r.errmsg))) return '公众号后台的「网页授权域名」和当前域名不一致';
  return (r && (r.errmsg || r.error_description)) || '微信登录失败';
};

/** 用 code 换 openid / unionid / 昵称 */
async function exchange(app, appid, secret, code) {
  const u = new URL(API_TOKEN);
  u.searchParams.set('appid', appid);
  u.searchParams.set('secret', secret);
  u.searchParams.set('code', code);
  u.searchParams.set('grant_type', 'authorization_code');
  const tok = await getJson(u.toString());
  if (tok.errcode || !tok.openid) throw new Error(explain(tok, app));

  let nickname = '', avatar = '', unionid = tok.unionid || '';
  try {
    const v = new URL(API_USER);
    v.searchParams.set('access_token', tok.access_token);
    v.searchParams.set('openid', tok.openid);
    v.searchParams.set('lang', 'zh_CN');
    const info = await getJson(v.toString());
    if (!info.errcode) {
      nickname = info.nickname || '';
      avatar = info.headimgurl || '';
      unionid = info.unionid || unionid;
    }
  } catch (e) { /* 昵称拿不到不影响登录 */ }

  return { openid: tok.openid, unionid: unionid || null, nickname: nickname, avatar: avatar };
}

function issueTicket(payload) {
  sweep();
  const t = crypto.randomBytes(18).toString('hex');
  tickets.set(t, Object.assign({ t: Date.now() }, payload));
  return t;
}

function consumeTicket(t) {
  sweep();
  const v = tickets.get(String(t || ''));
  if (!v) return null;
  tickets.delete(String(t));
  if (Date.now() - v.t > TICKET_TTL) return null;
  return v;
}

module.exports = { cfgOf, publicCfg, makeState, readState, buildUrl, exchange, issueTicket, consumeTicket, explain };
