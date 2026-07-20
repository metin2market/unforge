// The "ref omitted" path: which login, game account, or region a command should act on. One → use
// it silently; several → an interactive picker; none/ambiguous-in-a-script → an error naming the
// flag to pass. Kept out of the command wiring so the option-building stays pure and testable.

import { binName, gfHandle, regionLabel, type GameAccountRow } from "../app/index.ts";
import type { Region } from "../core/index.ts";
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
    label: r.displayName,
    hint: `${regionLabel(r.accountGroup)} · ${r.gfEmail}`,
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

/** Build the picker rows for the installed regions (pure). Value is the region tag. */
export function regionOptions(installed: Region[]): SelectOption<Region>[] {
  return installed.map((region) => ({ value: region, label: region }));
}

/**
 * Resolve the region to create a game account in when no `--region` was given: the sole installed
 * client, or one the user picks. Throws (with a hint) when there's none, or several and no TTY.
 */
export async function pickRegion(installed: Region[]): Promise<Region> {
  if (installed.length === 0) {
    throw new Error(`no game client configured — run \`${binName()} config set game-dir <path>\``);
  }
  if (installed.length === 1) return installed[0];

  const chosen = await askSelect(
    "Which region? (permanent — the account can only ever be played here)",
    regionOptions(installed),
  );
  if (chosen === undefined) {
    throw new Error(`several clients installed (${installed.join(", ")}) — pass --region <region>`);
  }
  return chosen;
}
