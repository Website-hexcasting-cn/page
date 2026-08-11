// iota 解析与图案渲染（客户端 JS，供 Astro 组件使用）
// 支持两种格式：
//   iota:<a85>             —— Ascii85 压缩的 NBT 二进制（IotaType.serialize）
//   iota:<ns>:<name>.json  —— 资源 JSON（{"nbt": "<SNBT>"}），fetch 后提取
// 目前只渲染 PatternIota（六边形网格笔画）；其余类型显示类型名。

import { inflate } from 'pako';

// ---------- Ascii85（字符 33~117，'z' = 4 个零字节）----------
const A85_BASE = 33;

export function decodeA85(str) {
  const out = [];
  const chars = [];
  for (const ch of str) {
    if (ch === 'z') {
      out.push(0, 0, 0, 0);
    } else {
      const v = ch.charCodeAt(0) - A85_BASE;
      if (v < 0 || v > 84) continue;
      chars.push(v);
      if (chars.length === 5) {
        const num = chars.reduce((acc, c) => acc * 85 + c, 0);
        out.push((num >>> 24) & 0xff, (num >>> 16) & 0xff, (num >>> 8) & 0xff, num & 0xff);
        chars.length = 0;
      }
    }
  }
  if (chars.length > 1) {
    // 尾部不足 5 个：补 84 到 5 个，解码后取前 n-1 字节
    const origLen = chars.length;
    while (chars.length < 5) chars.push(84);
    const num = chars.reduce((acc, c) => acc * 85 + c, 0);
    const n = origLen - 1;
    const bytes = [(num >>> 24) & 0xff, (num >>> 16) & 0xff, (num >>> 8) & 0xff, num & 0xff];
    for (let i = 0; i < n; i++) out.push(bytes[i]);
  }
  return new Uint8Array(out);
}

// ---------- NBT 二进制解析（覆盖 PatternIota 所需：Compound/String/Byte/ByteArray）----------
export function parseNbt(bytes) {
  const buf = bytes instanceof DataView ? bytes : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  const dec = new TextDecoder();
  const readByte = () => buf.getInt8(off++);
  const readShort = () => { const v = buf.getInt16(off); off += 2; return v; };
  const readInt = () => { const v = buf.getInt32(off); off += 4; return v; };
  const readLong = () => { const v = buf.getBigInt64(off); off += 8; return v; };
  const readFloat = () => { const v = buf.getFloat32(off); off += 4; return v; };
  const readDouble = () => { const v = buf.getFloat64(off); off += 8; return v; };
  const readString = () => { const len = readShort(); const s = dec.decode(new Uint8Array(buf.buffer, buf.byteOffset + off, len)); off += len; return s; };
  const readTag = (type) => {
    switch (type) {
      case 1: return readByte();                       // Byte
      case 2: return readShort();                      // Short
      case 3: return readInt();                        // Int
      case 4: return readLong();                       // Long
      case 5: return readFloat();                      // Float
      case 6: return readDouble();                     // Double
      case 7: {                                        // ByteArray
        const len = readInt(); const arr = [];
        for (let i = 0; i < len; i++) arr.push(readByte());
        return arr;
      }
      case 8: return readString();                     // String
      case 9: {                                        // List
        const etype = readByte(); const len = readInt(); const list = [];
        for (let i = 0; i < len; i++) list.push(readTag(etype));
        return list;
      }
      case 10: {                                       // Compound
        const obj = {}; let t;
        while ((t = readByte()) !== 0) { const name = readString(); obj[name] = readTag(t); }
        return obj;
      }
      case 11: {                                       // IntArray
        const len = readInt(); const arr = [];
        for (let i = 0; i < len; i++) arr.push(readInt());
        return arr;
      }
      case 12: {                                       // LongArray
        const len = readInt(); const arr = [];
        for (let i = 0; i < len; i++) arr.push(readLong());
        return arr;
      }
      default: throw new Error('不支持的 NBT 类型 ' + type);
    }
  };
  const rootType = readByte();
  if (rootType !== 10) throw new Error('根标签不是 Compound');
  readString(); // 根名
  return readTag(10);
}

