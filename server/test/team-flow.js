/* 团队隔离 / 邀请审批 / 排期冲突 / 休息日 / 导入导出 */
const BASE = process.env.BASE || 'http://127.0.0.1:8301';
let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};

async function api(path, body, token, method) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* 非 JSON */ }
  return { status: res.status, json };
}
const db = (token, q) => api('/api/db', q, token);
const last = r => (r.json && r.json.data && r.json.data[0]) || null;

/* 现场拼一个最小 xlsx（zip + deflate），用来验证手写的解析器——不引第三方库 */
const zlib = require('node:zlib');
function makeXlsx(rows) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const col = i => String.fromCharCode(65 + i);
  const shared = [];
  const idxOf = s => { const i = shared.indexOf(s); if (i >= 0) return i; shared.push(s); return shared.length - 1; };
  const rowXml = rows.map((r, ri) => {
    const cells = r.map((v, ci) => {
      if (v === '' || v === null || v === undefined) return '<c r="' + col(ci) + (ri + 1) + '"/>'; // 自闭合空单元格
      return '<c r="' + col(ci) + (ri + 1) + '" t="s"><v>' + idxOf(String(v)) + '</v></c>';
    }).join('');
    return '<row r="' + (ri + 1) + '">' + cells + '</row>';
  }).join('');
  const files = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook><sheets><sheet name="Sheet1" sheetId="1"/></sheets></workbook>',
    'xl/sharedStrings.xml': '<?xml version="1.0"?><sst count="' + shared.length + '">' +
      shared.map(s => '<si><t>' + esc(s) + '</t></si>').join('') + '</sst>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet><sheetData>' + rowXml + '</sheetData></worksheet>'
  };
  return zip(files);
}

function zip(files) {
  const locals = [], central = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const nb = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nb.length, 26);
    locals.push(lh, nb, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, nb);
    off += 30 + nb.length + comp.length;
  }
  const cen = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length / 2, 8); eocd.writeUInt16LE(central.length / 2, 10);
  eocd.writeUInt32LE(cen.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([Buffer.concat(locals), cen, eocd]);
}

