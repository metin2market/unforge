import { describe, expect, test } from "bun:test";
import {
  answer,
  buildInvocation,
  drainJsonObjects,
  encodeResponse,
  METIN2_APPLICATION_ID,
  pipePath,
  sessionIdOf,
} from "./protocol.ts";
import type { GameSession } from "./types.ts";

const SID = "dc7ecd9b-b350-4ba7-9a9b-b0d55d6c5a4d";
const session: GameSession = {
  code: "ba4ed5d8-4b98-4385-b21b-5bbf87deb1a4",
  name: "unclear_xyz",
  numericId: 109411749,
};
const lookup = (id: string): GameSession | undefined => (id === SID ? session : undefined);
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

describe("answer", () => {
  test("initSession echoes the sessionId back, without needing a registered session", () => {
    expect(answer(call("ClientLibrary.initSession"), () => undefined)).toBe(SID);
  });

  test("queryAuthorizationCode returns the login code", () => {
    expect(answer(call("ClientLibrary.queryAuthorizationCode"), lookup)).toBe(session.code);
  });

  test("queryGameAccountName returns the account name", () => {
    expect(answer(call("ClientLibrary.queryGameAccountName"), lookup)).toBe("unclear_xyz");
  });

  test("queryGameAccountNumericId returns a number, not a string", () => {
    const result = answer(call("ClientLibrary.queryGameAccountNumericId"), lookup);
    expect(result).toBe(109411749);
    expect(typeof result).toBe("number");
  });

  test("isClientRunning needs no session", () => {
    expect(answer({ method: "ClientLibrary.isClientRunning" }, () => undefined)).toBe("true");
  });

  test("accepts methods without the ClientLibrary prefix", () => {
    expect(answer(call("queryAuthorizationCode"), lookup)).toBe(session.code);
  });

  test("multiplexes: each session gets its own answers", () => {
    const other: GameSession = { code: "other-code", name: "other", numericId: 42 };
    const two = (id: string): GameSession | undefined =>
      id === SID ? session : id === "sid-2" ? other : undefined;
    expect(answer(call("queryAuthorizationCode", SID), two)).toBe(session.code);
    expect(answer(call("queryAuthorizationCode", "sid-2"), two)).toBe("other-code");
  });

  test("no answer for an unknown session, an unknown method, or a missing sessionId", () => {
    expect(answer(call("queryAuthorizationCode", "nope"), lookup)).toBeUndefined();
    expect(answer(call("ClientLibrary.whoKnows"), lookup)).toBeUndefined();
    expect(
      answer({ id: 1, method: "ClientLibrary.queryAuthorizationCode" }, lookup),
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
    expect(sessionIdOf(JSON.parse(objects[0]!))).toBe(SID);
  });
});