// ---------- HexPattern：start_dir(0-5) + angles(0-5) → 轴向坐标序列 ----------
// 六方向（HexMod HexDir 顺序，ordinal 即 NBT start_dir）：NORTH_EAST, EAST, SOUTH_EAST, SOUTH_WEST, WEST, NORTH_WEST
const HEX_DIRS = [
  [1, -1],  // NORTH_EAST 0
  [1, 0],   // EAST 1
  [0, 1],   // SOUTH_EAST 2
  [-1, 1],  // SOUTH_WEST 3
  [-1, 0],  // WEST 4
  [0, -1],  // NORTH_WEST 5
];
const HEX_DIR_NAMES = ['NORTH_EAST', 'EAST', 'SOUTH_EAST', 'SOUTH_WEST', 'WEST', 'NORTH_WEST'];

// 笔顺字符 → HexAngle ordinal（HexMod HexAngle.fromChar）
const HEX_ANGLE_CHARS = { w: 0, e: 1, d: 2, s: 3, a: 4, q: 5 };

/** 返回经过的轴向坐标 [[q,r], ...]（含起点与终点；HexMod positions() 同款：最后转向后多走一格） */
export function patternPoints(startDir, angles) {
  let d = ((startDir % 6) + 6) % 6;
  let q = 0, r = 0;
  const pts = [[0, 0]];
  for (const a of angles) {
    const v = HEX_DIRS[d];
    q += v[0]; r += v[1];
    pts.push([q, r]);
    d = ((d + a) % 6 + 6) % 6;
  }
  // HexMod positions()：最后再沿当前方向走一格（终点线段）
  const last = HEX_DIRS[d];
  pts.push([q + last[0], r + last[1]]);
  return pts;
}

// ---------- 轴向坐标 → SVG ----------
const SQRT3 = Math.sqrt(3);
// HexMod 官方 coordToPx：x = size * √3 * (q + r/2)，y = size * 1.5 * r
const coordToPx = (q, r, size) => [size * (SQRT3 * q + SQRT3 / 2 * r), size * 1.5 * r];

export function patternToSvg(startDir, angles, opts = {}) {
  const size = opts.size ?? 14;            // 每格间距（px）
  const dotColor = opts.dotColor ?? '#c8b7dc';
  const lineColor = opts.lineColor ?? '#9db8ff';   // 鲜明浅蓝（HexMod 图案色系）
  const dotR = opts.dotR ?? 2.2;                   // 节点圆点加大
  const strokeW = opts.strokeWidth ?? Math.max(2.5, size * 0.22); // 加粗笔画
  const showGrid = opts.grid ?? true;              // 是否画背景网格点阵（列表内关闭）

  const pts = patternPoints(startDir, angles);
  const px = pts.map(([q, r]) => coordToPx(q, r, size));

  // 居中
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of px) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const pad = size * 1.2;
  const w = (maxX - minX) + pad * 2, h = (maxY - minY) + pad * 2;

  // 网格点阵：覆盖图案外接六边形区域
  const grid = [];
  const radius = Math.max(2, Math.ceil(Math.max(w, h) / size));
  for (let q = -radius; q <= radius; q++) {
    for (let r = -radius; r <= radius; r++) {
      const [gx, gy] = coordToPx(q, r, size);
      const x = gx - cx + w / 2;
      const y = gy - cy + h / 2;
      if (x >= 0 && x <= w && y >= 0 && y <= h) grid.push([x, y]);
    }
  }

  const path = px.map(([x, y], i) =>
    (i === 0 ? `M ${x - cx + w / 2} ${y - cy + h / 2}` : `L ${x - cx + w / 2} ${y - cy + h / 2}`)
  ).join(' ');

  const dots = px.map(([x, y]) =>
    `<circle cx="${(x - cx + w / 2).toFixed(2)}" cy="${(y - cy + h / 2).toFixed(2)}" r="${dotR}" fill="${lineColor}"/>`
  ).join('');

  const gridDots = showGrid ? grid.map(([x, y]) =>
    `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="0.8" fill="${dotColor}"/>`
  ).join('') : '';

  return {
    svg: `<svg viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" xmlns="http://www.w3.org/2000/svg" role="img">` +
      gridDots +
      `<path d="${path}" stroke="${lineColor}" stroke-width="${strokeW}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` +
      dots +
      `</svg>`,
    width: w, height: h,
  };
}

