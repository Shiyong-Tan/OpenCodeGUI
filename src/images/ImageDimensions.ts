import * as fs from 'fs';
import * as path from 'path';

export interface ImageDimensions {
    readonly width: number;
    readonly height: number;
}

const MAX_HEADER_BYTES = 256 * 1024;

function valid(width: number, height: number): ImageDimensions | undefined {
    return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
        ? { width, height }
        : undefined;
}

function jpegDimensions(buffer: Buffer): ImageDimensions | undefined {
    let offset = 2;
    while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset += 1; continue; }
        const marker = buffer[offset + 1];
        offset += 2;
        if (marker === 0xd8 || marker === 0xd9) continue;
        if (offset + 2 > buffer.length) break;
        const length = buffer.readUInt16BE(offset);
        if (length < 2 || offset + length > buffer.length) break;
        if ((marker >= 0xc0 && marker <= 0xc3)
            || (marker >= 0xc5 && marker <= 0xc7)
            || (marker >= 0xc9 && marker <= 0xcb)
            || (marker >= 0xcd && marker <= 0xcf)) {
            return valid(buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3));
        }
        offset += length;
    }
    return undefined;
}

function webpDimensions(buffer: Buffer): ImageDimensions | undefined {
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && buffer.length >= 30) {
        const width = 1 + buffer.readUIntLE(24, 3);
        const height = 1 + buffer.readUIntLE(27, 3);
        return valid(width, height);
    }
    if (chunk === 'VP8 ' && buffer.length >= 30) {
        return valid(buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff);
    }
    if (chunk === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
        const width = 1 + buffer[21] + ((buffer[22] & 0x3f) << 8);
        const height = 1 + ((buffer[22] & 0xc0) >> 6) + (buffer[23] << 2) + ((buffer[24] & 0x0f) << 10);
        return valid(width, height);
    }
    return undefined;
}

function svgDimensions(buffer: Buffer): ImageDimensions | undefined {
    const source = buffer.toString('utf8');
    const tag = source.match(/<svg\b[^>]*>/i)?.[0] || '';
    const numeric = (name: string) => {
        const value = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']\\s*([0-9.]+)`, 'i'))?.[1];
        return value ? Math.round(Number(value)) : 0;
    };
    const explicit = valid(numeric('width'), numeric('height'));
    if (explicit) return explicit;
    const viewBox = tag.match(/\bviewBox\s*=\s*["']\s*[-+0-9.e]+[ ,]+[-+0-9.e]+[ ,]+([-+0-9.e]+)[ ,]+([-+0-9.e]+)/i);
    return viewBox ? valid(Math.round(Number(viewBox[1])), Math.round(Number(viewBox[2]))) : undefined;
}

export function parseImageDimensions(buffer: Buffer, extension = ''): ImageDimensions | undefined {
    if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        return valid(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
    }
    if (buffer.length >= 10 && (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a')) {
        return valid(buffer.readUInt16LE(6), buffer.readUInt16LE(8));
    }
    if (buffer.length >= 26 && buffer.toString('ascii', 0, 2) === 'BM') {
        return valid(buffer.readInt32LE(18), Math.abs(buffer.readInt32LE(22)));
    }
    if (buffer.length >= 10 && buffer.readUInt16LE(0) === 0 && buffer.readUInt16LE(2) === 1) {
        return valid(buffer[6] || 256, buffer[7] || 256);
    }
    if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) return jpegDimensions(buffer);
    if (buffer.length >= 16 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
        return webpDimensions(buffer);
    }
    if (extension.toLowerCase() === '.svg' || /^\s*<svg\b/i.test(buffer.toString('utf8', 0, 256))) {
        return svgDimensions(buffer);
    }
    return undefined;
}

export async function readImageDimensions(filePath: string): Promise<ImageDimensions | undefined> {
    let handle: fs.promises.FileHandle | undefined;
    try {
        handle = await fs.promises.open(filePath, 'r');
        const stat = await handle.stat();
        const buffer = Buffer.alloc(Math.min(MAX_HEADER_BYTES, stat.size));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return parseImageDimensions(buffer.subarray(0, bytesRead), path.extname(filePath));
    } catch {
        return undefined;
    } finally {
        await handle?.close().catch(() => undefined);
    }
}
