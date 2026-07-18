import { describe, expect, test } from "bun:test";
import { buildSessionRequest } from "./sessions.ts";
import { buildAccountsRequest } from "./accounts.ts";
import { buildAttestRequest } from "./iovation.ts";
import { buildCreateAccountRequest, METIN2_GAME_ID } from "./create-account.ts";
import { buildCodeRequest } from "./codes.ts";
import type { GameAccount } from "../types.ts";

// Structural contract of each Spark request, asserted against synthetic inputs
// (no secrets, CI-safe). The byte-for-byte match against a *real* launcher
// request lives in requests.capture.test.ts, which runs only where the captures
// exist. These pin the shape rules the protocol depends on.

const INSTALL = "5814f474-9054-4215-99fe-9a30baf46370"; // any UUID with a digit
const TOKEN = "e4839df5-7906-4450-badc-46c0df84af31";
const BB = "tra:AAAAExampleRawBlackbox";

const account: GameAccount = {
  id: "abcd1234-0000-0000-0000-000000000000",
  accountNumericId: 109411749,
  displayName: "test",
  usernames: ["test"],
  gameId: METIN2_GAME_ID,
  gameName: "metin2",
};

describe("buildSessionRequest", () => {
  test("POSTs v2 credentials/sessions with both installation-id headers + Origin", () => {
    const req = buildSessionRequest({
      email: "a@b.c",
      password: "pw",
      blackbox: BB,
      installationId: INSTALL,
    });
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://spark.gameforge.com/api/v2/authProviders/credentials/sessions");
    expect(req.headers["TNT-Installation-Id"]).toBe(INSTALL);
    expect(req.headers["gf-installation-id"]).toBe(INSTALL);
    expect(req.headers["Origin"]).toBe("spark://www.gameforge.com");
    expect(JSON.parse(req.body!)).toEqual({
      email: "a@b.c",
      password: "pw",
      locale: "en-GB",
      blackbox: BB,
    });
  });

  test("locale defaults to en-GB (hyphen form GF requires) and is overridable", () => {
    const dflt = JSON.parse(
      buildSessionRequest({
        email: "a@b.c",
        password: "pw",
        blackbox: BB,
        installationId: INSTALL,
      }).body!,
    );
    expect(dflt.locale).toBe("en-GB");
    const pt = JSON.parse(
      buildSessionRequest({
        email: "a@b.c",
        password: "pw",
        blackbox: BB,
        installationId: INSTALL,
        locale: "pt-PT",
      }).body!,
    );
    expect(pt.locale).toBe("pt-PT");
  });
});

describe("buildAccountsRequest", () => {
  test("GETs user/accounts with the bearer token, no body", () => {
    const req = buildAccountsRequest(TOKEN, INSTALL);
    expect(req.method).toBe("GET");
    expect(req.url).toBe("https://spark.gameforge.com/api/v1/user/accounts");
    expect(req.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(req.headers["TNT-Installation-Id"]).toBe(INSTALL);
    expect(req.body).toBeUndefined();
  });
});

describe("buildAttestRequest", () => {
  test("POSTs iovation with type play_now + the tra: blackbox", () => {
    const req = buildAttestRequest({
      token: TOKEN,
      installationId: INSTALL,
      accountId: account.id,
      blackbox: BB,
    });
    expect(req.url).toBe("https://spark.gameforge.com/api/v1/auth/iovation");
    expect(req.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(req.body!)).toEqual({
      accountId: account.id,
      blackbox: BB,
      type: "play_now",
    });
  });
});

describe("buildCreateAccountRequest", () => {
  test("POSTs v2 users/me/accounts; Metin2 ids + pt defaults", () => {
    const req = buildCreateAccountRequest({
      token: TOKEN,
      installationId: INSTALL,
      displayName: "alt1",
      blackbox: BB,
    });
    expect(req.url).toBe("https://spark.gameforge.com/api/v2/users/me/accounts");
    const body = JSON.parse(req.body!);
    expect(body.gameId).toBe(METIN2_GAME_ID);
    expect(body.gfLang).toBe("pt");
    expect(body.accountGroup).toBe("pt");
    expect(body.blackbox).toBe(BB);
  });
});

describe("buildCodeRequest", () => {
  const base = {
    token: TOKEN,
    account,
    installationId: INSTALL,
    clientVersion: { version: "2.8.5.1959", branch: "master", commitId: "eda2b413" },
    certificatePem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
    sessionId: "4f6b7f5a-ffcf-419a-a7be-f32422f7c1af",
    rawBlackbox: BB,
    region: "pt-PT",
    gsid: "4f6b7f5a-ffcf-419a-a7be-f32422f7c1af-5487",
  };

  test("gameId is <gameId>.<region>; gsid + account id echo through", () => {
    const body = JSON.parse(buildCodeRequest(base).body!);
    expect(body.gameId).toBe(`${METIN2_GAME_ID}.pt-PT`);
    expect(body.gsid).toBe(base.gsid);
    expect(body.platformGameAccountId).toBe(account.id);
  });

  test("carries the account-hash User-Agent (Chrome/C<version> (<hash>))", () => {
    const req = buildCodeRequest(base);
    expect(req.headers["User-Agent"]).toMatch(/^Chrome\/C2\.8\.5\.1959 \([0-9a-f]{10}\)$/);
  });

  test("sends NO Origin header (unlike every other step)", () => {
    const req = buildCodeRequest(base);
    expect(req.headers["Origin"]).toBeUndefined();
    expect("Origin" in req.headers).toBe(false);
  });

  test("blackbox is encrypted (not the raw tra:) and bound to the gsid", () => {
    const body = JSON.parse(buildCodeRequest(base).body!);
    expect(body.blackbox).not.toBe(BB);
    expect(body.blackbox.startsWith("tra:")).toBe(false);
    // A different gsid yields different ciphertext (key = sha512(gsid-account)).
    const other = JSON.parse(buildCodeRequest({ ...base, gsid: `${base.sessionId}-0000` }).body!);
    expect(other.blackbox).not.toBe(body.blackbox);
  });
});
