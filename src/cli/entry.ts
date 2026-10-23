// Process entry shared by bin/sparrow (source) and the compiled binary. Keeps the hot paths light: `hook` runs on every
// agent turn and must not load the CLI; `--version` needs nothing materialised.
import { COMPILED } from '../shared/config';

export async function entry(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === 'hook' && rest[0]) return (await import('./hook')).runHook(rest[0], rest.slice(1));
  if (cmd === '__fake-agent') {
    // The fake harness (tests, sandboxes, smoke runs) as a hidden subcommand: the binary has no repo to run fake-agent.ts from.
    process.argv.splice(2, 1);
    await import('../harness/fake-agent');
    return await new Promise<number>(() => {});   // runs until its window is killed (it calls process.exit itself)
  }
  if (COMPILED && cmd !== '--version' && cmd !== 'version' && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') {
    await (await import('../shared/app')).ensureApp();
  }
  return (await import('./main')).main(argv);
}
