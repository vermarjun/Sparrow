import { inflateRawSync } from 'node:zlib';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertWritable, skillPaths } from './paths';
import {
  createUploadStage, MAX_IMPORT_FILE_BYTES, MAX_IMPORT_FILES, MAX_IMPORT_TOTAL_BYTES, SkillImportError, type StagedImport,
} from './importer';
import type { SkillPaths } from './types';

interface ZipEntry {
  path: string;
  directory: boolean;
  compression: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  mode: number;
}

const u16 = (b: Buffer, o: number) => b.readUInt16LE(o);
const u32 = (b: Buffer, o: number) => b.readUInt32LE(o);

function checkedZipPath(name: string, directory: boolean): string {
  if (name.includes('\0')) throw new SkillImportError('ZIP entry name contains NUL.');
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new SkillImportError('ZIP entry name contains control characters.');
  if (Buffer.byteLength(name, 'utf8') > 4096) throw new SkillImportError('ZIP entry path is too long (max 4096 UTF-8 bytes).');
  if (name.includes('\\')) throw new SkillImportError('ZIP entry path contains a backslash: ' + name);
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new SkillImportError('ZIP entry path is absolute: ' + name);
  const clean = directory && name.endsWith('/') ? name.slice(0, -1) : name;
  const pieces = clean.split('/');
  if (!clean || pieces.some((part) => !part || part === '.' || part === '..')) {
    throw new SkillImportError('ZIP entry has an unsafe relative path: ' + name);
  }
  if (pieces.some((part) => Buffer.byteLength(part, 'utf8') > 255)) throw new SkillImportError('ZIP file name is too long (max 255 UTF-8 bytes per path component).');
  return pieces.join('/');
}

function crcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
}
const CRC_TABLE = crcTable();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Validate every central-directory and local-header path/type before returning any file bytes. */
export function readSafeZip(archive: Buffer): { path: string; bytes: Buffer; mode: number }[] {
  const min = Math.max(0, archive.length - 65_557);
  let eocd = -1;
  for (let offset = archive.length - 22; offset >= min; offset--) {
    if (archive.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new SkillImportError('ZIP end-of-central-directory record is missing.');
  const disk = u16(archive, eocd + 4);
  const centralDisk = u16(archive, eocd + 6);
  const diskCount = u16(archive, eocd + 8);
  const count = u16(archive, eocd + 10);
  const centralSize = u32(archive, eocd + 12);
  const centralOffset = u32(archive, eocd + 16);
  if (disk || centralDisk || diskCount !== count) throw new SkillImportError('Multi-disk ZIP archives are not supported.');
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new SkillImportError('ZIP64 archives are not supported.');
  }
  if (centralOffset + centralSize > eocd || centralOffset + centralSize > archive.length) {
    throw new SkillImportError('ZIP central directory is outside the archive bounds.');
  }

  const entries: ZipEntry[] = [];
  const names = new Map<string, boolean>();
  let cursor = centralOffset;
  let fileCount = 0, totalBytes = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > archive.length || u32(archive, cursor) !== 0x02014b50) {
      throw new SkillImportError('ZIP central directory entry is malformed.');
    }
    const madeBy = u16(archive, cursor + 4) >>> 8;
    const flags = u16(archive, cursor + 8);
    const compression = u16(archive, cursor + 10);
    const crc = u32(archive, cursor + 16);
    const compressedSize = u32(archive, cursor + 20);
    const size = u32(archive, cursor + 24);
    const nameLength = u16(archive, cursor + 28);
    const extraLength = u16(archive, cursor + 30);
    const commentLength = u16(archive, cursor + 32);
    const diskStart = u16(archive, cursor + 34);
    const external = u32(archive, cursor + 38);
    const localOffset = u32(archive, cursor + 42);
    const endName = cursor + 46 + nameLength;
    const endRecord = endName + extraLength + commentLength;
    if (endRecord > archive.length || diskStart !== 0) throw new SkillImportError('ZIP entry is malformed or spans disks.');
    const rawName = archive.subarray(cursor + 46, endName);
    let name: string;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(rawName); }
    catch { throw new SkillImportError('ZIP entry path is not valid UTF-8.'); }
    const directory = name.endsWith('/');
    const path = checkedZipPath(name, directory);
    if (names.has(path)) throw new SkillImportError('ZIP contains duplicate path: ' + path);
    names.set(path, directory);

    const unixType = madeBy === 3 ? ((external >>> 16) & 0xf000) : 0;
    if (unixType === 0xa000) throw new SkillImportError('ZIP symlink entries are not allowed: ' + path);
    if (unixType !== 0 && unixType !== 0x8000 && unixType !== 0x4000) {
      throw new SkillImportError('ZIP device or special-file entries are not allowed: ' + path);
    }
    if (!directory) {
      fileCount++;
      totalBytes += size;
      if (fileCount > MAX_IMPORT_FILES) throw new SkillImportError('ZIP contains more than ' + MAX_IMPORT_FILES + ' files.');
      if (size > MAX_IMPORT_FILE_BYTES) throw new SkillImportError('ZIP entry exceeds ' + MAX_IMPORT_FILE_BYTES + ' bytes: ' + path);
      if (totalBytes > MAX_IMPORT_TOTAL_BYTES) throw new SkillImportError('ZIP exceeds ' + MAX_IMPORT_TOTAL_BYTES + ' total uncompressed bytes.');
    }
    if (flags & 0x1) throw new SkillImportError('Encrypted ZIP entries are not supported: ' + path);
    if (compression !== 0 && compression !== 8) throw new SkillImportError('Unsupported ZIP compression method for ' + path + '.');
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new SkillImportError('ZIP64 entries are not supported: ' + path);
    }
    if (localOffset + 30 > archive.length || u32(archive, localOffset) !== 0x04034b50) {
      throw new SkillImportError('ZIP local file header is malformed: ' + path);
    }
    const localNameLength = u16(archive, localOffset + 26);
    const localExtraLength = u16(archive, localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > centralOffset || dataOffset + compressedSize > archive.length) {
      throw new SkillImportError('ZIP data range is outside archive bounds: ' + path);
    }
    const localName = archive.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    if (!localName.equals(rawName)) throw new SkillImportError('ZIP local and central names differ: ' + path);
    const mode = madeBy === 3 ? (external >>> 16) & 0o777 : 0o644;
    entries.push({ path, directory, compression, flags, crc, compressedSize, size, localOffset, mode });
    cursor = endRecord;
  }
  if (cursor !== centralOffset + centralSize) throw new SkillImportError('ZIP central directory length is inconsistent.');

  // Do not allow a regular file to act as a parent of another extracted path.
  for (const [path, directory] of names) {
    const pieces = path.split('/');
    for (let i = 1; i < pieces.length; i++) {
      const parent = pieces.slice(0, i).join('/');
      if (names.get(parent) === false) throw new SkillImportError('ZIP file path conflicts with a parent directory: ' + parent);
    }
    if (directory && names.get(path) !== true) throw new SkillImportError('ZIP path type is inconsistent: ' + path);
  }

  const result: { path: string; bytes: Buffer; mode: number }[] = [];
  for (const entry of entries) {
    if (entry.directory) continue;
    const nameLength = u16(archive, entry.localOffset + 26);
    const extraLength = u16(archive, entry.localOffset + 28);
    const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
    const compressed = archive.subarray(dataOffset, dataOffset + entry.compressedSize);
    let bytes: Buffer;
    try {
      bytes = entry.compression === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MAX_IMPORT_FILE_BYTES });
    } catch (error) { throw new SkillImportError('Could not decompress ZIP entry ' + entry.path + ': ' + (error as Error).message); }
    if (bytes.length !== entry.size) throw new SkillImportError('ZIP entry size does not match its header: ' + entry.path);
    if (crc32(bytes) !== entry.crc) throw new SkillImportError('ZIP entry checksum failed: ' + entry.path);
    result.push({ path: entry.path, bytes, mode: entry.mode });
  }
  return result;
}

