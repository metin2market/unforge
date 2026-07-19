// The handoff pipe server. The pipe is a machine-wide singleton, but every call carries its
// `sessionId`, so one server answers any number of concurrent clients — that multiplexing is what
// makes multibox possible, and why a long-lived host owns one server rather than one per launch.
//
// It lives in the application layer, not core: the wire protocol is GameForge's design
// (core/handoff), but binding an OS resource and holding a registry is runtime state with a
// lifetime. Windows-only. See docs/handoff.md.

import net from "node:net";
import {
  answerRpc,
  drainJsonObjects,
  encodeResponse,
  HANDOFF_PIPE_NAME,
  pipePath,
  sessionIdOf,
  type LaunchTicket,
  type RpcRequest,
} from "../core/handoff/index.ts";
import { PipeInUseError } from "../core/index.ts";
import { isRecord, parseJson } from "../util/index.ts";

export interface HandoffServerOptions {
  pipeName?: string;
  /** Every request, answered or not — how a host tracks a client reaching each stage. */
  onCall?: (call: { method: string; sessionId?: string; answered: boolean }) => void;
  /** A request that threw rather than produced an answer — in practice a failed mint. */
  onError?: (method: string, sessionId: string | undefined, error: unknown) => void;
}

export interface HandoffServer {
  /** Pipe the clients connect to. */
  readonly path: string;
  /** Add a launch; returns the `sessionId` to spawn the client with. */
  register(ticket: LaunchTicket): string;
  /** Drop a launch once its client is in (or gave up). */
  release(sessionId: string): void;
  /** Launches still registered. */
  readonly pending: number;
  close(): Promise<void>;
}

/**
 * Host the handoff pipe. Throws {@link PipeInUseError} when something else already owns it — in
 * practice the real GameForge launcher, which must be closed: launcher-less means replacing it.
 */
export async function createHandoffServer({
  pipeName = HANDOFF_PIPE_NAME,
  onCall,
  onError,
}: HandoffServerOptions = {}): Promise<HandoffServer> {
  const tickets = new Map<string, LaunchTicket>();
  const path = pipePath(pipeName);

  const server = net.createServer((conn) => {
    // One connection per call: the client opens the pipe, sends a request, reads the reply, closes.
    let buf = "";
    // Answers are async (each mints a code), so they're chained: concurrent mints would burn
    // codes the client never asked for.
    let answering: Promise<void> = Promise.resolve();
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const { objects, rest } = drainJsonObjects(buf);
      buf = rest;
      for (const raw of objects) {
        const parsed: unknown = parseJson(raw);
        if (!isRecord(parsed)) continue; // not ours to interpret; ignore rather than kill the connection
        const req: RpcRequest = parsed;
        answering = answering.then(async () => {
          // A failed mint must not take the pipe down for every other launch.
          const result: unknown = await answerRpc(req, (id) => tickets.get(id)).catch(
            (err: unknown) => {
              onError?.(req.method ?? "(none)", sessionIdOf(req), err);
            },
          );
          // The method and session, never the result — the result is the login code.
          onCall?.({
            method: req.method ?? "(none)",
            sessionId: sessionIdOf(req),
            answered: result !== undefined,
          });
          if (result !== undefined) conn.write(encodeResponse(req, result));
        });
      }
    });
    conn.on("error", () => {}); // a client vanishing mid-call must not take the server down
  });

  await new Promise<void>((resolve, reject) => {
    const onListenError = (err: NodeJS.ErrnoException): void => {
      // Match the message, not the code: Bun reports an already-taken named pipe as
      // `ERR_INVALID_ARG_TYPE`, not `EADDRINUSE`, which would slip past a code check and surface
      // as a bare "Failed to listen at …" instead of something the user can act on.
      const taken =
        err.code === "EADDRINUSE" || /failed to listen|already in use/i.test(err.message);
      reject(taken ? new PipeInUseError(path) : err);
    };
    server.once("error", onListenError);
    server.listen(path, () => {
      server.removeListener("error", onListenError);
      resolve();
    });
  });

  return {
    path,
    register(ticket) {
      const sessionId = crypto.randomUUID();
      tickets.set(sessionId, ticket);
      return sessionId;
    },
    release(sessionId) {
      tickets.delete(sessionId);
    },
    get pending() {
      return tickets.size;
    },
    close() {
      tickets.clear();
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
