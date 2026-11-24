'use strict';
/**
 * 表格解析（零依赖）
 *   · CSV / TSV：自己写状态机，支持引号、换行、BOM
 *   · XLSX：手写 zip 目录解析 + sharedStrings + sheet 行，够读普通表格，不引第三方库
 * 只做「读」，不写 Excel。
 */
const zlib = require('node:zlib');

/* ============================ CSV ============================ */
function decodeText(buf) {
  let s = buf.toString('utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  // 不是合法 UTF-8 时按 GBK 试一次（Excel 导出的中文 CSV 常见）
  if (s.indexOf('\ufffd') >= 0) {
    try { s = new TextDecoder('gbk').decode(buf); } catch (e) { /* 没有 ICU 就维持 utf8 */ }
  }
  return s;
}

function sniffDelimiter(text) {
  const head = text.slice(0, 4000).split(/\r?\n/).slice(0, 5).join('\n');
  const count = ch => (head.match(new RegExp('\\' + ch, 'g')) || []).length;
  const cands = [',', '\t', ';', '|'];
  let best = ',', bestN = 0;
  for (const c of cands) {
    const n = count(c);
    if (n > bestN) { best = c; bestN = n; }
  }
  return best;
}

function parseCsv(buf) {
  const text = decodeText(buf);
  const delim = sniffDelimiter(text);
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delim) { row.push(cell); cell = ''; continue; }
    if (ch === '\r') { if (text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

/* ============================ XLSX ============================ */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function unzip(buf, want) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 xlsx（zip 结构缺失）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (want(name)) {
      const lh = localOff;
      if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error('xlsx 压缩包损坏（文件头不对）');
      const lNameLen = buf.readUInt16LE(lh + 26);
      const lExtraLen = buf.readUInt16LE(lh + 28);
      const start = lh + 30 + lNameLen + lExtraLen;
      const raw = buf.slice(start, start + compSize);
      if (method === 0) out[name] = raw;
      else if (method === 8) out[name] = zlib.inflateRawSync(raw);
      else throw new Error('xlsx 用了不支持的压缩方式：' + method);
    }
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

const unxml = s => String(s)
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
  .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&amp;/g, '&');

function textOf(xml) {
  let out = '';
  const re = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(xml))) out += unxml(m[1]);
  return out;
}

function colIndex(ref) {
  const letters = String(ref || '').replace(/[^A-Za-z]/g, '').toUpperCase();
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

function parseXlsx(buf) {
  const files = unzip(buf, n =>
    n === 'xl/sharedStrings.xml' || n === 'xl/workbook.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  if (!files['xl/worksheets/sheet1.xml']) throw new Error('xlsx 里没有找到工作表');

  const shared = [];
  if (files['xl/sharedStrings.xml']) {
    const xml = files['xl/sharedStrings.xml'].toString('utf8');
    const re = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(xml))) shared.push(textOf(m[1]));
  }

  const sheet = files['xl/worksheets/sheet1.xml'].toString('utf8');
  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(sheet))) {
    const rowXml = rm[1];
    const cells = [];
    // 注意：空单元格是 <c r="C3"/> 自闭合，必须单独判断，
    // 否则会一路吃到下一个 </c>，把后面的列整体左移
    const cellRe = /<c\b([^>]*?)(\/)?>/g;
    let cm;
    while ((cm = cellRe.exec(rowXml))) {
      const attrs = cm[1] || '';
      let inner = '';
      if (!cm[2]) {
        const end = rowXml.indexOf('</c>', cellRe.lastIndex);
        inner = end >= 0 ? rowXml.slice(cellRe.lastIndex, end) : '';
        if (end >= 0) cellRe.lastIndex = end + 4;
      }
      const refM = attrs.match(/r="([A-Z]+\d+)"/);
      const idx = refM ? colIndex(refM[1]) : cells.length;
      const t = (attrs.match(/\bt="([^"]+)"/) || [])[1] || 'n';
      const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
      let val = '';
      if (t === 's') val = vm ? (shared[Number(vm[1])] || '') : '';
      else if (t === 'inlineStr') val = textOf(inner);
      else if (t === 'str' || t === 'e') val = vm ? unxml(vm[1]) : '';
      else if (t === 'b') val = vm && vm[1] === '1' ? 'TRUE' : 'FALSE';
      else val = vm ? unxml(vm[1]) : '';
      while (cells.length < idx) cells.push('');
      cells[idx] = val;
    }
    if (cells.some(v => String(v).trim() !== '')) rows.push(cells);
  }
  return rows;
}

/* ============================ 统一入口 ============================ */
function parseTable(buf, filename) {
  const name = String(filename || '').toLowerCase();
  if (/\.xlsx$/.test(name)) return { kind: 'xlsx', rows: parseXlsx(buf) };
  if (/\.xls$/.test(name)) throw new Error('老版 .xls 读不了，请在 Excel 里「另存为」xlsx 或 csv 再导入');
  if (/\.(csv|tsv|txt)$/.test(name)) return { kind: 'csv', rows: parseCsv(buf) };
  // 没扩展名：看魔数
  if (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50) return { kind: 'xlsx', rows: parseXlsx(buf) };
  return { kind: 'csv', rows: parseCsv(buf) };
}

/** 表头 + 数据行 → 对象数组（表头去空白、去重） */
function toObjects(rows) {
  if (!rows || !rows.length) return { header: [], list: [] };
  const header = rows[0].map((h, i) => {
    const v = String(h === null || h === undefined ? '' : h).trim();
    return v || ('第' + (i + 1) + '列');
  });
  const seen = {};
  const keys = header.map(h => {
    if (seen[h] === undefined) { seen[h] = 1; return h; }
    seen[h]++;
    return h + seen[h];
  });
  const list = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.some(v => String(v).trim() !== '')) continue;
    const obj = {};
    keys.forEach((k, j) => { obj[k] = r[j] === undefined ? '' : String(r[j]).trim(); });
    list.push(obj);
  }
  return { header: keys, list };
}

module.exports = { parseCsv, parseXlsx, parseTable, toObjects, decodeText, colIndex };
