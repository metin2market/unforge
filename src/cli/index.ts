#!/usr/bin/env bun
// unforge CLI — a thin wrapper over the library so it can be driven from a terminal.
// Commander handles subcommands, options, and --help; each action is a thin call into
// the application layer (src/app), which composes core + store + config + launch.
//
// Command surface (see docs/cli.md):
//   launch [game-account]            auth + spawn the client (picks if omitted) — the whole point
//   account list | create | code     game accounts — the everyday noun
//   auth   register                   create a GameForge account (solves the captcha) + record it
//   auth   login | list | logout     GameForge accounts — set up once, then forgotten
//   auth   alias <gf> [alias]        set/clear a GameForge account's short handle
//   auth   device show | regen       inspect / roll a GameForge account's device
//   config set game-dir             machine-level game-client dir per region
//   serve                            the local web UI

import { Command } from "commander";
import { getLogger } from "@logtape/logtape";
import { VERSION } from "../index.ts";
import { UnexpectedResponseError } from "../core/index.ts";
import { describeError } from "../app/describe-error.ts";
import { detachOwnConsole } from "./hide-console.ts";
import { askConfirm, askPassword, askText } from "./prompts.ts";
import { pickGameAccount, pickGfAccount } from "./pick.ts";

// Status/progress/errors go through the logger (stderr + the redacted file trail); command
// *results* — codes, lists, device reports — stay on `console.log` (stdout) so they pipe
// cleanly and secrets never reach the log file. See docs/logging.md.
const log = getLogger(["unforge", "cli"]);

// The store/config/app modules touch the filesystem (and DPAPI), so they're imported
// lazily inside the actions that need them — `serve`, `--help`, and `--version` stay light.
async function openStore() {
  const { openAccountStore } = await import("../storage/index.ts");
  return openAccountStore();
}
async function openCfg() {
  const { openConfig } = await import("../storage/index.ts");
  return openConfig();
}
async function app() {
  return import("../app/index.ts");
}

async function startServe(opts: {
  open: boolean;
  exitOnClose: boolean;
  verbose?: boolean;
}): Promise<void> {
  const { serve } = await import("../serve/index.ts");
  await serve(opts);
}

/** Report a failed command: a human summary for the user, GF's raw body for the file trail. */
function reportError(err: unknown): void {
  log.error("{error}", { error: describeError(err).summary });
  // The raw status + body stays in the debug trail for diagnosis (not shown by default).
  if (err instanceof UnexpectedResponseError) {
    log.debug("spark error: {status} {body}", { status: err.status, body: err.body ?? "" });
  }
}

/**
 * Wrap a command action so a failure is reported and exits non-zero — one try/catch for
 * every command instead of one per command. Applied to each `.action(run(async …))`.
 */
function run<A extends unknown[]>(fn: (...args: A) => Promise<void>) {
  return async (...args: A): Promise<void> => {
    try {
      await fn(...args);
    } catch (err) {
      reportError(err);
      process.exit(1);
    }
  };
}

/**
 * Gate a destructive action on a yes/no confirmation. `--yes` skips it; a non-interactive
 * shell without `--yes` refuses (rather than silently proceeding). Logs and returns false
 * when the user declines, so the caller can just `return`.
 */
async function confirmDestructive(skip: boolean | undefined, message: string): Promise<boolean> {
  if (skip) return true;
  const ok = await askConfirm(message);
  if (ok === undefined) {
    throw new Error("refusing without confirmation — pass --yes to proceed non-interactively");
  }
  if (!ok) log.info("cancelled");
  return ok;
}

const fmtTime = (ms?: number): string => (ms ? new Date(ms).toISOString() : "—");
function sessionLabel(expiresAt?: number): string {
  if (!expiresAt) return "no session";
  return expiresAt > Date.now() ? `valid until ${fmtTime(expiresAt)}` : "session expired";
}

const program = new Command();

/** The global `--verbose` flag, readable from any subcommand's action. */
const verbose = (): boolean => Boolean(program.opts().verbose);