// ---------- 统一入口：iota 字符串 → { kind, ... } ----------
/** 按括号深度分割顶层逗号（支持 vec:{}/pattern{}/嵌套 iota:[...]） */
function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 解析 hexguide 便携 iota 语法（无 iota: 前缀的内容）：double:/vec:{}/pattern{}/null/iota:[...] */
export function parsePortable(raw) {
  if (raw === 'null') return { kind: 'null' };
  if (raw === 'true') return { kind: 'boolean', value: true };
  if (raw === 'false') return { kind: 'boolean', value: false };
  if (raw.startsWith('double:')) {
    const v = parseFloat(raw.slice(7));
    return Number.isNaN(v) ? null : { kind: 'double', value: v };
  }
  if (raw.startsWith('vec:{') && raw.endsWith('}')) {
    const parts = raw.slice(5, -1).split(',').map((s) => parseFloat(s.trim()));
    if (parts.length === 3 && parts.every((n) => !Number.isNaN(n))) {
      return { kind: 'vec3', x: parts[0], y: parts[1], z: parts[2] };
    }
    return null;
  }
  if (raw.startsWith('pattern{') && raw.endsWith('}')) {
    // pattern{NORTH_EAST,qqaeaae}：朝向名, 笔顺（HexAngle 字符 w/e/d/s/a/q）
    const inner = raw.slice(8, -1);
    const comma = inner.indexOf(',');
    if (comma > 0) {
      const dirName = inner.slice(0, comma).trim().toUpperCase();
      const sig = inner.slice(comma + 1).trim();
      const startDir = HEX_DIR_NAMES.indexOf(dirName);
      if (startDir >= 0 && sig) {
        const angles = [...sig].map((c) => HEX_ANGLE_CHARS[c]).filter((a) => a !== undefined);
        if (angles.length === sig.length) return { kind: 'pattern', startDir, angles };
      }
    }
    return null;
  }
  if (raw.startsWith('[') && raw.endsWith(']')) {
    // [元素,...]：元素递归解析（double:/vec:{}/pattern{}/iota:[...]/null）——前缀 iota: 已被剥掉
    const inner = raw.slice(1, -1);
    const items = splitTopLevel(inner)
      .map((el) => parseIotaString(el))
      .filter((k) => k.kind !== 'unknown' && k.kind !== 'error');
    return { kind: 'list', items };
  }
  return null;
}

export function parseIotaString(str) {
  if (!str) return { kind: 'unknown', label: '' };
  if (!str.startsWith('iota:')) {
    // 便携语法（列表元素等无前缀形式）
    const p = parsePortable(str);
    return p ?? { kind: 'unknown', label: str };
  }
  const raw = str.slice(5);

  // 便携语法（iota: 前缀后）
  const portable = parsePortable(raw);
  if (portable) return portable;

  // 资源 JSON 引用：iota:<ns>:<name>.json 或 iota:<name>.json
  if (raw.includes('.json')) {
    return { kind: 'resource', raw };
  }

  // Ascii85
  try {
    const compressed = decodeA85(raw);
    const bytes = inflate(compressed);
    const nbt = parseNbt(bytes);
    return extractIota(nbt);
  } catch (e) {
    return { kind: 'error', label: `解析失败: ${e.message}` };
  }
}

