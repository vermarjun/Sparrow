// bunfig.toml [test] preload: runs before any test file loads (D7/D20).
// Deletes the agent identity vars, and refuses to run unless SPARROW_HOME is not ~/.sparrow and SPARROW_PORT is not unset/4040.
import { REFUSAL, scrub, testEnvProblem } from './preload-guard';

scrub(process.env);
const why = testEnvProblem(process.env);
if (why) {
  console.error(REFUSAL(why));
  process.exit(1);
}
