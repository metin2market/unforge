// Open the local UI in the user's *own* default browser — as a chromeless "app
// window" (`--app=`) when that browser is Chromium-based (Brave, Chrome, Edge,
// Vivaldi…), so the local page looks like a native application rather than a
// localhost tab. For a non-Chromium default (Firefox) or when we can't resolve
// it, fall back to a plain default-browser tab. The user never meets a "browser"
// or a "mode" — they open the app; this is only how the window is drawn.
//
// We pick the browser from the https default-association ProgId (reliable to
// read) and locate its exe by install path — rather than parsing the ProgId's
// shell command, which is brittle. Launching the *wrong* browser is exactly the
// trap that made an installed-but-locked-down Edge flash-and-close on an LTSC box.
//
// The browser is spawned and forgotten — not a child we supervise. Closing its
// window drops the UI's heartbeat socket, which tells the server to exit.

import { existsSync } from "node:fs";
import { openUrl } from "../app";

/** Known Chromium browsers: default-association ProgId prefix → install sub-path. */
const CHROMIUM_BROWSERS = [
  { progId: "BraveHTML", exe: "BraveSoftware\\Brave-Browser\\Application\\brave.exe" },
  { progId: "ChromeHTML", exe: "Google\\Chrome\\Application\\chrome.exe" },
  { progId: "MSEdgeHTM", exe: "Microsoft\\Edge\\Application\\msedge.exe" },
  { progId: "VivaldiHTM", exe: "Vivaldi\\Application\\vivaldi.exe" },
];

const INSTALL_ROOTS = [
  process.env["LOCALAPPDATA"],
  process.env["ProgramFiles"],
  process.env["ProgramFiles(x86)"],
].filter((r): r is string => Boolean(r));

function findExe(relPath: string): string | undefined {
  return INSTALL_ROOTS.map((root) => `${root}\\${relPath}`).find(existsSync);
}

/** The default browser's https ProgId, e.g. "BraveHTML.xxxx" — or undefined. */
function defaultBrowserProgId(): string | undefined {
  const r = Bun.spawnSync([
    "reg",
    "query",
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice",
    "/v",
    "ProgId",
  ]);
  if (!r.success) return undefined;
  return r.stdout.toString().match(/ProgId\s+REG_SZ\s+(\S+)/)?.[1];
}

/** The default browser's exe if it's a known Chromium (so it supports `--app=`). */
function defaultChromiumBrowser(): string | undefined {
  const progId = defaultBrowserProgId();
  if (!progId) return undefined;
  const match = CHROMIUM_BROWSERS.find((b) => progId.startsWith(b.progId));
  return match ? findExe(match.exe) : undefined;
}

/** Open `url` as an app window in the default Chromium browser, else a plain tab. */
export function openUi(url: string): void {
  const browser = defaultChromiumBrowser();
  if (browser) {
    Bun.spawn([browser, `--app=${url}`], { stdout: "ignore", stderr: "ignore" });
    return;
  }
  openUrl(url);
}