(async () => {
  console.log('\n[1] 初始化：账号 + 团队一次建好');
  const setup = await api('/api/auth/setup', { name: '王建国', pin: '123456', phone: '13800000001' });
  ok(setup.status === 200 && setup.json.token, '初始化返回 token');
  ok(/^[A-Z]{3}\d{6}$/.test(setup.json.team.code), '团队码是 3 位大写字母 + 6 位数字：' + setup.json.team.code);
  ok(setup.json.user.team_role === 'owner', '创建人是团队统筹');
  const admin = setup.json.token;
  const teamCode = setup.json.team.code;
  const teamId = setup.json.team.id;

  console.log('\n[2] 自助注册：进来之前什么都看不到');
  const reg = await api('/api/auth/register', { name: '张工', pin: '567890', phone: '13800000002' });
  ok(reg.status === 200 && reg.json.user.team_id === null, '注册成功但还没进团队');
  const tech = reg.json.token;
  const techId = reg.json.user.id;
  ok((await api('/api/auth/me', null, tech)).json.team === null, '未入团时 me 里没有团队');
  ok((await db(tech, { table: 'appointments', action: 'select' })).status === 403, '未入团不能查预约');
  const dupReg = await api('/api/auth/register', { name: '张工', pin: '999999' });
  ok(dupReg.status === 409, '同名待审账号不能重复注册');

  console.log('\n[3] 团队码申请 → 管理员同意');
  const badJoin = await api('/api/team/join', { code: 'XXX000000' }, tech);
  ok(badJoin.status === 400, '错的团队码被拒绝');
  const lowCode = await api('/api/team/join', { code: teamCode.toLowerCase() }, tech);
  ok(lowCode.status === 200 && lowCode.json.pending, '小写团队码也能识别，转为待审批');
  const meAfterApply = await api('/api/auth/me', null, tech);
  ok(meAfterApply.json.pending && meAfterApply.json.pending.team_name, '申请人能看到「等待审批」');
  ok((await db(tech, { table: 'projects', action: 'select' })).status === 403, '审批前仍然拿不到数据');

  const reqs = await api('/api/team/requests', null, admin);
  ok(reqs.status === 200 && reqs.json.data.length === 1, '管理员能看到 1 条申请');

  // 有人申请时，管理员要有站内通知，否则没人会主动去翻「设置 → 团队」
  const ntf = await db(admin, { table: 'notifications', action: 'select', filters: [{ op: 'eq', col: 'owner_id', val: setup.json.user.id }] });
  ok(ntf.status === 200 && ntf.json.data.some(n => /入团申请/.test(n.title) && /张工/.test(n.body || '')),
    '管理员收到「新的入团申请」通知', ntf.json && ntf.json.data && ntf.json.data.map(n => n.title));

  const decided = await api('/api/team/requests/decide', { id: reqs.json.data[0].id, approve: true }, admin);
  ok(decided.status === 200 && decided.json.approved, '同意申请');
  const meJoined = await api('/api/auth/me', null, tech);
  ok(meJoined.json.team && meJoined.json.team.id === teamId, '通过后进入团队');
  ok(meJoined.json.user.team_role === 'member', '默认是普通成员');

  const reqsAgain = await api('/api/team/requests', null, admin);
  ok(reqsAgain.json.data.length === 0, '申请列表清空');

  console.log('\n[3b] 同名档案合并：老台账里已经有这个人，审批不能报唯一索引错');
  const same = await db(admin, { table: 'profiles', action: 'insert', values: { name: '周红祥', role: 'tech', phone: '13122146919', color: '#0f9d76' } });
  ok(same.status === 200, '管理员手工建了同名技术员「周红祥」');
  const sameId = same.json.data[0].id;
  const sameAppt = await db(admin, {
    table: 'appointments', action: 'insert',
    values: { visit_date: '2026-12-05', time_slot: '上午', address: '2栋101', content: '换灯', tech_id: sameId, tech_name: '周红祥' }
  });
  ok(sameAppt.status === 200, '给同名技术员派了一单');
  const before = (await db(admin, { table: 'profiles', action: 'select' })).json.data.length;

  const regDup = await api('/api/auth/register', { name: '周红祥', pin: '668888', phone: '13122146919' });
  ok(regDup.status === 200, '本人用同样的名字注册新账号');
  const techDup = regDup.json.token, techDupId = regDup.json.user.id;
  const joinDup = await api('/api/team/join', { code: teamCode }, techDup);
  ok(joinDup.status === 200 && joinDup.json.pending, '提交入团申请');
  const reqsDup = await api('/api/team/requests', null, admin);
  const targetDup = (reqsDup.json.data || []).find(x => x.profile_id === techDupId);
  ok(targetDup && targetDup.dup_name === '周红祥', '申请列表里提前提示「已有同名成员」', targetDup);
  const decDup = await api('/api/team/requests/decide', { id: targetDup && targetDup.id, approve: true }, admin);
  ok(decDup.status === 200 && decDup.json.approved, '同意不再撞 UNIQUE 约束', decDup.json);
  ok(decDup.json.merged === '周红祥', '返回合并了哪个同名档案', decDup.json);
  const membersDup = (await db(admin, { table: 'profiles', action: 'select' })).json.data;
  ok(membersDup.length === before, '人数没变（占位行被合并掉，不是新增一行）', membersDup.length);
  ok(!membersDup.some(p => p.id === sameId), '同名占位档案已删除');
  const movedAppt = (await db(admin, { table: 'appointments', action: 'select', filters: [{ op: 'eq', col: 'id', val: sameAppt.json.data[0].id }] })).json.data[0];
  ok(movedAppt && movedAppt.tech_id === techDupId, '历史预约转到新账号上', movedAppt && movedAppt.tech_id);
  ok((await api('/api/auth/me', null, techDup)).json.team.id === teamId, '新账号顺利进团队');

  console.log('\n[3c] 同名的是管理员：不合并，给中文提示');
  ok((await api('/api/team/members/role', { id: techId, role: 'admin' }, admin)).status === 200, '把张工提成管理员');
  const regAdm = await api('/api/auth/register', { name: '张工', pin: '112233' });
  ok(regAdm.status === 200, '同名新账号可以注册');
  const techAdm = regAdm.json.token, techAdmId = regAdm.json.user.id;
  await api('/api/team/join', { code: teamCode }, techAdm);
  const reqsAdm = await api('/api/team/requests', null, admin);
  const tAdm = (reqsAdm.json.data || []).find(x => x.profile_id === techAdmId);
  const decAdm = await api('/api/team/requests/decide', { id: tAdm && tAdm.id, approve: true }, admin);
  ok(decAdm.status === 400 && /同名/.test(decAdm.json.error), '同名管理员时拒绝合并并说明原因', decAdm.json);
  ok((await api('/api/team/requests/decide', { id: tAdm && tAdm.id, approve: false }, admin)).json.approved === false, '可以改判为拒绝');
  ok((await api('/api/team/members/role', { id: techId, role: 'member' }, admin)).status === 200, '把张工改回成员（后面的权限用例要它当成员）');

  console.log('\n[4] 权限：成员不能管项目，能看到团队数据');
  ok((await db(tech, { table: 'projects', action: 'insert', values: { name: '偷偷加' } })).status === 403, '成员不能建项目');
  const proj = await db(admin, { table: 'projects', action: 'insert', values: { name: '阳光小区' } });
  ok(proj.status === 200, '管理员建项目');
  const seen = await db(tech, { table: 'projects', action: 'select' });
  ok(seen.json.data.length === 1, '成员能看到本团队项目');

  console.log('\n[5] 同一人同一时段不能派两单');
  const a1 = await db(admin, {
    table: 'appointments', action: 'insert',
    values: { visit_date: '2026-12-01', time_slot: '上午', address: '3栋501', content: '漏水', tech_id: techId, tech_name: '张工' }
  });
  ok(a1.status === 200, '第一条预约成功');
  const a2 = await db(admin, {
    table: 'appointments', action: 'insert',
    values: { visit_date: '2026-12-01', time_slot: '上午', address: '4栋101', content: '跳闸', tech_id: techId, tech_name: '张工' }
  });
  ok(a2.status === 409, '同一时段第二条被拦下', a2.json);
  ok(a2.json.conflicts && a2.json.conflicts.length === 1, '返回冲突明细');
  const a3 = await db(admin, {
    table: 'appointments', action: 'insert',
    values: { visit_date: '2026-12-01', time_slot: '下午', address: '4栋101', content: '跳闸', tech_id: techId, tech_name: '张工' }
  });
  ok(a3.status === 200, '换个时段可以排');
  const a4 = await db(admin, {
    table: 'appointments', action: 'insert',
    values: { visit_date: '2026-12-01', time_slot: '全天', address: '5栋', content: '全屋检修', tech_id: techId, tech_name: '张工' }
  });
  ok(a4.status === 409, '全天和已有上午冲突');
  const forced = await db(admin, {
    table: 'appointments', action: 'insert', force: true,
    values: { visit_date: '2026-12-01', time_slot: '上午', address: '6栋', content: '强排', tech_id: techId, tech_name: '张工' }
  });
  ok(forced.status === 200, 'force 可以强制排');
  // 改状态不该被冲突挡住（已经冲突的数据也能正常流转）
  const setStatus = await db(admin, { table: 'appointments', action: 'update', values: { status: '已确认' }, filters: [{ op: 'eq', col: 'id', val: a1.json.data[0].id }] });
  ok(setStatus.status === 200, '只改状态不触发冲突检查');

  console.log('\n[6] 休息日不能被预约');
  const off = await api('/api/schedule/time-off', { profile_id: techId, from: '2026-12-05', to: '2026-12-06', reason: '调休' }, admin);
  ok(off.status === 200 && off.json.added === 2, '排休 2 天', off.json);
  const offList = await api('/api/schedule/time-off?from=2026-12-01&to=2026-12-31', null, admin);
  ok(offList.json.data.length === 2, '休息日可以查出来');
  // 休息日是给全队看的：普通成员也要能查到别人的（日历上要标出来）
  const offSeenByMember = await api('/api/schedule/time-off?from=2026-12-01&to=2026-12-31', null, tech);
  ok(offSeenByMember.status === 200 && offSeenByMember.json.data.length === 2, '普通成员也能看到全队休息日');
  const offRaw = await db(tech, { table: 'time_off', action: 'select' });
  ok(offRaw.status === 200 && offRaw.json.data.length === 2, '成员直接查 time_off 也拿得到（日历数据源）');
  const onOff = await db(admin, {
    table: 'appointments', action: 'insert',
    values: { visit_date: '2026-12-05', time_slot: '上午', address: '7栋', content: '修灯', tech_id: techId, tech_name: '张工' }
  });
  ok(onOff.status === 409 && onOff.json.off, '休息日当天被拦下', onOff.json);
  const afterOff = await db(admin, {
    table: 'appointments', action: 'insert',
    values: { visit_date: '2026-12-07', time_slot: '上午', address: '7栋', content: '修灯', tech_id: techId, tech_name: '张工' }
  });
  ok(afterOff.status === 200, '休息日之外正常排单');
  const checkApi = await api('/api/schedule/check', { date: '2026-12-05', slot: '上午', tech_id: techId }, admin);
  ok(checkApi.status === 200 && checkApi.json.off && checkApi.json.off.reason === '调休', 'check 接口能提前查休息日');
  const rmOff = await api('/api/schedule/time-off/remove', { profile_id: techId, from: '2026-12-05', to: '2026-12-06' }, admin);
  ok(rmOff.status === 200, '取消排休');

  console.log('\n[6b] 半天休息：只有那个半天不能排单');
  const half = await api('/api/schedule/time-off', { profile_id: techId, from: '2026-12-14', to: '2026-12-14', part: '上午' }, admin);
  ok(half.status === 200 && half.json.added === 1 && half.json.part === '上午', '排了 12-14 上午休', half.json);
  const amBlocked = await db(admin, {
    table: 'appointments', action: 'insert',
    values: { visit_date: '2026-12-14', time_slot: '上午', address: '8栋', content: '修门', tech_id: techId, tech_name: '张工' }
  });
  ok(amBlocked.status === 409 && amBlocked.json.off && amBlocked.json.off.part === '上午', '上午被半天休拦下', amBlocked.json);
  const pmOk = await db(admin, {
    table: 'appointments', action: 'insert',
    values: { visit_date: '2026-12-14', time_slot: '下午', address: '8栋', content: '修门', tech_id: techId, tech_name: '张工' }
  });
  ok(pmOk.status === 200, '同一天下午照常能排');
  const merge = await api('/api/schedule/time-off', { profile_id: techId, from: '2026-12-15', to: '2026-12-15', part: '上午' }, admin);
  const merge2 = await api('/api/schedule/time-off', { profile_id: techId, from: '2026-12-15', to: '2026-12-15', part: '下午' }, admin);
  ok(merge.status === 200 && merge2.status === 200 && merge2.json.merged === 1, '上午 + 下午 自动合并成全天', merge2.json);
  const fullBlocked = await db(admin, {
    table: 'appointments', action: 'insert',
    values: { visit_date: '2026-12-15', time_slot: '下午', address: '9栋', content: '修窗', tech_id: techId, tech_name: '张工' }
  });
  ok(fullBlocked.status === 409 && fullBlocked.json.off.part === '全天', '合并成全天以后下午也拦', fullBlocked.json);

  console.log('\n[6c] 区间排休：从某天下午到某天上午');
  const span = await api('/api/schedule/time-off',
    { profile_id: techId, from: '2026-12-16', to: '2026-12-18', part: '下午', end_part: '上午' }, admin);
  ok(span.status === 200 && span.json.added === 3 && span.json.days === 3, '排了 12-16 到 12-18 三天', span.json);
  const spanList = await api('/api/schedule/time-off?from=2026-12-16&to=2026-12-18', null, admin);
  const partMap = {};
  (spanList.json.data || []).forEach(r => { if (r.profile_id === techId) partMap[r.off_date] = r.part; });
  ok(partMap['2026-12-16'] === '下午' && partMap['2026-12-17'] === '全天' && partMap['2026-12-18'] === '上午',
    '首日下午 / 中间全天 / 末日 上午', partMap);

  const day1am = await db(admin, {
    table: 'appointments', action: 'insert',
    values: { visit_date: '2026-12-16', time_slot: '上午', address: '10栋', content: '修灯', tech_id: techId, tech_name: '张工' }
  });
  ok(day1am.status === 200, '起始日上午照常能排（那天从下午开始休）');
  const day1pm = await db(admin, {
    table: 'appointments', action: 'insert',
    values: { visit_date: '2026-12-16', time_slot: '下午', address: '10栋', content: '修灯', tech_id: techId, tech_name: '张工' }
  });
  ok(day1pm.status === 409 && day1pm.json.off.part === '下午', '起始日下午被拦', day1pm.json);
  const day3pm = await db(admin, {
    table: 'appointments', action: 'insert',
    values: { visit_date: '2026-12-18', time_slot: '下午', address: '11栋', content: '修灯', tech_id: techId, tech_name: '张工' }
  });
  ok(day3pm.status === 200, '结束日下午照常能排（那天只休到上午）');
  const day3am = await db(admin, {
    table: 'appointments', action: 'insert',
    values: { visit_date: '2026-12-18', time_slot: '上午', address: '11栋', content: '修灯', tech_id: techId, tech_name: '张工' }
  });
  ok(day3am.status === 409 && day3am.json.off.part === '上午', '结束日上午被拦', day3am.json);
  const sameBad = await api('/api/schedule/time-off',
    { profile_id: techId, from: '2026-12-19', to: '2026-12-19', part: '下午', end_part: '上午' }, admin);
  ok(sameBad.status === 400, '同一天「下午到上午」被拒', sameBad.json);
  const revBad = await api('/api/schedule/time-off',
    { profile_id: techId, from: '2026-12-20', to: '2026-12-19', part: '上午', end_part: '上午' }, admin);
  ok(revBad.status === 400, '结束日期早于开始日期被拒', revBad.json);

  console.log('\n[7] 手机号位数');
  const badPhone = await api('/api/auth/profile', { name: '张工', phone: '1380000' }, tech);
  ok(badPhone.status === 400, '7 位手机号被拒绝');
  const goodPhone = await api('/api/auth/profile', { name: '张工', phone: '+86 138-0000-0002' }, tech);
  ok(goodPhone.status === 200 && goodPhone.json.user.phone === '13800000002', '带 +86 和横线也能存成 11 位');

  console.log('\n[8] 数据按团队隔离');
  const reg2 = await api('/api/auth/register', { name: '李经理', pin: 'abcd1234', phone: '13800000003' });
  const other = reg2.json.token;
  const madeTeam = await api('/api/team/create', { name: '另一个物业' }, other);
  ok(madeTeam.status === 200 && madeTeam.json.team.code !== teamCode, '第二个人建了另一个团队');
  const otherList = await db(other, { table: 'appointments', action: 'select' });
  ok(otherList.json.data.length === 0, '看不到别人团队的预约');
  const otherProj = await db(other, { table: 'projects', action: 'select' });
  ok(otherProj.json.data.length === 0, '看不到别人团队的项目');
  const otherMembers = await api('/api/team/members', null, other);
  ok(otherMembers.json.data.length === 1, '成员列表只有自己');

  console.log('\n[9] 导出 / 导入');
  const exp = await fetch(BASE + '/api/backup/export?format=json', { headers: { Authorization: 'Bearer ' + admin } });
  ok(exp.status === 200, '导出 JSON');
  const payload = await exp.json();
  ok(payload.data.appointments.length >= 4, '备份里带上了预约单');
  const settRow = payload.data.settings || {};
  ok(Array.isArray(payload.redacted) && payload.redacted.indexOf('smtp_pass') >= 0, '备份声明了被屏蔽的密钥字段', payload.redacted);
  ok(!settRow.smtp_pass && !settRow.wx_mp_secret && !settRow.wx_qr_secret, 'JSON 备份不含邮箱授权码与微信 Secret', settRow);
  ok(payload.data.profiles.every(p => !p.push_token), 'JSON 备份不含个人推送 token');
  ok(payload.data.profiles.some(p => p.pin_hash), '密码哈希保留（导入后还能用原密码登录）');
  const expDb = await fetch(BASE + '/api/backup/export?format=db', { headers: { Authorization: 'Bearer ' + admin } });
  ok(expDb.status === 200 && Number(expDb.headers.get('content-length')) > 1000, '导出整库 .db');
  const dbAsMember = await fetch(BASE + '/api/backup/export?format=db', { headers: { Authorization: 'Bearer ' + tech } });
  ok(dbAsMember.status === 403, '成员不能下载整库');

  const csv = '日期,时段,项目,维修人员,地址,报修内容,联系人,联系电话,状态\r\n' +
    '2026-12-10,上午,阳光小区,张工,3栋901,暖气不热,王女士,13800000009,已确认\r\n' +
    '2026/12/11,下午,,新来的,4栋101,水管漏,赵先生,13800000010,\r\n';
  for (const dry of ['1', '0']) {
    const r = await fetch(BASE + '/api/backup/import?filename=预约.csv&dry=' + dry, {
      method: 'POST', headers: { Authorization: 'Bearer ' + admin }, body: csv
    });
    const j = await r.json();
    ok(r.status === 200 && j.kind === 'appointments', 'CSV 导入 dry=' + dry + ' 识别为预约单');
    if (dry === '0') ok(j.add === 2 && j.created.techs.indexOf('新来的') >= 0, 'CSV 落库并自动建人员');
  }
  const afterCsv = await db(admin, { table: 'appointments', action: 'select' });
  ok(afterCsv.json.data.filter(a => a.visit_date === '2026-12-10').length === 1, '导入的预约能查到');
  const dupCsv = await fetch(BASE + '/api/backup/import?filename=预约.csv&dry=0', {
    method: 'POST', headers: { Authorization: 'Bearer ' + admin }, body: csv
  });
  ok((await dupCsv.json()).skip === 2, '重复导入会被跳过');

  // 导出的表头是「预约人 / 预约人电话」，再导回去要能认，而且电话列不能串到姓名里
  const csv2 = '日期,时段,项目,维修人员,地址,报修内容,预约人,预约人电话\r\n' +
    '2026-12-12,上午,阳光小区,张工,7栋202,门锁坏,陈先生,13900000013\r\n';
  const r2 = await fetch(BASE + '/api/backup/import?filename=预约2.csv&dry=0', {
    method: 'POST', headers: { Authorization: 'Bearer ' + admin }, body: csv2
  });
  const j2 = await r2.json();
  ok(r2.status === 200 && j2.add === 1, '「预约人 / 预约人电话」表头也能导入', j2);
  const imp = (await db(admin, { table: 'appointments', action: 'select' })).json.data.filter(a => a.visit_date === '2026-12-12')[0];
  ok(!!imp && imp.contact_name === '陈先生' && imp.contact_phone === '13900000013', '预约人姓名与电话没有串列',
    imp && { name: imp.contact_name, phone: imp.contact_phone });

  const mp = await fetch(BASE + '/api/backup/import?filename=人员.csv&dry=0', {
    method: 'POST', headers: { Authorization: 'Bearer ' + admin },
    body: '姓名,手机号,身份,密码\r\n孙工,13800000011,维修人员,888888\r\n'
  });
  const mpJson = await mp.json();
  ok(mp.status === 200 && mpJson.kind === 'profiles' && mpJson.add === 1, '人员表导入成功');

  // 手写 xlsx 解析：共享字符串、自闭合空单元格、Excel 日期序列号都要认
  const xlsxBuf = makeXlsx([
    ['日期', '时段', '项目', '维修人员', '地址', '报修内容', '联系电话'],
    ['2026/12/20', '下午', '阳光小区', '周工', '5栋201', '空调不制冷', '13900000012'],
    ['2026-12-21', '全天', '', '', '6栋301', '换水表', ''],
    ['', '', '', '', '', '', ''] // 整行空，应被忽略
  ]);
  const xr = await fetch(BASE + '/api/backup/import?filename=预约表.xlsx&dry=1', {
    method: 'POST', headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/octet-stream' }, body: xlsxBuf
  });
  const xj = await xr.json();
  ok(xr.status === 200 && xj.kind === 'appointments' && xj.total === 2, 'xlsx 预览认出 2 行（空行忽略）', xj);
  ok(xj.sheet === 'xlsx' && xj.add === 2 && xj.bad === 0, 'xlsx 解析完整、无坏行', { sheet: xj.sheet, bad: xj.bad, err: xj.errorRows });
  ok(xj.sample && xj.sample[0] && xj.sample[0].人员 === '周工' && xj.sample[0].项目 === '阳光小区', 'xlsx 列没串位', xj.sample);

  const xw = await fetch(BASE + '/api/backup/import?filename=预约表.xlsx&dry=0', {
    method: 'POST', headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/octet-stream' }, body: xlsxBuf
  });
  const xjReal = await xw.json();
  ok(xw.status === 200 && xjReal.add === 2, 'xlsx 落库 2 条预约', xjReal);
  const afterXlsx = await db(admin, { table: 'appointments', action: 'select' });
  const d20 = afterXlsx.json.data.find(a => a.visit_date === '2026-12-20');
  ok(d20 && d20.time_slot === '下午' && d20.tech_name === '周工' && d20.project_name === '阳光小区', 'xlsx 列没串位（人员/项目/时段都对）', d20);
  const d21 = afterXlsx.json.data.find(a => a.visit_date === '2026-12-21');
  ok(d21 && d21.time_slot === '全天', 'Excel 日期写法与全天时段都认', d21 && d21.time_slot);

  // 真实台账的列形：预定维修日期 / 维修项目 / 项目经理 / 创建时间——容易互相误认
  const ledger = makeXlsx([
    ['项目名称', '报修日期', '项目经理', '人员', '维修项目', '预定维修日期', '实际维修日期', '备注', '创建时间', '最后修改时间'],
    ['皇都花园', '2026-12-01', '乔通', '梅庭付', '换水表', '2026-12-15', '2026-12-15', '三号楼', '46217.62', '46217.71'],
    ['皇都花园', '2026-12-01', '乔通', '梅庭付', '修门锁', '46217', '', '', '46217.63', '46218.11']
  ]);
  const lr = await fetch(BASE + '/api/backup/import?filename=台账.xlsx&dry=1', {
    method: 'POST', headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/octet-stream' }, body: ledger
  });
  const lj = await lr.json();
  ok(lr.status === 200 && lj.kind === 'appointments' && lj.add === 2, '台账列形能识别', lj);
  ok(lj.sample[0].日期 === '2026-12-15' && lj.sample[0].项目 === '皇都花园' && lj.sample[0].内容 === '换水表',
    '取「预定维修日期」而不是「报修日期」，内容取「维修项目」', lj.sample[0]);
  ok(lj.sample[0].时段 === '全天', '台账没有时段列时按全天，不被「创建时间」带偏', lj.sample[0].时段);
  ok(lj.sample[1].日期.length === 10 && lj.sample[1].日期.slice(0, 4) === '2026', 'Excel 序列号当日期用', lj.sample[1].日期);
  ok(lj.created.techs.indexOf('梅庭付') >= 0 && lj.created.projects.indexOf('皇都花园') >= 0, '预览就告诉会新建哪些项目/人员', lj.created);

  const lw = await fetch(BASE + '/api/backup/import?filename=台账.xlsx&dry=0', {
    method: 'POST', headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/octet-stream' }, body: ledger
  });
  ok((await lw.json()).add === 2, '台账落库');
  const afterLedger = await db(admin, { table: 'appointments', action: 'select' });
  const done = afterLedger.json.data.filter(a => a.visit_date === '2026-12-15' && a.content === '换水表')[0];
  ok(done && done.status === '已完成', '填了「实际维修日期」的按已完成落库', done && done.status);
  ok(done && done.creator_name === '乔通', '「项目经理」落到创建人', done && done.creator_name);

  const jsonImport = await fetch(BASE + '/api/backup/import?filename=backup.json&dry=0', {
    method: 'POST', headers: { Authorization: 'Bearer ' + other },
    body: JSON.stringify(payload)
  });
  const jsonImportBody = await jsonImport.json();
  ok(jsonImport.status === 200 && jsonImportBody.kind === 'json', 'JSON 合并导入到另一个团队');
  const otherAfter = await db(other, { table: 'appointments', action: 'select' });
  ok(otherAfter.json.data.length === payload.data.appointments.length, '另一个团队拿到同样的预约数据');
  const adminAfter = await db(admin, { table: 'appointments', action: 'select' });
  ok(adminAfter.json.data.length >= 5, '原团队数据没被影响');

  console.log('\n[10] 团队码 / 角色');
  const reset = await api('/api/team/code/reset', {}, other);
  ok(reset.status === 200 && /^[A-Z]{3}\d{6}$/.test(reset.json.code), '重置团队码格式正确');
  ok(reset.json.code !== madeTeam.json.team.code, '新码和旧码不同');
  const memberReset = await api('/api/team/code/reset', {}, tech);
  ok(memberReset.status === 403, '普通成员不能重置团队码');
  const members2 = await api('/api/team/members', null, other);
  ok(members2.json.data[0].team_role === 'owner', '成员列表里能看出谁是队长');

  console.log('\n[11] 微信登录未配置时的表现');
  const st = await api('/api/auth/status');
  ok(st.json.wechat && st.json.wechat.mp === false && st.json.wechat.qr === false, '默认没开微信登录');
  const wxUrl = await api('/api/auth/wechat/url?mode=qr', null, admin);
  ok(wxUrl.status === 400, '没配置时提示去配置，而不是报错崩掉');

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
