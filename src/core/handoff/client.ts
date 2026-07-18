// Spawning the client in GameForge mode. Windows-only. See docs/handoff.md.

import { join } from "node:path";
import { buildInvocation, CLIENT_EXE, METIN2_APPLICATION_ID } from "./protocol.ts";

export interface SpawnGfClientOptions {
  /** The dir holding the client exe — the caller resolves it (core takes everything as input). */
  dir: string;
  /** From `HandoffServer.register()`; reaches the client as `_TNT_SESSION_ID`. */
  sessionId: string;
  applicationId?: string;
  exe?: string;
}

/**
 * Spawn the client so it fetches its login from the handoff pipe. The pipe must already be hosted,
 * and must stay hosted: the client connects once automatically (~2.5s, `initSession`), but only asks
 * for the login when the **user clicks Join** on the server/channel screen — an unbounded wait.
 *
 * The client requires **administrator** (anti-cheat manifest), so this rejects with `EACCES` when
 * we aren't elevated — how to react is the caller's policy, not ours. It also re-execs itself once
 * for the same reason, so the returned pid is the first of two processes.
 */
export async function spawnGfClient({
  dir,
  sessionId,
  applicationId = METIN2_APPLICATION_ID,
  exe = CLIENT_EXE,
}: SpawnGfClientOptions): Promise<number> {
  if (process.platform !== "win32") {
    throw new Error(`the handoff is Windows-only (${exe})`);
  }
  const { args, env } = buildInvocation({ sessionId, applicationId });
  // stdio all-"ignore" is what lets `detached` actually detach: an inherited pipe would
  // keep this process alive until the client exits.
  const child = Bun.spawn([join(dir, exe), ...args], {
    cwd: dir,
    env: { ...process.env, ...env },
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();
  return child.pid;
}