/** 从 NBT（{type, data}）提取结构化 Iota：pattern/double/vec3/null/garbage/list/unknown */
export function extractIota(nbt) {
  // 数组（嵌套列表）→ list
  if (Array.isArray(nbt)) return { kind: 'list', items: nbt.map(extractIota) };
  const type = nbt['hexcasting:type'] ?? nbt['type'];
  const data = nbt['hexcasting:data'] ?? nbt['data'] ?? {};
  switch (type) {
    case 'hexcasting:pattern': {
      const startDir = data['start_dir'] ?? data['startDir'];
      const angles = data['angles'];
      if (typeof startDir === 'number' && Array.isArray(angles)) {
        return { kind: 'pattern', startDir, angles: angles.map((a) => ((a % 6) + 6) % 6) };
      }
      return { kind: 'unknown', label: type };
    }
    case 'hexcasting:double': {
      // data 是裸 DoubleTag（如 {"hexcasting:data":0.0d}），也可能是 {x: ...} 对象
      const v = data && typeof data === 'object' ? data['x'] : data;
      return { kind: 'double', value: Number(v) };
    }
    case 'hexcasting:boolean': {
      // data 是裸 ByteTag（如 {"hexcasting:data":1b}），也可能是 {x: ...} 对象
      const b = data && typeof data === 'object' ? data['x'] : data;
      return { kind: 'boolean', value: b === true || b === 1 || b === '1b' || b === 'true' };
    }
    case 'hexcasting:vec3':
      return { kind: 'vec3', x: data['x'], y: data['y'], z: data['z'] };
    case 'hexcasting:null':
      return { kind: 'null' };
    case 'hexcasting:garbage':
      return { kind: 'garbage' };
    case 'hexcasting:list': {
      // data 可能是 {hexcasting:inner:[...]}，也可能直接是数组（quine.json 这类）
      const inner = data['hexcasting:inner'] ?? data['inner'] ?? data;
      if (!Array.isArray(inner)) return { kind: 'list', items: [] };
      return { kind: 'list', items: inner.map((it) => extractIota(it)) };
    }
    default:
      return { kind: 'unknown', label: type ?? 'iota' };
  }
}

/** 简易 SNBT 解析：把单个值字符串解析为 JS 对象/数组/数字/字符串 */
function findKeyColon(kv) {
  // 键名可含冒号（hexcasting:type），找第一个"冒号后跟值首字符"的分界
  for (let i = 0; i < kv.length; i++) {
    if (kv[i] === ':') {
      const next = kv[i + 1];
      if (next === '"' || next === '{' || next === '[' || next === '-' || (next >= '0' && next <= '9')) return i;
    }
  }
  return -1;
}

function parseSnbtValue(str) {
  str = (str || '').trim();
  if (str.startsWith('{')) {
    const inner = str.slice(1, -1);
    const obj = {};
    if (inner.trim()) {
      for (const kv of splitTopLevel(inner)) {
        const ci = findKeyColon(kv);
        if (ci <= 0) continue;
        const key = kv.slice(0, ci).trim().replace(/^"|"$/g, '');
        obj[key] = parseSnbtValue(kv.slice(ci + 1));
      }
    }
    return obj;
  }
  if (str.startsWith('[')) {
    // 带类型前缀的数组：[B;1b,2b]（ByteArray）/ [I;1,2]（IntArray）/ [L;1l,2l]（LongArray）
    const pm = str.match(/^\[([BIL]);(.*)\]$/s);
    if (pm) {
      const body = pm[2];
      if (!body.trim()) return [];
      return body.split(',').map((p) => parseInt(p.trim(), 10)).filter((n) => !Number.isNaN(n));
    }
    const inner = str.slice(1, -1);
    const parts = splitTopLevel(inner);
    if (!parts.length || (parts.length === 1 && parts[0] === '')) return [];
    if (parts.every((p) => /^-?\d+[bB]$/.test(p))) return parts.map((p) => parseInt(p, 10));      // ByteArray
    if (parts.every((p) => /^-?\d+[iI]$/.test(p))) return parts.map((p) => parseInt(p, 10));      // IntArray
    return parts.map(parseSnbtValue);                                                               // List
  }
  if (str.startsWith('"') && str.endsWith('"')) return str.slice(1, -1);
  if (/^-?\d+[bBsSlL]$/.test(str)) return parseInt(str.slice(0, -1), 10);   // Byte/Short/Long（整数）
  if (/^-?\d*\.?\d+[fFdD]$/.test(str)) return parseFloat(str.slice(0, -1));  // Float/Double（含 2.5d）
  if (/^-?\d+$/.test(str)) return parseInt(str, 10);
  if (/^-?\d*\.\d+(?:[eE][+-]?\d+)?$/.test(str) || /^-?\d+[eE][+-]?\d+$/.test(str)) return parseFloat(str);
  return str; // 未知 → 字符串
}

