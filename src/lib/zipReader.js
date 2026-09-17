// 极简 ZIP 读取器（浏览器 / Node 通用，零依赖，仅用 pako inflateRaw）
// 覆盖 hexdoc wheel 所需：EOCD → central directory → local header → stored/deflate
import { inflateRaw } from 'pako';

function latin1(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
}

/**
 * 解析 ZIP 二进制，返回 Map<entryName, Uint8Array>。
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Map<string, Uint8Array>}
 */
export function parseZip(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // 定位 EOCD（PK\x05\x06），zip 注释最多 65535 字节 → 从尾部起扫
    let eocd = -1;
    const scanStart = Math.max(0, bytes.length - 22 - 65535);
    for (let i = bytes.length - 22; i >= scanStart; i--) {
        if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error('zip: EOCD 未找到');

    const cdCount = dv.getUint16(eocd + 10, true);
    const cdOffset = dv.getUint32(eocd + 16, true);

    // 中央目录
    const entries = new Map();
    let p = cdOffset;
    for (let k = 0; k < cdCount; k++) {
        if (bytes[p] !== 0x50 || bytes[p + 1] !== 0x4b || bytes[p + 2] !== 0x01 || bytes[p + 3] !== 0x02) break;
        const flags = dv.getUint16(p + 8, true);
        const method = dv.getUint16(p + 10, true);
        const compSize = dv.getUint32(p + 20, true);
        const nameLen = dv.getUint16(p + 28, true);
        const extraLen = dv.getUint16(p + 30, true);
        const commentLen = dv.getUint16(p + 32, true);
        const localOff = dv.getUint32(p + 42, true);
        const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
        const name = flags & 0x800 ? new TextDecoder().decode(nameBytes) : latin1(nameBytes);
        entries.set(name, { method, compSize, localOff });
        p += 46 + nameLen + extraLen + commentLen;
    }

    // 逐个解压
    const out = new Map();
    for (const [name, e] of entries) {
        if (name.endsWith('/')) continue; // 目录项
        let lp = e.localOff;
        if (bytes[lp] !== 0x50 || bytes[lp + 1] !== 0x4b || bytes[lp + 2] !== 0x03 || bytes[lp + 3] !== 0x04) {
            throw new Error(`zip: 本地头损坏 ${name}`);
        }
        const nameLen = dv.getUint16(lp + 26, true);
        const extraLen = dv.getUint16(lp + 28, true);
        const dataStart = lp + 30 + nameLen + extraLen;
        const comp = bytes.subarray(dataStart, dataStart + e.compSize);
        let data;
        if (e.method === 0) data = comp; // stored
        else if (e.method === 8) data = inflateRaw(comp); // deflate
        else throw new Error(`zip: 不支持的压缩方式 ${e.method}（${name}）`);
        out.set(name, data);
    }
    return out;
}
