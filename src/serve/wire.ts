// The shapes the UI actually receives, and the one mapping that produces them.
//
// `app`'s types are the server's; these are the wire's. They differ in one place: a game account
// arrives with its region already rendered. The browser gets a string to display rather than a
// group code plus the table needed to read it — which is what lets the UI bundle hold nothing
// from `app` but erased types, and keeps the region reading identically in the window and the CLI.
//
// Every path that sends accounts goes through here — the snapshot, the mutation replies, and the
// socket — because the UI can't tell them apart and a raw one would render a blank.

import { regionLabel, type AppEvent, type AppSnapshot, type LaunchState } from "../app/index.ts";
import type { GfAccount, StoredGameAccount } from "../storage/index.ts";

/** A game account as the UI receives it: the stored fields, plus its region as text. */
export interface UiGameAccount extends StoredGameAccount {
  region: string;
}

export interface UiGfAccount extends Omit<GfAccount, "gameAccounts"> {
  gameAccounts: UiGameAccount[];
}

export interface UiSnapshot extends Omit<AppSnapshot, "accounts"> {
  accounts: UiGfAccount[];
}

export type UiAppEvent =
  | { type: "accounts"; accounts: UiGfAccount[] }
  | { type: "launch"; launch: LaunchState };

const uiGfAccount = (account: GfAccount): UiGfAccount => ({
  ...account,
  gameAccounts: account.gameAccounts.map((g) => ({ ...g, region: regionLabel(g.accountGroup) })),
});

export function uiSnapshot(snapshot: AppSnapshot): UiSnapshot {
  return { ...snapshot, accounts: snapshot.accounts.map(uiGfAccount) };
}

/** A launch event passes through — only accounts carry a region. */
export function uiEvent(event: AppEvent): UiAppEvent {
  if (event.type !== "accounts") return event;
  return { type: "accounts", accounts: event.accounts.map(uiGfAccount) };
}
