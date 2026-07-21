// Open a URL in the user's default browser as an ordinary tab (full chrome). Distinct
// from serve's chromeless `--app=` window: the browser-assisted `auth register` sends the
// user to the real GameForge site to solve the captcha the headless flow can't reproduce
// (see docs/captcha.md), so they need a normal browser with an address bar.
export function openUrl(url: string): void {
  const cmd =
    process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : process.platform === "darwin"
        ? ["open", url]
        : ["xdg-open", url];
  Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
}
