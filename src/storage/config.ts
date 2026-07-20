// unforge config — machine-level settings that are NOT per account: the game-client dir
// per region (genuinely machine-specific — where you installed the client). Not a secret
// (just filesystem paths), so this is a plain JSON file — **no DPAPI seal**, unlike its sibling
// the account store. The cert is not configured here: it's bundled (see src/core/cert.ts).
//
// One install, set once: `unforge config set game-dir … --region`.

import { z } from "zod";
import { isRegion, type Region } from "../core/index.ts";
import { parseJson } from "../util/index.ts";
import { atomicWrite } from "./atomic-write.ts";
import { unforgeDataFile } from "./paths.ts";

/** Region → game-client dir (holds `metin2client.exe`), e.g. `{ "pt-PT": "C:/…/pt-PT" }`. */
export type GameDirs = Partial<Record<Region, string>>;

/**
 * The persisted machine-level config. `version` is read back rather than re-stamped, so the shape
 * can evolve in code. Both fields default: this file is hand-editable and holds only paths, so a
 * malformed one costs a re-run of `config set` rather than a launch.
 *
 * `gameDirs` is keyed by region by construction — an unknown key is dropped here, the one place
 * the file is read, so nothing downstream re-filters and `config list` can't disagree with
 * `account create` about what's installed.
 */
export const UnforgeConfig = z.object({
  version: z.number().default(() => CONFIG_VERSION),
  gameDirs: z
    .record(z.string(), z.string())
    .transform(
      (dirs): GameDirs => Object.fromEntries(Object.entries(dirs).filter(([r]) => isRegion(r))),
    )
    .catch({})
    .default({}),
});
export type UnforgeConfig = z.infer<typeof UnforgeConfig>;

export const CONFIG_VERSION = 1;

/** `%LOCALAPPDATA%\unforge\config.json` — the default config location (per-user). */
export function defaultConfigPath(): string {
  return unforgeDataFile("config.json");
}

function emptyConfig(): UnforgeConfig {
  return { version: CONFIG_VERSION, gameDirs: {} };
}

export interface ConfigStore {
  /** Every region with a client installed here — what `account create` and `config list` ask. */
  regions(): Region[];
  /** The dirs by region, as a copy. Mutate through {@link ConfigStore.setGameDirs}. */
  gameDirs(): GameDirs;
  /** The game-client dir for a region, or undefined. */
  gameDir(region: Region): string | undefined;
  /**
   * Set region → dir pairs. Takes several because that's what discovery produces (one install
   * root, a folder per region) and they land in a single write rather than one file rewrite each.
   */
  setGameDirs(entries: Iterable<readonly [Region, string]>): Promise<void>;
}

class FileConfigStore implements ConfigStore {
  constructor(
    private readonly path: string,
    private config: UnforgeConfig,
  ) {}

  // `filter` because `Object.keys` widens back to `string[]`; the schema already dropped non-regions.
  regions(): Region[] {
    return Object.keys(this.config.gameDirs).filter(isRegion);
  }

  gameDirs(): GameDirs {
    return { ...this.config.gameDirs };
  }

  gameDir(region: Region): string | undefined {
    return this.config.gameDirs[region];
  }

  async setGameDirs(entries: Iterable<readonly [Region, string]>): Promise<void> {
    const gameDirs = { ...this.config.gameDirs };
    for (const [region, dir] of entries) gameDirs[region] = dir;
    const next = { ...this.config, gameDirs };
    // atomicWrite's temp write creates the config dir if it's missing, so opening stays read-only.
    await atomicWrite(this.path, JSON.stringify(next, null, 2));
    // Adopted only once the write survived, so a failure can't leave memory ahead of disk.
    this.config = next;
  }
}

/** Open the config at `path` (defaults to the per-user location), loading it into memory. */
export async function openConfig(path: string = defaultConfigPath()): Promise<ConfigStore> {
  const file = Bun.file(path);
  let config = emptyConfig();
  if (await file.exists()) {
    // A hand-edited config shouldn't crash a launch — take what's well-formed, default the rest.
    config = UnforgeConfig.catch(emptyConfig()).parse(parseJson(await file.text()));
  }
  return new FileConfigStore(path, config);
}
