import { expect, test } from "bun:test";
import { groupForRegion, isRegion, knownRegions, regionForGroup } from "./regions.ts";

test("pairs a group with the region it plays in", () => {
  expect(regionForGroup("pt")).toBe("pt-PT");
  expect(regionForGroup("tr")).toBe("tr-TR");
  expect(regionForGroup("PT")).toBe("pt-PT"); // GF's casing isn't guaranteed
});

test('never doubles the subtag — GameForge ships "en" as en-GB, not en-EN', () => {
  expect(regionForGroup("en")).toBe("en-GB");
});

test("translates the groups whose code is a country, not a language", () => {
  // GF files Danish accounts under "dk" but ships the client as Danish; same for cz/cs.
  expect(regionForGroup("dk")).toBe("da-DK");
  expect(regionForGroup("cz")).toBe("cs-CZ");
});

test("a group outside the table has no region — a missing row, not a guess", () => {
  expect(regionForGroup("zz")).toBeUndefined();
});

test("pairs a region back with the group GameForge files it under", () => {
  expect(groupForRegion("pt-PT")).toBe("pt");
  expect(groupForRegion("tr-TR")).toBe("tr");
});

test("the reverse is never the region's language subtag", () => {
  // The trap: splitting on "-" gives the language the *patcher* wants (`da`, `cs`), which is not
  // the group. Creating an account under `da` files it in a group GameForge doesn't have — and
  // the region is permanent, so there is no fixing it afterwards.
  expect(groupForRegion("da-DK")).toBe("dk");
  expect(groupForRegion("cs-CZ")).toBe("cz");
  expect(groupForRegion("en-GB")).toBe("en");
});

// A region outside the table needs no test: `groupForRegion` takes a `Region`, so `isRegion` has
// already ruled one out before the call — the check is the type, not a runtime branch.

test("isRegion accepts only the regions Metin2 runs", () => {
  expect(isRegion("pt-PT")).toBe(true);
  // Shaped like a region but not one GameForge runs, and the two codes it's easiest to confuse
  // a region with: an account group, and the client language.
  expect(isRegion("xx-XX")).toBe(false);
  expect(isRegion("pt")).toBe(false);
  expect(isRegion("da")).toBe(false);
});

test("every region round-trips through its group", () => {
  expect(knownRegions()).toHaveLength(13);
  for (const region of knownRegions()) {
    expect(regionForGroup(groupForRegion(region))).toBe(region);
  }
});
