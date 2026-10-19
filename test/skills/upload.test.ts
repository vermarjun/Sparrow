import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importStaged, MAX_IMPORT_FILE_BYTES, MAX_IMPORT_FILES } from '../../src/skills/importer';
import { stageUpload } from '../../src/skills/upload';
import { skillPaths } from '../../src/skills/paths';
import { makeZip } from './zip-fixture';

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'skills-upload-'));
  const home = join(base, 'home');
  const paths = skillPaths({ HOME: home, SPARROW_SKILLS_HOME: home, SPARROW_HOME: join(home, '.sparrow') });
  return { base, paths };
}

function formZip(bytes: Buffer): FormData {
  const form = new FormData();
  const data = new Uint8Array(bytes.byteLength);
  data.set(bytes);
  form.append('file', new File([data], 'upload.zip', { type: 'application/zip' }));
  return form;
}

function formFiles(files: { path: string; file: File }[]): FormData {
  return { entries: () => files.map(({ path, file }) => [path, file] as [string, FormDataEntryValue])[Symbol.iterator]() } as unknown as FormData;
}

function sizedFile(path: string, size: number): File {
  return { name: path, size, arrayBuffer: async () => { throw new Error('oversized files must be rejected before reading'); } } as unknown as File;
}

const validSkill = '---\nname: safe-skill\ndescription: Safe imported skill.\n---\n\n# Safe\n';

