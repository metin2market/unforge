// The "ref omitted" path: figure out which account a command should act on — a GameForge login
// (`pickGfAccount`), or a game account to launch (`pickGameAccount`). One → use it silently;
// several → an interactive picker; none/ambiguous-in-a-script → a clear error telling the user to
// pass the ref. Kept out of the command wiring so the option-building stays pure and unit-testable.

import { binName, gfHandle, type GameAccountRow } from "../app/index.ts";
import type { GfAccount } from "../storage/index.ts";
import { askSelect, type SelectOption } from "./prompts.ts";

/** Build the picker rows for a set of GF accounts (pure — no I/O). Value is the account id. */
export function gfAccountOptions(accounts: GfAccount[]): SelectOption<string>[] {
  return accounts.map((a) => ({
    value: a.id,
    label: gfHandle(a),
    hint: `${a.email} · ${a.gameAccounts.length} game account(s)`,
  }));
}

/**
 * Resolve the GF account id to act on when no `--gf` was given: the sole account, or one
 * the user picks. Throws (with a `--gf` hint) when there's none, or several and no TTY.
 */
export async function pickGfAccount(accounts: GfAccount[]): Promise<string> {
  if (accounts.length === 0) {
    throw new Error(`no GameForge account — run \`${binName()} auth register\` first`);
  }
  if (accounts.length === 1) return accounts[0].id;

  const chosen = await askSelect("Which GameForge login?", gfAccountOptions(accounts));
  if (chosen === undefined) {
    throw new Error("multiple GameForge accounts — pass --gf <handle>");
  }
  return chosen;
}

/** Build the picker rows for game accounts (pure). Value is the account id (a launchable ref). */
export function gameAccountOptions(rows: GameAccountRow[]): SelectOption<string>[] {
  return rows.map((r) => ({
    value: r.accountId,
    label: r.displayName ?? r.username,
    hint: `${r.region} · ${r.gfEmail}`,
  }));
}

/**
 * Resolve the game-account ref to launch when none was given on the command line: the sole game
 * account, or one the user picks. Throws (with a hint) when there's none, or several and no TTY.
 */
export async function pickGameAccount(rows: GameAccountRow[]): Promise<string> {
  if (rows.length === 0) {
    throw new Error(
      `no game accounts — run \`${binName()} auth login\` or \`account create\` first`,
    );
  }
  if (rows.length === 1) return rows[0].accountId;

  const chosen = await askSelect("Which game account to launch?", gameAccountOptions(rows));
  if (chosen === undefined) {
    throw new Error("multiple game accounts — pass one as an argument");
  }
  return chosen;
}
