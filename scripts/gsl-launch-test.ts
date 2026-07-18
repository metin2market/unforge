// GF launch probe — reproduce the modern GameForge client handoff (see docs/launch.md →
// "The auto-login gap"): host the `GameforgeClientJSONRPC` named pipe, launch the client in
// GameForge mode (`--gf` + `_TNT_SESSION_ID`), and serve our `thin/codes` code when the client's
// gameforge_api.dll asks for `queryAuthorizationCode`. Adapted from GflessClient's
// Launcher/src/auth/gflessclient.cpp (https://github.com/hatz2/GflessClient).
//
// The launch shape is CAPTURED, not guessed (scripts/capture-launch.ps1 on a real launcher Play):
//   metin2client.exe  pid 10112  parent gfclient        --gf
//   metin2client.exe  pid 4388   parent metin2client    --gf     (client re-execs itself for admin)
// So `gfclient.exe` (the launcher) spawns the client DIRECTLY with the single flag `--gf` — the
// session is not on the argv, so it travels via env + the fixed launcher pipe. Two corrections this
// bought us: the flag is `--gf`, not NosTale's positional `gf <lang>` (that was the bug that left the
// client at the legacy login), and `gsl_metin2.exe` is NOT in the Play path at all (it never runs —
// it's install/update-time only, so its /startedFromGsl //host= //msgId= strings are a dead end).
//
// This is an OBSERVATION harness first: it logs every JSON-RPC call the client makes, so we
// learn the Metin2-specific method set / params and whether our responses drive auto-login.
//
// Run from an ELEVATED terminal (the client needs admin, and the pipe must be same-integrity):
//   UNFORGE_GAME_ACCOUNT=unclear_xyz bun scripts/gsl-launch-test.ts
// Env knobs (to iterate on the unknowns):
//   UNFORGE_GAME_ACCOUNT   required — game-account ref (username / display name / id)
//   UNFORGE_GF_MODE_ARG    launch mode arg (default "--gf", as captured)
//   UNFORGE_GF_LANG        extra arg after the mode arg (default "-" = omit; real launches pass none)
//   UNFORGE_TNT_APP_ID     _TNT_CLIENT_APPLICATION_ID (default = gsl.ini gameUuid for Metin2)
//   UNFORGE_PIPES          comma-separated pipe names to host (default: the launcher pipe)
//   UNFORGE_STOP_SERVICE=1 also `sc stop GameforgeClientService` (default OFF — the client rings the
//                          launcher pipe, and stopping the real service only broke the launcher's
//                          own install check, flipping its Play button to "Update")
//   UNFORGE_LAUNCH_EXE     exe to spawn (default "metin2client.exe"; use "gsl_metin2.exe" for the
//                          real GSL entry the launcher spawns — reads gsl.ini, drives the handoff)
//   UNFORGE_LAUNCH_ARGS    override launch args, space-separated ("-" = none). Default = mode+lang.
//   UNFORGE_KILL_LAUNCHER  "0" = leave gfclient.exe running (don't free the launcher pipe)
//   UNFORGE_STOP_SERVICE   "0" = leave GameforgeClientService running (keeps the real session alive)
//
// Clean handoff probe (option 1 — fair test of the GSL path): observe the real entry with the GF
// service alive, hosting only the launcher pipe (kill gfclient to free it):
//   UNFORGE_LAUNCH_EXE=gsl_metin2.exe UNFORGE_LAUNCH_ARGS=- UNFORGE_STOP_SERVICE=0 \
//     UNFORGE_PIPES=GameforgeClientJSONRPC UNFORGE_GAME_ACCOUNT=DE_CrBGames1 bun scripts/gsl-launch-test.ts

import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { openConfig } from "../src/storage/index.ts";
import { findClientDir } from "../src/launch/index.ts";
import { mintCode, resolveGameAccount } from "../src/app/index.ts";
import { openAccountStore } from "../src/storage/index.ts";

const METIN2_GAME_UUID = "fab180a3-cd65-4b7e-bd0e-2ef77fd0c258";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** True if this process is elevated (needed: the client requires admin + same-integrity pipe). */
function isElevated(): boolean {
  return spawnSync("net", ["session"], { stdio: "ignore" }).status === 0;
}

/**
 * Kill the real GameForge launcher so we can host its `GameforgeClientJSONRPC` pipe. Deliberately
 * NOT `/T`: the game client is a *child* of gfclient, and tree-killing a live client strands its
 * session server-side — GF then 403s `thin/codes` with "Not allowed to create code" until it lapses.
 */
function killGfLauncher(): boolean {
  const r = spawnSync("taskkill", ["/IM", "gfclient.exe", "/F"], { encoding: "utf8" });
  return /SUCCESS/i.test(r.stdout ?? "");
}

