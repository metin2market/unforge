import { afterEach, expect, test } from "bun:test";
import { configure, type LogRecord } from "@logtape/logtape";
import { installFetchTrace } from "./trace.ts";

const originalFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await configure({ reset: true, sinks: {}, loggers: [] });
});

/** Configure a single capturing sink, the way the file sink would receive records. */
async function captureRecords(): Promise<LogRecord[]> {
  const records: LogRecord[] = [];
  await configure({
    reset: true,
    sinks: { capture: (record) => records.push(record) },
    loggers: [
      { category: ["unforge"], lowestLevel: "trace", sinks: ["capture"] },
      { category: ["logtape", "meta"], lowestLevel: "warning", sinks: [] },
    ],
  });
  return records;
}

test("logs each request/response at trace level and restores fetch", async () => {
  const records = await captureRecords();

  const mockFetch = (async () =>
    new Response(JSON.stringify({ token: "eyJ.secret.value" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  globalThis.fetch = mockFetch;

  const restore = installFetchTrace();
  // Installing swaps fetch for the tracing wrapper, not the mock.
  expect(globalThis.fetch).not.toBe(mockFetch);
  const res = await fetch("https://spark.gameforge.com/api/v2/users", {
    method: "POST",
    headers: { "TNT-Installation-Id": "inst-1" },
    body: JSON.stringify({ email: "a@b.c", password: "hunter2", blackbox: "tra:AbC" }),
  });
  // The wrapped fetch still returns a readable body (clone, not consume).
  expect(await res.json()).toEqual({ token: "eyJ.secret.value" });
  restore();
  expect(globalThis.fetch).toBe(mockFetch);

  expect(records).toHaveLength(2);
  const [sent, received] = records;
  expect(sent.level).toBe("trace");
  expect(received.level).toBe("trace");
  expect(sent.category).toEqual(["unforge", "http"]);

  expect(sent.properties.method).toBe("POST");
  expect(sent.properties.url).toBe("https://spark.gameforge.com/api/v2/users");
  expect(JSON.parse(sent.properties.headers as string)["tnt-installation-id"]).toBe("inst-1");
  expect(received.properties.status).toBe(201);
  expect(typeof received.properties.ms).toBe("number");

  // Scrubbed on the way in: credentials masked, protocol material intact.
  const reqBody = JSON.parse(sent.properties.body as string);
  expect(reqBody.password).toBe("«password»");
  expect(reqBody.blackbox).toBe("tra:AbC");
  const resBody = JSON.parse(received.properties.body as string);
  expect(resBody.token).not.toContain("secret");
});

test("the request is logged before the response, so a hung call still leaves a mark", async () => {
  const records = await captureRecords();

  globalThis.fetch = (async () => {
    // The request record must already exist while the call is still in flight.
    expect(records).toHaveLength(1);
    throw new Error("connection reset");
  }) as unknown as typeof fetch;

  const restore = installFetchTrace();
  await expect(fetch("https://spark.gameforge.com/api/v2/users")).rejects.toThrow(
    "connection reset",
  );
  restore();

  expect(records).toHaveLength(1);
  expect(records[0].message.join("")).toContain("→");
});
