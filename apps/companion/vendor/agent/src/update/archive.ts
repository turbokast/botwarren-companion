/**
 * VENDORED FILE: src/update/archive.ts of the Botwarren ship agent (https://github.com/turbokast/botwarren-ship), copied verbatim when this repository was exported;
 * the only edit is this header. The Companion shares the agent's release trust chain (the pinned public release keys, the manifest schema and
 * verifier, the Cloud KMS signer) on purpose: one key, one verifier. Do not edit here: changes are made in the ship agent repository and re-vendored.
 * Copyright 2026 TurboKast Ltd. Licensed under the Apache License, Version 2.0 (see the LICENSE file at the repository root).
 */
/**
 * Dependency-free archive helpers (zip + tar.gz), used by the updater (read zip) and the packaging scripts.
 *
 * Safety: every entry name is validated BEFORE anything is written: no absolute paths, no drive letters, no `..`,
 * no NUL/backslash tricks, only regular files and directories (symlinks and devices are rejected), and total size and
 * entry count are capped (zip-bomb guard). Writers are deterministic (fixed timestamps, sorted entries).
 */
import { crc32, deflateRawSync, gunzipSync, gzipSync, inflateRawSync } from 'node:zlib';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

export interface ArchiveEntry { name: string; data: Buffer; mode: number }

export const LIMITS = { maxEntries: 5000, maxTotalBytes: 600 * 1024 * 1024, maxEntryBytes: 300 * 1024 * 1024 };

export interface ReadOptions {
  /** keep only entries whose (validated) name passes; others are skipped without being decompressed or counted */
  only?: (name: string) => boolean;
  /** entry-count cap for the archive itself (default 5000; large third-party archives such as Node's need more) */
  maxEntries?: number;
}

export class ArchiveError extends Error {
  constructor(msg: string) { super(msg); this.name = 'ArchiveError'; }
}

/** Throws unless `name` is a plain relative path with no traversal. Returns the normalised name (forward slashes). */
export function safeEntryName(name: string): string {
  if (!name || name.length > 512 || name.includes('\0') || name.includes('\\')) throw new ArchiveError('bad entry name');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new ArchiveError('absolute entry path');
  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0 || parts.some((p) => p === '..')) throw new ArchiveError('path traversal');
  return parts.join('/');
}

// ---------------------------------------------------------------- zip
const u16 = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

export function writeZip(entries: ArchiveEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const e of sorted) {
    const name = Buffer.from(safeEntryName(e.name));
    const comp = deflateRawSync(e.data, { level: 9 });
    const crc = crc32(e.data);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(8), u16(0), u16(DOS_DATE), u32(crc), u32(comp.length), u32(e.data.length), u16(name.length), u16(0), name, comp]);
    centrals.push(Buffer.concat([u32(0x02014b50), u16((3 << 8) | 20), u16(20), u16(0x0800), u16(8), u16(0), u16(DOS_DATE), u32(crc), u32(comp.length), u32(e.data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(((0o100000 | (e.mode & 0o777)) << 16) >>> 0), u32(offset), name]));
    locals.push(local); offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  return Buffer.concat([...locals, cd, Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(sorted.length), u16(sorted.length), u32(cd.length), u32(offset), u16(0)])]);
}

export function readZip(buf: Buffer, opts: ReadOptions = {}): ArchiveEntry[] {
  // end of central directory (no archive comment support: we never write one and refuse any)
  const eocd = buf.length - 22;
  if (eocd < 0 || buf.readUInt32LE(eocd) !== 0x06054b50) throw new ArchiveError('not a zip (or has a comment)');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (count > (opts.maxEntries ?? LIMITS.maxEntries) || cdOff + cdSize > eocd) throw new ArchiveError('bad zip directory');
  const out: ArchiveEntry[] = []; let total = 0; let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new ArchiveError('bad central header');
    const flags = buf.readUInt16LE(p + 8); const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16); const csize = buf.readUInt32LE(p + 20); const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28); const xlen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32);
    const attr = buf.readUInt32LE(p + 38) >>> 16; const lho = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (flags & 1) throw new ArchiveError('encrypted entry');
    if (rawName.endsWith('/')) continue; // directory
    const fileType = attr & 0o170000;
    if (fileType !== 0 && fileType !== 0o100000) throw new ArchiveError('special file in archive'); // symlink, device...
    const name = safeEntryName(rawName);
    if (opts.only && !opts.only(name)) continue;
    if (usize > LIMITS.maxEntryBytes || (total += usize) > LIMITS.maxTotalBytes) throw new ArchiveError('archive too large');
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new ArchiveError('bad local header');
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + csize);
    if (raw.length !== csize) throw new ArchiveError('truncated entry');
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw, { maxOutputLength: LIMITS.maxEntryBytes }) : null;
    if (!data) throw new ArchiveError('unsupported compression');
    if (data.length !== usize || crc32(data) !== crc) throw new ArchiveError('entry checksum mismatch');
    out.push({ name, data, mode: (attr & 0o777) || 0o644 });
  }
  return out;
}

