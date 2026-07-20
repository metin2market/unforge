// The client handoff protocol — how the game client asks for its login over the
// `GameforgeClientJSONRPC` pipe. Everything here is GameForge's design: the pipe name, the
// `--gf` invocation, the method set, the wire shapes. Pure, so it's all unit-testable.
//
// Hosting the pipe is not here: a server binds a machine-wide OS resource and has a
// lifetime, so it belongs to the application layer (src/app/handoff-server.ts).
// See docs/handoff.md.

export {
  answerRpc,
  bareMethod,
  buildInvocation,
  CLIENT_EXE,
  drainJsonObjects,
  encodeResponse,
  HANDOFF_PIPE_NAME,
  METIN2_APPLICATION_ID,
  pipePath,
  sessionIdOf,
} from "./protocol.ts";
export type { LaunchTicket, RpcRequest } from "./types.ts";
