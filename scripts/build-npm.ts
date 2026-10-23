import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const platforms = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
const binDir = resolve(root, process.env.SPARROW_BIN_DIR || "dist/bin");
const outDir = resolve(root, "dist/npm");
const metadata = {
  version: pkg.version,
  description: pkg.description,
  license: "MIT",
  repository: pkg.repository,
  homepage: pkg.homepage,
  bugs: pkg.bugs,
  keywords: pkg.keywords,
};
async function writePackage(name: string, fields: Record<string, unknown>) {
  const dir = resolve(outDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "package.json"), JSON.stringify({ name, ...metadata, ...fields }, null, 2) + "\n");
  await copyFile(resolve(root, "npm/LICENSE"), resolve(dir, "LICENSE"));
  await writeFile(resolve(dir, "README.md"), `# ${name}\n\nSparrow runs coding agents in tmux. Requires tmux and a supported, authenticated coding harness.\n\nInstall: \`npm install -g sparrow-agents\`, then run \`sparrow\`.\n\nDocumentation: https://github.com/vermarjun/Sparrow#readme\n`);
  return dir;
}
for (const platform of platforms) {
  const [os, cpu] = platform.split("-");
  const dir = await writePackage(`sparrow-agents-${platform}`, { os: [os], cpu: [cpu], files: ["bin/sparrow"], preferUnplugged: true });
  await mkdir(resolve(dir, "bin"), { recursive: true });
  await copyFile(resolve(binDir, `sparrow-${platform}`), resolve(dir, "bin/sparrow"));
  await chmod(resolve(dir, "bin/sparrow"), 0o755);
}
const wrapper = await writePackage("sparrow-agents", {
  bin: { sparrow: "bin/sparrow.cjs" },
  engines: { node: ">=18" },
  files: ["bin/sparrow.cjs"],
  optionalDependencies: Object.fromEntries(platforms.map(p => [`sparrow-agents-${p}`, pkg.version])),
});
await mkdir(resolve(wrapper, "bin"), { recursive: true });
await copyFile(resolve(root, "npm/launcher.cjs"), resolve(wrapper, "bin/sparrow.cjs"));
await chmod(resolve(wrapper, "bin/sparrow.cjs"), 0o755);
console.log(`Generated 5 npm packages at ${outDir} (v${pkg.version})`);
