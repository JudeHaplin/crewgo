/* 预约附件 + 谁改的 / 谁能取消 的权限边界 */
const BASE = process.env.BASE || 'http://127.0.0.1:8307';
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

async function upload(token, name, buf, apptId, mime) {
  const url = BASE + '/api/files' + (apptId ? '?appointment_id=' + apptId : '');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'X-File-Name': encodeURIComponent(name),
      'Content-Type': mime || 'application/octet-stream'
    },
    body: buf
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* ignore */ }
  return { status: res.status, json };
}

(async () => {
  console.log('\n[1] 建团队：统筹 + 维修工 + 预约人');
  const setup = await api('/api/auth/setup', { name: '王建国', pin: '123456', phone: '13800000001' });
  const admin = setup.json.token;
  const teamCode = setup.json.team.code;
  ok(setup.status === 200 && !!admin, '初始化统筹账号');

  const regTech = await api('/api/auth/register', { name: '张工', pin: '567890', phone: '13800000002' });
  const tech = regTech.json.token, techUid = regTech.json.user.id;
  await api('/api/team/join', { code: teamCode }, tech);
  let reqs = await api('/api/team/requests', null, admin);
  await api('/api/team/requests/decide', { id: reqs.json.data.find(r => r.profile_id === techUid).id, approve: true }, admin);

  const regReq = await api('/api/auth/register', { name: '李姐', pin: '432100', phone: '13800000003' });
  const req = regReq.json.token, reqUid = regReq.json.user.id;
  await api('/api/team/join', { code: teamCode }, req);
  reqs = await api('/api/team/requests', null, admin);
  await api('/api/team/requests/decide', { id: reqs.json.data.find(r => r.profile_id === reqUid).id, approve: true }, admin);

  const members = (await db(admin, { table: 'profiles', action: 'select' })).json.data;
  const techP = members.find(p => p.user_id === techUid);
  const reqP = members.find(p => p.user_id === reqUid);
  ok(techP && reqP, '两个成员都有团队内档案');

  const proj = await db(admin, { table: 'projects', action: 'insert', values: { name: '恒静安世纪' } });
  ok(proj.status === 200, '管理员建项目');

  console.log('\n[2] 预约人建单：owner 记成他自己');
  const made = await db(req, {
    table: 'appointments', action: 'insert',
    values: {
      visit_date: '2026-12-20', time_slot: '上午', address: '01市01区',
      content: '卫生间漏水', project_id: proj.json.data[0].id, project_name: '恒静安世纪',
      tech_id: techP.id, tech_name: '张工',
      contact_name: '李姐', contact_phone: '13800000003'
    }
  });
  ok(made.status === 200, '预约建好了', made.json);
  const appt = made.json.data[0];
  ok(appt.owner_id === reqUid, '创建人就是预约人本人');

  console.log('\n[3] 上传附件（选择 / 拖拽 / 粘贴最终都走这个接口）');
  const img = Buffer.from('89504E470D0A1A0A0000000D49484452', 'hex'); // 一段假的 PNG 头
  const up = await upload(tech, '现场照片.png', img, appt.id, 'image/png');
  ok(up.status === 200 && up.json.id, '维修工给这条单传了附件', up.json);
  ok(up.json.name === '现场照片.png', '中文文件名没乱码', up.json.name);

  const list = (await db(admin, { table: 'attachments', action: 'select' })).json.data;
  ok(list.length === 1 && Number(list[0].appointment_id) === Number(appt.id), '附件挂在预约单上');
  ok(list[0].size === img.length && list[0].mime === 'image/png', '大小和类型记录正确', list[0]);

  console.log('\n[4] 下载附件：必须带令牌');
  const noTok = await fetch(BASE + '/api/files/' + up.json.id);
  ok(noTok.status === 401, '不带令牌不能下载');
  const withTok = await fetch(BASE + '/api/files/' + up.json.id + '?t=' + encodeURIComponent(admin));
  const buf = Buffer.from(await withTok.arrayBuffer());
  ok(withTok.status === 200 && buf.equals(img), '带令牌能拿到原文件');
  ok(/image\/png/.test(withTok.headers.get('content-type') || ''), '图片按 inline 返回（能在页面上直接显示）');
  const bodyTok = await fetch(BASE + '/api/files/' + up.json.id, { headers: { Authorization: 'Bearer ' + admin } });
  ok(bodyTok.status === 200, '带 Authorization 头也能下载');

  console.log('\n[5] 传别的团队的预约单上会被拒');
  const setup2 = await api('/api/auth/setup', { name: '赵工', pin: '123456', phone: '13900000009' });
  ok(setup2.status === 409 || setup2.status === 200, '第二个团队（或已初始化过）');
  const other = setup2.status === 200 ? setup2.json.token : null;
  if (other) {
    const bad = await upload(other, 'x.txt', Buffer.from('hi'), appt.id, 'text/plain');
    ok(bad.status === 404, '别的团队不能往这条单上传', bad.json);
  }

  console.log('\n[6] 维修人员：能标记状态，不能改内容');
  const editByTech = await db(tech, {
    table: 'appointments', action: 'update',
    values: { address: '偷偷改地址' },
    filters: [{ op: 'eq', col: 'id', val: appt.id }]
  });
  ok(editByTech.status === 403, '维修工改内容被拒', editByTech.json);

  const mark = await db(tech, {
    table: 'appointments', action: 'update',
    values: { status: '已确认' },
    filters: [{ op: 'eq', col: 'id', val: appt.id }]
  });
  ok(mark.status === 200 && mark.json.data[0].status === '已确认', '维修工可以标记状态');
  ok(mark.json.data[0].updater_name === '张工', '记录了改动人', mark.json.data[0].updater_name);
  ok(!!mark.json.data[0].updated_at, '记录了改动时间', mark.json.data[0].updated_at);

  console.log('\n[6b] 维修人员可以「标记为取消」，但不能改别人的单');
  const made2 = await db(req, {
    table: 'appointments', action: 'insert',
    values: {
      visit_date: '2026-12-21', time_slot: '下午', address: '01市01区 2栋',
      content: '门锁坏了', project_id: proj.json.data[0].id, project_name: '恒静安世纪',
      tech_id: techP.id, tech_name: '张工'
    }
  });
  const appt2 = made2.json.data[0];
  const cancelByTech = await db(tech, {
    table: 'appointments', action: 'update',
    values: { status: '已取消' },
    filters: [{ op: 'eq', col: 'id', val: appt2.id }]
  });
  ok(cancelByTech.status === 200 && cancelByTech.json.data[0].status === '已取消',
    '维修工把这条单标记为已取消', cancelByTech.json);

  console.log('\n[7] 预约人可以取消自己的');
  const cancelByOwner = await db(req, {
    table: 'appointments', action: 'update',
    values: { status: '已取消' },
    filters: [{ op: 'eq', col: 'id', val: appt.id }]
  });
  ok(cancelByOwner.status === 200 && cancelByOwner.json.data[0].status === '已取消', '预约人取消成功');

  console.log('\n[8] 管理员不受约束');
  const adminEdit = await db(admin, {
    table: 'appointments', action: 'update',
    values: { status: '进行中', address: '01市01区 3栋' },
    filters: [{ op: 'eq', col: 'id', val: appt.id }]
  });
  ok(adminEdit.status === 200 && adminEdit.json.data[0].address.indexOf('3栋') > 0, '管理员改内容 + 改状态都行');

  console.log('\n[9] 先传再挂（新建预约时的流程）');
  const loose = await upload(req, '报价单.pdf', Buffer.from('%PDF-1.4 test'), null, 'application/pdf');
  ok(loose.status === 200 && loose.json.id, '先传一个没挂单的附件');
  const link = await api('/api/files/link', { appointment_id: appt.id, ids: [loose.json.id] }, req);
  ok(link.status === 200 && link.json.linked === 1, '保存后挂到预约单上', link.json);
  const dlPdf = await fetch(BASE + '/api/files/' + loose.json.id + '?t=' + encodeURIComponent(req));
  ok(dlPdf.status === 200 && /inline/.test(dlPdf.headers.get('content-disposition') || ''),
    'PDF 直接预览（Content-Disposition: inline）');
  const doc = await upload(req, '派工单.docx', Buffer.from('PK fake'), null,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  await api('/api/files/link', { appointment_id: appt.id, ids: [doc.json.id] }, req);
  const dlDoc = await fetch(BASE + '/api/files/' + doc.json.id + '?t=' + encodeURIComponent(req));
  ok(/attachment/.test(dlDoc.headers.get('content-disposition') || ''), 'Office 文档按附件下载');

  console.log('\n[10] 删除预约单会连附件一起清掉');
  const delAppt = await db(admin, { table: 'appointments', action: 'delete', filters: [{ op: 'eq', col: 'id', val: appt.id }] });
  ok(delAppt.status === 200, '删除预约单');
  const afterRows = (await db(admin, { table: 'attachments', action: 'select' })).json.data;
  ok(afterRows.length === 0, '附件记录一起清空', afterRows.length);
  const gone = await fetch(BASE + '/api/files/' + up.json.id + '?t=' + encodeURIComponent(admin));
  ok(gone.status === 404, '文件也读不到了');

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
