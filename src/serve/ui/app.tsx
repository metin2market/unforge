// The prototype UI. Plain React components + JSX — Bun bundles this .tsx (and
// gives HMR) with zero config beyond `jsx: react-jsx` in tsconfig.
//
// State comes from the app in two pieces: `GET /api/state` once on mount, then every
// change as a `UiAppEvent` over the socket. Nothing polls, and the UI keeps no derived
// state of its own — a launch's status is whatever the last event said it was.

import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { isRecord } from "../../util/index.ts";
// Type-only, so nothing but erased types reaches the browser bundle — and the wire contract stops
// being a hand-copy that can drift silently into rendering `undefined`. The server renders the
// region (see wire.ts), so this file needs no GameForge knowledge at all.
import type { LaunchState, LaunchStatus } from "../../app/index.ts";
import type { UiAppEvent, UiGameAccount, UiGfAccount, UiSnapshot } from "../wire.ts";

/** The store knows only whether a cached session is still good — that's the persisted state. */
function sessionLabel(acc: UiGfAccount): string {
  if (!acc.tokenExpiresAt) return "no session";
  return acc.tokenExpiresAt > Date.now() ? "session valid" : "session expired";
}

/** Launch statuses a person reads, and which badge colour carries them. */
const STATUS_LABEL: Record<LaunchStatus, string> = {
  authenticating: "Authenticating…",
  spawning: "Starting client…",
  "awaiting-client": "Waiting for client…",
  connected: "Client connected",
  "logged-in": "In game",
  failed: "Failed",
};

function badgeClass(status: LaunchStatus): string {
  if (status === "logged-in") return "badge badge-ingame";
  if (status === "failed") return "badge badge-redbar";
  return "badge badge-captcha";
}

/** A launch is over — for the button — once it's in game or has given up. */
const isSettled = (l: LaunchState): boolean => l.status === "logged-in" || l.status === "failed";

function GameAccountRow({
  gameAccount,
  launch,
  onLaunch,
}: {
  gameAccount: UiGameAccount;
  launch?: LaunchState;
  onLaunch: (gameAccount: UiGameAccount) => void;
}) {
  return (
    <div className="row">
      <div className="row-main">
        <div className="email">{gameAccount.displayName}</div>
        <div className="server">{gameAccount.region}</div>
        {launch?.error && <div className="detail">{launch.error}</div>}
        {launch?.elevated && !launch.error && (
          <div className="detail">approve the UAC prompt to continue</div>
        )}
      </div>
      {launch && <span className={badgeClass(launch.status)}>{STATUS_LABEL[launch.status]}</span>}
      <button
        disabled={launch !== undefined && !isSettled(launch)}
        onClick={() => onLaunch(gameAccount)}
      >
        Launch
      </button>
    </div>
  );
}

function AccountGroup({
  acc,
  launches,
  onLaunch,
  onRemove,
}: {
  acc: UiGfAccount;
  launches: LaunchState[];
  onLaunch: (gameAccount: UiGameAccount) => void;
  onRemove: (acc: UiGfAccount) => void;
}) {
  return (
    <section className="accounts">
      <div className="row">
        <div className="row-main">
          <div className="email">{acc.alias ?? acc.email}</div>
          <div className="server">
            {acc.gameAccounts.length} game account(s) · {sessionLabel(acc)}
          </div>
        </div>
        <button className="ghost" onClick={() => onRemove(acc)}>
          Remove
        </button>
      </div>
      {acc.gameAccounts.length === 0 && (
        <div className="detail">no game accounts — create one with `unforge account create`</div>
      )}
      {acc.gameAccounts.map((gameAccount) => (
        <GameAccountRow
          key={gameAccount.accountId}
          gameAccount={gameAccount}
          // The newest launch for this account is the one worth showing.
          launch={launches.findLast((l) => l.account.accountId === gameAccount.accountId)}
          onLaunch={onLaunch}
        />
      ))}
    </section>
  );
}

