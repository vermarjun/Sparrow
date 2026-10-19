import { deflateRawSync } from 'node:zlib';

export interface ZipFixtureEntry {
  name: string | Buffer;
  data?: Buffer | string;
  mode?: number;
  reportedSize?: number;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function put16(buffer: Buffer, offset: number, value: number) { buffer.writeUInt16LE(value, offset); }
function put32(buffer: Buffer, offset: number, value: number) { buffer.writeUInt32LE(value >>> 0, offset); }

export function makeZip(entries: ZipFixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name);
    const original = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '');
    const compressed = deflateRawSync(original);
    const crc = crc32(original);
    const local = Buffer.alloc(30 + name.length + compressed.length);
    put32(local, 0, 0x04034b50);
    put16(local, 4, 20);
    put16(local, 6, 0x800);
    put16(local, 8, 8);
    put32(local, 14, crc);
    put32(local, 18, compressed.length);
    put32(local, 22, original.length);
    put16(local, 26, name.length);
    name.copy(local, 30);
    compressed.copy(local, 30 + name.length);
    locals.push(local);

    const central = Buffer.alloc(46 + name.length);
    put32(central, 0, 0x02014b50);
    put16(central, 4, 0x0314); // Unix host, ZIP 2.0.
    put16(central, 6, 20);
    put16(central, 8, 0x800);
    put16(central, 10, 8);
    put32(central, 16, crc);
    put32(central, 20, compressed.length);
    put32(central, 24, entry.reportedSize ?? original.length);
    put16(central, 28, name.length);
    put32(central, 38, ((entry.mode ?? 0o100644) << 16) >>> 0);
    put32(central, 42, offset);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const localBytes = Buffer.concat(locals);
  const end = Buffer.alloc(22);
  put32(end, 0, 0x06054b50);
  put16(end, 8, entries.length);
  put16(end, 10, entries.length);
  put32(end, 12, centralBytes.length);
  put32(end, 16, localBytes.length);
  return Buffer.concat([localBytes, centralBytes, end]);
}