/** 从资源 JSON 的 SNBT 字符串提取结构化 Iota（优先 JSON 形式，回退完整 SNBT 解析） */
export function extractIotaFromSnbt(snbt) {
  if (!snbt) return { kind: 'unknown', label: 'iota' };
  // 优先 JSON 形式：{"hexcasting:type":..., "hexcasting:data":{...}}
  try {
    const obj = JSON.parse(snbt);
    if (obj && obj['hexcasting:type'] && obj['hexcasting:data']) {
      return extractIota(obj);
    }
  } catch (e) { /* 非 JSON */ }
  // SNBT 完整解析（支持列表/多图案等 HexGuide 保存格式）
  try {
    const obj = parseSnbtValue(snbt);
    if (obj && obj['hexcasting:type']) {
      return extractIota(obj);
    }
    // 兼容 quine.json 这类：顶层 {hexcasting:data:[...]}（ListIota 的 inner，无 type 包装）
    if (obj && Array.isArray(obj['hexcasting:data'])) {
      return { kind: 'list', items: obj['hexcasting:data'].map(extractIota) };
    }
    if (obj && Array.isArray(obj['hexcasting:inner'])) {
      return { kind: 'list', items: obj['hexcasting:inner'].map(extractIota) };
    }
  } catch (e) { /* 解析失败 */ }
  // 兜底：正则提取单个图案
  const sd = snbt.match(/start_dir\s*:\s*(-?\d+)/i);
  const ang = snbt.match(/angles\s*:\s*\[([^\]]*)\]/i);
  const type = snbt.match(/hexcasting:type\s*:\s*"?([a-z0-9:_-]+)"?/i)?.[1] ?? 'iota';
  if (sd && ang) {
    const angles = ang[1].split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n));
    return { kind: 'pattern', startDir: parseInt(sd[1], 10), angles: angles.map((a) => ((a % 6) + 6) % 6) };
  }
  return { kind: 'unknown', label: type };
}

/**
 * 资源 JSON 引用 → SNBT。
 * 约定：iota:<ns>:<name>.json（或 iota:<name>.json，ns 默认 hexguide）
 * 站点文件放 public/<ns>/iotas/<name>.json → fetch /<ns>/iotas/<name>.json
 */
