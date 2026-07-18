import { expect, test } from "bun:test";
import { PipeInUseError } from "../core/index.ts";
import { createHandoffServer } from "./handoff-server.ts";
import type { LaunchTicket } from "../core/handoff/index.ts";

const onWindows = process.platform === "win32";
const session: LaunchTicket = { code: "c-1", name: "acct", numericId: 1 };
const uniquePipe = (): string => `unforge-test-${crypto.randomUUID()}`;

// Named pipes are a Windows thing; the handoff is Windows-only.
test.skipIf(!onWindows)(
  "a pipe already in use throws PipeInUseError, not a raw listen error",
  async () => {
    const pipeName = uniquePipe();
    const first = await createHandoffServer({ pipeName });
    try {
      // Bun reports this as ERR_INVALID_ARG_TYPE with "Failed to listen at …" — not EADDRINUSE — so
      // a code-only check leaks a bare error instead of "close the GameForge launcher".
      expect(createHandoffServer({ pipeName })).rejects.toBeInstanceOf(PipeInUseError);
    } finally {
      await first.close();
    }
  },
);

test.skipIf(!onWindows)(
  "register hands back a distinct sessionId per launch, release drops it",
  async () => {
    const server = await createHandoffServer({ pipeName: uniquePipe() });
    try {
      const a = server.register(session);
      const b = server.register({ ...session, name: "other" });
      expect(a).not.toBe(b);
      expect(server.pending).toBe(2);

      server.release(a);
      expect(server.pending).toBe(1);
    } finally {
      await server.close();
    }
  },
);

test.skipIf(!onWindows)("closing frees the pipe for the next owner", async () => {
  const pipeName = uniquePipe();
  await (await createHandoffServer({ pipeName })).close();
  const second = await createHandoffServer({ pipeName });
  await second.close();
});
