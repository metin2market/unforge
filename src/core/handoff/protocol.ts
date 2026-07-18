// The client handoff protocol — pure. Everything here is dictated by GameForge: the pipe name, the
// invocation, the method set, and the wire shapes. No I/O, so it's all unit-testable.
// See docs/handoff.md.

import type { GameSession, RpcRequest } from "./types.ts";

/** The pipe the launcher hosts and the client connects to. One per machine. */
export const HANDOFF_PIPE_NAME = "GameforgeClientJSONRPC";

/** Metin2's `gsl.ini` gameUuid — the client's `_TNT_CLIENT_APPLICATION_ID`. */
export const METIN2_APPLICATION_ID = "fab180a3-cd65-4b7e-bd0e-2ef77fd0c258";

export const CLIENT_EXE = "metin2client.exe";

export const pipePath = (name: string = HANDOFF_PIPE_NAME): string => `\\\\.\\pipe\\${name}`;

/** How the client is invoked: `metin2client.exe --gf`, session in the environment. */
export function buildInvocation({
  sessionId,
  applicationId = METIN2_APPLICATION_ID,
}: {
  sessionId: string;
  applicationId?: string;
}): { args: string[]; env: Record<string, string> } {
  return {
    args: ["--gf"],
    env: { _TNT_SESSION_ID: sessionId, _TNT_CLIENT_APPLICATION_ID: applicationId },
  };
}

/**
 * Split a raw stream into balanced top-level JSON objects, returning any trailing partial. The
 * client sends bare JSON with no length prefix, so a reader has to scan for balanced braces
 * (string- and escape-aware) rather than assume one object per read.
 */
export function drainJsonObjects(buf: string): { objects: string[]; rest: string } {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        objects.push(buf.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return { objects, rest: start >= 0 ? buf.slice(start) : "" };
}

/** Look up the session a call belongs to, by the `sessionId` we passed as `_TNT_SESSION_ID`. */
export type SessionLookup = (sessionId: string) => GameSession | undefined;

/** The `sessionId` a request is for, if it carries one. */
export function sessionIdOf(req: RpcRequest): string | undefined {
  const id = req.params?.sessionId;
  return typeof id === "string" ? id : undefined;
}

/**
 * The reply to one client call, or `undefined` when we have no answer (unknown method, or a call
 * for a session we don't know) — the caller then sends nothing back.
 *
 * `queryGameAccountNumericId` must answer with a JSON **number**; the rest are strings.
 */
export function answer(req: RpcRequest, lookup: SessionLookup): unknown {
  const method = (req.method ?? "").replace(/^ClientLibrary\./, "");
  if (method === "isClientRunning") return "true";

  const sessionId = sessionIdOf(req);
  if (sessionId === undefined) return undefined;
  if (method === "initSession") return sessionId;

  const session = lookup(sessionId);
  if (!session) return undefined;
  switch (method) {
    case "queryAuthorizationCode":
      return session.code;
    case "queryGameAccountName":
      return session.name;
    case "queryGameAccountNumericId":
      return session.numericId;
    default:
      return undefined;
  }
}

/** Frame a reply: the request's `id`/`jsonrpc` echoed back with the result. */
export function encodeResponse(req: RpcRequest, result: unknown): string {
  return JSON.stringify({ id: req.id, jsonrpc: req.jsonrpc ?? "2.0", result });
}
