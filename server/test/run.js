/* 测试运行器：每个测试文件各自起一个干净的服务实例（独立端口 + 独立数据目录）。
   这样测试之间不会互相污染，也不用手工 sleep / kill。
   用法：
     node server/test/run.js              # 跑全部
     node server/test/run.js api-smoke    # 只跑一个
*/
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const TESTS = ['api-smoke', 'client-shim'];
const PORT_BASE = Number(process.env.TEST_PORT_BASE || 8300);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitHealth(base, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) return true;
    } catch (e) { /* 还没起来 */ }
    await sleep(200);
  }
  return false;
}

function once(child, name, ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), ms);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}

async function runOne(name, port) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewgo-' + name + '-'));
  const base = 'http://127.0.0.1:' + port;
  const env = Object.assign({}, process.env, {
    DATA_DIR: dataDir,
    PORT: String(port),
    HOST: '127.0.0.1',
    NODE_ENV: 'test'
  });

  console.log('\n=== ' + name + '（端口 ' + port + '，数据目录 ' + path.basename(dataDir) + '）===');

  const srv = spawn(process.execPath, ['--no-warnings', 'server/src/index.js'], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe']
  });
  let srvErr = '';
  srv.stderr.on('data', d => { srvErr += d.toString(); });

  const up = await waitHealth(base);
  if (!up) {
    console.log('  ✗ 服务未能在 20 秒内启动');
    if (srvErr) console.log(srvErr.trim());
    try { srv.kill(); } catch (e) {}
    fs.rmSync(dataDir, { recursive: true, force: true });
    return 1;
  }

  const code = await new Promise(resolve => {
    const t = spawn(process.execPath, ['--no-warnings', 'server/test/' + name + '.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { BASE: base }),
      stdio: 'inherit'
    });
    t.on('exit', resolve);
  });

  try { srv.kill(); } catch (e) {}
  await once(srv, 'server', 3000);
  fs.rmSync(dataDir, { recursive: true, force: true });
  return code === 0 ? 0 : 1;
}

(async () => {
  const picked = process.argv[2] ? [process.argv[2]] : TESTS;
  let failed = 0;
  for (let i = 0; i < picked.length; i++) {
    const code = await runOne(picked[i], PORT_BASE + i);
    if (code !== 0) failed++;
  }
  console.log('\n' + (failed ? '✗ ' + failed + ' 个测试文件失败' : '✓ 全部测试通过'));
  process.exit(failed ? 1 : 0);
})();
