// Runner for ssl-capture.js: spawn gfclient.exe under Frida, load the SSL tap, and
// stream every decrypted frame to scripts/captures/frida-<ts>.jsonl. Then log in +
// click Play in the launcher as usual — this records the pinned traffic (events2 et
// al.) mitmproxy can't see. Ctrl+C to stop. See docs/capturing-traffic.md.
//
//   cd scripts/frida && bun install && bun capture-ssl.ts
//   bun capture-ssl.ts --dry     # verify Frida loads + the launcher path, no launch
//
// Pair it with a normal `scripts/capture.cmd` run (mitmproxy) in parallel: mitmproxy
// gives the readable CEF/spark flow + the full host map (http_connect), Frida gives
// the pinned-layer plaintext. Together = total visibility of one launcher login.

import frida from "frida";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const GFCLIENT = "C:\\Program Files (x86)\\GameforgeClient\\gfclient.exe";
const AGENT = join(import.meta.dir, "ssl-capture.js");
const dry = Bun.argv.includes("--dry");

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
const outFile = join(import.meta.dir, "..", "captures", `frida-${stamp}.jsonl`);
mkdirSync(dirname(outFile), { recursive: true });

// Keep only printable ASCII for a quick eyeball preview; the full bytes live in b64.
const printable = (buf: Buffer) =>
  [...buf.subarray(0, 400)]
    .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
    .join("");

const device = await frida.getLocalDevice();
console.log(`frida ${frida.version ?? ""} — device: ${device.name}`);

if (dry) {
  const exists = await Bun.file(GFCLIENT).exists();
  console.log(`launcher path exists: ${exists} (${GFCLIENT})`);
  console.log(`agent: ${AGENT}`);
  console.log("dry run ok — Frida binding loaded. Run without --dry to spawn + capture.");
  process.exit(0);
}

console.log("spawning launcher (suspended) …");
const pid = await device.spawn([GFCLIENT]);
const session = await device.attach(pid);
const script = await session.createScript(await Bun.file(AGENT).text());

let frames = 0;
script.message.connect((message: any, data: Buffer | null) => {
  if (message.type === "error") {
    console.error("agent error:", message.description);
    return;
  }
  const p = message.payload;
  if (p?.t === "ready") {
    console.log("SSL tap ready:", JSON.stringify(p.hooked));
    return;
  }
  if (p?.t === "ssl" && data) {
    frames++;
    const rec = {
      time: new Date().toISOString().slice(11, 19),
      dir: p.dir,
      peer: p.peer,
      len: p.len,
      text: printable(data),
      b64: data.toString("base64"),
    };
    appendFileSync(outFile, JSON.stringify(rec) + "\n");
    if (frames % 20 === 0) process.stdout.write(`\r  ${frames} frames captured …`);
  }
});

await script.load();
await device.resume(pid);
console.log(`\n  Capturing → ${outFile}`);
console.log("  Log OUT, log in fresh (email+password), click Play. Ctrl+C when done.\n");

const stop = async () => {
  console.log(`\n  Stopping — ${frames} frames → ${outFile}`);
  try {
    await script.unload();
  } catch {}
  try {
    await session.detach();
  } catch {}
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => {}); // run until Ctrl+C
