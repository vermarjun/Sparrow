// Subprocess entry for end-to-end tests: starts the real server (real T2 spawner) with whatever
// SPARROW_HOME / SPARROW_PORT / SPARROW_TMUX_SOCKET / SPARROW_TMUX_PREFIX / SPARROW_SETTINGS the parent set.
import { startServer } from '../../src/server/main';

if (!process.env.SPARROW_HOME || !process.env.SPARROW_TMUX_SOCKET) {
  console.error('refusing to run: set SPARROW_HOME and SPARROW_TMUX_SOCKET (never touch the real state)');
  process.exit(2);
}
const srv = await startServer({ webDist: '/nonexistent' });
const bye = async () => { await srv.stop(); process.exit(0); };
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
