// Launches — auth, mint, spawn, and answer the handoff pipe for a game client.
//
// A launch is tracked state, not a promise you await. The interesting transition
// (`awaiting-client` → `logged-in`) waits on a **person** clicking Join, which is unbounded
// (measured 11s and 48s for the same client), so `start` returns as soon as the client
// process exists and the rest is observed. That is also what lets one long-lived host run
// many launches: the alternative — a call that blocks for the life of the game — can serve
// exactly one. See docs/handoff.md.

import { getLogger } from "@logtape/logtape";
import type { StoredGameAccount } from "../storage/index.ts";
import type { HandoffServer } from "./handoff-server.ts";

const log = getLogger(["unforge", "launch"]);

/**
 * Where a launch has got to. Stops at `logged-in`: the client re-execs itself once for
 * elevation, so the pid we spawned exits almost immediately and means nothing — we have no
 * honest signal for "the game closed", and won't invent one.
 */
export type LaunchStatus =
  /** Running the auth chain. */
  | "authenticating"
  /** Code minted, client process starting. */
  | "spawning"
  /** Client spawned and registered on the pipe, not yet connected. */
  | "awaiting-client"
  /** Client connected and called `initSession`. */
  | "connected"
  /** Client took its code — the account is in. */
  | "logged-in"
  | "failed";

/** Plain data: a long-lived host has to be able to serialize this to a UI. */
export interface LaunchState {
  id: string;
  /** The game account's ref, as the caller gave it. */
  accountRef: string;
  account: StoredGameAccount;
  status: LaunchStatus;
  /** The first of two processes — the client re-execs itself. Absent when elevated. */
  pid?: number;
  /** True when a UAC prompt was needed (the client requires administrator). */
  elevated: boolean;
  gameDir: string;
  startedAt: number;
  /** Set when `status` is `failed`. */
  error?: string;
}

/** Tracks live launches and maps pipe traffic onto their status. */
export class LaunchRegistry {
  private readonly byId = new Map<string, LaunchState>();
  private readonly sessionToId = new Map<string, string>();

  constructor(private readonly onChange: (launch: LaunchState) => void) {}

  list(): LaunchState[] {
    return [...this.byId.values()];
  }

  get(id: string): LaunchState | undefined {
    return this.byId.get(id);
  }

  add(state: LaunchState): void {
    this.byId.set(state.id, state);
    this.onChange(state);
  }

  /** Bind a launch to its pipe session, so client calls can be attributed to it. */
  bindSession(id: string, sessionId: string): void {
    this.sessionToId.set(sessionId, id);
  }

  update(id: string, patch: Partial<LaunchState>): void {
    const current = this.byId.get(id);
    if (!current) return;
    const next = { ...current, ...patch };
    this.byId.set(id, next);
    this.onChange(next);
  }

  /** Advance the launch a pipe call belongs to. `initSession` is the client saying hello. */
  onHandoffCall(sessionId: string | undefined, method: string): void {
    if (!sessionId) return;
    const id = this.sessionToId.get(sessionId);
    if (!id) return;
    const bare = method.replace(/^ClientLibrary\./, "");
    if (bare === "initSession") this.update(id, { status: "connected" });
    if (bare === "queryAuthorizationCode") this.update(id, { status: "logged-in" });
  }

  /**
   * Stop answering for a launch. The client keeps expecting a responder for the whole
   * session — "the launcher is no longer working" if it's gone — so this is for a launch
   * that failed or that the caller is deliberately abandoning, not routine cleanup.
   */
  release(id: string, server: HandoffServer | undefined): void {
    for (const [sessionId, launchId] of this.sessionToId) {
      if (launchId !== id) continue;
      server?.release(sessionId);
      this.sessionToId.delete(sessionId);
    }
    this.byId.delete(id);
    log.debug("released launch {id}", { id });
  }
}