test('stages a valid ZIP and reports files and scripts for review', async () => {
  const { base, paths } = sandbox();
  try {
    const zip = makeZip([
      { name: 'safe-skill/SKILL.md', data: validSkill },
      { name: 'safe-skill/scripts/run.sh', data: '#!/bin/sh\necho safe\n' },
      { name: 'safe-skill/README.md', data: 'Read only.' },
    ]);
    const staged = await stageUpload(formZip(zip), paths);
    expect(staged.skills).toEqual([{
      name: 'safe-skill', description: 'Safe imported skill.', problems: [], warnings: [],
      files: [
        { path: 'README.md', size: 10 },
        { path: 'scripts/run.sh', size: 20 },
        { path: 'SKILL.md', size: Buffer.byteLength(validSkill) },
      ],
      scripts: ['scripts/run.sh'],
      scriptDetails: [{ path: 'scripts/run.sh', executable: false, shebang: '#!/bin/sh', scriptsDirectory: true }],
    }]);
    expect(staged.id).toMatch(/^[0-9a-f-]{36}$/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
test('rejects ZIP traversal, absolute paths, symlinks and NUL names before staging', async () => {
  const { base, paths } = sandbox();
  try {
    const cases: [string, Buffer, RegExp][] = [
      ['zip-slip', makeZip([{ name: '../../evil', data: 'bad' }]), /unsafe relative path/],
      ['absolute', makeZip([{ name: '/etc/x', data: 'bad' }]), /absolute/],
      ['passwd symlink', makeZip([{ name: 'skill/passwd', data: '/etc/passwd', mode: 0o120777 }]), /symlink entries are not allowed/],
      ['escaping symlink', makeZip([{ name: 'skill/escape', data: '../../outside', mode: 0o120777 }]), /symlink entries are not allowed/],
      ['FIFO', makeZip([{ name: 'skill/pipe', data: '', mode: 0o010644 }]), /device or special-file entries are not allowed/],
      ['NUL name', makeZip([{ name: Buffer.from([0x61, 0x00, 0x62]), data: 'bad' }]), /contains NUL/],
    ];
    for (const [label, archive, message] of cases) {
      await expect(stageUpload(formZip(archive), paths), label).rejects.toThrow(message);
      expect(existsSync(join(base, 'evil'))).toBe(false);
      expect(existsSync(join(base, 'outside'))).toBe(false);
    }
    expect(existsSync(join(paths.sparrowHome, 'skills-staging'))).toBe(false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('rejects ZIP file-count and per-file size caps before decompressing', async () => {
  const { base, paths } = sandbox();
  try {
    const many = makeZip(Array.from({ length: 10_000 }, (_, i) => ({ name: 'files/f' + i, data: '' })));
    await expect(stageUpload(formZip(many), paths)).rejects.toThrow('more than ' + MAX_IMPORT_FILES + ' files');
    const large = makeZip([{ name: 'skill/large.bin', data: Buffer.alloc(50 * 1024 * 1024, 0x41) }]);
    await expect(stageUpload(formZip(large), paths)).rejects.toThrow('exceeds ' + MAX_IMPORT_FILE_BYTES + ' bytes');
    expect(existsSync(join(paths.sparrowHome, 'skills-staging'))).toBe(false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('rejects an uploaded skill with an invalid name or invalid SKILL.md', async () => {
  const { base, paths } = sandbox();
  try {
    const invalidName = makeZip([{ name: 'bad-name/SKILL.md', data: '---\nname: "!!!"\ndescription: bad\n---\n' }]);
    await expect(stageUpload(formZip(invalidName), paths)).rejects.toThrow(/Invalid uploaded skill.*name/);
    const reserved = makeZip([{ name: 'sparrow-worker/SKILL.md', data: '---\nname: sparrow-worker\ndescription: bad\n---\n' }]);
    await expect(stageUpload(formZip(reserved), paths)).rejects.toThrow(/reserved/);
    const invalidYaml = makeZip([{ name: 'safe-skill/SKILL.md', data: '---\nname: [\ndescription: bad\n---\n' }]);
    await expect(stageUpload(formZip(invalidYaml), paths)).rejects.toThrow(/Invalid uploaded skill.*YAML/);
    const missing = makeZip([{ name: 'README.md', data: 'no skill' }]);
    await expect(stageUpload(formZip(missing), paths)).rejects.toThrow(/No SKILL.md folders/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('dropped-folder files require safe relative paths and enforce total caps', async () => {
  const { base, paths } = sandbox();
  try {
    const badPath = new FormData();
    badPath.append('files', new File(['bad'], '../../escape'));
    await expect(stageUpload(badPath, paths)).rejects.toThrow(/unsafe relative path/);
    for (const path of ['/etc/passwd', 'C:/Windows/win.ini', 'skill\\escape']) {
      await expect(stageUpload(formFiles([{ path, file: new File(['bad'], path) }]), paths)).rejects.toThrow(/absolute|forward slashes/);
    }
    expect(existsSync(join(base, 'escape'))).toBe(false);

    const oversized = formFiles([{ path: 'skill/large.bin', file: sizedFile('skill/large.bin', MAX_IMPORT_FILE_BYTES + 1) }]);
    await expect(stageUpload(oversized, paths)).rejects.toThrow('exceeds ' + MAX_IMPORT_FILE_BYTES + ' bytes');
    const tooMany = formFiles(Array.from({ length: MAX_IMPORT_FILES + 1 }, (_, i) => {
      const path = 'skill/file-' + i;
      return { path, file: sizedFile(path, 0) };
    }));
    await expect(stageUpload(tooMany, paths)).rejects.toThrow('more than ' + MAX_IMPORT_FILES + ' files');
    const tooLargeTotal = formFiles(Array.from({ length: 5 }, (_, i) => {
      const path = 'skill/file-' + i;
      return { path, file: sizedFile(path, MAX_IMPORT_FILE_BYTES) };
    }));
    await expect(stageUpload(tooLargeTotal, paths)).rejects.toThrow(/total bytes/);

    const folder = new FormData();
    folder.append('files', new File([validSkill], 'safe-skill/SKILL.md'));
    folder.append('files', new File(['#!/bin/sh\n'], 'safe-skill/scripts/x'));
    const staged = await stageUpload(folder, paths);
    expect(staged.skills[0]?.name).toBe('safe-skill');
    expect(staged.skills[0]?.scripts).toEqual(['scripts/x']);
    expect(staged.skills[0]?.files.find((file) => file.path === 'scripts/x')?.size).toBe(10);
    expect(staged.skills[0]?.scriptDetails[0]?.executable).toBe(false);
    expect(staged.notices).toContain('Browser folder uploads do not expose POSIX executable bits; files are staged as non-executable. ZIP uploads preserve supplied mode metadata.');
    await importStaged(staged.id, ['safe-skill'], [], paths);
    expect(statSync(join(paths.library, 'safe-skill/scripts/x')).mode & 0o111).toBe(0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('folder uploads accept nested ZIP assets and preview executable ZIP metadata', async () => {
  const { base, paths } = sandbox();
  try {
    const folder = new FormData();
    folder.append('files', new File([validSkill], 'safe-skill/SKILL.md'));
    folder.append('files', new File(['zip bytes'], 'safe-skill/assets/reference.zip'));
    folder.append('files', new File(['#!/bin/sh\n'], 'safe-skill/tools/deploy'));
    const staged = await stageUpload(folder, paths);
    expect(staged.skills[0]?.files.map((file) => file.path)).toContain('assets/reference.zip');

    const archive = makeZip([
      { name: 'exec-skill/SKILL.md', data: validSkill.replaceAll('safe-skill', 'exec-skill') },
      { name: 'exec-skill/tools/deploy', data: '#!/bin/sh\n', mode: 0o100755 },
    ]);
    const executable = await stageUpload(formZip(archive), paths);
    expect(executable.skills[0]?.scriptDetails).toContainEqual({
      path: 'tools/deploy', executable: true, shebang: '#!/bin/sh', scriptsDirectory: false,
    });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('ZIP import preserves external executable bits, keeps non-executable files non-executable, and never runs scripts', async () => {
  const { base, paths } = sandbox();
  try {
    const marker = join(base, 'zip-script-ran');
    const archive = makeZip([
      { name: 'zip-skill/SKILL.md', data: validSkill.replaceAll('safe-skill', 'zip-skill') },
      { name: 'zip-skill/scripts/run.sh', data: `#!/bin/sh\nprintf ran > '${marker}'\n`, mode: 0o100755 },
      { name: 'zip-skill/tools/inspect.sh', data: '#!/bin/sh\necho inspect\n', mode: 0o100644 },
    ]);
    const staged = await stageUpload(formZip(archive), paths);
    expect(staged.skills[0]?.scriptDetails).toEqual([
      { path: 'scripts/run.sh', executable: true, shebang: '#!/bin/sh', scriptsDirectory: true },
      { path: 'tools/inspect.sh', executable: false, shebang: '#!/bin/sh', scriptsDirectory: false },
    ]);
    expect(staged.notices).toBeUndefined();
    expect(existsSync(marker)).toBe(false);

    await importStaged(staged.id, ['zip-skill'], [], paths);
    expect(statSync(join(paths.library, 'zip-skill/scripts/run.sh')).mode & 0o777).toBe(0o755);
    expect(statSync(join(paths.library, 'zip-skill/tools/inspect.sh')).mode & 0o777).toBe(0o644);
    expect(existsSync(marker)).toBe(false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('folder uploads reject control characters, overlong names, and file-directory collisions', async () => {
  const { base, paths } = sandbox();
  try {
    for (const path of ['safe-skill/bad\nname.txt', `safe-skill/${'x'.repeat(256)}.txt`]) {
      await expect(stageUpload(formFiles([{ path, file: new File(['x'], path) }]), paths)).rejects.toThrow(/control characters|too long/);
    }
    await expect(stageUpload(formFiles([
      { path: 'safe-skill/item', file: new File(['x'], 'safe-skill/item') },
      { path: 'safe-skill/item/child', file: new File(['x'], 'safe-skill/item/child') },
    ]), paths)).rejects.toThrow(/both a file and a directory/);
    expect(existsSync(join(paths.sparrowHome, 'skills-staging'))).toBe(false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('rejects duplicate ZIP paths, corrupt checksums and truncated ZIP records without staging', async () => {
  const { base, paths } = sandbox();
  try {
    const duplicate = makeZip([
      { name: 'safe-skill/SKILL.md', data: validSkill },
      { name: 'safe-skill/SKILL.md', data: validSkill },
    ]);
    await expect(stageUpload(formZip(duplicate), paths)).rejects.toThrow(/duplicate path/);

    const badChecksum = makeZip([{ name: 'safe-skill/SKILL.md', data: validSkill }]);
    const eocd = badChecksum.length - 22;
    const centralOffset = badChecksum.readUInt32LE(eocd + 16);
    badChecksum.writeUInt32LE((badChecksum.readUInt32LE(centralOffset + 16) ^ 1) >>> 0, centralOffset + 16);
    await expect(stageUpload(formZip(badChecksum), paths)).rejects.toThrow(/checksum failed/);

    await expect(stageUpload(formZip(Buffer.from('not a zip')), paths)).rejects.toThrow(/end-of-central-directory/);
    expect(existsSync(join(paths.sparrowHome, 'skills-staging'))).toBe(false);
    expect(existsSync(join(base, 'evil'))).toBe(false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