program
  .name("unforge")
  .description("Launch GameForge games without the GameForge launcher")
  .version(VERSION, "-v, --version")
  // Global: `unforge --verbose <command>` drops the console to debug for any command.
  .option("--verbose", "log every step to the console")
  // Global: `unforge --trace <file> <command>` dumps every request/response to a JSONL trace
  // for diagnosis (un-redacted — holds secrets, gitignored). Also honours `UNFORGE_TRACE`.
  .option("--trace <file>", "write a JSONL request trace to <file> (diagnostic; holds secrets)")
  // Wire the logger + trace once before any command runs, so every command's status/error
  // output has sinks (unconfigured, LogTape is a no-op). `serve` reconfigures its own sinks.
  .hook("preAction", async () => {
    const a = await app();
    await a.configureLogging({ verbose: verbose() });
    const traceFile = (program.opts().trace as string | undefined) ?? process.env.UNFORGE_TRACE;
    if (traceFile) a.installFetchTrace(traceFile);
  })
  // No subcommand = double-clicked from the file manager: run as the "app" — detach the
  // stray console, open the window, and quit with it.
  .action(() => {
    detachOwnConsole();
    return startServe({ open: true, exitOnClose: true, verbose: verbose() });
  });

// ── launch (top-level, the hot path) ────────────────────────────────────────────
program
  .command("launch")
  .argument(
    "[game-account]",
    "game account to launch (username, display name, or id; picks if omitted)",
  )
  .description("Auth + spawn the game client into a game account (Windows)")
  .option("--locale <locale>", "GF locale for the auth calls, e.g. pt-PT")
  .action(
    run(async (ref: string | undefined, opts: { locale?: string }) => {
      const [store, config, a] = await Promise.all([openStore(), openCfg(), app()]);
      const target = ref ?? (await pickGameAccount(store));
      const res = await a.launchAccount(store, config, target, opts.locale);
      const how = res.elevated
        ? " (elevated — approve the UAC prompt)"
        : res.pid
          ? ` — pid ${res.pid}`
          : "";
      log.info("launched {name} ({region}){how}", {
        name: res.account.displayName,
        region: res.region,
        how,
      });
      log.info("game dir: {dir}", { dir: res.gameDir });
      // The client wants a responder for the whole session, not just at login — so we never close
      // the pipe on our own; this window is the responder.
      log.info(
        "keep this window open while you play — closing it breaks the game's launcher link.",
      );
      log.info("Ctrl+C when you're done.");
    }),
  );

// ── account (game accounts — the everyday noun) ─────────────────────────────────
const account = program
  .command("account")
  .description("Manage game accounts (the per-game logins under a GameForge account)");

account
  .command("list")
  .description("List game accounts across your GameForge logins")
  .option("--gf <gf>", "only this GameForge account (email, handle, or id)")
  .action(
    run(async (opts: { gf?: string }) => {
      const [store, a] = await Promise.all([openStore(), app()]);
      const gfId = opts.gf ? a.resolveGfAccount(store, opts.gf).id : undefined;
      const rows = a.listAllGameAccounts(store, gfId);
      if (rows.length === 0) {
        console.log("no game accounts — run `unforge auth login` first");
        return;
      }
      for (const r of rows) {
        const name = r.displayName ?? r.username;
        console.log(`${name}  [${r.region}]  ${r.username}  ·  ${r.gfEmail}`);
      }
    }),
  );

account
  .command("create")
  .argument("[display-name]", "display name for the new game account (prompted if omitted)")
  .description("Create a game account under a GameForge login (solves the captcha if one fires)")
  .option("--gf <gf>", "GameForge account to create it under (email, handle, or id; omit to pick)")
  .option("--region <region>", "region stamped on the new game account (default pt-PT)")
  .option("--locale <locale>", "GF locale for the auth calls, e.g. pt-PT")
  .action(
    run(
      async (
        displayName: string | undefined,
        opts: { gf?: string; region?: string; locale?: string },
      ) => {
        const [store, a] = await Promise.all([openStore(), app()]);
        // Choose the owning login first (flag, sole account, or picker), then the name.
        const gfId = opts.gf ? a.resolveGfAccount(store, opts.gf).id : await pickGfAccount(store);
        const name = displayName ?? (await askText("Game account name"));
        if (!name) throw new Error("a display name is required");

        const res = await a.addGameAccount({
          store,
          gf: gfId,
          displayName: name,
          region: opts.region,
          locale: opts.locale,
        });
        log.info("created {name} [{region}] under {gf}", {
          name: res.account.displayName ?? res.account.username,
          region: res.account.region,
          gf: res.gfEmail,
        });
      },
    ),
  );

account
  .command("code")
  .argument("<game-account>", "game account (username, display name, or id)")
  .description("Mint + print a one-time login code (test / diagnostic)")
  .option("--locale <locale>", "GF locale for the auth calls, e.g. pt-PT")
  .action(
    run(async (ref: string, opts: { locale?: string }) => {
      const [store, a] = await Promise.all([openStore(), app()]);
      const res = await a.mintCode(store, ref, opts.locale);
      // The login code is the command's result (and a secret) — stdout only, never the log.
      console.log(res.code);
    }),
  );

