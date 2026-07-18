import type { LoginCode } from "../types.ts";

/**
 * What the client asks for once it connects — everything needed to log one account in.
 * Not a session: it's a one-time credential bundle, spent on the account. The pipe's
 * `sessionId` is a separate thing (the launch's key on the pipe).
 */
export interface LaunchTicket {
  /** The one-time `thin/codes` login code. */
  code: LoginCode;
  /** The game account's name — `displayName` (`usernames[]` is typically empty). */
  name: string;
  /** `numericId` from `user/accounts` — distinct from the account's UUID `id`. */
  numericId: number;
}

/** A JSON-RPC call from the client. */
export interface RpcRequest {
  id?: unknown;
  jsonrpc?: string;
  method?: string;
  params?: Record<string, unknown>;
}
