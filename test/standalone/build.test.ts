// The build script's pure parts: target naming (a contract with the npm / install.sh / brew tooling), the manifest, the generated entry.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collect, entrySource, hostTarget, outName, TARGETS } from '../../scripts/build-binary';
import { tempDir } from '../cli/helpers';

describe('build-binary', () => {
  test('binary names are sparrow-<os>-<arch> for the four targets', () => {
    expect(TARGETS.map(outName)).toEqual(['sparrow-darwin-arm64', 'sparrow-darwin-x64', 'sparrow-linux-x64', 'sparrow-linux-arm64']);
    expect(TARGETS).toContain(hostTarget());
  });

  test('collect maps assets/** and web/dist/** and the build id follows the content', () => {
    const root = tempDir('build-');
    mkdirSync(join(root, 'assets', 'resumes'), { recursive: true });
    mkdirSync(join(root, 'web', 'dist', 'assets'), { recursive: true });
    writeFileSync(join(root, 'assets', 'protocol.md'), 'p');
    writeFileSync(join(root, 'assets', 'resumes', 'a.md'), 'a');
    writeFileSync(join(root, 'web', 'dist', 'index.html'), '<html>');
    writeFileSync(join(root, 'web', 'dist', 'assets', 'x.js'), 'x');
    const m = collect(root);
    expect(m.files.map(([r]) => r)).toEqual(['assets/protocol.md', 'assets/resumes/a.md', 'web/assets/x.js', 'web/index.html']);
    writeFileSync(join(root, 'assets', 'protocol.md'), 'changed');
    expect(collect(root).build).not.toBe(m.build);
    expect(collect(root).build).toBe(collect(root).build);
  });

  test('the generated entry embeds each file, registers the manifest before loading the CLI', () => {
    const src = entrySource({ files: [['assets/a.md', '/r/assets/a.md'], ['web/index.html', '/r/web/dist/index.html']], build: 'abc' }, '9.9.9', '/r/dist/build');
    expect(src).toContain(`import f0 from "../../assets/a.md" with { type: 'file' };`);
    expect(src).toContain(`import f1 from "../../web/dist/index.html" with { type: 'file' };`);
    expect(src).toContain(`version: "9.9.9", build: "abc"`);
    expect(src).toContain(`"web/index.html": f1,`);
    expect(src.indexOf('__SPARROW_EMBED__')).toBeLessThan(src.indexOf('await import('));
  });
});
