// unforge — public library surface.
// Reproduce GameForge's spark.gameforge.com login to obtain a game login code
// without the GF launcher. See README.md for the protocol write-up.
//
// Everything here is the cross-platform `core`; platform-specific layers (the
// Windows `launch`, the CLI) will re-export from their own folders.

// Single source of truth: package.json. `bun build --compile` inlines this JSON, so the
// compiled binary's `--version` stays correct without a second place to bump.
import { version } from "../package.json";
export const VERSION: string = version;

export * from "./core/index.ts";
