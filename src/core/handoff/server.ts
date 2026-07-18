// The handoff pipe server. The pipe is a machine-wide singleton, but every call carries its
// `sessionId`, so one server answers any number of concurrent clients — that multiplexing is what
// makes multibox possible. Windows-only. See docs/handoff.md.

import net from "node:net";
import { PipeInUseError } from "../errors.ts";
import {
  answer,
  drainJsonObjects,
  encodeResponse,
  HANDOFF_PIPE_NAME,
  pipePath,
} from "./protocol.ts";
import type { GameSession, RpcRequest } from "./types.ts";

export interface HandoffServerOptions {
  pipeName?: string;
  /** Called for every request, answered or not — for logging/diagnostics. */
  onCall?: (req: RpcRequest, result: unknown) => void;
}

export interface HandoffServer {
  /** Pipe the clients connect to. */
  readonly path: string;
  /** Add a launch; returns the `sessionId` to spawn the client with. */
  register(session: GameSession): string;
  /** Drop a session once its client is in (or gave up). */
  release(sessionId: string): void;
  /** Sessions still waiting for their client. */
  readonly size: number;
  close(): Promise<void>;
}

/**
 * Host the handoff pipe. Throws {@link PipeInUseError} when something else already owns it — in
 * practice the real GameForge launcher, which must be closed: launcher-less means replacing it.
 */
export async function createHandoffServer({
  pipeName = HANDOFF_PIPE_NAME,
  onCall,
}: HandoffServerOptions = {}): Promise<HandoffServer> {
  const sessions = new Map<string, GameSession>();
  const path = pipePath(pipeName);

  const server = net.createServer((conn) => {
    // One connection per call: the client opens the pipe, sends a request, reads the reply, closes.
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const { objects, rest } = drainJsonObjects(buf);
      buf = rest;
      for (const raw of objects) {
        let req: RpcRequest;
        try {
          req = JSON.parse(raw) as RpcRequest;
        } catch {
          continue; // not ours to interpret; ignore rather than kill the connection
        }
        const result = answer(req, (id) => sessions.get(id));
        onCall?.(req, result);
        if (result !== undefined) conn.write(encodeResponse(req, result));
      }
    });
    conn.on("error", () => {}); // a client vanishing mid-call must not take the server down
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      // Match the message, not the code: Bun reports an already-taken named pipe as
      // `ERR_INVALID_ARG_TYPE`, not `EADDRINUSE`, which would slip past a code check and surface
      // as a bare "Failed to listen at …" instead of something the user can act on.
      const taken =
        err.code === "EADDRINUSE" || /failed to listen|already in use/i.test(err.message);
      reject(taken ? new PipeInUseError(path) : err);
    };
    server.once("error", onError);
    server.listen(path, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  return {
    path,
    register(session) {
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, session);
      return sessionId;
    },
    release(sessionId) {
      sessions.delete(sessionId);
    },
    get size() {
      return sessions.size;
    },
    close() {
      sessions.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
