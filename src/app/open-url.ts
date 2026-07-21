// Open a URL in the user's default browser as an ordinary tab (full chrome) — serve's
// fallback when the default browser isn't one it can drive as a chromeless `--app=` window
// (see serve/open-browser.ts).
export function openUrl(url: string): void {
  const cmd =
    process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : process.platform === "darwin"
        ? ["open", url]
        : ["xdg-open", url];
  Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
}
