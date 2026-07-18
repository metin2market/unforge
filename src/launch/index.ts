// unforge launch — the machine-side of launching: where the client is installed on *this* box, and
// how we react to its administrator requirement. The protocol itself (the `--gf` invocation, the
// pipe, the method set) is GameForge's design and lives in `core/handoff`; this composes it.
// See docs/launch.md; the orchestration (auth → handoff → spawn) lives in src/app.

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { buildInvocation, CLIENT_EXE, spawnGfClient } from "../core/handoff/index.ts";

/** A GameForge region / client language folder, e.g. "pt-PT". */
const REGION_RE = /^[a-z]{2}-[A-Z]{2}$/;

/** Expand a leading `~` to the home dir (shells don't always do it for arbitrary args). */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Locate the folder holding `metin2client.exe` under a (possibly imprecise) game dir. Tries,
 * in order: the dir itself; a `<region>` subfolder (the client's per-language layout); then a
 * bounded recursive search, preferring a hit whose path mentions the region and otherwise the
 * shallowest. Expands a leading `~`. Throws a clear error if nothing is found.
 */
export function findClientDir(gameDir: string, region?: string, maxDepth = 4): string {
  const base = expandHome(gameDir);
  if (!existsSync(base)) throw new Error(`game dir does not exist: ${base}`);
  if (existsSync(join(base, CLIENT_EXE))) return base;
  if (region && existsSync(join(base, region, CLIENT_EXE))) return join(base, region);

  const hits: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable dir — skip
    }
    if (entries.includes(CLIENT_EXE)) hits.push(dir);
    if (depth >= maxDepth) return;
    for (const e of entries) {
      const p = join(dir, e);
      if (isDir(p)) walk(p, depth + 1);
    }
  };
  walk(base, 0);

  if (hits.length === 0) throw new Error(`${CLIENT_EXE} not found under ${base}`);
  const byRegion = region
    ? hits.find((h) => h.toLowerCase().includes(region.toLowerCase()))
    : undefined;
  return byRegion ?? hits.sort((a, b) => a.length - b.length)[0]!;
}

/** A discovered client install: the dir holding the exe, and its region if the folder names it. */
export interface DiscoveredClient {
  region?: string;
  dir: string;
}

/**
 * Discover client install dir(s) under a (possibly imprecise) path — for `config set game-dir`,
 * so what's stored is the resolved location. Expands `~`. If the path is a language dir
 * (`…/pt-PT`) it scans the PARENT so sibling languages are filled too; each language folder
 * holding the exe becomes an entry. Falls back to a recursive search (region unknown) when no
 * language-named folders are present.
 */
export function discoverGameDirs(gamePath: string): DiscoveredClient[] {
  const base = expandHome(gamePath);
  if (!existsSync(base)) throw new Error(`game dir does not exist: ${base}`);

  // A language dir → scan its parent to catch sibling languages; otherwise scan the dir.
  const root =
    existsSync(join(base, CLIENT_EXE)) && REGION_RE.test(basename(base)) ? dirname(base) : base;

  const found: DiscoveredClient[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    // fall through to the recursive fallback
  }
  for (const e of entries.sort()) {
    if (REGION_RE.test(e) && existsSync(join(root, e, CLIENT_EXE))) {
      found.push({ region: e, dir: join(root, e) });
    }
  }
  if (found.length > 0) return found;

  // No language-named folders — search, inferring the region from the folder name if it fits.
  const dir = findClientDir(base);
  const b = basename(dir);
  return [{ region: REGION_RE.test(b) ? b : undefined, dir }];
}

export interface SpawnClientOptions {
  /** The resolved dir holding `metin2client.exe` — the caller locates it via {@link findClientDir}. */
  dir: string;
  /** From `HandoffServer.register()` — the client fetches its login over the pipe with this. */
  sessionId: string;
}

export interface SpawnResult {
  pid: number | undefined;
  /** True when launched via elevation (the client requires administrator — anti-cheat). */
  elevated: boolean;
}

/**
 * Build the PowerShell command that relaunches the client elevated **with its env intact**.
 *
 * The catch: `Start-Process -Verb RunAs` elevates through ShellExecute, which does **not** carry
 * the caller's environment across the UAC boundary — so pointing it straight at the client loses
 * `_TNT_SESSION_ID`, and the client then can't fetch its login over the handoff pipe (it sends an
 * empty session id, so `queryAuthorizationCode` finds nothing and the client hangs). The fix is to
 * elevate a **PowerShell** that sets the vars in its own process and then `Start-Process`es the
 * client as a child (a child inherits its parent's env, and stays elevated). That inner script
 * rides as a base64 `-EncodedCommand` so no quoting has to survive two shell layers.
 */
export function buildElevatedCommand(
  exe: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): string {
  const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
  const setEnv = Object.entries(env)
    .map(([k, v]) => `$env:${k}=${q(v)}`)
    .join("; ");
  const argList = args.length ? ` -ArgumentList ${args.map(q).join(",")}` : "";
  const inner = `${setEnv}; Start-Process -FilePath ${q(exe)} -WorkingDirectory ${q(cwd)}${argList}`;
  // -EncodedCommand takes base64 of UTF-16LE — immune to quote/space mangling through the outer shell.
  const encoded = Buffer.from(inner, "utf16le").toString("base64");
  return `Start-Process -Verb RunAs -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'`;
}

/**
 * Relaunch elevated through a UAC prompt (see {@link buildElevatedCommand} for the env-passing
 * trick). Run **synchronously** (not detached) so the helper actually executes before we return
 * and its failure — a bad command, or the user declining UAC — is captured rather than lost. The
 * inner `Start-Process` (no `-Wait`) returns once the client is launched, so this blocks only for
 * the prompt, not the game session. The pid doesn't cross the elevation boundary, so there's none
 * to return. Throws on failure.
 */
function spawnElevated(
  exe: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): void {
  const cmd = buildElevatedCommand(exe, args, cwd, env);
  let r: ReturnType<typeof Bun.spawnSync>;
  try {
    r = Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", cmd]);
  } catch (err) {
    // Thrown only when powershell itself can't be started; a declined UAC prompt is a
    // non-zero exit instead.
    throw new Error(`could not run the elevation helper: ${(err as Error).message}`);
  }
  if (!r.success) {
    const detail =
      (r.stderr?.toString() || r.stdout?.toString() || "").trim() ||
      `powershell exited ${r.exitCode}`;
    throw new Error(`elevated launch failed: ${detail}`);
  }
}

/**
 * Spawn the client for a session already registered on the handoff server, from a dir the caller
 * has resolved. Applies our elevation policy: a plain spawn works when unforge is already elevated;
 * otherwise it `EACCES`es and we relaunch through a UAC prompt. Windows-only.
 */
export async function spawnClient({ dir, sessionId }: SpawnClientOptions): Promise<SpawnResult> {
  try {
    return { pid: await spawnGfClient({ dir, sessionId }), elevated: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EACCES") throw err;
    const { args, env } = buildInvocation({ sessionId });
    spawnElevated(join(dir, CLIENT_EXE), args, dir, env);
    return { pid: undefined, elevated: true };
  }
}
