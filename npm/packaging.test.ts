import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "sparrow-packaging-"));
afterAll(() => {
  const result = spawnSync("trash", [scratch]);
  // Linux CI may not have trash installed: leave only this isolated temp directory.
  if (result.status !== 0) console.log(`Packaging fixtures retained at ${scratch}`);
});
function fixture(name: string, body: string) {
  const path = join(scratch, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
function launcher(binary: string, args: string[] = []) {
  return spawnSync("node", [join(root, "npm/launcher.cjs"), ...args], {
    env: { ...process.env, SPARROW_BINARY_PATH: binary }, encoding: "utf8",
  });
}

test("launcher explains missing optional dependency", () => {
  const result = launcher("");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("optional dependencies enabled");
});
test("launcher honors binary override and passes arguments", () => {
  const result = launcher(fixture("arguments", 'printf "%s\\n" "$@"'), ["--version", "two words"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("--version\ntwo words\n");
});
test("launcher propagates nonzero exit", () => {
  expect(launcher(fixture("failure", "exit 27")).status).toBe(27);
});
test("launcher explains missing override binary", () => {
  const result = launcher(join(scratch, "absent"));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Could not start Sparrow");
});
test("launcher propagates child termination signal", () => {
  expect(launcher(fixture("signal", "kill -TERM $$")).signal).toBe("SIGTERM");
});
test("launcher forwards SIGTERM to its child", async () => {
  const binary = fixture("forward-signal", 'trap "exit 31" TERM\necho ready\nwhile :; do sleep 0.1; done');
  const child = Bun.spawn(["node", join(root, "npm/launcher.cjs")], {
    env: { ...process.env, SPARROW_BINARY_PATH: binary }, stdout: "pipe", stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  await reader.read();
  child.kill("SIGTERM");
  expect(await child.exited).toBe(31);
});
test("installer verifies, repeats, upgrades and rejects tampered releases atomically", () => {
  const asset = `sparrow-${process.platform}-${process.arch}`;
  const original = '#!/bin/sh\necho "sparrow 0.1.0"\n';
  const binary = join(scratch, asset);
  const checksum = join(scratch, "checksums.txt");
  const target = join(scratch, "install path's bin");
  function release(contents: string) {
    writeFileSync(binary, contents);
    writeFileSync(checksum, `${createHash("sha256").update(contents).digest("hex")}  ${asset}\n`);
  }
  function install() {
    return spawnSync("sh", [join(root, "install.sh")], {
      env: { ...process.env, SPARROW_DOWNLOAD_URL: `file://${scratch}`, SPARROW_INSTALL_DIR: target, SHELL: "/bin/sh" }, encoding: "utf8",
    });
  }
  release(original);
  for (let i = 0; i < 2; i++) {
    const result = install();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Checksum verified");
    const exportLine = result.stdout.split("\n").find(line => line.startsWith("  export PATH="));
    expect(exportLine).toBeDefined();
    const exported = spawnSync("sh", ["-c", `${exportLine}; printf '%s' "$PATH"`], { encoding: "utf8" });
    expect(exported.stdout.startsWith(`${target}:`)).toBe(true);
  }
  writeFileSync(checksum, `${"0".repeat(64)}  ${asset}\n`);
  const failed = install();
  expect(failed.status).not.toBe(0);
  expect(failed.stderr).toContain("Checksum verification failed");
  expect(readFileSync(join(target, "sparrow"), "utf8")).toBe(original);
  release('#!/bin/sh\necho "sparrow 0.1.1"\n');
  expect(install().status).toBe(0);
  expect(spawnSync(join(target, "sparrow"), ["--version"], { encoding: "utf8" }).stdout.trim()).toBe("sparrow 0.1.1");
});
