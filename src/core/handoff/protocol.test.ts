import { describe, expect, test } from "bun:test";
import {
  answerRpc,
  buildInvocation,
  drainJsonObjects,
  encodeResponse,
  METIN2_APPLICATION_ID,
  pipePath,
  sessionIdOf,
} from "./protocol.ts";
import type { LaunchTicket } from "./types.ts";

const SID = "dc7ecd9b-b350-4ba7-9a9b-b0d55d6c5a4d";
const CODE = "ba4ed5d8-4b98-4385-b21b-5bbf87deb1a4";
const session: LaunchTicket = {
  mintCode: () => Promise.resolve(CODE),
  name: "unclear_xyz",
  numericId: 109411749,
};
const lookup = (id: string): LaunchTicket | undefined => (id === SID ? session : undefined);
const call = (method: string, sessionId: string | undefined = SID) => ({
  id: 1,
  jsonrpc: "2.0",
  method,
  ...(sessionId === undefined ? {} : { params: { sessionId } }),
});

describe("buildInvocation", () => {
  test("is `--gf` with the session in the environment, not the argv", () => {
    const { args, env } = buildInvocation({ sessionId: SID });
    expect(args).toEqual(["--gf"]);
    expect(env._TNT_SESSION_ID).toBe(SID);
    expect(env._TNT_CLIENT_APPLICATION_ID).toBe(METIN2_APPLICATION_ID);
    expect(args.join(" ")).not.toContain(SID);
  });
});

test("pipePath is the Windows named-pipe form", () => {
  expect(pipePath()).toBe("\\\\.\\pipe\\GameforgeClientJSONRPC");
});

describe("answerRpc", () => {
  test("initSession echoes the sessionId back, without needing a registered session", async () => {
    expect(await answerRpc(call("ClientLibrary.initSession"), () => undefined)).toBe(SID);
  });

  test("queryAuthorizationCode returns the login code", async () => {
    expect(await answerRpc(call("ClientLibrary.queryAuthorizationCode"), lookup)).toBe(CODE);
  });

  test("queryAuthorizationCode mints per call — a re-entry never gets a spent code", async () => {
    const minted: string[] = [];
    let n = 0;
    const reMinting: LaunchTicket = {
      mintCode: () => Promise.resolve(`code-${++n}`),
      name: "unclear_xyz",
      numericId: 1,
    };
    for (let i = 0; i < 3; i++) {
      minted.push((await answerRpc(call("queryAuthorizationCode"), () => reMinting)) as string);
    }
    expect(minted).toEqual(["code-1", "code-2", "code-3"]);
    expect(new Set(minted).size).toBe(3);
  });

  test("only queryAuthorizationCode mints — the other answers are static", async () => {
    let mints = 0;
    const counting: LaunchTicket = {
      mintCode: () => Promise.resolve(`code-${++mints}`),
      name: "unclear_xyz",
      numericId: 1,
    };
    await answerRpc(call("queryGameAccountName"), () => counting);
    await answerRpc(call("queryGameAccountNumericId"), () => counting);
    await answerRpc(call("initSession"), () => counting);
    expect(mints).toBe(0);
  });

  test("queryGameAccountName returns the account name", async () => {
    expect(await answerRpc(call("ClientLibrary.queryGameAccountName"), lookup)).toBe("unclear_xyz");
  });

  test("queryGameAccountNumericId returns a number, not a string", async () => {
    const result = await answerRpc(call("ClientLibrary.queryGameAccountNumericId"), lookup);
    expect(result).toBe(109411749);
    expect(typeof result).toBe("number");
  });

  test("isClientRunning needs no session", async () => {
    expect(await answerRpc({ method: "ClientLibrary.isClientRunning" }, () => undefined)).toBe(
      "true",
    );
  });

  test("accepts methods without the ClientLibrary prefix", async () => {
    expect(await answerRpc(call("queryAuthorizationCode"), lookup)).toBe(CODE);
  });

  test("multiplexes: each session gets its own answers", async () => {
    const other: LaunchTicket = {
      mintCode: () => Promise.resolve("other-code"),
      name: "other",
      numericId: 42,
    };
    const two = (id: string): LaunchTicket | undefined =>
      id === SID ? session : id === "sid-2" ? other : undefined;
    expect(await answerRpc(call("queryAuthorizationCode", SID), two)).toBe(CODE);
    expect(await answerRpc(call("queryAuthorizationCode", "sid-2"), two)).toBe("other-code");
  });

  test("no answerRpc for an unknown session, an unknown method, or a missing sessionId", async () => {
    expect(await answerRpc(call("queryAuthorizationCode", "nope"), lookup)).toBeUndefined();
    expect(await answerRpc(call("ClientLibrary.whoKnows"), lookup)).toBeUndefined();
    expect(
      await answerRpc({ id: 1, method: "ClientLibrary.queryAuthorizationCode" }, lookup),
    ).toBeUndefined();
  });
});

test("sessionIdOf ignores a non-string sessionId", () => {
  expect(sessionIdOf({ method: "x", params: { sessionId: 7 } })).toBeUndefined();
});

test("encodeResponse echoes id and jsonrpc", () => {
  expect(JSON.parse(encodeResponse(call("initSession"), SID))).toEqual({
    id: 1,
    jsonrpc: "2.0",
    result: SID,
  });
});

describe("drainJsonObjects", () => {
  test("splits concatenated objects with no framing", () => {
    const { objects, rest } = drainJsonObjects('{"a":1}{"b":2}');
    expect(objects).toEqual(['{"a":1}', '{"b":2}']);
    expect(rest).toBe("");
  });

  test("holds a partial object back as `rest` until the remainder arrives", () => {
    const first = drainJsonObjects('{"a":1}{"b":');
    expect(first.objects).toEqual(['{"a":1}']);
    expect(first.rest).toBe('{"b":');

    const second = drainJsonObjects(first.rest + "2}");
    expect(second.objects).toEqual(['{"b":2}']);
    expect(second.rest).toBe("");
  });

  test("braces inside strings and escapes don't split an object", () => {
    const raw = '{"s":"}{ \\" }"}';
    expect(drainJsonObjects(raw).objects).toEqual([raw]);
  });

  test("a real initSession frame round-trips", () => {
    const raw = `{"id":1,"jsonrpc":"2.0","method":"ClientLibrary.initSession","params":{"sessionId":"${SID}"}}`;
    const { objects } = drainJsonObjects(raw);
    expect(objects).toHaveLength(1);
    expect(sessionIdOf(JSON.parse(objects[0]))).toBe(SID);
  });
});
