// The client handoff protocol — pure. Everything here is dictated by GameForge: the pipe name, the
// invocation, the method set, and the wire shapes. No I/O of its own (the mint is injected via the
// ticket), so it's all unit-testable.
// See docs/launch.md.

import type { LaunchTicket, RpcRequest } from "./types.ts";

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
    const c = buf[i];
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

/** The `sessionId` a request is for, if it carries one. */
export function sessionIdOf(req: RpcRequest): string | undefined {
  const id = req.params?.sessionId;
  return typeof id === "string" ? id : undefined;
}

/**
 * A method name without the client's `ClientLibrary.` namespace, which it sends on some calls and
 * omits on others. GameForge's convention, so it's stated here — anyone matching on a method name
 * off the pipe goes through this rather than re-deriving the prefix.
 */
export function bareMethod(method: string | undefined): string {
  return (method ?? "").replace(/^ClientLibrary\./, "");
}

/**
 * The reply to one client call, or `undefined` when we have no answer (unknown method, or a call
 * for a launch we don't know) — the caller then sends nothing back.
 *
 * `queryAuthorizationCode` mints a fresh code on every call.
 *
 * `queryGameAccountNumericId` must answer with a JSON **number**; the rest are strings.
 */
export async function answerRpc(
  req: RpcRequest,
  lookup: (sessionId: string) => LaunchTicket | undefined,
): Promise<unknown> {
  const method = bareMethod(req.method);
  if (method === "isClientRunning") return "true";

  const sessionId = sessionIdOf(req);
  if (sessionId === undefined) return undefined;
  if (method === "initSession") return sessionId;

  const ticket = lookup(sessionId);
  if (!ticket) return undefined;
  switch (method) {
    case "queryAuthorizationCode":
      return await ticket.mintCode();
    case "queryGameAccountName":
      return ticket.name;
    case "queryGameAccountNumericId":
      return ticket.numericId;
    default:
      return undefined;
  }
}

/** Frame a reply: the request's `id`/`jsonrpc` echoed back with the result. */
export function encodeResponse(req: RpcRequest, result: unknown): string {
  return JSON.stringify({ id: req.id, jsonrpc: req.jsonrpc ?? "2.0", result });
}
