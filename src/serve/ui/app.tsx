// The prototype UI. Plain React components + JSX — Bun bundles this .tsx (and
// gives HMR) with zero config beyond `jsx: react-jsx` in tsconfig. Everything is
// a thin fetch to the JSON API next door; no client-side state library needed.

import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";

type RuntimeStatus = "idle" | "launching" | "blocked";

interface Account {
  id: string;
  email: string;
  installationId: string;
  gameAccounts: { accountId: string; username: string; region: string }[];
  createdAt: number;
  lastUsedAt?: number;
  tokenExpiresAt?: number;
  runtime: { status: RuntimeStatus; detail?: string };
}

/** The store knows only whether a cached session is still good — that's the persisted state. */
function sessionLabel(acc: Account): string {
  if (!acc.tokenExpiresAt) return "no session";
  return acc.tokenExpiresAt > Date.now() ? "session valid" : "session expired";
}

function StatusBadge({ acc }: { acc: Account }) {
  if (acc.runtime.status === "blocked") return <span className="badge badge-redbar">Blocked</span>;
  if (acc.runtime.status === "launching")
    return <span className="badge badge-captcha">Launching…</span>;
  const ready = acc.tokenExpiresAt !== undefined && acc.tokenExpiresAt > Date.now();
  return <span className={`badge ${ready ? "badge-ingame" : ""}`}>{ready ? "Ready" : "Idle"}</span>;
}

function AccountRow({
  acc,
  onLaunch,
  onRemove,
}: {
  acc: Account;
  onLaunch: (a: Account) => void;
  onRemove: (a: Account) => void;
}) {
  return (
    <div className="row">
      <div className="row-main">
        <div className="email">{acc.email}</div>
        <div className="server">
          {acc.installationId.slice(0, 8)} · {sessionLabel(acc)}
        </div>
        {acc.runtime.detail && <div className="detail">{acc.runtime.detail}</div>}
      </div>
      <StatusBadge acc={acc} />
      <button disabled={acc.runtime.status === "launching"} onClick={() => onLaunch(acc)}>
        Launch
      </button>
      <button className="ghost" onClick={() => onRemove(acc)}>
        Remove
      </button>
    </div>
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
  const [accounts, setAccounts] = useState<Account[]>([]);

  const load = () =>
    fetch("/api/accounts")
      .then((r) => r.json())
      .then(setAccounts);

  useEffect(() => {
    void load();
  }, []);

  // Heartbeat: while this window is open the server stays alive; when it closes
  // the socket drops and the hidden server exits itself. This window *is* the app.
  useEffect(() => {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    return () => ws.close();
  }, []);

  // Every mutation returns the fresh account list on success, or `{ error }` on failure.
  async function apply(res: Response) {
    const data = await res.json();
    if (!res.ok) {
      alert(data?.error ?? `request failed (${res.status})`);
      return;
    }
    setAccounts(data);
  }

  async function launch(acc: Account) {
    await apply(await fetch(`/api/accounts/${acc.id}/launch`, { method: "POST" }));
  }

  async function remove(acc: Account) {
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

      <section className="accounts">
        {accounts.map((acc) => (
          <AccountRow key={acc.id} acc={acc} onLaunch={launch} onRemove={remove} />
        ))}
      </section>

      <AddAccount onAdd={add} />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
