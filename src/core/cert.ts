// The launcher's client certificate — an input to the `thin/codes` account hash
// (docs/protocol.md → Certificate). Imported as text so it inlines into the compiled binary.

import pem from "./gameforge-cert.pem" with { type: "text" };

export const GAMEFORGE_CERT_PEM: string = pem;
