#!/usr/bin/env node
// 从 PyPI 拉取 HexBug-data 及其 hexdoc-* 依赖的图案与多语言名称，并抓取 hexdoc 网页书的手册介绍。
// 用法：
//   node scripts/fetch-hexdoc-patterns.mjs            # 总是重新拉取
//   node scripts/fetch-hexdoc-patterns.mjs --if-missing  # 已有数据则跳过（供 build 用）
// 输出：public/pattern-data/{meta.json, packages.json, patterns.json}
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    fetchPyPIJson,
    getHexBugDependencies,
    getLatestWheel,
    extractPatternsFromWheel,
    USER_AGENT,
} from '../src/lib/hexdocData.js';
import { extractPatternEntries } from '../src/lib/bookScrape.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public', 'pattern-data');

// HexBug-data 未收录但已发布到 PyPI 的 hexdoc 包（用户自己的书）
const EXTRA_PACKAGES = [
    'hexdoc-miehex-revolution',
    'hexdoc-abadoned-greatwork',
    'hexdoc-almightly-staff',
    'hexdoc-miehex',
];

// 手册（hexdoc 网页书）来源：包名 → 书 URL 模板
// 原版用 hexxy.media 的 latest/1.20 分支；用户的书用 hexbook.xm1221.cn（hash 从 sitemap 动态获取）
const BOOKS = [
    { pkg: 'hexdoc-hexcasting', url: 'https://hexcasting.hexxy.media/v/latest/1.20' },
    { pkg: 'hexdoc-miehex-revolution', url: 'https://hexbook.xm1221.cn/miehex-revolution' },
    { pkg: 'hexdoc-abadoned-greatwork', url: 'https://hexbook.xm1221.cn/abadoned-greatwork' },
    { pkg: 'hexdoc-almightly-staff', url: 'https://hexbook.xm1221.cn/almightly-staff' },
    { pkg: 'hexdoc-miehex', url: 'https://hexbook.xm1221.cn/miehex-for-bigpackage' },
];

const BOOK_LANGS = ['zh_cn', 'en_us'];

const ifMissing = process.argv.includes('--if-missing');
if (ifMissing && existsSync(join(OUT_DIR, 'patterns.json'))) {
    const meta = JSON.parse(readFileSync(join(OUT_DIR, 'meta.json'), 'utf8'));
    console.log(`[fetch-hexdoc-patterns] 已有数据（${meta.updatedAt}，${meta.packages} 个包），--if-missing 跳过`);
    process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchBuffer(url) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.arrayBuffer();
}

async function fetchText(url) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.text();
}

/** 从 hexdoc 网页书抓取图案介绍（多语言），挂到 patterns（按 id） */
async function fetchBookDescriptions(book, knownIds) {
    const descMap = new Map(); // id → { lang: {title, text} }
    let base = book.url;
    try {
        // hexbook 部署：从 sitemap 拿当前 hash（latest/<hash>）
        if (book.url.includes('hexbook.xm1221.cn')) {
            const sitemap = await (await fetch(`${book.url}/meta/sitemap.json`, { headers: { 'User-Agent': USER_AGENT } })).json();
            const versionKey = Object.keys(sitemap).find((k) => k.startsWith('latest/'));
            if (versionKey) base = `${book.url}/v/${versionKey}`;
        }
    } catch { /* 保持原 URL */ }

    for (const lang of BOOK_LANGS) {
        try {
            const html = await fetchText(`${base}/${lang}`);
            const entries = extractPatternEntries(html, knownIds);
            for (const [id, entry] of entries) {
                if (!descMap.has(id)) descMap.set(id, {});
                descMap.get(id)[lang] = entry;
            }
            console.log(`  ✓ ${book.pkg} 书[${lang}]: ${entries.size} 个图案条目`);
        } catch (e) {
            console.warn(`  ⚠ ${book.pkg} 书[${lang}] 抓取失败：${e.message}`);
        }
        await sleep(150);
    }
    return descMap;
}

// ─── 主流程 ─────────────────────────────────────────────
console.log('[fetch-hexdoc-patterns] 拉取 HexBug-data 元数据…');
const mainInfo = await fetchPyPIJson('HexBug-data');
console.log(`  HexBug-data v${mainInfo.info?.version}`);
const hexDeps = await getHexBugDependencies();
// 合并用户自己的包（去重）
const allDeps = [...new Set([...hexDeps, ...EXTRA_PACKAGES])];
console.log(`  hexdoc-* 依赖：${hexDeps.length} 个 + 额外 ${EXTRA_PACKAGES.length} 个 = ${allDeps.length} 个`);

const packages = [];
const allPatterns = [];
for (const dep of allDeps) {
    try {
        const { url, version } = await getLatestWheel(dep);
        const bytes = await fetchBuffer(url);
        const { patterns, modid } = extractPatternsFromWheel(bytes, dep);
        packages.push({ pkg: dep, version, count: patterns.length, modid });
        allPatterns.push(...patterns);
        console.log(`  ✓ ${dep} v${version}: ${patterns.length} patterns（modid=${modid}）`);
        await sleep(200); // 礼貌限速
    } catch (e) {
        console.warn(`  ⚠ ${dep} 处理失败：${e.message}`);
        packages.push({ pkg: dep, version: 'error', count: 0, error: String(e.message) });
    }
}

// 手册介绍（先建 id 集合用于过滤）
const knownIds = new Set(allPatterns.map((p) => p.id));
const descByPattern = new Map();
for (const book of BOOKS) {
    console.log(`[book] ${book.pkg} → ${book.url}`);
    const map = await fetchBookDescriptions(book, knownIds);
    for (const [id, desc] of map) {
        if (!descByPattern.has(id)) descByPattern.set(id, {});
        Object.assign(descByPattern.get(id), desc);
    }
}

// 合并 desc 到图案
for (const p of allPatterns) {
    const desc = descByPattern.get(p.id);
    if (desc) p.desc = desc;
}

allPatterns.sort((a, b) => a.pkg.localeCompare(b.pkg) || a.id.localeCompare(b.id));
const allLangs = [...new Set(allPatterns.flatMap((p) => Object.keys(p.names)))].sort();
const descCount = allPatterns.filter((p) => p.desc).length;

const meta = {
    source: 'PyPI HexBug-data + hexdoc 网页书',
    updatedAt: new Date().toISOString(),
    total: allPatterns.length,
    packages: packages.length,
    langs: allLangs,
    withDesc: descCount,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'patterns.json'), JSON.stringify(allPatterns));
writeFileSync(join(OUT_DIR, 'packages.json'), JSON.stringify(packages, null, 2));
writeFileSync(join(OUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
console.log(`[fetch-hexdoc-patterns] 完成：${allPatterns.length} 个图案，${packages.length} 个包，语言=${allLangs.join(',')}`);
console.log(`  手册介绍覆盖：${descCount}/${allPatterns.length} 个图案`);
console.log(`  输出 → public/pattern-data/`);
