// GameForge's account groups paired with the regions they play in — the client's folder name, its
// `gsl.ini` `region=` key, and the `gameId.<region>` suffix `thin/codes` accepts.
//
// A table because neither side derives from the other, and why these 13:
// docs/regions.md#the-region-rule.

// `as const` so both halves become types — a new market is a one-line edit.
const REGION_BY_GROUP = {
  cz: "cs-CZ",
  de: "de-DE",
  dk: "da-DK",
  en: "en-GB",
  es: "es-ES",
  fr: "fr-FR",
  hu: "hu-HU",
  it: "it-IT",
  nl: "nl-NL",
  pl: "pl-PL",
  pt: "pt-PT",
  ro: "ro-RO",
  tr: "tr-TR",
} as const;

/** A GameForge account group, e.g. `"pt"` — the form GF reports and files accounts under. */
export type AccountGroup = keyof typeof REGION_BY_GROUP;

/** A Metin2 client region, e.g. `"pt-PT"` — the client folder, `gsl.ini`, and the `gameId` suffix. */
export type Region = (typeof REGION_BY_GROUP)[AccountGroup];

/** Written out, not inverted: `satisfies` makes a one-sided edit fail to compile. */
const GROUP_BY_REGION = {
  "cs-CZ": "cz",
  "da-DK": "dk",
  "de-DE": "de",
  "en-GB": "en",
  "es-ES": "es",
  "fr-FR": "fr",
  "hu-HU": "hu",
  "it-IT": "it",
  "nl-NL": "nl",
  "pl-PL": "pl",
  "pt-PT": "pt",
  "ro-RO": "ro",
  "tr-TR": "tr",
} as const satisfies Record<Region, AccountGroup>;

/**
 * The client region an account group plays in. Undefined for a group not in the table — the
 * answer, not a hole: `accountGroup` is GF's own data, so an unknown one must survive the lookup.
 */
export function regionForGroup(accountGroup: string): Region | undefined {
  // Widened on assignment rather than asserted at the index — an arbitrary string is the input.
  const byGroup: Record<string, Region> = REGION_BY_GROUP;
  return byGroup[accountGroup.toLowerCase()];
}

/** The account group a region belongs to — what `account create` sends, since GF files by group. */
export function groupForRegion(region: Region): AccountGroup {
  return GROUP_BY_REGION[region];
}

/** Whether a string is one of the regions Metin2 runs — the narrowing gate for outside input. */
export function isRegion(value: string): value is Region {
  // `hasOwn`, not `in`: `in` walks the prototype, so "toString" would pass as a region.
  return Object.hasOwn(GROUP_BY_REGION, value);
}

const REGIONS: readonly Region[] = Object.values(REGION_BY_GROUP).toSorted();

/** Every region Metin2 runs, ascending — the valid values for `--region`. */
export function knownRegions(): readonly Region[] {
  return REGIONS;
}

/** {@link isRegion} as an assertion, for callers that want to proceed rather than branch. */
export function assertRegion(region: string): asserts region is Region {
  if (!isRegion(region)) {
    throw new Error(`${region} is not a Metin2 region — one of: ${knownRegions().join(", ")}`);
  }
}
