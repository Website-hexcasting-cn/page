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

// 自建书不在 <mod>.hexxy.media 上，用站点根路径，版本从 sitemap 解析。
const CUSTOM_BOOK_ROOTS = {
    'hexdoc-miehex-revolution': 'https://hexbook.xm1221.cn/miehex-revolution',
    'hexdoc-abadoned-greatwork': 'https://hexbook.xm1221.cn/abadoned-greatwork',
    'hexdoc-almightly-staff': 'https://hexbook.xm1221.cn/almightly-staff',
    'hexdoc-miehex': 'https://hexbook.xm1221.cn/miehex-for-bigpackage',
};

const BOOK_LANGS = ['zh_cn', 'en_us'];

const ifMissing = process.argv.includes('--if-missing');
if (ifMissing && existsSync(join(OUT_DIR, 'patterns.json'))) {
    const meta = JSON.parse(readFileSync(join(OUT_DIR, 'meta.json'), 'utf8'));
    console.log(`[fetch-hexdoc-patterns] 已有数据（${meta.updatedAt}，${meta.packages} 个包），--if-missing 跳过`);
    process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FETCH_MS = 45_000;
const fetchOpts = () => ({ headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_MS) });

async function fetchBuffer(url) {
    const res = await fetch(url, fetchOpts());
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.arrayBuffer();
}

