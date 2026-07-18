import type { LoginCode } from "../types.ts";

/** What the client asks for once it connects — everything needed to log one account in. */
export interface GameSession {
  /** The one-time `thin/codes` login code. */
  code: LoginCode;
  /** The game account's name — `displayName` (`usernames[]` is typically empty). */
  name: string;
  /** `accountNumericId` from `user/accounts` — distinct from the account's UUID `id`. */
  numericId: number;
}

/** A JSON-RPC call from the client. */
export interface RpcRequest {
  id?: unknown;
  jsonrpc?: string;
  method?: string;
  params?: Record<string, unknown>;
}