// ---------------------------------------------------------------- tar.gz (ustar)
function octal(n: number, len: number): Buffer { return Buffer.from(n.toString(8).padStart(len - 1, '0') + '\0'); }

export function writeTarGz(entries: ArchiveEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const blocks: Buffer[] = [];
  for (const e of sorted) {
    const name = safeEntryName(e.name);
    if (Buffer.byteLength(name) > 100) throw new ArchiveError('entry name too long for ustar');
    const h = Buffer.alloc(512);
    h.write(name, 0, 'utf8'); octal(e.mode & 0o777, 8).copy(h, 100); octal(0, 8).copy(h, 108); octal(0, 8).copy(h, 116);
    octal(e.data.length, 12).copy(h, 124); octal(1_767_225_600, 12).copy(h, 136); // 2026-01-01
    h.write('        ', 148, 'ascii'); h.write('0', 156, 'ascii'); h.write('ustar\0', 257, 'ascii'); h.write('00', 263, 'ascii');
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    blocks.push(h, e.data, Buffer.alloc((512 - (e.data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9, mtime: 0 } as never);
}

export function readTarGz(gz: Buffer, opts: ReadOptions = {}): ArchiveEntry[] {
  const buf = gunzipSync(gz, { maxOutputLength: LIMITS.maxTotalBytes });
  const out: ArchiveEntry[] = []; let total = 0; let p = 0;
  let longName: string | null = null;
  while (p + 512 <= buf.length) {
    const h = buf.subarray(p, p + 512);
    if (h.every((b) => b === 0)) break;
    const str = (o: number, l: number) => h.subarray(o, o + l).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 0x30);
    const mode = parseInt(str(100, 8).trim() || '644', 8) & 0o777;
    const prefix = str(345, 155);
    let name = longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    longName = null;
    p += 512;
    const data = buf.subarray(p, p + size);
    p += Math.ceil(size / 512) * 512;
    if (!Number.isFinite(size) || size < 0 || p > buf.length + 512) throw new ArchiveError('bad tar header');
    if (type === 'L') { longName = data.toString('utf8').replace(/\0.*$/s, ''); continue; } // GNU long name
    if (type === 'x' || type === 'g') { // pax header: honour `path=` only
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      if (m) longName = m[1]!;
      continue;
    }
    if (type === '5') continue; // directory
    if (type !== '0' && type !== '\0') { if (type === '2' || type === '1' || type === '3' || type === '4' || type === '6') continue; throw new ArchiveError('special file in archive'); }
    name = safeEntryName(name.replace(/^\.\//, ''));
    if (opts.only && !opts.only(name)) continue;
    if (size > LIMITS.maxEntryBytes || (total += size) > LIMITS.maxTotalBytes || out.length >= (opts.maxEntries ?? LIMITS.maxEntries)) throw new ArchiveError('archive too large');
    out.push({ name, data: Buffer.from(data), mode: mode || 0o644 });
  }
  return out;
}

/** Writes entries under `dir` (created if needed). Names are re-validated and the resolved path must stay inside `dir`. */
export function extractTo(entries: ArchiveEntry[], dir: string): void {
  const root = resolve(dir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const e of entries) {
    const target = resolve(join(root, safeEntryName(e.name)));
    if (target !== root && !target.startsWith(root + sep)) throw new ArchiveError('path traversal');
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, e.data, { mode: e.mode & 0o777 || 0o644, flag: 'wx' });
    try { chmodSync(target, e.mode & 0o777 || 0o644); } catch { /* best effort on Windows */ }
  }
}
