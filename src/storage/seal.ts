// At-rest sealing of secret columns via Windows DPAPI (CurrentUser scope). The key
// is machine+user-bound and OS-managed — no key held here, no passphrase, works
// unattended. Defeats file theft / backup / accidental commit; does NOT defeat a
// live box compromised as the same user. Rationale + threat model: docs/storage.md.
//
// Reached through Windows PowerShell (ProtectedData lives in the full .NET Framework;
// pwsh 7 / .NET Core doesn't ship it). Secrets cross the process boundary over stdin
// as base64, never on argv (argv is world-visible via Win32_Process and leaks to logs).

const PROTECT = `
Add-Type -AssemblyName System.Security
$in = [Convert]::FromBase64String([Console]::In.ReadToEnd())
$out = [Security.Cryptography.ProtectedData]::Protect($in, $null, 'CurrentUser')
[Console]::Out.Write([Convert]::ToBase64String($out))`;

const UNPROTECT = `
Add-Type -AssemblyName System.Security
$in = [Convert]::FromBase64String([Console]::In.ReadToEnd())
$out = [Security.Cryptography.ProtectedData]::Unprotect($in, $null, 'CurrentUser')
[Console]::Out.Write([Convert]::ToBase64String($out))`;

async function dpapi(script: string, input: Uint8Array): Promise<Buffer> {
  // The script is passed base64 via -EncodedCommand (avoids quoting); the data goes
  // over stdin. -EncodedCommand wants UTF-16LE base64.
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const proc = Bun.spawn(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { stdin: Buffer.from(Buffer.from(input).toString("base64")), stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`DPAPI failed (exit ${code}): ${err.trim()}`);
  return Buffer.from(out.trim(), "base64");
}

// Debug escape hatch: UNFORGE_STORE_PLAINTEXT=1 writes the store as readable JSON behind a
// marker prefix instead of DPAPI-sealing it. Reads auto-detect the marker, so a plaintext
// store still opens without the flag (and a DPAPI store still opens with it). Default is
// sealed — this only changes what a WRITE produces. Never leave it on for real secrets.
const PLAINTEXT_MARKER = Buffer.from("unforge-plaintext:v1\n", "utf8");
let warnedPlaintext = false;

function plaintextMode(): boolean {
  if (process.env.UNFORGE_STORE_PLAINTEXT !== "1") return false;
  if (!warnedPlaintext) {
    console.warn("⚠ UNFORGE_STORE_PLAINTEXT=1 — store written UNENCRYPTED (debug only).");
    warnedPlaintext = true;
  }
  return true;
}

/** Seal a plaintext secret into an opaque blob bound to this machine+user (or plaintext in debug mode). */
export async function sealSecret(plaintext: string): Promise<Buffer> {
  if (plaintextMode()) return Buffer.concat([PLAINTEXT_MARKER, Buffer.from(plaintext, "utf8")]);
  return dpapi(PROTECT, Buffer.from(plaintext, "utf8"));
}

/** Recover a secret sealed by {@link sealSecret} on this same machine+user. */
export async function unsealSecret(blob: Uint8Array): Promise<string> {
  const buf = Buffer.from(blob);
  // A plaintext (debug) blob carries the marker; read it regardless of the current flag.
  if (buf.subarray(0, PLAINTEXT_MARKER.length).equals(PLAINTEXT_MARKER)) {
    return buf.subarray(PLAINTEXT_MARKER.length).toString("utf8");
  }
  return Buffer.from(await dpapi(UNPROTECT, blob)).toString("utf8");
}
