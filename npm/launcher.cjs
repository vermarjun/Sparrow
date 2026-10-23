#!/usr/bin/env node
'use strict';
const { spawn } = require('node:child_process');
const platform = `${process.platform}-${process.arch}`;
const supported = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];
let binary = process.env.SPARROW_BINARY_PATH;
if (!binary) {
  if (!supported.includes(platform)) {
    console.error(`Sparrow does not support ${platform}. On Windows, install inside WSL.`);
    process.exit(1);
  }
  try {
    binary = require.resolve(`sparrow-agents-${platform}/bin/sparrow`);
  } catch {
    console.error(`Sparrow's binary package sparrow-agents-${platform} is missing. Reinstall sparrow-agents with optional dependencies enabled (omit --no-optional / --omit=optional), or set SPARROW_BINARY_PATH.`);
    process.exit(1);
  }
}
const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', (error) => {
  console.error(`Could not start Sparrow at ${binary}: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code ?? 1;
  }
});
