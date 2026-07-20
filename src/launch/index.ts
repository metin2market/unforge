// unforge launch — the machine-side of launching: where the client is installed on *this* box, and
// how we react to its administrator requirement. The protocol itself (the `--gf` invocation, the
// pipe, the method set) is GameForge's design and lives in `core/handoff`; this composes it.
// See docs/launch.md; the orchestration (auth → handoff → spawn) lives in src/app.

import { existsSync, readdirSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { buildInvocation, CLIENT_EXE } from "../core/handoff/index.ts";
import { isRegion, type Region } from "../core/index.ts";
import { errnoCode, errorMessage } from "../util/index.ts";

/** Expand a leading `~` to the home dir (shells don't always do it for arbitrary args). */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/** The existing dir a game path names, `~` expanded. Throws if it isn't there. */
function resolveBase(gameDir: string): string {
  const base = expandHome(gameDir);
  if (!existsSync(base)) throw new Error(`game dir does not exist: ${base}`);
  return base;
}

/** The shortest path — a stand-in for the least-nested install, when there is nothing better to
 * prefer. Not strictly depth: a long folder name can outweigh a segment. */
const shallowest = (hits: string[]): string =>
  hits.reduce((best, h) => (h.length < best.length ? h : best));

/** Every folder holding the client exe under `base`, depth-bounded. */
function clientDirsUnder(base: string, maxDepth: number): string[] {
  const hits: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: Dirent[];
    try {
      // `withFileTypes` over a stat per entry: a Metin2 install is thousands of files.
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    if (entries.some((e) => e.name === CLIENT_EXE)) hits.push(dir);
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (e.isDirectory()) walk(join(dir, e.name), depth + 1);
    }
  };
  walk(base, 0);
  if (hits.length === 0) throw new Error(`${CLIENT_EXE} not found under ${base}`);
  return hits;
}

/**
 * Locate the folder holding `metin2client.exe` for a region, under a (possibly imprecise) game
 * dir. Tries the dir itself, then a `<region>` subfolder, then a bounded recursive search
 * preferring a hit whose path names the region. Expands `~`; throws if nothing is found.
 *
 * `region` is required — preferring its folder over the box's other installs is the whole job.
 */
export function findClientDir(gameDir: string, region: Region, maxDepth = 4): string {
  const base = resolveBase(gameDir);
  if (existsSync(join(base, CLIENT_EXE))) return base;
  if (existsSync(join(base, region, CLIENT_EXE))) return join(base, region);

  const hits = clientDirsUnder(base, maxDepth);
  const byRegion = hits.find((h) => h.toLowerCase().includes(region.toLowerCase()));
  return byRegion ?? shallowest(hits);
}

/**
 * Locate a client dir when no region is known yet — `config set game-dir` discovering what's on
 * the box. Takes the shallowest hit, since there is nothing to prefer.
 */
export function findClientDirAnywhere(gameDir: string, maxDepth = 4): string {
  const base = resolveBase(gameDir);
  if (existsSync(join(base, CLIENT_EXE))) return base;
  return shallowest(clientDirsUnder(base, maxDepth));
}

/**
 * A discovered client install. `region` is absent when the folder name doesn't name one — the
 * caller must then supply it, since a game dir is stored under its region and there is nothing
 * to guess from.
 */
export interface DiscoveredClient {
  region?: Region;
  dir: string;
}

/**
 * Discover client install dir(s) under a (possibly imprecise) path — for `config set game-dir`,
 * so what's stored is the resolved location. Expands `~`. If the path is a region dir
 * (`…/pt-PT`) it scans the PARENT so sibling regions are filled too; each region folder
 * holding the exe becomes an entry. Falls back to a recursive search (region unknown) when no
 * region-named folders are present.
 */
export function discoverGameDirs(gamePath: string): DiscoveredClient[] {
  const base = resolveBase(gamePath);

  // A region dir → scan its parent to catch sibling regions; otherwise scan the dir.
  const root =
    existsSync(join(base, CLIENT_EXE)) && isRegion(basename(base)) ? dirname(base) : base;

  const found: DiscoveredClient[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    // fall through to the recursive fallback
  }
  for (const e of entries.toSorted()) {
    if (isRegion(e) && existsSync(join(root, e, CLIENT_EXE))) {
      found.push({ region: e, dir: join(root, e) });
    }
  }
  if (found.length > 0) return found;

  // No region-named folders — search the whole tree (no region to prefer), then infer one from
  // the folder name if it fits.
  const dir = findClientDirAnywhere(base);
  const b = basename(dir);
  return [{ region: isRegion(b) ? b : undefined, dir }];
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
    throw new Error(`could not run the elevation helper: ${errorMessage(err)}`, {
      cause: err,
    });
  }
  if (!r.success) {
    const detail =
      (r.stderr?.toString() || r.stdout?.toString() || "").trim() ||
      `powershell exited ${r.exitCode}`;
    throw new Error(`elevated launch failed: ${detail}`);
  }
}

/**
 * Spawn the client so it fetches its login from the handoff pipe. The pipe must already be
 * hosted, and must stay hosted: the client connects once automatically (~2.5s, `initSession`)
 * but only asks for the login when the **user clicks Join** — an unbounded wait.
 *
 * Applies our elevation policy: a plain spawn works when unforge is already elevated; otherwise
 * it `EACCES`es (the client's manifest requires administrator) and we relaunch through a UAC
 * prompt, which loses the pid. The client also re-execs itself once, so a returned pid is the
 * first of two processes. Windows-only.
 */
export async function spawnClient({ dir, sessionId }: SpawnClientOptions): Promise<SpawnResult> {
  if (process.platform !== "win32") throw new Error(`the handoff is Windows-only (${CLIENT_EXE})`);
  const { args, env } = buildInvocation({ sessionId });
  try {
    // stdio all-"ignore" is what lets `detached` actually detach: an inherited pipe would
    // keep this process alive until the client exits.
    const child = Bun.spawn([join(dir, CLIENT_EXE), ...args], {
      cwd: dir,
      env: { ...process.env, ...env },
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    child.unref();
    return { pid: child.pid, elevated: false };
  } catch (err) {
    if (errnoCode(err) !== "EACCES") throw err;
    spawnElevated(join(dir, CLIENT_EXE), args, dir, env);
    return { pid: undefined, elevated: true };
  }
}
