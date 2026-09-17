// hexdoc 图案数据提取（浏览器 / Node 通用：PyPI 元数据 + wheel 解压 + 图案/语言合并）
// 与 scripts/fetch-hexdoc-patterns.mjs 共用同一套解析逻辑。
import { parseZip } from './zipReader.js';
import { parseJsonLoose } from './jsonLoose.js';

export const PYPI_JSON_URL = (pkg) => `https://pypi.org/pypi/${pkg}/json`;
export const USER_AGENT = 'hexcasting-cn-fetch/1.0';

export async function fetchPyPIJson(pkg) {
    const res = await fetch(PYPI_JSON_URL(pkg), { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${pkg}`);
    return res.json();
}

/** HexBug-data 的 requires_dist 里所有 hexdoc-* 依赖名 */
export async function getHexBugDependencies() {
    const info = await fetchPyPIJson('HexBug-data');
    const requires = info.info?.requires_dist || [];
    return requires
        .map((r) => r.match(/^\s*([A-Za-z0-9._-]+)/)?.[1]?.toLowerCase())
        .filter((n) => n && n.startsWith('hexdoc-'));
}

/** 取包的最新 wheel 下载信息 */
export async function getLatestWheel(pkg) {
    const info = await fetchPyPIJson(pkg);
    const version = info.info?.version ?? 'unknown';
    const wheel = (info.urls || []).find((f) => f.packagetype === 'bdist_wheel');
    if (!wheel) throw new Error(`no wheel for ${pkg} ${version}`);
    return { url: wheel.url, version };
}

/**
 * 从 wheel 中查找 patterns.hexdoc.json。
 * 优先匹配 hexdoc_<modpostfix>/ 前缀下的（wheel 里可能打包了其它 mod 的数据文件）。
 */
export function findPatternsEntry(zip, modpostfix) {
    const prefix = `hexdoc_${modpostfix}/`;
    let fallback = null;
    for (const name of zip.keys()) {
        if (!name.endsWith('.patterns.hexdoc.json')) continue;
        if (name.startsWith(prefix)) return name;
        if (!fallback) fallback = name;
    }
    return fallback;
}

/** 收集 assets/<modid>/lang/<lang>.json|json5 → { lang: 表 }；flatten 副本仅在无原始文件时补缺 */
export function loadLangFiles(zip) {
    const langs = {};
    const flatten = {};
    for (const [name, data] of zip) {
        const m = name.match(/assets\/([^/]+)\/lang\/([^/]+)\.json5?$/);
        if (!m) continue;
        const [, mod, tail] = m;
        const base = tail.replace(/\.json5?$/, ''); // 去 .json / .json5 后缀
        let lang = base;
        if (base.endsWith('.flatten')) lang = base.slice(0, -'.flatten'.length); // en_us.flatten → en_us
        if (!lang) continue;
        let table;
        try {
            table = parseJsonLoose(new TextDecoder().decode(data));
        } catch {
            continue;
        }
        if (table && typeof table === 'object' && !Array.isArray(table)) {
            if (base.includes('.flatten')) flatten[lang] = Object.assign(flatten[lang] || {}, table);
            else langs[lang] = Object.assign(langs[lang] || {}, table);
        }
    }
    // flatten（键已是点路径）为对应语言补缺
    for (const [lang, table] of Object.entries(flatten)) {
        if (!langs[lang]) langs[lang] = table;
        else {
            const base = langs[lang];
            for (const [k, v] of Object.entries(table)) if (!(k in base)) base[k] = v;
        }
    }
    return langs;
}

/** 查一个 pattern 在 lang 表里的名称（键为 hexcasting.action.<rawId>，rawId 带命名空间前缀） */
export function resolveName(pattern, langs) {
    const names = {};
    const keys = [];
    if (pattern.rawId) keys.push(`hexcasting.action.${pattern.rawId}`);
    keys.push(`hexcasting.action.${pattern.id}`);
    if (typeof pattern.display_name === 'string') keys.push(pattern.display_name);
    for (const [lang, table] of Object.entries(langs)) {
        for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(table, key)) {
                const v = table[key];
                if (typeof v === 'string' && v) { names[lang] = v; break; }
            }
        }
    }
    return names;
}

/**
 * 从 wheel 二进制提取图案（标准化为 {id, modid, pkg, startDir, angles, names}）。
 * @param {ArrayBuffer|Uint8Array} bytes
 * @param {string} pkg 包名（hexdoc-xxx）
 */
export function extractPatternsFromWheel(bytes, pkg) {
    const postfix = pkg.slice('hexdoc-'.length);
    const modpostfix = postfix.replace(/-/g, '_');
    const zip = parseZip(bytes);
    const patternsEntry = findPatternsEntry(zip, modpostfix);
    if (!patternsEntry) throw new Error(`patterns.hexdoc.json not found in ${pkg}`);
    const patternsData = JSON.parse(new TextDecoder().decode(zip.get(patternsEntry)));
    const patterns = patternsData.patterns || [];
    const langs = loadLangFiles(zip);
    return {
        patterns: patterns
            .map((p) => {
                const rawId = String(p.id ?? ''); // 原始 id（可能带 "hexcasting:" 前缀，lang 键用它）
                const id = rawId.replace(/^[a-z0-9_]+:/i, '');
                return {
                    id,
                    modid: modpostfix,
                    pkg,
                    startDir: toStartDir(p),
                    angles: toAngles(p),
                    names: resolveName({ id, rawId, display_name: p.display_name }, langs),
                };
            })
            .filter((p) => p.id),
        langs: Object.keys(langs).sort(),
        modid: modpostfix,
    };
}

// hexdoc 数据两代格式兼容：新版 startdir(NORTH_EAST)+signature(qaq) / 旧版 start_dir+angles
const DIR_INDEX = { NORTH_EAST: 0, EAST: 1, SOUTH_EAST: 2, SOUTH_WEST: 3, WEST: 4, NORTH_WEST: 5 };
const CHAR_INDEX = { w: 0, e: 1, d: 2, s: 3, a: 4, q: 5 };

function toStartDir(p) {
    if (typeof p.startdir === 'string') return DIR_INDEX[p.startdir.toUpperCase()] ?? 0;
    const v = p.start_dir ?? p.startDir ?? 0;
    return typeof v === 'number' ? ((v % 6) + 6) % 6 : 0;
}

function toAngles(p) {
    if (Array.isArray(p.angles)) return p.angles.map((a) => ((Number(a) % 6) + 6) % 6);
    if (typeof p.signature === 'string') {
        return [...p.signature].map((c) => CHAR_INDEX[c.toLowerCase()]).filter((v) => v !== undefined);
    }
    return [];
}