/** PIDs of any running game client — a live session blocks minting a new code (see above). */
function runningClients(): string[] {
  const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq metin2client.exe", "/NH"], {
    encoding: "utf8",
  });
  return (r.stdout ?? "")
    .split(/\r?\n/)
    .filter((l) => /metin2client\.exe/i.test(l))
    .map((l) => l.trim().split(/\s+/)[1] ?? "?");
}

/** Stop the GameForge background service so we can host its `GameforgeClientServiceJSONRPC` pipe. */
function stopGfService(): boolean {
  const r = spawnSync("sc", ["stop", "GameforgeClientService"], { encoding: "utf8" });
  return r.status === 0;
}

const ref = Bun.env.UNFORGE_GAME_ACCOUNT;
if (!ref) {
  console.error("set UNFORGE_GAME_ACCOUNT to a game-account ref");
  process.exit(1);
}
const modeArg = Bun.env.UNFORGE_GF_MODE_ARG ?? "--gf";
const lang = Bun.env.UNFORGE_GF_LANG ?? "-";
const appId = Bun.env.UNFORGE_TNT_APP_ID ?? METIN2_GAME_UUID;
const launchExe = Bun.env.UNFORGE_LAUNCH_EXE ?? "metin2client.exe";
const killLauncher = Bun.env.UNFORGE_KILL_LAUNCHER !== "0";
// Off by default: the client rings the LAUNCHER pipe, so the real service can keep running. Stopping
// it only broke gfclient's own install check (its Play button flipped to "Update").
const stopService = Bun.env.UNFORGE_STOP_SERVICE === "1";
// The captured launch shows the client is a child of gfclient.exe, so it rings that launcher pipe
// (`GameforgeClientJSONRPC`). The service pipe is install/update plumbing, not the auth handoff.
const pipeNames = (Bun.env.UNFORGE_PIPES ?? "GameforgeClientJSONRPC")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const pipePathOf = (name: string): string => `\\\\.\\pipe\\${name}`;
const sessionId = crypto.randomUUID();

const ts = (): string => new Date().toISOString().slice(11, 23);
const log = (...a: unknown[]): void => console.log(ts(), ...a);

const store = await openAccountStore();
const config = await openConfig();
const { game } = resolveGameAccount(store, ref);
const gameDir = config.gameDir(game.region);
if (!gameDir) {
  console.error(`no game dir for region ${game.region} — run: unforge config set game-dir <path>`);
  process.exit(1);
}
const clientDir = findClientDir(gameDir, game.region);
const username = game.username;

const argsOverride = Bun.env.UNFORGE_LAUNCH_ARGS;
const launchArgs =
  argsOverride !== undefined
    ? argsOverride === "-" || argsOverride === ""
      ? []
      : argsOverride.split(" ").filter(Boolean)
    : lang === "-"
      ? [modeArg]
      : [modeArg, lang];
log(`account:   ${username} (${game.displayName ?? "?"})  region ${game.region}`);
log(`clientDir: ${clientDir}`);
log(`launch:    ${launchExe} ${launchArgs.join(" ")}`);
log(`sessionId: ${sessionId}  appId: ${appId}`);
log(`pipes:     ${pipeNames.join(", ")}`);

// Dry run: validate resolution/config only — no elevation, no launcher-kill, no pipe, no mint.
if (Bun.env.UNFORGE_PROBE_DRY === "1") {
  log("dry run — resolution + config OK; not touching the launcher/pipe. Exiting.");
  process.exit(0);
}

if (!isElevated()) {
  console.error(
    "\nNot elevated. The client requires admin, and our pipe must be at the same integrity as the\n" +
      "client, so run this from an ELEVATED terminal (right-click → Run as administrator).",
  );
  process.exit(1);
}

// Refuse to run while a client is up: it's a live session, so `thin/codes` would 403 ("Not allowed
// to create code"), and killing it here would strand that session server-side for minutes.
const live = runningClients();
if (live.length > 0) {
  console.error(
    `\nA game client is already running (pid ${live.join(", ")}). That's a live session, so GF will\n` +
      "refuse to mint a login code. Close the game normally (don't force-kill — a clean logout\n" +
      "releases the session immediately), then re-run.",
  );
  process.exit(1);
}

// The launcher (gfclient.exe) owns the pipe we need to host; free it. Reopen it any time — it's just
// the GF tray app. The service is left alone (see stopService).
if (killLauncher && killGfLauncher()) log("closed the GameForge launcher (gfclient.exe)");
if (stopService && stopGfService()) log("stopped the GameForge service (GameforgeClientService)");
await sleep(800); // let the OS release the pipe handles

// Mint the login code fresh right before launch (codes are short-lived). The auth flow lists
// `user/accounts` on its way through, so `account` carries the numeric id the client asks for —
// no extra call, no extra login.
log("minting thin/codes login code …");
const { code, account } = await mintCode(store, ref);
log(`code: ${code}`);
log(`account numeric id: ${account.accountNumericId}`);

