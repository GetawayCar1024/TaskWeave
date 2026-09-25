import { crc32, deflateRawSync } from 'node:zlib';

interface Entry {
  name: Buffer;
  crc: number;
  size: number;
  compressed: Buffer;
  method: number;
  offset: number;
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

  add(name: string, data: Buffer | string): void {
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
      c.writeUInt16LE(20, 4); // version made by
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