function AddAccount({ onAdd }: { onAdd: (email: string, password: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return (
    <form
      className="add"
      onSubmit={(e) => {
        e.preventDefault();
        if (email.trim() && password) {
          onAdd(email.trim(), password);
          setEmail("");
          setPassword("");
        }
      }}
    >
      <input placeholder="GF email…" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input
        type="password"
        placeholder="password…"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button type="submit">Add account</button>
    </form>
  );
}

function App() {
  const [accounts, setAccounts] = useState<UiGfAccount[]>([]);
  const [launches, setLaunches] = useState<LaunchState[]>([]);

  useEffect(() => {
    void readJson<UiSnapshot>(fetch("/api/state")).then((s) => {
      setAccounts(s.accounts);
      setLaunches(s.launches);
    });
  }, []);

  // The socket is both the heartbeat — while this window is open the server stays alive, and
  // when it closes the hidden server exits itself — and how every state change arrives.
  useEffect(() => {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.addEventListener("message", (e: MessageEvent<string>) => {
      const event = parseEvent(e.data);
      if (event?.type === "accounts") setAccounts(event.accounts);
      else if (event?.type === "launch") setLaunches((prev) => upsert(prev, event.launch));
    });
    return () => ws.close();
  }, []);

  /** Mutations answer with the whole snapshot; failures with `{ error }`. */
  async function apply(res: Response) {
    if (!res.ok) {
      alert(await failure(res));
      return;
    }
    const snapshot = await readJson<UiSnapshot>(res);
    setAccounts(snapshot.accounts);
    setLaunches(snapshot.launches);
  }

  async function launch(gameAccount: UiGameAccount) {
    const res = await fetch(
      `/api/game-accounts/${encodeURIComponent(gameAccount.accountId)}/launch`,
      {
        method: "POST",
      },
    );
    if (!res.ok) {
      alert(await failure(res));
      return;
    }
    // The socket will keep this current; seeding it makes the button react immediately.
    const started = await readJson<LaunchState>(res);
    setLaunches((prev) => upsert(prev, started));
  }

  async function remove(acc: UiGfAccount) {
    await apply(await fetch(`/api/accounts/${acc.id}`, { method: "DELETE" }));
  }

  async function add(email: string, password: string) {
    await apply(
      await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    );
  }

  return (
    <main>
      <header>
        <h1>unforge</h1>
        <span className="sub">launcher-less GameForge login</span>
      </header>

      {accounts.map((acc) => (
        <AccountGroup
          key={acc.id}
          acc={acc}
          launches={launches}
          onLaunch={launch}
          onRemove={remove}
        />
      ))}

      <AddAccount onAdd={add} />
    </main>
  );
}

/**
 * The payloads are ours: this UI is served by the same process it talks to, and every body is
 * a `UiSnapshot` / `UiAppEvent` / `LaunchState` typed at the source. So the assertion is over
 * our own serialization, not untrusted input — one place, rather than a cast per call site.
 */
async function readJson<T>(res: Response | Promise<Response>): Promise<T> {
  const data: unknown = await (await res).json();
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return data as T;
}

/**
 * A socket frame, narrowed on the one field that decides how it's read. Unlike the fetch
 * bodies, a frame arrives unsolicited and its `type` is the whole contract — so this reads
 * it rather than trusting it, and ignores anything it doesn't recognise.
 */
function parseEvent(raw: string): UiAppEvent | undefined {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) return undefined;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  if (parsed.type === "accounts" && Array.isArray(parsed.accounts)) return parsed as UiAppEvent;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  if (parsed.type === "launch" && isRecord(parsed.launch)) return parsed as UiAppEvent;
  return undefined;
}

/** The app's error shape (`describeError`), or a bare status if the body isn't one. */
async function failure(res: Response): Promise<string> {
  const body = await readJson<{ error?: string }>(res);
  return body.error ?? `request failed (${res.status})`;
}

/** Replace a launch in place, or append it — events arrive for launches we may not have yet. */
function upsert(launches: LaunchState[], next: LaunchState): LaunchState[] {
  const at = launches.findIndex((l) => l.id === next.id);
  if (at === -1) return [...launches, next];
  return launches.map((l) => (l.id === next.id ? next : l));
}

createRoot(document.getElementById("root")!).render(<App />);
