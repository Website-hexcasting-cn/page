// hexdoc 网页书（index.html）图案条目解析
// hexdoc 网页书为单页应用：所有条目以 <div id="patterns/..."> 锚点内嵌在 index.html 中。
// 锚点格式兼容两代 hexdoc：
//   新版：patterns/<分类>@<ns>:<图案id>    如 patterns/basics@hexcasting:get_caster
//   旧版：patterns/<分类>/<图案id>         如 patterns/spells/changeenv
// 图案条目 div 内含：标题（pattern-title / entry-title）、canvas 签名（data-string/data-start）、介绍文本（<p>）。

/**
 * @typedef {{ regs?: Set<string>, ids?: Set<string> }} KnownPatterns
 * @typedef {{ key: string, ns: string|null, id: string, category: string, title: string, text: string }} PatternEntry
 */

/**
 * 从 hexdoc 网页书 HTML 中提取图案条目。
 * 合并键：有命名空间时为 `ns:id`，旧锚点只有短 id。
 * @param {string} html 书页 index.html
 * @param {KnownPatterns} known 本站收录的注册名 / 短 id（用于过滤分类锚点）
 * @returns {Map<string, PatternEntry>}
 */
export function extractPatternEntries(html, known) {
    const regs = known?.regs ?? new Set();
    const ids = known?.ids ?? new Set();
    const out = new Map();
    // 匹配所有 patterns/ 锚点 div（class 可不含 entry：新版 hexdoc 图案 div 无 class，旧版为 class=""）
    const anchorRe = /<div[^>]*id="(patterns\/[^"]+)"[^>]*>/g;
    const anchors = [];
    let m;
    while ((m = anchorRe.exec(html)) !== null) {
        anchors.push({ anchor: m[1], index: m.index });
    }
    for (let i = 0; i < anchors.length; i++) {
        const { anchor, index } = anchors[i];
        const end = i + 1 < anchors.length ? anchors[i + 1].index : html.length;
        const slice = html.slice(index, end);

        const parsed = parseAnchor(anchor);
        if (!parsed || !isKnown(parsed, regs, ids)) continue;

        const title = extractTitle(slice);
        const text = extractText(slice);
        const entry = {
            key: parsed.ns ? `${parsed.ns}:${parsed.id}` : parsed.id,
            ns: parsed.ns,
            id: parsed.id,
            category: parsed.category,
            title,
            text,
        };
        const prev = out.get(entry.key);
        if (prev && (prev.text?.length || 0) >= (text?.length || 0) && (prev.title || !title)) continue;
        out.set(entry.key, entry);
    }
    return out;
}

function isKnown(parsed, regs, ids) {
    if (parsed.ns) return regs.has(`${parsed.ns}:${parsed.id}`);
    return ids.has(parsed.id);
}

/** @returns {{ category: string, ns: string|null, id: string } | null} */
function parseAnchor(anchor) {
    let raw = anchor;
    try { raw = decodeURIComponent(anchor); } catch { /* 保持原文 */ }
    const at = raw.indexOf('@');
    if (at >= 0) {
        const category = raw.slice('patterns/'.length, at);
        const after = raw.slice(at + 1); // ns:pid
        const colon = after.indexOf(':');
        if (colon < 0) return null;
        const ns = after.slice(0, colon);
        const id = after.slice(colon + 1);
        if (!ns || !id) return null;
        return { category, ns, id };
    }
    // 旧格式：patterns/<分类>/<pid>
    const parts = raw.split('/');
    if (parts.length < 3) return null;
    return { category: parts[1], ns: null, id: parts.slice(2).join('/') };
}

function extractTitle(slice) {
    const m = slice.match(/class="pattern-title"[^>]*>([\s\S]*?)<\/h4>/);
    if (m) return cleanText(m[1]);
    const m2 = slice.match(/class="entry-title[^"]*"[^>]*>([\s\S]*?)<\/h3>/);
    return m2 ? cleanText(m2[1]) : '';
}

function extractText(slice) {
    // 条目 div 内所有 <p> 段落文本（跳过“渲染方式/配色/浏览器不支持”等界面文案）
    const paras = [];
    const pRe = /<p[^>]*>([\s\S]*?)<\/p>/g;
    let m;
    while ((m = pRe.exec(slice)) !== null) {
        const t = cleanText(m[1]);
        if (!t) continue;
        if (/渲染方式|配色|浏览器不支持|不支持的浏览器|可视化/.test(t)) continue;
        if (t.length < 2) continue;
        paras.push(t);
    }
    return paras.join('\n');
}

function cleanText(s) {
    return s
        .replace(/<[^>]+>/g, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&#\d+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
