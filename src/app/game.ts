// Game-account operations for the CLI's `account` namespace and top-level `launch`:
// list the game accounts across logins, mint a login code, and launch the client into
// one. Composes `core.authenticate()` with `store` (device + secrets), `config` (per-region
// game dir), and `launch` (the Windows spawn).

import { homedir } from "node:os";
import { join } from "node:path";
import {
  authenticate,
  createBlackboxSequence,
  createGameAccount,
  createSession,
  GAMEFORGE_CERT_PEM,
  listGameAccounts,
  type GameAccount,
} from "../core/index.ts";
import { createHandoffServer, type HandoffServer } from "../core/handoff/index.ts";
import { findClientDir, spawnClient } from "../launch/index.ts";
import type { AccountStore, ConfigStore, GfAccount, StoredGameAccount } from "../storage/index.ts";
import { getLogger } from "@logtape/logtape";
import {
  binName,
  DEFAULT_REGION,
  resolveGameAccount,
  resolveGfAccount,
  SESSION_TTL_MS,
  toStoredGameAccount,
} from "./shared.ts";

const log = getLogger(["unforge", "launch"]);

// Overrides the bundled cert — the way to swap one in without a rebuild.
export const DEFAULT_CERT_PATH = join(homedir(), "unforge-materials", "cert.pem");

/** Resolve the cert PEM: a local file if present, else the bundled one. `opts` is injectable for tests. */
export async function resolveCertPem(
  opts: { defaultPath?: string; bundled?: string } = {},
): Promise<string> {
  const file = Bun.file(opts.defaultPath ?? DEFAULT_CERT_PATH);
  if (await file.exists()) return file.text();
  return opts.bundled ?? GAMEFORGE_CERT_PEM;
}

/** A game account plus which GameForge login owns it — the `account list` row. */
export interface GameAccountRow extends StoredGameAccount {
  gfId: string;
  gfEmail: string;
}

/** `account list [--gf <gf>]` — game accounts across logins, optionally one login's. */
export function listAllGameAccounts(store: AccountStore, gfId?: string): GameAccountRow[] {
  return store
    .list()
    .filter((s) => !gfId || s.id === gfId)
    .flatMap((s) => s.gameAccounts.map((g) => ({ ...g, gfId: s.id, gfEmail: s.email })));
}

/**
 * Run the auth flow for one resolved game account with its stored device, and persist the
 * fresh token + drifted identity. Shared by `mintCode` and `launchAccount`. The region comes
 * from the stored game account; the cert PEM from {@link resolveCertPem}.
 */
async function authGameAccount(
  store: AccountStore,
  gf: GfAccount,
  game: StoredGameAccount,
  locale?: string,
): Promise<{ code: string; account: GameAccount }> {
  const certificatePem = await resolveCertPem();
  log.debug("authenticating {email} → {account} ({region})", {
    email: gf.email,
    account: game.displayName ?? game.username,
    region: game.region,
  });

  const result = await authenticate({
    email: gf.email,
    password: gf.password,
    installationId: gf.installationId,
    region: game.region,
    certificatePem,
    locale,
    deviceProfile: gf.deviceProfile,
    deviceIdentity: gf.deviceIdentity,
    selectAccount: (accts) => {
      const found = accts.find((a) => a.id === game.accountId);
      if (!found) throw new Error(`game account "${game.username}" is no longer on this login`);
      return found;
    },
  });
  log.info("login code minted");

  await store.recordAuth(gf.id, {
    session: { token: result.token, expiresAt: Date.now() + SESSION_TTL_MS },
    deviceIdentity: result.deviceIdentity,
  });

  return { code: result.code, account: result.account };
}

export interface MintCodeResult {
  code: string;
  account: GameAccount;
  region: string;
}

/** `account code <game-account>` — mint + return a one-time login code (test/diagnostic). */
export async function mintCode(
  store: AccountStore,
  ref: string,
  locale?: string,
): Promise<MintCodeResult> {
  const { gf, game } = resolveGameAccount(store, ref);
  const { code, account } = await authGameAccount(store, gf, game, locale);
  return { code, account, region: game.region };
}

export interface AddGameAccountOptions {
  store: AccountStore;
  /** The GameForge login to create it under (email or id). Omit when only one exists. */
  gf?: string;
  /** The new game account's display name. */
  displayName: string;
  /** Region stamped on the new game account. Default: the login's first account, else pt-PT. */
  region?: string;
  locale?: string;
}

export interface AddGameAccountResult {
  gfEmail: string;
  account: StoredGameAccount;
}

/**
 * `account create <display-name>` — create a new game account under a GameForge login
 * (`POST /users/me/accounts`, solving the PoW captcha if one fires). Reuses the login's
 * cached session when it's still valid, else authenticates for a fresh token; then re-lists
 * so the store gets each account's canonical shape (username, numeric id) for `launch`/`code`.
 * One GameForge login can own several game accounts — this is the multibox entry point.
 */
