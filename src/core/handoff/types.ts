import type { LoginCode } from "../types.ts";

/**
 * What answers the pipe for one account. The pipe's `sessionId` is a separate thing
 * (the launch's key on the pipe).
 */
export interface LaunchTicket {
  /** A `thin/codes` code, minted per call: it's one-time and the client asks on every entry. */
  mintCode(): Promise<LoginCode>;
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
