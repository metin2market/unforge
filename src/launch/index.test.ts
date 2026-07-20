import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildElevatedCommand,
  discoverGameDirs,
  expandHome,
  findClientDir,
  findClientDirAnywhere,
  spawnClient,
} from "./index.ts";

test("spawnClient rejects a bogus dir rather than spawning", () => {
  // On Windows spawning a non-existent exe throws; elsewhere the platform guard does. Either
  // way a bogus dir must reject rather than silently spawn.
  expect(spawnClient({ dir: "C:/does/not/exist", sessionId: "s-1" })).rejects.toThrow();
});

describe("buildElevatedCommand", () => {
  // Decode the base64 `-EncodedCommand` (UTF-16LE) back to the inner PowerShell script.
  const decodeInner = (cmd: string): string => {
    const b64 = /-EncodedCommand','([^']+)'/.exec(cmd)?.[1] ?? "";
    return Buffer.from(b64, "base64").toString("utf16le");
  };

  test("elevates a PowerShell that sets the env THEN launches the client", () => {
    const cmd = buildElevatedCommand("C:\\game\\metin2client.exe", ["--gf"], "C:\\game", {
      _TNT_SESSION_ID: "sess-123",
      _TNT_CLIENT_APPLICATION_ID: "app-9",
    });
    // Outer command elevates powershell, not the client directly (so env survives the UAC boundary).
    expect(cmd).toContain("-Verb RunAs");
    expect(cmd).toContain("-FilePath 'powershell.exe'");

    const inner = decodeInner(cmd);
    // The session env is set...
    expect(inner).toContain("$env:_TNT_SESSION_ID='sess-123'");
    expect(inner).toContain("$env:_TNT_CLIENT_APPLICATION_ID='app-9'");
    // ...before the client is launched (order matters — the child inherits it).
    expect(inner.indexOf("_TNT_SESSION_ID")).toBeLessThan(inner.indexOf("Start-Process -FilePath"));
    expect(inner).toContain("-FilePath 'C:\\game\\metin2client.exe'");
    expect(inner).toContain("-ArgumentList '--gf'");
  });

  test("escapes single quotes in paths", () => {
    const cmd = buildElevatedCommand("C:\\o'brien\\metin2client.exe", [], "C:\\o'brien", {});
    expect(decodeInner(cmd)).toContain("'C:\\o''brien\\metin2client.exe'");
  });
});

test("expandHome expands a leading ~", () => {
  expect(expandHome("~/Desktop/metin2")).toBe(join(homedir(), "Desktop", "metin2"));
  expect(expandHome("~")).toBe(homedir());
  expect(expandHome("C:/already/absolute")).toBe("C:/already/absolute");
});

describe("findClientDir", () => {
  let dir: string;
  const exe = "metin2client.exe";
  const touch = (...parts: string[]): void => {
    const p = join(dir, ...parts);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "");
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "unforge-gamedir-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("finds the exe directly in the given dir", () => {
    touch(exe);
    expect(findClientDir(dir, "pt-PT")).toBe(dir);
  });

  test("finds the exe in a region subfolder", () => {
    touch("pt-PT", exe);
    expect(findClientDir(dir, "pt-PT")).toBe(join(dir, "pt-PT"));
  });

  test("finds the exe nested deeper via search", () => {
    touch("game", "client", "bin", exe);
    expect(findClientDir(dir, "pt-PT")).toBe(join(dir, "game", "client", "bin"));
  });

  test("prefers the region-matching path when several clients exist", () => {
    touch("de-DE", exe);
    touch("pt-PT", exe);
    expect(findClientDir(dir, "pt-PT")).toBe(join(dir, "pt-PT"));
    // The point of requiring a region: the same tree resolves differently per account.
    expect(findClientDir(dir, "de-DE")).toBe(join(dir, "de-DE"));
  });

  test("throws when no client is found", () => {
    mkdirSync(join(dir, "empty"), { recursive: true });
    expect(() => findClientDir(dir, "pt-PT")).toThrow(/not found/);
  });

  test("throws when the dir does not exist", () => {
    expect(() => findClientDir(join(dir, "nope"), "pt-PT")).toThrow(/does not exist/);
  });

  test("findClientDirAnywhere takes the shallowest hit when no region is known", () => {
    touch("game", "client", "bin", exe);
    expect(findClientDirAnywhere(dir)).toBe(join(dir, "game", "client", "bin"));
  });

  test("discoverGameDirs fills every region folder under the root", () => {
    touch("pt-PT", exe);
    touch("en-GB", exe);
    const found = discoverGameDirs(dir);
    expect(found.map((f) => f.region).toSorted((a, b) => (a ?? "").localeCompare(b ?? ""))).toEqual(
      ["en-GB", "pt-PT"],
    );
    expect(found.find((f) => f.region === "pt-PT")?.dir).toBe(join(dir, "pt-PT"));
  });

  test("discoverGameDirs fills siblings even when pointed at one region dir", () => {
    touch("pt-PT", exe);
    touch("en-GB", exe);
    // Pointing at a region dir scans its parent, so both regions are still filled.
    const found = discoverGameDirs(join(dir, "pt-PT"));
    expect(found.map((f) => f.region).toSorted((a, b) => (a ?? "").localeCompare(b ?? ""))).toEqual(
      ["en-GB", "pt-PT"],
    );
  });

  test("discoverGameDirs infers no region for a non-region folder", () => {
    touch("client", exe);
    const found = discoverGameDirs(join(dir, "client"));
    expect(found).toHaveLength(1);
    // The caller has to supply one; `config set game-dir` errors if it can't.
    expect(found[0].region).toBeUndefined();
    expect(found[0].dir).toBe(join(dir, "client"));
  });
});