export async function addGameAccount(opts: AddGameAccountOptions): Promise<AddGameAccountResult> {
  const { store, displayName } = opts;
  const summary = opts.gf ? resolveGfAccount(store, opts.gf) : soleGfAccount(store);
  const gf = store.get(summary.id)!;

  const region = opts.region ?? gf.gameAccounts[0]?.region ?? DEFAULT_REGION;
  // GF wants a language / account-group slug ("pt"), not the region tag ("pt-PT").
  const gfLang = region.split("-")[0]!.toLowerCase();

  // One sequence spans the (optional) re-auth and the create — the vector advances per call.
  const blackbox = createBlackboxSequence({
    profile: gf.deviceProfile,
    identity: gf.deviceIdentity,
  });

  let session = gf.session;
  if (!session || session.expiresAt <= Date.now()) {
    log.debug("sessions: no valid cached token, authenticating {email}", { email: gf.email });
    const token = await createSession({
      email: gf.email,
      password: gf.password,
      installationId: gf.installationId,
      blackbox: blackbox.next(),
      locale: opts.locale,
    });
    session = { token, expiresAt: Date.now() + SESSION_TTL_MS };
  }

  log.debug("users/me/accounts: creating '{displayName}' [{gfLang}]", { displayName, gfLang });
  const created = await createGameAccount({
    token: session.token,
    installationId: gf.installationId,
    displayName,
    blackbox: blackbox.next(),
    gfLang,
    accountGroup: gfLang,
    locale: opts.locale,
  });
  log.info("created game account '{displayName}'", { displayName: created.displayName });

  const discovered = await listGameAccounts(session.token, gf.installationId);
  const gameAccounts = discovered.map((a) => toStoredGameAccount(a, region, gf));
  await store.put({
    id: gf.id,
    email: gf.email,
    password: gf.password,
    installationId: gf.installationId,
    deviceIdentity: blackbox.identity,
    deviceProfile: gf.deviceProfile,
    session,
    gameAccounts,
  });

  const account = gameAccounts.find((g) => g.accountId === created.accountId);
  if (!account) {
    throw new Error(`created '${displayName}' but it did not appear in the account list`);
  }
  return { gfEmail: gf.email, account };
}

/** Resolve the one-and-only GameForge login, or fail with a clear hint if that's ambiguous. */
function soleGfAccount(store: AccountStore) {
  const all = store.list();
  if (all.length === 0) {
    throw new Error(`no GameForge account — run \`${binName()} auth register\` first`);
  }
  if (all.length > 1) {
    throw new Error(`multiple GameForge accounts — pass --gf <email>`);
  }
  return all[0]!;
}

export interface LaunchResult {
  pid: number | undefined;
  account: GameAccount;
  region: string;
  gameDir: string;
  /** True when launched via a UAC prompt (the client requires administrator). */
  elevated: boolean;
}

/**
 * `launch <game-account>` — auth, then hand the code to the client over the handoff pipe so it logs
 * itself in (docs/handoff.md).
 *
 * Returns once the client is spawned, but a self-hosted pipe is **left open** and keeps the process
 * alive: the client asks for its login only when the user clicks Join, and goes on expecting a
 * responder afterwards — stop answering and it fails with "the launcher is no longer working". So a
 * one-shot caller lives as long as the game does; it's ended by stopping the process. Pass `server`
 * to share one pipe across launches — what multibox needs — and its lifetime becomes yours.
 */
export async function launchAccount(
  store: AccountStore,
  config: ConfigStore,
  ref: string,
  locale?: string,
  server?: HandoffServer,
): Promise<LaunchResult> {
  const { gf, game } = resolveGameAccount(store, ref);

  // Fail before burning an auth if the game dir isn't configured or the client isn't found: an
  // unconsumed code locks the account out of a retry for ~18m (CodeNotAllowedError).
  const gameDir = config.gameDir(game.region);
  if (!gameDir) {
    throw new Error(
      `no game dir for region ${game.region} — run: ${binName()} config set game-dir <path> --region ${game.region}`,
    );
  }
  const clientDir = findClientDir(gameDir, game.region);
  log.debug("client dir: {clientDir}", { clientDir });

  // Host the pipe before minting, for the same reason: PipeInUseError must not cost a code.
  // Log the method, never the result — the result is the login code.
  const owned = server
    ? undefined
    : await createHandoffServer({
        onCall: (req, result) =>
          log.debug("handoff: {method} {outcome}", {
            method: req.method,
            outcome: result === undefined ? "(no answer)" : "answered",
          }),
      });
  const pipe = server ?? owned!;

  try {
    const { code, account } = await authGameAccount(store, gf, game, locale);
    const sessionId = pipe.register({
      code,
      name: game.displayName ?? game.username,
      numericId: account.accountNumericId,
    });
    log.debug("spawning the client for session {sessionId}", { sessionId });
    const { pid, elevated } = await spawnClient({ dir: clientDir, sessionId });
    log.info(elevated ? "not elevated, relaunching via UAC" : "spawned pid {pid}", { pid });

    // Deliberately no timeout on `owned`: the client needs a responder for the whole session, so
    // the pipe (and this process) stay up until the caller stops them.
    if (owned) log.info("serving the handoff pipe for this session");
    return { pid, account, region: game.region, gameDir: clientDir, elevated };
  } catch (err) {
    await owned?.close();
    throw err;
  }
}
