# Regions

Five names, easy to conflate, and GameForge uses all of them. Two are full `xx-XX` tags meaning
different things; three are bare codes from **three different namespaces**. Every name here is
GameForge's own.

| Name                | Example     | What it is                                                                                                                                             |
| ------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **region**          | `pt-PT`     | **Where a game account lives.** The client folder, its `gsl.ini` `region=` key, and the `gameId` suffix. What the launcher's "Região" dropdown selects |
| **accountGroup**    | `pt`        | GameForge's own encoding of that same fact, and the only form it reports. Per account, fixed at creation                                               |
| **gfLang**          | `pt`, `all` | Which **community site** — the `<gfLang>.metin2.gameforge.com` dimension. Travels beside `accountGroup` on creation                                    |
| **client language** | `pt`, `da`  | The region's **language subtag**, which is what the patcher's `?locale=` wants. Not a group: Danish is `da`, not `dk`                                  |
| **locale**          | `en-GB`     | GameForge's **interface** language: error text, the captcha page. Per request; also stored on the GF account (`user/me`)                               |

The region and the group are **one fact in two encodings**, paired by a table read both ways
([`core/regions.ts`](../src/core/regions.ts)). `Region` and `AccountGroup` are literal unions over
that table, so the two confusable codes can't be swapped by accident.

## The region rule

**A game account belongs to one region, fixed when it is created, and can only be played there.**
That value decides both which localized client launches and which servers the account is minted
against (`gameId` = `<gameId>.<region>`). The game config states the coupling outright:
`coupledClientServerLocale: true`.

GameForge reports only the group, and the region **cannot be synthesised** from it — GF ships `en`
as `en-GB`, so doubling the subtag invents `en-EN`, which exists nowhere. Hence the table, and the
region is a lookup, never stored. A group outside it has no region and can be neither launched nor
minted; adding a row is the fix, not a fallback.

**The reverse direction needs the same table, and is the easier one to get wrong:** splitting a
region on `-` yields the _client language_ (`da-DK` → `da`), not the group (`dk`). Creating an
account under `da` files it in a group GameForge doesn't have, and the region is permanent — so
`groupForRegion` is a lookup and an unknown region is refused before the request is built.

**Whether a client is installed is a separate question**, answered from `config` at launch. A
perfectly valid account is simply not launchable on a machine without its client.

## accountGroup is not a language

The full set GameForge lists for Metin2 — the maintenance-flag response enumerates exactly these,
so the table is complete, not a sample:

```
es  ro  pl  en  it  fr  dk  pt  hu  cz  tr  nl  de
```

`dk` and `cz` are **country** codes — Danish is `da`, Czech is `cs`. So the group namespace and the
client-language namespace disagree for those two, and any code treating a group as a language is
wrong for 3 of 13 (`gr`→`el` behaves the same way but isn't among Metin2's groups).

Established by probing the patching endpoint, which answers `200` for any locale but returns an
empty file list for one that isn't real:

```
?locale=dk → {"entries":[],"totalSize":0}      ?locale=da → the full client
?locale=cz → {"entries":[],"totalSize":0}      ?locale=cs → the full client
```

The other eleven map to themselves, each verified the same way.

## gfLang is not a synonym for accountGroup

It answers "which community", not "where does this account play". The maintenance endpoint returns
`gfLang: "all"` on every row, and the subdomains GameForge serves
(`ae cz de dk en es fr gr hu it nl pl pt ro ru tr`) are a **superset** of Metin2's 13 groups. The
launcher sends the group in both fields on creation and unforge does the same — as two dimensions
that coincide, not as one value.

## Where the choice is made

Creation is the only place a region is decided, and it is permanent, so nothing is defaulted:
`--region` if given, else the sole installed client, else a picker (or `--region` required with no
terminal to ask at). The inferred case is announced rather than taken silently. It refuses both a
region GameForge doesn't run and one with no client here — an account you can't launch is not worth
creating.

Everywhere else the region is **derived at the point of use**: `storage` keeps GameForge's
`accountGroup` verbatim, and the two consumers each resolve it in one call — `regionLabel` to
render it (the single place a group becomes text) and `launchRegion` to launch into it. So no
resolved field rides along on the stored account, and a new table row takes effect on the next read
with no migration.

The `locale` alongside the group only colours GF's own error text and the captcha page, so it is
not a setting at any layer — but it is always sent, since every genuine launcher body carries one
and omitting it would make ours distinguishable.
