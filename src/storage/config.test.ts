import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openConfig, type ConfigStore } from "./config.ts";

let dir: string;
let path: string;
let config: ConfigStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "unforge-config-"));
  path = join(dir, "config.json");
  config = await openConfig(path);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("empty by default", () => {
  expect(config.gameDir("pt-PT")).toBeUndefined();
  expect(config.regions()).toEqual([]);
});

test("set + read per-region game dirs, in one write", async () => {
  await config.setGameDirs([
    ["pt-PT", "C:/metin2/pt-PT"],
    ["de-DE", "C:/metin2/de-DE"],
  ]);

  expect(config.gameDir("pt-PT")).toBe("C:/metin2/pt-PT");
  expect(config.gameDir("de-DE")).toBe("C:/metin2/de-DE");
  expect(config.regions().toSorted()).toEqual(["de-DE", "pt-PT"]);
});

test("persists across reopen", async () => {
  await config.setGameDirs([["pt-PT", "C:/metin2/pt-PT"]]);

  const reopened = await openConfig(path);
  expect(reopened.gameDir("pt-PT")).toBe("C:/metin2/pt-PT");
});

// The file is hand-editable, so a key that isn't a region is dropped at the read rather than
// carried and re-filtered downstream — otherwise `config list` shows an install that `account
// create` can't see.
test("a hand-edited key that isn't a region is dropped on load", async () => {
  await Bun.write(
    path,
    JSON.stringify({ version: 1, gameDirs: { "pt-PT": "C:/m/pt", pt_PT: "C:/m/junk" } }),
  );

  const reopened = await openConfig(path);
  expect(reopened.regions()).toEqual(["pt-PT"]);
  expect(reopened.gameDirs()).toEqual({ "pt-PT": "C:/m/pt" });
});
