#!/usr/bin/env bun
// unforge CLI — a thin wrapper over the library so it can be driven from a terminal.
// Commander handles subcommands, options, and --help; each action opens the app (src/app)
// and calls one operation on it. No command logic lives here.
//
// Command surface (see docs/cli.md):
//   launch [game-account]            auth + spawn the client (picks if omitted) — the whole point
//   account list | sync | create | code   game accounts — the everyday noun
//   auth   register                  create a GameForge account (solves the captcha) + record it
//   auth   login | list | logout     GameForge accounts — set up once, then forgotten
//   auth   alias <gf> [alias]        set/clear a GameForge account's short handle
//   auth   device show | regen       inspect / roll a GameForge account's device
//   config set game-dir              machine-level game-client dir per region
//   serve                            the local web UI

import { Command } from "commander";
import { getLogger } from "@logtape/logtape";
import { VERSION } from "../index.ts";
import { assertRegion, knownRegions, UnexpectedResponseError, type Region } from "../core/index.ts";
import { describeError, regionLabel } from "../app/index.ts";
import type { GfAccount } from "../storage/index.ts";
import { detachOwnConsole } from "./hide-console.ts";
import { askConfirm, askPassword, askText } from "./prompts.ts";
import { pickGameAccount, pickGfAccount, pickRegion } from "./pick.ts";

// Status/progress/errors go through the logger (stderr + the redacted file trail); command
// *results* — codes, lists, device reports — stay on `console.log` (stdout) so they pipe
// cleanly and secrets never reach the log file. See docs/logging.md.
const log = getLogger(["unforge", "cli"]);