export async function fetchResourceSnbt(raw) {
  let ns = 'hexguide';
  let path = raw;
  const ci = raw.indexOf(':');
  if (ci > 0) { ns = raw.slice(0, ci); path = raw.slice(ci + 1); }
  if (!path.endsWith('.json')) path += '.json';
  const url = `/${ns}/iotas/${path}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`资源不存在: ${url}`);
  const json = await res.json();
  if (json && typeof json.nbt === 'string') return json.nbt;
  return JSON.stringify(json); // 兼容直接 SNBT JSON
}

// ---------- 自动渲染：扫描页面文本，把 iota:... 替换为图案/图标 ----------

/** 数值格式化：整数不带小数，其余保留合理位数 */
function fmtNum(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  return String(parseFloat(n.toFixed(4)));
}

/** 按结构化 Iota 渲染为 HTML（列表递归；列表内 pattern 用小 size 且不画网格，保持紧凑） */
export function renderIotaHtml(kind, size, inList = false) {
  switch (kind.kind) {
    case 'pattern': {
      const r = patternToSvg(kind.startDir, kind.angles, {
        size: inList ? Math.max(7, size * 0.6) : size,
        grid: !inList,
      });
      return r.svg;
    }
    case 'double':
      return `<span class="iota-double">${fmtNum(kind.value)}</span>`;
    case 'boolean':
      // True/False 为专有名词不翻译；颜色仿照 HexMod BooleanIota.display（绿/红）
      return `<span class="iota-boolean${kind.value ? ' iota-true' : ' iota-false'}">${kind.value ? 'True' : 'False'}</span>`;
    case 'vec3':
      return `<span class="iota-vec">(${fmtNum(kind.x)}, ${fmtNum(kind.y)}, ${fmtNum(kind.z)})</span>`;
    case 'null':
      return `<span class="iota-null">Null</span>`;
    case 'garbage':
      return `<span class="iota-garbage">�乱码�</span>`;
    case 'list': {
      // HexMod 规则：相邻两个都是图案 → 不加逗号；涉及非图案 → 加逗号
      const items = kind.items;
      const htmls = items.map((it) => renderIotaHtml(it, size, true));
      const inner = items.map((it, i) => {
        const needComma = i < items.length - 1 && (items[i].kind !== 'pattern' || items[i + 1].kind !== 'pattern');
        return htmls[i] + (needComma ? '<span class="iota-comma">,</span>' : '');
      }).join('');
      return `<span class="iota-list">[${inner}]</span>`;
    }
    default:
      return `<span class="iota-label">${kind.label ?? 'iota'}</span>`;
  }
}

/** 渲染单个 iota span（由 autoRenderIotas 或组件调用） */
export async function renderIotaSpan(span) {
  const value = span.dataset.iota;
  const size = parseInt(span.dataset.size || '14', 10);
  if (!value || !value.startsWith('iota:')) {
    span.className = 'iota-pattern iota-error';
    span.textContent = value || '';
    return;
  }
  const parsed = parseIotaString(value);
  if (parsed.kind === 'resource') {
    try {
      const snbt = await fetchResourceSnbt(parsed.raw);
      const kind = extractIotaFromSnbt(snbt);
      span.className = 'iota-pattern';
      span.innerHTML = renderIotaHtml(kind, size);
    } catch (e) {
      span.className = 'iota-pattern iota-error';
      span.textContent = value; // 失败保留原文
    }
  } else if (parsed.kind === 'error') {
    span.className = 'iota-pattern iota-error';
    span.textContent = value;
  } else {
    span.className = 'iota-pattern';
    span.innerHTML = renderIotaHtml(parsed, size);
  }
}

/**
 * 扫描 root（默认 document.body）的文本节点，把 iota:... 替换为图案 span。
 * 跳过 script/style/pre/code/textarea/input（代码块和表单里保留原文）。
 */
export function autoRenderIotas(root = document.body) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p || p.closest('script,style,pre,code,textarea,input,svg')) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue.includes('iota:')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) replaceTextNode(node);
}

function replaceTextNode(node) {
  const text = node.nodeValue;
  const re = /iota:[!-~]+/g;
  let m;
  let last = 0;
  const frag = document.createDocumentFragment();
  let changed = false;
  while ((m = re.exec(text)) !== null) {
    const value = m[0];
    frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    const span = document.createElement('span');
    span.className = 'iota-pattern';
    span.dataset.iota = value;
    span.dataset.size = '14';
    span.textContent = '…';
    frag.appendChild(span);
    last = m.index + value.length;
    changed = true;
  }
  if (changed) {
    frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
    frag.querySelectorAll('.iota-pattern').forEach((s) => renderIotaSpan(s));
  }
}