// ── auth (GameForge accounts — set up once, then forgotten) ──────────────────────
const auth = program
  .command("auth")
  .description("Manage GameForge accounts (the email + password logins)");

auth
  .command("register")
  .description("Create a GameForge account (POST /users, solving the captcha) and record it")
  .option("--email <email>", "GameForge account email")
  .option("--password <password>", "GameForge account password (prompted if omitted)")
  .option("--alias <alias>", "short handle to store for this account (else derived from the email)")
  .option("--region <region>", "region stamped on discovered game accounts (default pt-PT)")
  .option("--locale <locale>", "GF locale for the auth calls, e.g. pt-PT")
  .action(
    run(
      async (opts: {
        email?: string;
        password?: string;
        alias?: string;
        region?: string;
        locale?: string;
      }) => {
        const email = opts.email ?? (await askText("GameForge email"));
        const password = opts.password ?? (await askPassword("Password"));
        if (!email || !password) throw new Error("email and password are required");

        const [store, a] = await Promise.all([openStore(), app()]);
        const res = await a.createGfAccount({
          store,
          email,
          password,
          alias: opts.alias,
          region: opts.region,
          locale: opts.locale,
        });
        log.info("registered {email} — {count} game account(s)", {
          email: res.email,
          count: res.gameAccounts.length,
        });
        for (const g of res.gameAccounts) {
          log.info("  {name}  [{region}]", { name: g.displayName ?? g.username, region: g.region });
        }
        // GF won't issue a play code until the email is verified — the account can log in and
        // create game accounts before then, but `launch` will 403 (see CodeNotAllowedError).
        log.info("next: verify {email} from GameForge's confirmation email before you can play.", {
          email: res.email,
        });
      },
    ),
  );

auth
  .command("login")
  .description("Authenticate a GameForge account, mint its device, and list its game accounts")
  .option("--email <email>", "GameForge account email")
  .option("--password <password>", "GameForge account password (prompted if omitted)")
  .option("--alias <alias>", "short handle to store for this account (else derived from the email)")
  .option("--region <region>", "region for discovered game accounts (default pt-PT)")
  .option("--locale <locale>", "GF locale for the auth calls, e.g. pt-PT")
  .action(
    run(
      async (opts: {
        email?: string;
        password?: string;
        alias?: string;
        region?: string;
        locale?: string;
      }) => {
        // Prompt when a flag is omitted; no env fallback (Bun auto-loads `.env`, so a
        // scripts' `UNFORGE_PASSWORD` would silently hijack the login). Use `--password`.
        const email = opts.email ?? (await askText("GameForge email"));
        const password = opts.password ?? (await askPassword("Password"));
        if (!email || !password) throw new Error("email and password are required");

        const [store, a] = await Promise.all([openStore(), app()]);
        const res = await a.registerAccount({
          store,
          email,
          password,
          alias: opts.alias,
          region: opts.region,
          locale: opts.locale,
        });
        log.info("{verb} {email} — {count} game account(s)", {
          verb: res.isNew ? "added" : "updated",
          email: res.email,
          count: res.gameAccounts.length,
        });
        for (const g of res.gameAccounts) {
          log.info("  {name}  [{region}]", {
            name: g.displayName ?? g.username,
            region: g.region,
          });
        }
      },
    ),
  );

auth
  .command("list")
  .description("List GameForge accounts and their session validity")
  .action(
    run(async () => {
      const [store, a] = await Promise.all([openStore(), app()]);
      const rows = a.listGfAccounts(store);
      if (rows.length === 0) {
        console.log("no GameForge accounts — run `unforge auth login`");
        return;
      }
      for (const r of rows) {
        const handle = a.gfHandle(r);
        console.log(
          `${handle}  ·  ${r.email}  ·  ${r.gameAccounts.length} game account(s)  ·  ${sessionLabel(r.tokenExpiresAt)}`,
        );
      }
    }),
  );

auth
  .command("alias")
  .argument("<gf>", "GameForge account (email, handle, or id)")
  .argument("[alias]", "new short handle; omit to clear back to the email-derived one")
  .description("Set or clear a GameForge account's short handle")
  .action(
    run(async (ref: string, alias: string | undefined) => {
      const [store, a] = await Promise.all([openStore(), app()]);
      const res = await a.setGfAlias(store, ref, alias);
      log.info("{email} → handle '{handle}'", { email: res.email, handle: res.handle });
    }),
  );

