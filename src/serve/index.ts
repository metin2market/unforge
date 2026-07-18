// unforge serve — the local web UI entry point. A Bun HTTP server bound to
// 127.0.0.1 that serves a small React UI and drives the library over JSON.
//
// The server draws no window of its own: it opens the UI as an app window (a
// frameless browser window when it can) and stays alive only while it's open.
// The window holds a heartbeat WebSocket; when the last one drops, the server
// exits itself (`exitOnClose`) — so closing the UI *is* quitting the app, with
// no daemon to manage. A second launch finds the port taken and just reopens the
// window at the running instance.
//
// State is two layers: the *persisted* account set comes from the sealed store
// (`store.list()` — never any secrets over the wire); *runtime* status (a launch
// in flight) lives only in this process's memory for the life of the attempt.
// Staying-alive / crash-recovery is the host process's job, not ours — so there's
// deliberately no persisted "in game" here.

import type { Server, ServerWebSocket } from "bun";
import { getLogger } from "@logtape/logtape";
import index from "./ui/index.html";
import { openUi } from "./open-browser.ts";
import { configureLogging, launchAccount, registerAccount } from "../app/index.ts";
import { createHandoffServer, type HandoffServer } from "../core/handoff/index.ts";
import { openAccountStore, openConfig, type GfAccountSummary } from "../storage/index.ts";

const log = getLogger(["unforge", "serve"]);

const HOST = "127.0.0.1";
const PORT = 4000;
const URL_ = `http://${HOST}:${PORT}`;

// How long to wait after the last UI window closes before exiting — absorbs a
// reload or a quick reopen without tearing the server down.
const GRACE_MS = 2000;

/** Transient, in-memory only: where an account is in a launch attempt right now. */
type RuntimeStatus = "idle" | "launching" | "blocked";
interface Runtime {
  status: RuntimeStatus;
  detail?: string;
}

/** What the UI sees per account: the sealed-store summary plus live runtime state. */
type AccountView = GfAccountSummary & { runtime: Runtime };

const json = (data: unknown, status = 200): Response => Response.json(data, { status });

export interface ServeOptions {
  /** Open a browser window at startup (the double-click "app" entry). */
  open?: boolean;
  /** Exit once the last UI window closes. On for the app, off for a plain `serve`. */
  exitOnClose?: boolean;
  /** Drop the console threshold to `debug` (the `--verbose` flag). */
  verbose?: boolean;
}

/** Start the local web UI. Resolves once the server is listening. */
export async function serve({
  open = false,
  exitOnClose = false,
  verbose = false,
}: ServeOptions = {}): Promise<void> {
  await configureLogging({ verbose });
  const store = await openAccountStore();
  const config = await openConfig();

  // Live UI windows, tracked by their heartbeat socket. Empty → nobody's looking.
  const clients = new Set<ServerWebSocket<undefined>>();
  let exitTimer: ReturnType<typeof setTimeout> | null = null;

  // The handoff pipe is a machine-wide singleton, so one server multiplexes every launch this
  // process makes — created on the first launch (so `serve` still starts with a launcher open,
  // the error surfacing per-launch instead) and shared thereafter. Left open for the process
  // lifetime: clients ask for their login only when the user clicks Join. TODO: a longer-lived
  // orchestrator should own this and release sessions once consumed.
  let handoff: HandoffServer | undefined;
  const ensureHandoff = async (): Promise<HandoffServer> =>
    (handoff ??= await createHandoffServer({
      onCall: (req, result) =>
        log.debug("handoff: {method} {outcome}", {
          method: req.method,
          outcome: result === undefined ? "(no answer)" : "answered",
        }),
    }));

  // Runtime status by account id — reset on restart; the store is the durable half.
  const runtime = new Map<string, Runtime>();
  const views = (): AccountView[] =>
    store.list().map((a) => ({ ...a, runtime: runtime.get(a.id) ?? { status: "idle" } }));

  let server: Server<undefined>;
  try {
    server = Bun.serve({
      hostname: HOST,
      port: PORT,
      development: true,

      routes: {
        "/": index,

        "/api/accounts": {
          GET: () => json(views()),
          // Add a GF account: the user brings email + password; `registerAccount`
          // authenticates (proving the credentials), mints a stable+distinct device,
          // discovers the game accounts, and seals the lot to disk. The password never
          // comes back out — reads are secret-free summaries.
          POST: async (req) => {
            const body = (await req.json()) as {
              email?: string;
              password?: string;
            };
            if (!body.email || !body.password)
              return json({ error: "email and password required" }, 400);
            try {
              await registerAccount({
                store,
                email: body.email,
                password: body.password,
              });
            } catch (err) {
              return json({ error: err instanceof Error ? err.message : String(err) }, 400);
            }
            return json(views());
          },
        },

        "/api/accounts/:id": {
          DELETE: async (req) => {
            await store.remove(req.params.id);
            runtime.delete(req.params.id);
            return json(views());
          },
        },

        // Launch: authenticate the GF account with its stored device, mint a login
        // code, and spawn the client into its first game account (Windows-only). Needs
        // the cert path + region game dir from config; a clear error lands in `detail`
        // if either is missing. Secrets never leave here.
        "/api/accounts/:id/launch": {
          POST: async (req) => {
            const acc = store.get(req.params.id);
            if (!acc) return json({ error: "unknown account" }, 404);
            const game = acc.gameAccounts[0];
            if (!game) {
              runtime.set(acc.id, { status: "blocked", detail: "no game accounts — log in again" });
              return json(views());
            }
            runtime.set(acc.id, { status: "launching" });
            try {
              const res = await launchAccount(
                store,
                config,
                game.accountId,
                undefined,
                await ensureHandoff(),
              );
              runtime.set(acc.id, {
                status: "idle",
                detail: res.elevated
                  ? "launched (elevated via UAC)"
                  : `launched pid ${res.pid ?? "?"}`,
              });
            } catch (err) {
              runtime.set(acc.id, {
                status: "blocked",
                detail: err instanceof Error ? err.message : String(err),
              });
            }
            return json(views());
          },
        },
      },

      // The heartbeat socket lives outside the route table.
      fetch(req, srv) {
        if (new URL(req.url).pathname === "/ws" && srv.upgrade(req)) return undefined;
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
    if ((err as { code?: string }).code === "EADDRINUSE") {
      console.error(`unforge is already running → ${URL_}`);
      if (open) openUi(URL_);
      process.exit(0);
    }
    throw err;
  }

  console.log(`unforge serve → ${server.url.href}`);
  if (open) openUi(URL_);
}
