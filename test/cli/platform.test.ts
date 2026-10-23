import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cmdlineToCommand, listenerPids, openCommands, openUrl, parseLsofPids, parseProcNetTcp, parseSsPids, pidsOwningInodes, processCommand,
} from '../../src/cli/platform';

const has = (...names: string[]) => (n: string) => (names.includes(n) ? `/usr/bin/${n}` : null);

describe('openCommands', () => {
  test('darwin uses open', () => {
    expect(openCommands('http://x', 'darwin', {}, has())).toEqual([['open', 'http://x']]);
  });
  test('linux with a display uses xdg-open', () => {
    expect(openCommands('http://x', 'linux', { DISPLAY: ':0' }, has('xdg-open'))).toEqual([['xdg-open', 'http://x']]);
    expect(openCommands('http://x', 'linux', { WAYLAND_DISPLAY: 'wayland-0' }, has('gio'))).toEqual([['gio', 'open', 'http://x']]);
  });
  test('linux headless (no display, not WSL) tries nothing, so the CLI never blocks in a terminal browser', () => {
    expect(openCommands('http://x', 'linux', {}, has('xdg-open'))).toEqual([]);
  });
  test('WSL prefers wslview', () => {
    expect(openCommands('http://x', 'linux', { WSL_DISTRO_NAME: 'Ubuntu' }, has('wslview', 'xdg-open'))).toEqual([['wslview', 'http://x']]);
  });
  test('other platforms and a missing opener yield no commands', () => {
    expect(openCommands('http://x', 'win32', {}, has('open'))).toEqual([]);
    expect(openCommands('http://x', 'linux', { DISPLAY: ':0' }, has())).toEqual([]);
  });
});

describe('openUrl', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.SPARROW_NO_OPEN; });
  afterEach(() => { if (saved === undefined) delete process.env.SPARROW_NO_OPEN; else process.env.SPARROW_NO_OPEN = saved; });
  test('SPARROW_NO_OPEN=1 returns false without spawning anything', async () => {
    process.env.SPARROW_NO_OPEN = '1';
    expect(await openUrl('http://127.0.0.1:1/')).toBe(false);
  });
});

const LSOF = 'p4242\np4242\np77\n';
const SS = [
  'LISTEN 0      4096       127.0.0.1:4040       0.0.0.0:*    users:(("bun",pid=1234,fd=10))',
  'LISTEN 0      511                *:4041             *:*    users:(("node",pid=999,fd=21),("node",pid=1000,fd=21))',
  'LISTEN 0      128             [::]:22               [::]:*',
  'LISTEN 0      128          0.0.0.0:14040        0.0.0.0:*    users:(("other",pid=5,fd=3))',
  '',
].join('\n');
const PROC_TCP = [
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  '   0: 0100007F:0FC8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 55501 1 ffff 100 0 0 10 0',
  '   1: 0100007F:0FC8 0100007F:D000 01 00000000:00000000 00:00000000 00000000  1000        0 55502 1 ffff 100 0 0 10 0',
  '   2: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 55503 1 ffff 100 0 0 10 0',
].join('\n');
const PROC_TCP6 = [
  '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  '   0: 00000000000000000000000000000000:0FC8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 55504 1 ffff 100 0 0 10 0',
].join('\n');

describe('listener parsers', () => {
  test('parseLsofPids dedupes', () => { expect(parseLsofPids(LSOF)).toEqual([4242, 77]); expect(parseLsofPids('')).toEqual([]); });
  test('parseSsPids matches the exact local port and every pid in users:()', () => {
    expect(parseSsPids(SS, 4040)).toEqual([1234]);
    expect(parseSsPids(SS, 4041)).toEqual([999, 1000]);
    expect(parseSsPids(SS, 22)).toEqual([]);          // listening, but no process info (not ours)
    expect(parseSsPids(SS, 404)).toEqual([]);         // no substring matches
    expect(parseSsPids(SS, 14040)).toEqual([5]);
  });
  test('parseProcNetTcp returns LISTEN inodes for the port (hex) in tcp and tcp6', () => {
    expect(parseProcNetTcp(PROC_TCP, 4040)).toEqual(['55501']); // 0FC8 = 4040; the ESTABLISHED row (st 01) is skipped
    expect(parseProcNetTcp(PROC_TCP, 22)).toEqual(['55503']);
    expect(parseProcNetTcp(PROC_TCP6, 4040)).toEqual(['55504']);
    expect(parseProcNetTcp(PROC_TCP, 9999)).toEqual([]);
    expect(parseProcNetTcp('', 1)).toEqual([]);
  });
});

describe('pidsOwningInodes (fake /proc)', () => {
  test('maps socket inodes to the pids holding them, ignoring non-pid dirs and unreadable fds', () => {
    const root = mkdtempSync(join(tmpdir(), 'sp-proc-'));
    mkdirSync(join(root, '100/fd'), { recursive: true });
    mkdirSync(join(root, '200/fd'), { recursive: true });
    mkdirSync(join(root, 'self'), { recursive: true });
    mkdirSync(join(root, '300'), { recursive: true }); // no fd dir (permission denied in real life)
    symlinkSync('socket:[55501]', join(root, '100/fd/7'));
    symlinkSync('/dev/null', join(root, '100/fd/0'));
    symlinkSync('socket:[777]', join(root, '200/fd/3'));
    expect(pidsOwningInodes(['55501'], root)).toEqual([100]);
    expect(pidsOwningInodes(['55501', '777'], root).sort()).toEqual([100, 200]);
    expect(pidsOwningInodes([], root)).toEqual([]);
    expect(pidsOwningInodes(['1'], join(root, 'missing'))).toEqual([]);
  });
});

describe('processCommand / listenerPids (live)', () => {
  test('cmdlineToCommand turns NUL-separated argv into one line', () => {
    expect(cmdlineToCommand('bun\0/x/bin/sparrow\0up\0--port\0 4040\0')).toBe('bun /x/bin/sparrow up --port  4040');
    expect(cmdlineToCommand('')).toBe('');
  });
  test('processCommand of this process names bun; of a dead pid is empty', () => {
    expect(processCommand(process.pid)).toMatch(/bun/i);
    expect(processCommand(2 ** 22 + 12345)).toBe('');
  });
  test('listenerPids finds this process on a port it listens on, and nothing on a free port', async () => {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') });
    try {
      expect(listenerPids(server.port!)).toContain(process.pid);
    } finally { server.stop(true); }
    expect(listenerPids(server.port!)).not.toContain(process.pid);
  });
});