// The app touches the filesystem (and DPAPI), so it's opened lazily inside the actions that
// need it — `serve`, `--help` and `--version` stay light. One object holds the store, the
// config, and the handoff pipe for the life of the command.
async function app() {
  const { openApp } = await import("../app/index.ts");
  return openApp();
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
  // Wire the logger + trace once before any command runs, so every command's status/error
  // output has sinks (unconfigured, LogTape is a no-op). `serve` reconfigures its own sinks.
  .hook("preAction", async () => {
    const { configureLogging, installFetchTrace } = await import("../app/index.ts");
    await configureLogging({ verbose: verbose() });
    // Always traced, no flag: a GameForge refusal is usually only diagnosable from the run that
    // hit it, and that run is over by the time anyone thinks to ask for a trace. Goes into the
    // normal log at `trace` level — see docs/logging.md.
    installFetchTrace();
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
  .argument("[game-account]", "game account to launch (display name or id; picks if omitted)")
  .description("Auth + spawn the game client into a game account (Windows)")
  .action(
    run(async (ref: string | undefined) => {
      const a = await app();
      const target = ref ?? (await pickGameAccount(a.accounts.list()));
      const launch = await a.launches.start(target);
      const how = launch.elevated
        ? " (elevated — approve the UAC prompt)"
        : launch.pid
          ? ` — pid ${launch.pid}`
          : "";
      log.info("launched {name} ({region}){how}", {
        name: launch.account.displayName,
        region: regionLabel(launch.account.accountGroup),
        how,
      });
      log.info("game dir: {dir}", { dir: launch.gameDir });

      // `start` returns as soon as the client exists — the client asks for its login only when
      // the user clicks Join, and keeps expecting a responder afterwards. Holding the process
      // open is the CLI's policy; the library has no opinion about it.
      // On the transition, not the state: the client re-enters `logged-in` on every rejoin.
      let loggedIn = false;
      a.subscribe((e) => {
        if (e.type !== "launch" || e.launch.id !== launch.id) return;
        const now = e.launch.status === "logged-in";
        if (now && !loggedIn) log.info("client logged in");
        loggedIn = now;
      });
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
      const a = await app();
      const rows = a.accounts.list(opts.gf);
      if (rows.length === 0) {
        console.log("no game accounts — run `unforge account sync` to fetch them from GameForge");
        return;
      }
      for (const r of rows) {
        console.log(`${r.displayName}  [${regionLabel(r.accountGroup)}]  ·  ${r.gfEmail}`);
      }
    }),
  );

account
  .command("sync")
  .description("Re-fetch game accounts from GameForge and replace what's stored")
  .option("--gf <gf>", "only this GameForge account (email, handle, or id; omit for all)")
  .action(
    run(async (opts: { gf?: string }) => {
      const a = await app();
      const rows = await a.accounts.sync(opts.gf);
      for (const r of rows) {
        console.log(`${r.displayName}  [${regionLabel(r.accountGroup)}]  ·  ${r.gfEmail}`);
      }
    }),
  );

account
  .command("create")
  .argument("[display-name]", "display name for the new game account (prompted if omitted)")
  .description("Create a game account under a GameForge login (solves the captcha if one fires)")
  .option("--gf <gf>", "GameForge account to create it under (email, handle, or id; omit to pick)")
  .option(
    "--region <region>",
    `region to create it in — permanent; asks when several clients (${knownRegions().join(", ")})`,
  )
  .action(
    run(async (displayName: string | undefined, opts: { gf?: string; region?: string }) => {
      const a = await app();
      // argv is where a region stops being an arbitrary string — refuse here, before anything is
      // chosen, so the app below takes a `Region` and never re-checks one.
      let explicit: Region | undefined;
      if (opts.region !== undefined) {
        assertRegion(opts.region);
        explicit = opts.region;
      }
      // Choose the owning login first (flag, sole account, or picker), then the name.
      const gf = opts.gf ?? (await pickGfAccount(a.auth.list()));
      const name = displayName ?? (await askText("Game account name"));
      if (!name) throw new Error("a display name is required");
      // Announced either way, inferred or picked — the choice is permanent.
      const region = explicit ?? (await pickRegion(a.config.regions()));
      log.info("creating {name} in {region} — permanent, and the only region it can be played in", {
        name,
        region,
      });

      const created = await a.accounts.create({ displayName: name, gf, region });
      log.info("created {name} [{region}] under {gf}", {
        name: created.displayName,
        region: regionLabel(created.accountGroup),
        gf: created.gfEmail,
      });
    }),
  );

account
  .command("code")
  .argument("<game-account>", "game account (display name or id)")
  .description("Mint + print a one-time login code (test / diagnostic)")
  .action(
    run(async (ref: string) => {
      const a = await app();
      const { code } = await a.accounts.mintCode(ref);
      // The login code is the command's result (and a secret) — stdout only, never the log.
      console.log(code);
    }),
  );

// ── auth (GameForge accounts — set up once, then forgotten) ──────────────────────
const auth = program
  .command("auth")
  .description("Manage GameForge accounts (the email + password logins)");

/** What `register` and `login` both print: the account and the game accounts under it. */
function reportAccount(verb: string, gf: GfAccount): void {
  log.info(`${verb} {email} — {count} game account(s)`, {
    email: gf.email,
    count: gf.gameAccounts.length,
  });
  for (const g of gf.gameAccounts) {
    log.info("  {name}  [{region}]", {
      name: g.displayName,
      region: regionLabel(g.accountGroup),
    });
  }
}

/** Both `register` and `login` take the same credentials, prompting for what's missing. */
async function credentials(opts: { email?: string; password?: string }) {
  // No env fallback (Bun auto-loads `.env`, so a stray `UNFORGE_PASSWORD` would silently
  // hijack the login). Use `--password`.
  const email = opts.email ?? (await askText("GameForge email"));
  const password = opts.password ?? (await askPassword("Password"));
  if (!email || !password) throw new Error("email and password are required");
  return { email, password };
}

auth
  .command("register")
  .description("Create a GameForge account (POST /users, solving the captcha) and record it")
  .option("--email <email>", "GameForge account email")
  .option("--password <password>", "GameForge account password (prompted if omitted)")
  .option("--alias <alias>", "short handle to store for this account (else derived from the email)")
  .action(
    run(async (opts: { email?: string; password?: string; alias?: string }) => {
      const a = await app();
      const registered = await a.auth.register({
        ...(await credentials(opts)),
        alias: opts.alias,
      });
      reportAccount("registered", registered);
      // GF won't issue a play code until the email is verified — the account can log in and
      // create game accounts before then, but `launch` will 403 (see CodeNotAllowedError).
      log.info("next: verify {email} from GameForge's confirmation email before you can play.", {
        email: registered.email,
      });
    }),
  );

auth
  .command("login")
  .description("Authenticate a GameForge account, mint its device, and list its game accounts")
  .option("--email <email>", "GameForge account email")
  .option("--password <password>", "GameForge account password (prompted if omitted)")
  .option("--alias <alias>", "short handle to store for this account (else derived from the email)")
  .action(
    run(async (opts: { email?: string; password?: string; alias?: string }) => {
      const a = await app();
      const loggedIn = await a.auth.login({
        ...(await credentials(opts)),
        alias: opts.alias,
      });
      reportAccount("authenticated", loggedIn);
    }),
  );

auth
  .command("list")
  .description("List GameForge accounts and their session validity")
  .action(
    run(async () => {
      const [a, { gfHandle }] = await Promise.all([app(), import("../app/index.ts")]);
      const rows = a.auth.list();
      if (rows.length === 0) {
        console.log("no GameForge accounts — run `unforge auth login`");
        return;
      }
      for (const r of rows) {
        console.log(
          `${gfHandle(r)}  ·  ${r.email}  ·  ${r.gameAccounts.length} game account(s)  ·  ${sessionLabel(r.tokenExpiresAt)}`,
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
      const a = await app();
      const res = await a.auth.setAlias(ref, alias ?? null);
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
      const [a, { gfHandle, resolveGfAccount }] = await Promise.all([
        app(),
        import("../app/index.ts"),
      ]);
      const target = resolveGfAccount(a.auth.list(), ref);
      if (!(await confirmDestructive(opts.yes, `Forget ${gfHandle(target)} (${target.email})?`))) {
        return;
      }
      const { email } = await a.auth.logout(target.id);
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
      const a = await app();
      const { email, device: d } = a.auth.device(ref);
      const p = d.profile;
      console.log(`account:        ${email}`);
      console.log(`installation:   ${d.installationId}`);
      console.log(`client id:      ${d.identity.clientId}`);
      console.log(`vector stamped: ${fmtTime(d.identity.vectorUpdatedAt)}`);
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
      const [a, { gfHandle, resolveGfAccount }] = await Promise.all([
        app(),
        import("../app/index.ts"),
      ]);
      const target = resolveGfAccount(a.auth.list(), ref);
      const msg = `Roll a new device for ${gfHandle(target)}? The old fingerprint is retired.`;
      if (!(await confirmDestructive(opts.yes, msg))) return;
      const { email, device: d } = await a.auth.regenDevice(target.id);
      console.log(`rolled a new device for ${email}`);
      console.log(`installation:   ${d.installationId}`);
      console.log(`gpu:            ${d.profile.webglVendorRenderer.split(",")[1] ?? "?"}`);
    }),
  );

// ── config (machine-level, set once) ────────────────────────────────────────────
const config = program
  .command("config")
  .description("Machine-level settings (per-region game dirs) — set once per install");

const configSet = config.command("set").description("Set a config value");

configSet
  .command("game-dir")
  .argument("<path>", "game install path — the root or a region dir (metin2client.exe is found)")
  .option("--region <region>", "region, when it can't be inferred from the folder name")
  .description("Set the game-client dir(s) — resolves the exe and fills each region found")
  .action(
    run(async (path: string, opts: { region?: string }) => {
      const { discoverGameDirs } = await import("../launch/index.ts");
      const found = discoverGameDirs(path);
      const a = await app();
      const entries = found.map(({ region, dir }): [Region, string] => {
        const r = region ?? opts.region;
        if (!r) throw new Error(`could not infer a region for ${dir} — pass --region <region>`);
        assertRegion(r);
        return [r, dir];
      });
      // Resolved first, written once: a path that names an unknown region shouldn't leave the
      // earlier folders of the same scan already committed.
      await a.config.setGameDirs(entries);
      for (const [region, dir] of entries) log.info("game-dir[{region}] = {dir}", { region, dir });
    }),
  );

config
  .command("list")
  .description("Show the current machine-level config")
  .action(
    run(async () => {
      const a = await app();
      const gameDirs = a.config.gameDirs();
      const regions = a.config.regions();
      if (regions.length === 0) {
        console.log("game-dirs: —");
        return;
      }
      console.log("game-dirs:");
      for (const r of regions) console.log(`  ${r}: ${gameDirs[r]}`);
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