// Extract balanced top-level JSON objects from a raw byte stream (no fixed framing).
function drainJsonObjects(buf: string): { objects: string[]; rest: string } {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        objects.push(buf.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return { objects, rest: depth > 0 && start >= 0 ? buf.slice(start) : "" };
}

interface RpcRequest {
  id?: unknown;
  jsonrpc?: string;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * Answer the client's JSON-RPC calls (GflessClient's handlePipe). Unknown → logged, no reply.
 * `queryGameAccountNumericId` is Metin2-specific — GflessClient (NosTale) never sees it, so the
 * shape is ours to determine: we send the id as a JSON number, matching the method's name.
 * `UNFORGE_NUMERIC_ID_AS_STRING=1` sends it quoted instead, if the client rejects a bare number.
 */
function handle(req: RpcRequest): unknown {
  const method = req.method ?? "";
  const bare = method.replace(/^ClientLibrary\./, "");
  switch (bare) {
    case "isClientRunning":
      return "true";
    case "initSession":
      return String((req.params?.sessionId as string) ?? sessionId);
    case "queryAuthorizationCode":
      return code;
    case "queryGameAccountName":
      return username;
    case "queryGameAccountNumericId":
      return Bun.env.UNFORGE_NUMERIC_ID_AS_STRING === "1"
        ? String(account.accountNumericId)
        : account.accountNumericId;
    default:
      log(`  ⚠ UNHANDLED method: ${method}  params=${JSON.stringify(req.params ?? {})}`);
      return undefined;
  }
}

/** A JSON-RPC responder for one named pipe, tagging every log line with the pipe it rang. */
function makeServer(pipeLabel: string): net.Server {
  return net.createServer((conn) => {
    log(`→ client connected to pipe [${pipeLabel}]`);
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
          log(`  ✗ [${pipeLabel}] non-JSON frame: ${raw}`);
          continue;
        }
        log(`  ← [${pipeLabel}] ${req.method}  ${JSON.stringify(req.params ?? {})}`);
        const result = handle(req);
        if (result !== undefined) {
          const resp = JSON.stringify({ id: req.id, jsonrpc: req.jsonrpc ?? "2.0", result });
          conn.write(resp);
          const shown = typeof result === "string" ? result : JSON.stringify(result);
          log(
            `  → [${pipeLabel}] ${req.method} = ${shown.length > 40 ? shown.slice(0, 40) + "…" : shown}`,
          );
        }
      }
    });
    conn.on("close", () => log(`← [${pipeLabel}] client closed pipe`));
    conn.on("error", (e) => log(`[${pipeLabel}] conn error:`, e.message));
  });
}

/** Bind one pipe, retrying briefly (the OS may hold the handle a moment after kill/stop). */
async function listenPipe(server: net.Server, path: string, attempts = 6): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      const onErr = (e: Error): void => {
        server.removeListener("error", onErr);
        if (/listen|EADDRINUSE|already/i.test(e.message) && i < attempts - 1) return resolve(false);
        log(`  ✗ could not bind ${path}: ${e.message}`);
        resolve(false); // don't exit — another candidate pipe may still bind
      };
      server.once("error", onErr);
      server.listen(path, () => {
        server.removeListener("error", onErr);
        resolve(true);
      });
    });
    if (ok) return true;
    await sleep(400);
  }
  return false;
}

let bound = 0;
for (const name of pipeNames) {
  if (await listenPipe(makeServer(name), pipePathOf(name))) {
    log(`pipe listening: ${name}`);
    bound++;
  }
}
if (bound === 0) {
  log(
    "⚠ no pipe hosted — the real launcher/service still own them. Launching OBSERVE-ONLY: we can't\n" +
      "  see pipe traffic, only whether the client reaches the game. To intercept, free a pipe\n" +
      "  (UNFORGE_KILL_LAUNCHER / UNFORGE_STOP_SERVICE) or point UNFORGE_PIPES at a free one.",
  );
}

const exe = `${clientDir}\\${launchExe}`;
log(`launching: ${launchExe} ${launchArgs.join(" ")}  (cwd ${clientDir})`);

const child = spawn(exe, launchArgs, {
  cwd: clientDir,
  env: { ...process.env, _TNT_SESSION_ID: sessionId, _TNT_CLIENT_APPLICATION_ID: appId },
  detached: true,
  stdio: "ignore",
});
child.once("error", (e) => {
  console.error(
    (e as NodeJS.ErrnoException).code === "EACCES"
      ? "\nEACCES — the client needs admin; run this from an elevated terminal."
      : `spawn error: ${e.message}`,
  );
  process.exit(1);
});
child.once("spawn", () => log(`spawned pid ${child.pid}`));
child.unref();

log(`serving ${bound} pipe(s) — watch the game window + these logs; Ctrl+C to stop.`);
