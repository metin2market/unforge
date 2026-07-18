// unforge — the default entry: the whole tool as a library.
//
// Three layers, each importable on its own:
//
//   unforge           this file — `openApp()`, the complete workflows
//   unforge/core      the reverse-engineering layer: endpoints, hashes, blackbox, wire protocol
//   unforge/storage   the sealed account store + machine config
//
// Reach for `unforge/core` alone when you want the protocol without our policy or our disk
// layout — it's cross-platform and touches nothing but the network. This entry pulls in
// storage, so it wants Windows (DPAPI seals the store).

// Single source of truth: package.json. `bun build --compile` inlines this JSON, so the
// compiled binary's `--version` stays correct without a second place to bump.
import { version } from "../package.json";
export const VERSION: string = version;

export * from "./app/index.ts";
export type { Credentials, GameAccount, LoginCode } from "./core/index.ts";
export type { Device, GfAccount, StoredGameAccount } from "./storage/index.ts";
