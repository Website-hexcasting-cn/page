// 宽松 JSON 解析：剥离 // 与 /* */ 注释、去掉尾逗号后 JSON.parse。
// 用于 hexdoc wheel 内的 lang 文件（可能以 .json5 扩展名保存的标准 JSON）。
export function stripComments(src) {
    let out = '';
    let i = 0;
    const n = src.length;
    let inStr = null; // '"' 或 "'"
    let esc = false;
    while (i < n) {
        const c = src[i];
        if (inStr) {
            out += c;
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === inStr) inStr = null;
            i++;
            continue;
        }
        if (c === '"' || c === "'") { inStr = c; out += c; i++; continue; }
        if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
        if (c === '/' && src[i + 1] === '*') {
            i += 2;
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
            i = Math.min(i + 2, n);
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

/** 解析可能带注释/尾逗号的 JSON（.json5 兼容层），失败抛错 */
export function parseJsonLoose(src) {
    const cleaned = stripComments(src).replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(cleaned);
}
