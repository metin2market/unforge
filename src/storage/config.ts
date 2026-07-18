// unforge config — machine-level settings that are NOT per account: the game-client dir
// per region (genuinely machine-specific — where you installed the client). Not a secret
// (just filesystem paths), so this is a plain JSON file — **no DPAPI seal**, unlike its sibling
// the account store. The cert is not configured here: it's bundled (see src/core/cert.ts).
//
// One install, set once: `unforge config set game-dir … --region`.

import { z } from "zod";
import { parseJson } from "../util/index.ts";
import { atomicWrite } from "./atomic-write.ts";
import { unforgeDataFile } from "./paths.ts";

/**
 * The persisted machine-level config. `version` lets the shape evolve in code, so it is read
 * back rather than re-stamped. Both fields default: this file is hand-editable and holds only
 * paths, so a malformed one costs a re-run of `config set`, not an account — losing a bad entry
 * beats refusing to launch. (The account store takes the opposite line, and should.)
 */
export const UnforgeConfig = z.object({
  version: z.number().default(() => CONFIG_VERSION),
  /** Region → game-client dir (holds `metin2client.exe`), e.g. `{ "pt-PT": "C:/…/pt-PT" }`. */
  gameDirs: z.record(z.string(), z.string()).catch({}).default({}),
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
  /** The whole config (a copy). */
  get(): UnforgeConfig;
  /** The game-client dir for a region, or undefined. */
  gameDir(region: string): string | undefined;
  /** Set the game-client dir for a region. */
  setGameDir(region: string, dir: string): Promise<void>;
}

class FileConfigStore implements ConfigStore {
  constructor(
    private readonly path: string,
    private config: UnforgeConfig,
  ) {}

  get(): UnforgeConfig {
    return structuredClone(this.config);
  }

  gameDir(region: string): string | undefined {
    return this.config.gameDirs[region];
  }

  private async save(): Promise<void> {
    // atomicWrite's temp write creates the config dir if it's missing, so opening stays read-only.
    await atomicWrite(this.path, JSON.stringify(this.config, null, 2));
  }

  async setGameDir(region: string, dir: string): Promise<void> {
    this.config.gameDirs[region] = dir;
    await this.save();
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