async function fetchText(url) {
    const res = await fetch(url, { ...fetchOpts(), signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.text();
}

/** 网络抖动时再试一次。 */
async function attempt(label, fn) {
    try {
        return await fn();
    } catch (e) {
        console.warn(`  ↻ ${label} 重试：${e.message}`);
        await sleep(800);
        return await fn();
    }
}

/** sitemap 里优先 1.20 系 latest，否则 latest/main，再否则任一 latest/。 */
function pickLatestKey(keys) {
    const latest = keys.filter((k) => k.startsWith('latest/'));
    return latest.find((k) => /1\.20/.test(k))
        || latest.find((k) => k === 'latest/main')
        || latest[0]
        || null;
}

/** 解析一本书的版本化根路径（不含语言）。找不到返回 null。 */
async function resolveBookBase(pkg) {
    const custom = CUSTOM_BOOK_ROOTS[pkg];
    const root = custom ?? `https://${pkg.slice('hexdoc-'.length)}.hexxy.media`;
    try {
        const sitemap = await attempt(`${pkg} sitemap`, async () => {
            const res = await fetch(`${root}/meta/sitemap.json`, fetchOpts());
            if (!res.ok) throw new Error(`sitemap HTTP ${res.status}`);
            return res.json();
        });
        const versionKey = pickLatestKey(Object.keys(sitemap));
        if (!versionKey) throw new Error('sitemap 无 latest 分支');
        return `${root}/v/${versionKey}`;
    } catch (e) {
        if (custom) return root;
        console.warn(`  ⚠ ${pkg} 无网页书：${e.message}`);
        return null;
    }
}

const regNameOf = (p) => (p.ns ? `${p.ns}:${p.id}` : p.id);

/**
 * 把一条书页条目挂到图案上。有命名空间时按注册名精确匹配；
 * 旧锚点没有命名空间，只在本书对应的包里按短 id 匹配，避免串到别的模组。
 */
function findPatternForEntry(patterns, bookPkg, entry) {
    if (entry.ns) return patterns.find((p) => regNameOf(p) === `${entry.ns}:${entry.id}`) ?? null;
    const inPkg = patterns.filter((p) => p.pkg === bookPkg && p.id === entry.id);
    if (inPkg.length === 1) return inPkg[0];
    const global = patterns.filter((p) => p.id === entry.id);
    return global.length === 1 ? global[0] : null;
}

/** 从 hexdoc 网页书抓取图案介绍（多语言）并写入 patterns。 */
async function fetchBookDescriptions(pkg, base, patterns, known) {
    let attached = 0;
    for (const lang of BOOK_LANGS) {
        try {
            const html = await attempt(`${pkg} 书[${lang}]`, () => fetchText(`${base}/${lang}`));
            const entries = extractPatternEntries(html, known);
            let langHits = 0;
            for (const entry of entries.values()) {
                const pattern = findPatternForEntry(patterns, pkg, entry);
                if (!pattern) continue;
                const own = pattern.pkg === pkg;
                if (entry.category && (own || !pattern.category)) pattern.category = entry.category;
                if (!entry.title && !entry.text) continue;
                // 图案自己的书可以覆盖其它书先写入的介绍；其它书只补缺
                if (!own && pattern.desc?.[lang]) continue;
                if (!pattern.desc) pattern.desc = {};
                const prev = pattern.desc[lang];
                pattern.desc[lang] = { title: entry.title, text: entry.text };
                if (!prev) langHits++;
            }
            attached += langHits;
            console.log(`  ✓ ${pkg} 书[${lang}]: 解析 ${entries.size}，新写入 ${langHits}`);
        } catch (e) {
            console.warn(`  ⚠ ${pkg} 书[${lang}] 抓取失败：${e.message}`);
        }
        await sleep(150);
    }
    return attached;
}

// ─── 主流程 ─────────────────────────────────────────────
const booksOnly = process.argv.includes('--books-only');
const pkgArg = process.argv.find((a) => a.startsWith('--pkgs='));
const pkgFilter = pkgArg ? new Set(pkgArg.slice('--pkgs='.length).split(',').filter(Boolean)) : null;

let packages = [];
let allPatterns = [];
if (booksOnly) {
    allPatterns = JSON.parse(readFileSync(join(OUT_DIR, 'patterns.json'), 'utf8'));
    packages = JSON.parse(readFileSync(join(OUT_DIR, 'packages.json'), 'utf8'));
    console.log(`[fetch-hexdoc-patterns] --books-only，沿用已有 ${allPatterns.length} 个图案`);
} else {
    console.log('[fetch-hexdoc-patterns] 拉取 HexBug-data 元数据…');
    const mainInfo = await fetchPyPIJson('HexBug-data');
    console.log(`  HexBug-data v${mainInfo.info?.version}`);
    const hexDeps = await getHexBugDependencies();
    // 合并用户自己的包（去重）
    const allDeps = [...new Set([...hexDeps, ...EXTRA_PACKAGES])];
    console.log(`  hexdoc-* 依赖：${hexDeps.length} 个 + 额外 ${EXTRA_PACKAGES.length} 个 = ${allDeps.length} 个`);

    for (const dep of allDeps) {
        console.log(`  … ${dep}`);
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
}

// 手册介绍：每个成功拉到图案的包都尝试对应网页书（hexxy.media 或自建站）
const known = {
    regs: new Set(allPatterns.map(regNameOf)),
    ids: new Set(allPatterns.map((p) => p.id)),
};
const bookPkgs = [...new Set(allPatterns.map((p) => p.pkg))].filter((pkg) => !pkgFilter || pkgFilter.has(pkg));
let booksOk = 0;
for (const pkg of bookPkgs) {
    const base = await resolveBookBase(pkg);
    if (!base) continue;
    console.log(`[book] ${pkg} → ${base}`);
    const attached = await fetchBookDescriptions(pkg, base, allPatterns, known);
    if (attached > 0) booksOk++;
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
    books: new Set(allPatterns.filter((p) => p.desc).map((p) => p.pkg)).size,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'patterns.json'), JSON.stringify(allPatterns));
if (!booksOnly) writeFileSync(join(OUT_DIR, 'packages.json'), JSON.stringify(packages, null, 2));
writeFileSync(join(OUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
console.log(`[fetch-hexdoc-patterns] 完成：${allPatterns.length} 个图案，${packages.length} 个包，语言=${allLangs.join(',')}`);
console.log(`  手册介绍覆盖：${descCount}/${allPatterns.length} 个图案（${booksOk} 本书有命中）`);
console.log(`  输出 → public/pattern-data/`);
