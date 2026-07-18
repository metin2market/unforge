// Live smoke test of the auth flow, driven by a local .env (Bun auto-loads it).
// Runs each Spark step separately so we can see exactly how far a real account
// gets. Throwaway accounts only. Run: `bun run smoke`.
//
// .env keys (see .env.example):
//   UNFORGE_EMAIL, UNFORGE_PASSWORD   required
//   UNFORGE_BLACKBOX                  optional — overrides the native blackbox
//                                     (set empty to probe GF's rejection)
//   UNFORGE_LOCALE                    optional — default en-GB
//   UNFORGE_INSTALLATION_ID           optional — generated + printed if absent
//   UNFORGE_CERT_PEM                  optional — path to the PEM cert; without
//                                     it we stop before requesting the code

import {
  attestDevice,
  CaptchaRequiredError,
  createDeviceIdentity,
  createSession,
  DEFAULT_CLIENT_VERSION,
  generateBlackbox,
  generateDeviceProfile,
  generateInstallationId,
  InvalidCredentialsError,
  listGameAccounts,
  requestLoginCode,
} from "../src/core/index.ts";

function required(key: string): string {
  const value = Bun.env[key];
  if (!value) {
    console.error(`missing ${key} — set it in .env (see .env.example)`);
    process.exit(1);
  }
  return value;
}

const email = required("UNFORGE_EMAIL");
const password = required("UNFORGE_PASSWORD");
// GF wants the hyphen form (en-GB); tolerate the underscore convention.
const locale = (Bun.env.UNFORGE_LOCALE || "en-GB").replace("_", "-");
const installationId = Bun.env.UNFORGE_INSTALLATION_ID || generateInstallationId();
const sessionId = crypto.randomUUID();

// Each step sends its OWN fresh blackbox (reusing one 403s iovation — see authenticate.ts);
// the identity threads forward. UNFORGE_BLACKBOX overrides the sessions one only, to
// probe GF's rejection (e.g. set it empty).
const identity = createDeviceIdentity();
const deviceProfile = generateDeviceProfile();
const session = generateBlackbox({ profile: deviceProfile, identity });
const blackbox = Bun.env.UNFORGE_BLACKBOX || session.blackbox;

console.log(`installation id: ${installationId}`);
console.log(`client version:  ${DEFAULT_CLIENT_VERSION.version}`);
console.log(
  `blackbox:        ${blackbox ? `${blackbox.slice(0, 16)}… (${blackbox.length} chars)` : "(empty)"}`,
);
console.log();

try {
  console.log("① sessions → token");
  const token = await createSession({ email, password, blackbox, locale, installationId });
  console.log(`   ok — token ${token.slice(0, 12)}…\n`);

  console.log("② user/accounts");
  const accounts = await listGameAccounts(token, installationId);
  for (const a of accounts) console.log(`   ${a.gameName}: ${a.displayName} (${a.id})`);
  console.log();

  console.log("③ iovation → attest device");
  const attest = generateBlackbox({
    profile: deviceProfile,
    identity: session.identity,
    forceVectorDrift: true,
  });
  await attestDevice({
    token,
    installationId,
    accountId: accounts[0].id,
    blackbox: attest.blackbox,
  });
  console.log("   ok\n");

  const certPath = Bun.env.UNFORGE_CERT_PEM;
  if (!certPath) {
    console.log("④ thin/codes — skipped (set UNFORGE_CERT_PEM to a cert to go further)");
    process.exit(0);
  }

  console.log("④ thin/codes → login code");
  const certificatePem = await Bun.file(certPath).text();
  // thin/codes uses its own fresh blackbox, with `extraPayload` populated; codes.ts
  // then encrypts it, bound to the gsid + account.
  const codeBlackbox = generateBlackbox({
    profile: deviceProfile,
    identity: attest.identity,
    extraPayload: { installation: installationId, session: sessionId },
    forceVectorDrift: true,
  });
  const code = await requestLoginCode({
    token,
    account: accounts[0],
    installationId,
    clientVersion: DEFAULT_CLIENT_VERSION,
    certificatePem,
    sessionId,
    rawBlackbox: codeBlackbox.blackbox,
    region: Bun.env.UNFORGE_REGION || locale,
  });
  console.log(`   ok — login code: ${code}`);
} catch (err) {
  if (err instanceof CaptchaRequiredError) {
    console.error(`\n✗ captcha required (challenge ${err.challengeId}) — solve human-in-the-loop`);
  } else if (err instanceof InvalidCredentialsError) {
    console.error(`\n✗ ${err.message}`);
  } else {
    console.error("\n✗", err);
  }
  process.exit(1);
}
