// unforge serve — the local web UI entry point. A Bun HTTP server bound to
// 127.0.0.1 that serves a small React UI and drives the app over JSON.
//
// The server draws no window of its own: it opens the UI as an app window (a
// frameless browser window when it can) and stays alive only while it's open.
// The window holds a heartbeat WebSocket; when the last one drops, the server
// exits itself (`exitOnClose`) — so closing the UI *is* quitting the app, with
// no daemon to manage. A second launch finds the port taken and just reopens the
// window at the running instance.
//
// All state — the persisted accounts and the live launches — comes from one `App`
// (src/app). This layer only maps HTTP onto it: no command logic, no runtime bookkeeping
// of its own. That's what will let a long-lived host replace this entry without moving
// any behaviour.

import type { Server, ServerWebSocket } from "bun";
import index from "./ui/index.html";
import { openUi } from "./open-browser.ts";
import { configureLogging, describeError, openApp, type App } from "../app/index.ts";
import { errnoCode, stringField } from "../util/index.ts";
import { uiEvent, uiSnapshot } from "./wire.ts";

const HOST = "127.0.0.1";
const PORT = 4000;
const URL_ = `http://${HOST}:${PORT}`;

// How long to wait after the last UI window closes before exiting — absorbs a
// reload or a quick reopen without tearing the server down.
const GRACE_MS = 2000;

const json = (data: unknown, status = 200): Response => Response.json(data, { status });

export interface ServeOptions {
  /** Open a browser window at startup (the double-click "app" entry). */
  open?: boolean;
  /** Exit once the last UI window closes. On for the app, off for a plain `serve`. */
  exitOnClose?: boolean;
  /** Drop the console threshold to `debug` (the `--verbose` flag). */
  verbose?: boolean;
}

/** Turn a thrown error into the UI's error shape — the same wording the CLI shows. */
const fail = (err: unknown): Response => {
  const { summary, kind, fields } = describeError(err);
  return json({ error: summary, kind, fields }, 400);
};

/** Start the local web UI. Resolves once the server is listening. */
export async function serve({
  open = false,
  exitOnClose = false,
  verbose = false,
}: ServeOptions = {}): Promise<void> {
  await configureLogging({ verbose });
  const app: App = await openApp();

  // Live UI windows, tracked by their heartbeat socket. Empty → nobody's looking.
  const clients = new Set<ServerWebSocket>();
  let exitTimer: ReturnType<typeof setTimeout> | null = null;

  // Push every app event to every open window, so the UI never polls.
  app.subscribe((event) => {
    const payload = JSON.stringify(uiEvent(event));
    for (const ws of clients) ws.send(payload);
  });

  let server: Server<undefined>;
  try {
    server = Bun.serve({
      hostname: HOST,
      port: PORT,
      development: true,

      routes: {
        "/": index,

        // One call gives a fresh window everything it renders; the socket keeps it current.
        "/api/state": { GET: () => json(uiSnapshot(app.snapshot())) },

        "/api/accounts": {
          // The user brings email + password; `auth.login` authenticates (proving the
          // credentials), mints a stable+distinct device, discovers the game accounts, and
          // seals the lot. The password never comes back out — reads carry no secrets.
          POST: async (req) => {
            const body: unknown = await req.json();
            const email = stringField(body, "email");
            const password = stringField(body, "password");
            if (!email || !password) {
              return json({ error: "email and password required" }, 400);
            }
            try {
              await app.auth.login({ email, password });
            } catch (err) {
              return fail(err);
            }
            return json(uiSnapshot(app.snapshot()));
          },
        },

        "/api/accounts/:id": {
          DELETE: async (req) => {
            try {
              await app.auth.logout(req.params.id);
            } catch (err) {
              return fail(err);
            }
            return json(uiSnapshot(app.snapshot()));
          },
        },

        // Launch a game account: auth, mint a code, spawn the client, and answer the handoff
        // pipe so it logs itself in. Returns as soon as the client process exists — progress
        // after that arrives as `launch` events on the socket.
        "/api/game-accounts/:ref/launch": {
          POST: async (req) => {
            try {
              return json(await app.launches.start(req.params.ref));
            } catch (err) {
              return fail(err);
            }
          },
        },
      },

      // The heartbeat socket lives outside the route table.
      fetch(req, srv) {
        if (new URL(req.url).pathname === "/ws" && srv.upgrade(req)) return;
        return new Response("not found", { status: 404 });
      },

      websocket: {
        open(ws) {
          clients.add(ws);
          if (exitTimer) {
            clearTimeout(exitTimer);
            exitTimer = null;
          }
        },
        close(ws) {
          clients.delete(ws);
          // Last window gone: give it a grace period, then quit if nobody returns.
          if (exitOnClose && clients.size === 0) {
            exitTimer = setTimeout(() => {
              if (clients.size === 0) process.exit(0);
            }, GRACE_MS);
          }
        },
        message() {},
      },
    });
  } catch (err) {
    // Port taken → an instance is already up. Reopen its window and step aside.
    if (errnoCode(err) === "EADDRINUSE") {
      console.error(`unforge is already running → ${URL_}`);
      if (open) openUi(URL_);
      process.exit(0);
    }
    throw err;
  }

  console.log(`unforge serve → ${server.url.href}`);
  if (open) openUi(URL_);
}
