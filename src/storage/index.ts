// unforge storage — everything that persists to the per-user data folder, above `core`. Two
// separate modules sit here side by side: the **account store** (GF accounts, a single
// DPAPI-sealed JSON file — encrypted at rest, Windows-only) and the **config** (machine-level
// game dirs, plain JSON — no seal). They share only the data-folder path (paths.ts) and the safe
// whole-file write (atomic-write.ts). Import separately from `core`, which stays pure. Design +
// threat model: docs/accounts.md.

export { openAccountStore } from "./account-store.ts";
export type { AccountStore, GfAccount, GfAccountInput, GfAccountSummary } from "./account-store.ts";
export { defaultStorePath } from "./store-file.ts";
export type { Session, StoredGameAccount } from "./store-file.ts";
export { sealSecret, unsealSecret } from "./seal.ts";

export { openConfig, defaultConfigPath, CONFIG_VERSION } from "./config.ts";
export type { ConfigStore, UnforgeConfig } from "./config.ts";
