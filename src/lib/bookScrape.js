// hexdoc 网页书（index.html）图案条目解析
// hexdoc 网页书为单页应用：所有条目以 <div id="patterns/..."> 锚点内嵌在 index.html 中。
// 锚点格式兼容两代 hexdoc：
//   新版：patterns/<分类>@<ns>:<图案id>    如 patterns/basics@hexcasting:get_caster
//   旧版：patterns/<分类>/<图案id>         如 patterns/spells/changeenv
// 图案条目 div 内含：标题（pattern-title / entry-title）、canvas 签名（data-string/data-start）、介绍文本（<p>）。

/**
 * 从 hexdoc 网页书 HTML 中提取图案条目。
 * @param {string} html 书页 index.html
 * @param {Set<string>} knownIds patterns.json 中已知的图案 id（用于过滤非图案锚点）
 * @returns {Map<string, {title: string, text: string, sig: string|null, start: string|null}>} id → 条目
 */
export function extractPatternEntries(html, knownIds) {
    const out = new Map();
    // 找到所有图案区锚点位置
    const anchorRe = /<div id="(patterns\/[^"]+)" class="entry">/g;
    const anchors = [];
    let m;
    while ((m = anchorRe.exec(html)) !== null) {
        anchors.push({ anchor: m[1], index: m.index });
    }
    for (let i = 0; i < anchors.length; i++) {
        const { anchor, index } = anchors[i];
        const end = i + 1 < anchors.length ? anchors[i + 1].index : html.length;
        const slice = html.slice(index, end);

        const pid = parsePatternId(anchor);
        if (!pid || !knownIds.has(pid)) continue; // 只保留本站收录的图案

        const title = extractTitle(slice);
        const text = extractText(slice);
        if (!title && !text) continue;

        const canvas = slice.match(/data-string="([^"]*)"[^>]*data-start="([^"]*)"/);
        out.set(pid, {
            title,
            text,
            sig: canvas ? canvas[1] : null,
            start: canvas ? canvas[2] : null,
        });
    }
    return out;
}

/** 从锚点提取图案 id：patterns/<分类>@<ns>:<pid> → pid；patterns/<分类>/<pid> → pid */
function parsePatternId(anchor) {
    const at = anchor.indexOf('@');
    if (at >= 0) {
        const after = anchor.slice(at + 1); // ns:pid
        const colon = after.indexOf(':');
        return colon >= 0 ? after.slice(colon + 1) : null;
    }
    // 旧格式：patterns/<分类>/<pid>
    const parts = anchor.split('/');
    return parts.length >= 3 ? parts.slice(2).join('/') : null;
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
