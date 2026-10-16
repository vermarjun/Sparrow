// Captain launcher (U1, owned by the cli track). Opens the user's own Claude Code
// in a tmux window with the captain guide loaded. Used by `sparrow captain` and POST /api/captain/start.
import type { CaptainStartReq, CaptainStartRes } from '../shared/types';

export async function launchCaptain(_req: CaptainStartReq): Promise<CaptainStartRes> {
  throw new Error('launchCaptain: not implemented yet');
}
