// unforge app — the complete workflows, over core + storage.
//
// This is where policy lives: one device per GameForge account, cached sessions, region and
// locale defaults, cert resolution, minting a code only when the client asks for one. `core`
// has none of it, deliberately.
//
// Shaped for a long-lived host, because that is the demanding consumer and the CLI gets it
// for free (the reverse doesn't work — a CLI-shaped API can't be hosted):
//
//   • dependencies bind once, at openApp(), not per call;
//   • no operation blocks for the lifetime of a game client;
//   • state is readable (snapshot) and observable (subscribe), in plain JSON.

import { getLogger } from "@logtape/logtape";
import { UnauthorizedError, type GameAccount } from "../core/index.ts";
import { errorMessage } from "../util/index.ts";
import { findClientDir, spawnClient } from "../launch/index.ts";
import {
  openAccountStore,
  openConfig,
  createDevice,
  type AccountStore,
  type ConfigStore,
  type Device,
  type GfAccount,
  type GfAccountWithSecrets,
  type StoredGameAccount,
} from "../storage/index.ts";
import { resolveCertPem } from "./cert.ts";
import { createHandoffServer, type HandoffServer } from "./handoff-server.ts";
import {
  openGfSession,
  registerGfSession,
  resumeGfSession,
  type GfSession,
  type GfSessionPolicy,
} from "./gf-session.ts";
import { LaunchRegistry, type LaunchState } from "./launches.ts";
import {
  binName,
  gfHandle,
  resolveGameAccount,
  resolveGfAccount,
  soleGfAccount,
  toStoredGameAccount,
  validateAlias,
} from "./refs.ts";

const log = getLogger(["unforge", "app"]);

/** How long a freshly-minted bearer token is treated as good (GF exposes no real expiry). */
const TOKEN_TTL_MS = 55 * 60 * 1000;

export const DEFAULT_REGION = "pt-PT";
export const DEFAULT_LOCALE = "en-GB";

export interface AppOptions {
  store?: AccountStore;
  config?: ConfigStore;
  /** Default region for new game accounts and minted codes. */
  region?: string;
  /** Default GF locale, `^[a-z]{2}-[A-Z]{2}$`. */
  locale?: string;
  /** Overrides the resolved cert (materials path → bundled). */
  certificatePem?: string;
}

/** Everything a frontend needs to render, in one call. Plain JSON — no secrets. */
export interface AppSnapshot {
  accounts: GfAccount[];
  launches: LaunchState[];
  gameDirs: Record<string, string>;
}

/** Every state change. A host forwards these to its clients verbatim. */
export type AppEvent =
  | { type: "accounts"; accounts: GfAccount[] }
  | { type: "launch"; launch: LaunchState };

export interface App {
  readonly auth: AuthApi;
  readonly accounts: AccountsApi;
  readonly launches: LaunchApi;
  readonly config: ConfigStore;
  snapshot(): AppSnapshot;
  subscribe(fn: (event: AppEvent) => void): () => void;
  /** Release the handoff pipe and stop answering. Does not close running clients. */
  close(): Promise<void>;
}

export interface AuthApi {
  /** `auth login` — authenticate, mint a device if this email is new, persist with its game accounts. */
  login(input: {
    email: string;
    password: string;
    alias?: string;
    region?: string;
  }): Promise<GfAccount>;
  /** `auth register` — create a NEW GameForge account, then log it in on the same device. */
  register(input: {
    email: string;
    password: string;
    alias?: string;
    region?: string;
  }): Promise<GfAccount>;
  list(): GfAccount[];
  /** Set, or with `null`, clear back to the email-derived handle. */
  setAlias(ref: string, alias: string | null): Promise<{ email: string; handle: string }>;
  device(ref: string): { email: string; device: Device };
  /** Roll a whole new device; the old fingerprint is retired at once. */
  regenDevice(ref: string): Promise<{ email: string; device: Device }>;
  /** Invalidate server-side, then forget locally. */
  logout(ref: string): Promise<{ email: string }>;
}

/** A game account plus which GameForge login owns it. */
export interface GameAccountRow extends StoredGameAccount {
  gfId: string;
  gfEmail: string;
}

export interface AccountsApi {
  list(gfRef?: string): GameAccountRow[];
  /** Create one under a login — the multibox lever. Omit `gf` when only one login exists. */
  create(input: { displayName: string; gf?: string; region?: string }): Promise<GameAccountRow>;
  /**
   * Mint a one-time login code. Diagnostic — prefer `launches.start`, which mints only when the
   * client asks. An unconsumed code blocks the account for ~18 minutes.
   */
  mintCode(ref: string): Promise<{ code: string; account: StoredGameAccount; numericId: number }>;
}

