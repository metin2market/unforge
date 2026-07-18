// The client handoff: hand a `thin/codes` login code to the game client so it logs itself in.
// The Windows-only half of the RE surface — kept a subpath so `unforge/core` (auth) stays portable.
// See docs/handoff.md.

export {
  answer,
  buildInvocation,
  CLIENT_EXE,
  drainJsonObjects,
  encodeResponse,
  HANDOFF_PIPE_NAME,
  METIN2_APPLICATION_ID,
  pipePath,
  sessionIdOf,
} from "./protocol.ts";
export type { SessionLookup } from "./protocol.ts";
export { createHandoffServer } from "./server.ts";
export type { HandoffServer, HandoffServerOptions } from "./server.ts";
export { spawnGfClient } from "./client.ts";
export type { SpawnGfClientOptions } from "./client.ts";
export type { GameSession, RpcRequest } from "./types.ts";