auth
  .command("logout")
  .argument("<gf>", "GameForge account (email, handle, or id)")
  .description("Forget a GameForge account (invalidates its session, then drops it)")
  .option("-y, --yes", "skip the confirmation prompt")
  .action(
    run(async (ref: string, opts: { yes?: boolean }) => {
      const [store, a] = await Promise.all([openStore(), app()]);
      const target = a.resolveGfAccount(store, ref);
      if (
        !(await confirmDestructive(opts.yes, `Forget ${a.gfHandle(target)} (${target.email})?`))
      ) {
        return;
      }
      const { email } = await a.logoutAccount(store, target.id);
      log.info("logged out and removed {email}", { email });
    }),
  );

const device = auth
  .command("device")
  .description("Inspect or roll a GameForge account's device (fingerprint + identity)");

device
  .command("show")
  .argument("<gf>", "GameForge account (email, handle, or id)")
  .description("Show the device profile, installation id, and identity")
  .action(
    run(async (ref: string) => {
      const [store, a] = await Promise.all([openStore(), app()]);
      const d = a.deviceInfo(store, ref);
      const p = d.deviceProfile;
      console.log(`account:        ${d.email}`);
      console.log(`installation:   ${d.installationId}`);
      console.log(`client id:      ${d.clientId}`);
      console.log(`vector stamped: ${fmtTime(d.vectorUpdatedAt)}`);
      console.log(
        `gpu:            ${p.webglVendorRenderer.split(",")[1] ?? p.webglVendorRenderer}`,
      );
      console.log(`screen:         ${p.screenAvailWidth}×${p.screenAvailHeight}`);
      console.log(`memory / cores: ${p.deviceMemoryGb} GB / ${p.hardwareConcurrency}`);
      console.log(`canvas fp:      ${p.canvasFingerprint}`);
    }),
  );

device
  .command("regen")
  .argument("<gf>", "GameForge account (email, handle, or id)")
  .description("Roll a new device (installation id + identity + fingerprint)")
  .option("-y, --yes", "skip the confirmation prompt")
  .action(
    run(async (ref: string, opts: { yes?: boolean }) => {
      const [store, a] = await Promise.all([openStore(), app()]);
      const target = a.resolveGfAccount(store, ref);
      const msg = `Roll a new device for ${a.gfHandle(target)}? The old fingerprint is retired.`;
      if (!(await confirmDestructive(opts.yes, msg))) return;
      const d = await a.regenDevice(store, target.id);
      console.log(`rolled a new device for ${d.email}`);
      console.log(`installation:   ${d.installationId}`);
      console.log(`gpu:            ${d.deviceProfile.webglVendorRenderer.split(",")[1] ?? "?"}`);
    }),
  );

// ── config (machine-level, set once) ────────────────────────────────────────────
const config = program
  .command("config")
  .description("Machine-level settings (per-region game dirs) — set once per install");

const configSet = config.command("set").description("Set a config value");

configSet
  .command("game-dir")
  .argument("<path>", "game install path — the root or a language dir (metin2client.exe is found)")
  .option("--region <region>", "region, when it can't be inferred from the folder name")
  .description("Set the game-client dir(s) — resolves the exe and fills each language found")
  .action(
    run(async (path: string, opts: { region?: string }) => {
      const { discoverGameDirs } = await import("../launch/index.ts");
      const found = discoverGameDirs(path);
      const cfg = await openCfg();
      for (const f of found) {
        const region = f.region ?? opts.region;
        if (!region) {
          throw new Error(`could not infer a region for ${f.dir} — pass --region <region>`);
        }
        await cfg.setGameDir(region, f.dir);
        log.info("game-dir[{region}] = {dir}", { region, dir: f.dir });
      }
    }),
  );

config
  .command("list")
  .description("Show the current machine-level config")
  .action(
    run(async () => {
      const cfg = await openCfg();
      const c = cfg.get();
      const regions = Object.keys(c.gameDirs);
      if (regions.length === 0) {
        console.log("game-dirs: —");
      } else {
        console.log("game-dirs:");
        for (const r of regions) console.log(`  ${r}: ${c.gameDirs[r]}`);
      }
    }),
  );

// ── serve (the web UI) ──────────────────────────────────────────────────────────
program
  .command("serve")
  .description("Start the local web UI (http://127.0.0.1:4000)")
  .option("--no-open", "don't open a browser window")
  // Explicit `serve` stays up until Ctrl+C — the dev / advanced entry.
  .action((opts: { open: boolean }) =>
    startServe({ open: opts.open, exitOnClose: false, verbose: verbose() }),
  );

await program.parseAsync();
