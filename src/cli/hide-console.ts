// Windows only: if this process owns a *fresh* console — i.e. it was double-clicked
// from Explorer, which spins up a console just for us and attaches nothing else —
// detach from it so no stray console box lingers behind the app window. When we're
// run from a real shell, that shell is also attached (process count > 1), so we
// leave the console alone and CLI output keeps working.
//
// Bun's `--windows-hide-console` does not hide the console on this platform, so we
// do it ourselves with a one-call FFI into kernel32. Purely cosmetic — any failure
// is swallowed.

import { dlopen, ptr } from "bun:ffi";

export function detachOwnConsole(): void {
  if (process.platform !== "win32") return;
  try {
    const k = dlopen("kernel32.dll", {
      GetConsoleProcessList: { args: ["ptr", "u32"], returns: "u32" },
      FreeConsole: { args: [], returns: "bool" },
    });
    const pids = new Uint32Array(4);
    const attached = k.symbols.GetConsoleProcessList(ptr(pids), pids.length);
    // 1 = only us → our own console (double-click). >1 → a shell is here too.
    if (attached <= 1) k.symbols.FreeConsole();
    k.close();
  } catch {
    // Best-effort cosmetics — never break launch over a console detach.
  }
}