export interface LaunchApi {
  /** Auth, mint, spawn, register on the pipe. Returns once the client process exists. */
  start(ref: string): Promise<LaunchState>;
  list(): LaunchState[];
  get(id: string): LaunchState | undefined;
  /** Stop answering for this launch. The client will lose its launcher link. */
  stop(id: string): Promise<void>;
}

/** Open the application: binds the store, config, and policy for the process lifetime. */
export async function openApp(opts: AppOptions = {}): Promise<App> {
  const store = opts.store ?? (await openAccountStore());
  const config = opts.config ?? (await openConfig());
  const region = opts.region ?? DEFAULT_REGION;
  const locale = opts.locale ?? DEFAULT_LOCALE;

  const listeners = new Set<(event: AppEvent) => void>();
  const emit = (event: AppEvent): void => {
    for (const fn of listeners) fn(event);
  };
  store.onChange((accounts) => emit({ type: "accounts", accounts }));

  const launches = new LaunchRegistry((launch) => emit({ type: "launch", launch }));

  // The pipe is a machine-wide singleton, so one server serves every launch. Created on the
  // first launch, not at open: `openApp` must work with the real launcher running (and on a
  // non-Windows box), with PipeInUseError surfacing per launch instead.
  let handoff: HandoffServer | undefined;
  const ensureHandoff = async (): Promise<HandoffServer> =>
    (handoff ??= await createHandoffServer({
      onCall: ({ method, sessionId, answered }) => {
        launches.onHandoffCall(sessionId, method);
        log.debug("handoff: {method} {outcome}", {
          method,
          outcome: answered ? "answered" : "(no answer)",
        });
      },
      // The client just gets no answer, so this is the only place the reason surfaces.
      onError: (method, _sessionId, err) => {
        log.error("handoff: {method} failed — {error}", { method, error: errorMessage(err) });
      },
    }));

  /**
   * The client regions installed on this machine — the language folders `config set game-dir`
   * found. These are the regions an account can actually be launched into, and the only place
   * a language's country half ("en" → "en-GB") is known for certain.
   */
  const installedRegions = (): string[] => Object.keys(config.get().gameDirs);

  let policy: GfSessionPolicy | undefined;
  const sessionPolicy = async (): Promise<GfSessionPolicy> =>
    (policy ??= {
      locale,
      region,
      certificatePem: opts.certificatePem ?? (await resolveCertPem()),
    });

  /**
   * A session for a stored account, reusing its cached token when it's still good — re-auth
   * churn is a risk-scoring trigger, so the token is the cheap path, not just an optimisation.
   * Persists the drifted device (and any fresh token) afterwards.
   *
   * `TOKEN_TTL_MS` is a guess (GameForge publishes no expiry), so a cached token can be dead
   * while we still believe in it. That surfaces as a `401` on whatever the caller was doing,
   * and without recovery every command fails until our own TTL happens to lapse — up to an
   * hour of a working account looking broken. So a resumed session that comes back
   * unauthorized can re-authenticate **once** and retry. Only for resumed sessions: a `401` on
   * a token minted seconds earlier is a real rejection, and retrying it would be a login loop.
   *
   * The retry replays the *whole* callback, so it's opt-in via `retryable` — a `fn` that acts
   * before it reads would act twice if the `401` lands on the read.
   */
  async function withSession<T>(
    account: GfAccountWithSecrets,
    fn: (session: GfSession) => Promise<T>,
    { retryable = false }: { retryable?: boolean } = {},
  ): Promise<T> {
    const p = await sessionPolicy();
    const cached = account.secrets.token;
    const authenticate = (): Promise<GfSession> =>
      openGfSession(
        { email: account.email, password: account.secrets.password },
        account.secrets.device,
        p,
      );

    const stale = cached === undefined || cached.expiresAt <= Date.now();
    let fresh = stale;
    let session = stale
      ? await authenticate()
      : resumeGfSession(cached.token, account.secrets.device, p);

    try {
      try {
        return await fn(session);
      } catch (err) {
        if (fresh || !retryable || !(err instanceof UnauthorizedError)) throw err;
        log.debug("cached session rejected — re-authenticating once and retrying");
        session = await authenticate();
        fresh = true;
        return await fn(session);
      }
    } finally {
      // One write: the drifted device and the token land together, so a crash can't desync them.
      await store.save(account.id, {
        device: session.device,
        lastUsedAt: Date.now(),
        ...(fresh ? { token: { token: session.token, expiresAt: Date.now() + TOKEN_TTL_MS } } : {}),
      });
    }
  }

  /** Shared tail of login/register: discover game accounts and persist everything. */
  async function persistSession(
    session: GfSession,
    input: { email: string; password: string; alias?: string; region?: string },
    prior?: GfAccount,
  ): Promise<GfAccount> {
    const discovered = await session.accounts();
    log.info("found {count} game account(s)", { count: discovered.length });
    const gameAccounts = discovered.map((a: GameAccount) =>
      toStoredGameAccount(a, {
        explicit: input.region,
        installed: installedRegions(),
        fallback: region,
        prior,
      }),
    );
    for (const [i, a] of discovered.entries()) {
      log.debug(
        "game account {name}: group={accountGroup} server={server} region={region}{retired}",
        {
          name: a.displayName,
          accountGroup: a.accountGroup ?? "?",
          server: a.server ?? "?",
          region: gameAccounts[i].region,
          retired: a.retired ? " RETIRED" : "",
        },
      );
    }
    const token = { token: session.token, expiresAt: Date.now() + TOKEN_TTL_MS };

    if (prior) {
      await store.save(prior.id, {
        alias: input.alias ?? undefined,
        password: input.password,
        device: session.device,
        token,
        gameAccounts,
      });
      return store.list().find((a) => a.id === prior.id)!;
    }
    const added = await store.add({
      email: input.email,
      alias: input.alias,
      password: input.password,
      device: session.device,
      token,
      gameAccounts,
    });
    const { secrets: _secrets, ...safe } = added;
    return safe;
  }

  const auth: AuthApi = {
    async login(input) {
      const prior = store.list().find((a) => a.email.toLowerCase() === input.email.toLowerCase());
      // Reuse this account's device forever — a fingerprint that changes between logins is
      // itself a flag; a shared one correlates accounts.
      const device = prior
        ? store.get(prior.id)!.secrets.device
        : createDevice(input.region ?? region);
      log.debug("sessions: authenticating {email} ({which} device)", {
        email: input.email,
        which: prior ? "existing" : "new",
      });
      const session = await openGfSession(
        { email: input.email, password: input.password },
        device,
        await sessionPolicy(),
      );
      return persistSession(session, input, prior);
    },

    async register(input) {
      if (store.list().some((a) => a.email.toLowerCase() === input.email.toLowerCase())) {
        throw new Error(
          `already have a GameForge account for ${input.email} — use \`${binName()} auth login\``,
        );
      }
      const session = await registerGfSession(
        { email: input.email, password: input.password },
        createDevice(input.region ?? region),
        await sessionPolicy(),
      );
      return persistSession(session, input);
    },

    list: () => store.list(),

    async setAlias(ref, alias) {
      const target = resolveGfAccount(store.list(), ref);
      const value = alias === null ? null : validateAlias(store.list(), target.id, alias);
      await store.save(target.id, { alias: value });
      return {
        email: target.email,
        handle: gfHandle({ email: target.email, alias: value ?? undefined }),
      };
    },

    device(ref) {
      const target = resolveGfAccount(store.list(), ref);
      return { email: target.email, device: store.get(target.id)!.secrets.device };
    },

    async regenDevice(ref) {
      const target = resolveGfAccount(store.list(), ref);
      // The login's own region, not the app default — else the cleanup introduces a mismatch.
      const device = createDevice(target.gameAccounts[0]?.region ?? region);
      // Keep the cached token: it's account-level, not device-bound.
      await store.save(target.id, { device });
      return { email: target.email, device };
    },

    async logout(ref) {
      const target = resolveGfAccount(store.list(), ref);
      const account = store.get(target.id)!;
      const cached = account.secrets.token;
      if (cached && cached.expiresAt > Date.now()) {
        await resumeGfSession(cached.token, account.secrets.device, await sessionPolicy()).close();
      }
      await store.remove(target.id);
      return { email: target.email };
    },
  };

  const accounts: AccountsApi = {
    list(gfRef) {
      const gfId = gfRef ? resolveGfAccount(store.list(), gfRef).id : undefined;
      return store
        .list()
        .filter((a) => !gfId || a.id === gfId)
        .flatMap((a) => a.gameAccounts.map((g) => ({ ...g, gfId: a.id, gfEmail: a.email })));
    },

    async create(input) {
      const summary = input.gf
        ? resolveGfAccount(store.list(), input.gf)
        : soleGfAccount(store.list());
      const account = store.get(summary.id)!;
      // Where the account is created is where it lives permanently, so it's decided here and
      // used for both halves — the creation itself and the region we stamp it with.
      const createIn = input.region ?? region;
      if (!installedRegions().includes(createIn)) {
        log.warning("no {region} client installed — this account won't be launchable here", {
          region: createIn,
        });
      }

      // Not `retryable`: a 401 on the re-list would replay the create, making a second account.
      const created = await withSession(account, async (session) => {
        const made = await session.createGameAccount(input.displayName, { region: createIn });
        log.info("created game account '{name}' in {region}", {
          name: made.displayName,
          region: createIn,
        });
        // Re-list so the store gets each account's canonical shape (username, numeric id).
        const discovered = await session.accounts();
        await store.save(account.id, {
          gameAccounts: discovered.map((a) =>
            toStoredGameAccount(a, {
              installed: installedRegions(),
              fallback: createIn,
              prior: account,
            }),
          ),
        });
        return made;
      });

      const row = accounts.list(summary.id).find((g) => g.accountId === created.accountId);
      if (!row) {
        throw new Error(`created '${input.displayName}' but it did not appear in the account list`);
      }
      return row;
    },

    async mintCode(ref) {
      const { gfId, game } = resolveGameAccount(store.list(), ref);
      const gf = store.get(gfId)!;
      // The numeric id rides along: whoever consumes a code has to answer the client with it.
      // Retryable: a 401 means the mint didn't happen, so no code is left outstanding.
      return withSession(
        gf,
        async (session) => {
          const remote = pickRemote(await session.accounts(), game);
          const code = await session.mintCode(remote, { region: game.region });
          return { code, account: game, numericId: remote.numericId };
        },
        { retryable: true },
      );
    },
  };

  const launchApi: LaunchApi = {
    async start(ref) {
      const { gfId, game } = resolveGameAccount(store.list(), ref);
      const gf = store.get(gfId)!;

      // Fail before burning an auth if the client isn't reachable.
      const gameDir = config.gameDir(game.region);
      if (!gameDir) {
        throw new Error(
          `no game dir for region ${game.region} — run: ${binName()} config set game-dir <path> --region ${game.region}`,
        );
      }
      const clientDir = findClientDir(gameDir, game.region);
      // Same reason: bind the pipe before spawning, so PipeInUseError surfaces here.
      const pipe = await ensureHandoff();

      const state: LaunchState = {
        id: crypto.randomUUID(),
        accountRef: ref,
        account: game,
        status: "authenticating",
        elevated: false,
        gameDir: clientDir,
        startedAt: Date.now(),
      };
      launches.add(state);

      try {
        // Only the account is resolved, for the ticket's `numericId`. Minting here would leave a
        // code outstanding across the unbounded wait at the server screen, holding the account
        // ~18 minutes if the client is closed before joining. Retryable: a read.
        const remote = await withSession(
          gf,
          async (session) => pickRemote(await session.accounts(), game),
          { retryable: true },
        );

        launches.update(state.id, { status: "spawning" });
        // Minted per ask, never stored — see docs/handoff.md.
        // Retryable: a 401 means the mint didn't happen, so no code is left outstanding.
        const sessionId = pipe.register({
          mintCode: () => {
            log.debug("handoff: minting a login code for {name}", {
              name: game.displayName ?? game.username,
            });
            return withSession(gf, (session) => session.mintCode(remote, { region: game.region }), {
              retryable: true,
            });
          },
          name: game.displayName ?? game.username,
          numericId: remote.numericId,
        });
        launches.bindSession(state.id, sessionId);

        const { pid, elevated } = await spawnClient({ dir: clientDir, sessionId });
        log.info(elevated ? "relaunching elevated via UAC" : "spawned pid {pid}", { pid });
        launches.update(state.id, { status: "awaiting-client", pid, elevated });
        return launches.get(state.id)!;
      } catch (err) {
        launches.update(state.id, { status: "failed", error: errorMessage(err) });
        throw err;
      }
    },

    list: () => launches.list(),
    get: (id) => launches.get(id),
    async stop(id) {
      launches.release(id, handoff);
    },
  };

  return {
    auth,
    accounts,
    launches: launchApi,
    config,
    snapshot: () => ({
      accounts: store.list(),
      launches: launches.list(),
      gameDirs: { ...config.get().gameDirs },
    }),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async close() {
      await handoff?.close();
      handoff = undefined;
    },
  };
}

/** Match a stored game account to its live `/user/accounts` entry. */
function pickRemote(remote: GameAccount[], game: StoredGameAccount): GameAccount {
  const found = remote.find((a) => a.id === game.accountId);
  if (!found) throw new Error(`game account "${game.username}" is no longer on this login`);
  return found;
}
