import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { HttpError, validateFileName } from './fs.js';

interface Entry {
  name: Buffer;
  crc: number;
  size: number;
  compressed: Buffer;
  method: number;
  offset: number;
  attributes: number;
}

/** DOS date/time for the zip headers. */
function dosTime(d: Date) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Minimal zip writer (deflate or store, UTF-8 names, no zip64: < 4 GB). */
export class ZipWriter {
  private parts: Buffer[] = [];
  private entries: Entry[] = [];
  private offset = 0;
  private stamp = dosTime(new Date());

  add(name: string, data: Buffer | string, executable = false): void {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const deflated = deflateRawSync(buf);
    const useDeflate = deflated.length < buf.length;
    const e: Entry = {
      name: Buffer.from(name.replace(/\\/g, '/'), 'utf8'),
      crc: crc32(buf) >>> 0,
      size: buf.length,
      compressed: useDeflate ? deflated : buf,
      method: useDeflate ? 8 : 0,
      offset: this.offset,
      attributes: name.endsWith('/') ? (0o40755 << 16) | 0x10 : ((executable ? 0o100755 : 0o100644) << 16) >>> 0,
    };
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4); // version needed
    h.writeUInt16LE(0x0800, 6); // UTF-8 names
    h.writeUInt16LE(e.method, 8);
    h.writeUInt16LE(this.stamp.time, 10);
    h.writeUInt16LE(this.stamp.date, 12);
    h.writeUInt32LE(e.crc, 14);
    h.writeUInt32LE(e.compressed.length, 18);
    h.writeUInt32LE(e.size, 22);
    h.writeUInt16LE(e.name.length, 26);
    h.writeUInt16LE(0, 28);
    this.parts.push(h, e.name, e.compressed);
    this.offset += h.length + e.name.length + e.compressed.length;
    this.entries.push(e);
  }

  finish(): Buffer {
    const central: Buffer[] = [];
    let size = 0;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(0x0314, 4); // Unix attributes, ZIP 2.0
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(e.method, 10);
      c.writeUInt16LE(this.stamp.time, 12);
      c.writeUInt16LE(this.stamp.date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.compressed.length, 20);
      c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(e.name.length, 28);
      c.writeUInt32LE(e.offset, 42);
      c.writeUInt32LE(e.attributes >>> 0, 38);
      central.push(c, e.name);
      size += c.length + e.name.length;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(size, 12);
    end.writeUInt32LE(this.offset, 16);
    return Buffer.concat([...this.parts, ...central, end]);
  }
}

/** Read the central directory (including ZIPs with data descriptors). No extraction side effects. */
export function readZip(data: Buffer, maxBytes = 512 * 1024 * 1024): Map<string, Buffer> {
  const fail = (message: string): never => { throw new HttpError(400, 'invalid_zip', message); };
  const check = (offset: number, length: number) => {
    if (offset < 0 || length < 0 || offset + length > data.length) fail('Truncated ZIP archive.');
  };
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length) { end = i; break; }
  }
  if (end < 0) fail('Not a ZIP archive.');
  const count = data.readUInt16LE(end + 10), size = data.readUInt32LE(end + 12), start = data.readUInt32LE(end + 16);
  if (data.readUInt32LE(end + 4) || data.readUInt16LE(end + 8) !== count || count === 65535 || start === 0xffffffff) fail('Multi-volume and ZIP64 archives are not supported.');
  if (count > 20000) fail('Too many files in ZIP (maximum 20000).');
  check(start, size);
  if (start + size > end) fail('Invalid ZIP central directory.');
  const out = new Map<string, Buffer>(), names = new Set<string>();
  let at = start, total = 0;
  for (let n = 0; n < count; n++) {
    check(at, 46);
    if (data.readUInt32LE(at) !== 0x02014b50) fail('Invalid ZIP entry.');
    const flags = data.readUInt16LE(at + 8), method = data.readUInt16LE(at + 10);
    const crc = data.readUInt32LE(at + 16), compressed = data.readUInt32LE(at + 20), length = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28), extraLength = data.readUInt16LE(at + 30), commentLength = data.readUInt16LE(at + 32);
    const attributes = data.readUInt32LE(at + 38), local = data.readUInt32LE(at + 42);
    check(at + 46, nameLength + extraLength + commentLength);
    const rawName = data.subarray(at + 46, at + 46 + nameLength);
    let name = rawName.toString('utf8');
    // Info-ZIP Unicode Path extra field takes precedence for legacy-name ZIPs.
    for (let p = at + 46 + nameLength, stop = p + extraLength; p + 4 <= stop;) {
      const id = data.readUInt16LE(p), len = data.readUInt16LE(p + 2);
      if (p + 4 + len > stop) fail('Invalid ZIP extra field.');
      if (id === 0x7075 && len >= 5 && data[p + 4] === 1 && data.readUInt32LE(p + 5) === crc32(rawName)) name = data.subarray(p + 9, p + 4 + len).toString('utf8');
      p += 4 + len;
    }
    if (name.includes('\ufffd')) fail('ZIP file names must be UTF-8; re-create the archive with UTF-8 names.');
    name = name.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
    const directory = name.endsWith('/');
    const clean = directory ? name.slice(0, -1) : name;
    if (clean) validateFileName(clean);
    else if (!directory) fail('Empty ZIP file name.');
    const identity = clean.toLowerCase();
    if (identity && names.has(identity)) fail(`Duplicate ZIP path: ${clean}`);
    names.add(identity);
    if (((attributes >>> 16) & 0xf000) === 0xa000) fail(`Symbolic links are not supported: ${clean}`);
    if (flags & 1 || ![0, 8].includes(method)) fail(`Unsupported ZIP compression or encryption: ${clean}`);
    total += length;
    if (total > maxBytes) fail(`ZIP expands beyond ${maxBytes / 1024 / 1024} MiB.`);
    check(local, 30);
    if (data.readUInt32LE(local) !== 0x04034b50) fail('Missing ZIP local header.');
    const offset = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    check(offset, compressed);
    if (offset + compressed > start) fail('ZIP data overlaps the central directory.');
    if (!directory) {
      const packed = data.subarray(offset, offset + compressed);
      let bytes: Buffer;
      try { bytes = method === 0 ? Buffer.from(packed) : inflateRawSync(packed, { maxOutputLength: Math.max(1, length) }); }
      catch { fail(`Cannot decompress ${name}.`); }
      if (bytes!.length !== length || crc32(bytes!) !== crc) fail(`ZIP checksum mismatch: ${name}`);
      out.set(name, bytes!);
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  if (at !== start + size) fail('Invalid ZIP directory size.');
  const fileNames = new Set([...out.keys()].map(n => n.toLowerCase()));
  for (const name of out.keys()) {
    const parts = name.toLowerCase().split('/');
    for (let i = 1; i < parts.length; i++) if (fileNames.has(parts.slice(0, i).join('/'))) fail(`ZIP file/directory collision: ${name}`);
  }
  return out;
}