function safeUploadPath(path: string): string {
  if (path.includes('\0')) throw new SkillImportError('Uploaded file path contains NUL.');
  if (/[\u0000-\u001f\u007f-\u009f]/.test(path)) throw new SkillImportError('Uploaded file path contains control characters.');
  if (Buffer.byteLength(path, 'utf8') > 4096) throw new SkillImportError('Uploaded file path is too long (max 4096 UTF-8 bytes).');
  if (path.includes('\\')) throw new SkillImportError('Uploaded file paths must use forward slashes: ' + path);
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) throw new SkillImportError('Uploaded file path is absolute: ' + path);
  const pieces = path.split('/');
  if (!path || pieces.some((part) => !part || part === '.' || part === '..')) {
    throw new SkillImportError('Uploaded file has an unsafe relative path: ' + path);
  }
  if (pieces.some((part) => Buffer.byteLength(part, 'utf8') > 255)) throw new SkillImportError('Uploaded file name is too long (max 255 UTF-8 bytes per path component).');
  return pieces.join('/');
}

function rejectFileDirectoryCollisions(paths: string[]) {
  const files = new Set(paths);
  for (const path of paths) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join('/');
      if (files.has(parent)) throw new SkillImportError('Upload path conflict: "' + parent + '" is both a file and a directory.');
    }
  }
}

async function fileBytes(file: File): Promise<Buffer> {
  return Buffer.from(await file.arrayBuffer());
}

/** Accepts standard multipart File entries; filenames carry the dropped folder's relative paths. */
export async function stageUpload(form: FormData, paths: SkillPaths = skillPaths()): Promise<StagedImport> {
  const files: { path: string; file: File }[] = [];
  for (const [field, value] of form.entries()) {
    if (typeof value !== 'object' || value === null || !('name' in value) || !('arrayBuffer' in value)) continue;
    const file = value as File;
    const namedPath = file.name && file.name !== 'blob' ? file.name : field;
    files.push({ path: safeUploadPath(namedPath), file });
  }
  if (!files.length) throw new SkillImportError('Upload must contain files.');
  const zips = files.filter((item) => /\.zip$/i.test(item.path) && !item.path.includes('/'));
  if (zips.length) {
    if (zips.length !== 1 || files.length !== 1) throw new SkillImportError('Upload either one .zip file or dropped-folder files, not both.');
    const zipBuffer = await fileBytes(zips[0]!.file);
    const unpacked = readSafeZip(zipBuffer); // All names/types/limits are checked before any filesystem writes.
    return createUploadStage(paths, (repoDir) => {
      mkdirSync(assertWritable(repoDir, paths), { recursive: true });
      for (const item of unpacked) {
        const target = assertWritable(join(repoDir, ...item.path.split('/')), paths);
        if (existsSync(target)) throw new SkillImportError('ZIP contains duplicate target path: ' + item.path);
        mkdirSync(assertWritable(dirname(target), paths), { recursive: true });
        const mode = 0o644 | (item.mode & 0o111);
        writeFileSync(target, item.bytes, { flag: 'wx', mode });
        chmodSync(target, mode);
      }
    });
  }
  if (files.length > MAX_IMPORT_FILES) throw new SkillImportError('Upload contains more than ' + MAX_IMPORT_FILES + ' files.');
  const pathsSeen = new Set<string>();
  let total = 0;
  for (const item of files) {
    if (pathsSeen.has(item.path)) throw new SkillImportError('Upload contains duplicate path: ' + item.path);
    pathsSeen.add(item.path);
    if (item.file.size > MAX_IMPORT_FILE_BYTES) throw new SkillImportError('Uploaded file exceeds ' + MAX_IMPORT_FILE_BYTES + ' bytes: ' + item.path);
    total += item.file.size;
    if (total > MAX_IMPORT_TOTAL_BYTES) throw new SkillImportError('Upload exceeds ' + MAX_IMPORT_TOTAL_BYTES + ' total bytes.');
  }
  rejectFileDirectoryCollisions([...pathsSeen]);
  const bytes = await Promise.all(files.map((item) => fileBytes(item.file)));
  return createUploadStage(paths, (repoDir) => {
    mkdirSync(assertWritable(repoDir, paths), { recursive: true });
    for (let index = 0; index < files.length; index++) {
      const item = files[index]!;
      const target = assertWritable(join(repoDir, ...item.path.split('/')), paths);
      if (existsSync(target)) throw new SkillImportError('Upload contains duplicate target path: ' + item.path);
      mkdirSync(assertWritable(dirname(target), paths), { recursive: true });
      writeFileSync(target, bytes[index]!, { flag: 'wx', mode: 0o644 });
    }
  }, ['Browser folder uploads do not expose POSIX executable bits; files are staged as non-executable. ZIP uploads preserve supplied mode metadata.']);
}
