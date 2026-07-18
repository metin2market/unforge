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
});

test("set + read per-region game dirs", async () => {
  await config.setGameDir("pt-PT", "C:/metin2/pt-PT");
  await config.setGameDir("de-DE", "C:/metin2/de-DE");

  expect(config.gameDir("pt-PT")).toBe("C:/metin2/pt-PT");
  expect(config.gameDir("de-DE")).toBe("C:/metin2/de-DE");
});

test("persists across reopen", async () => {
  await config.setGameDir("pt-PT", "C:/metin2/pt-PT");

  const reopened = await openConfig(path);
  expect(reopened.gameDir("pt-PT")).toBe("C:/metin2/pt-PT");
});
