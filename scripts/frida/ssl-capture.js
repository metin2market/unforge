"use strict";
// Frida agent: tap the DECRYPTED bytes of gfclient.exe's native TLS layer.
//
// Why: the launcher's cert-pinned hosts — events2/events telemetry and anything
// else on the native Qt/OpenSSL stack — never reach mitmproxy (they validate against
// a private GF PKI, not the Windows store). Hooking OpenSSL's SSL_write/SSL_read
// sees the plaintext BEFORE encryption / AFTER decryption, defeating the pinning, so
// we can finally read what the launcher sends that we don't. This is the "capture
// everything" half of the out-of-band-grade hunt (see docs/status.md).
//
// The launcher ships OpenSSL 1.0 (ssleay32.dll = SSL, libeay32.dll = crypto). The
// CEF/Chromium layer (spark, pow-captcha) uses BoringSSL inside libcef.dll and is
// already visible via mitmproxy, so this deliberately targets the OpenSSL layer where
// the pinned traffic lives. If a future build moves to OpenSSL 1.1 we also try its
// names.

const MAX = 16384; // cap per frame so a large body can't flood the message transport

function findExport(name) {
  for (const mod of ["ssleay32.dll", "libssl-1_1.dll", "libssl.dll"]) {
    const p = Module.findExportByName(mod, name);
    if (p) return p;
  }
  return null;
}

const pWrite = findExport("SSL_write");
const pRead = findExport("SSL_read");
const pGetFd = findExport("SSL_get_fd");
const SSL_get_fd = pGetFd ? new NativeFunction(pGetFd, "int", ["pointer"]) : null;
const pGetpeername = Module.findExportByName("ws2_32.dll", "getpeername");
const getpeername = pGetpeername
  ? new NativeFunction(pGetpeername, "int", ["int", "pointer", "pointer"])
  : null;

// Best-effort peer ip:port for an SSL* (via its socket fd) so each frame is
// attributable to a host even when the payload itself doesn't name one (e.g. HTTP/2
// or a binary protocol).
function peerOf(ssl) {
  if (!SSL_get_fd || !getpeername) return null;
  try {
    const fd = SSL_get_fd(ssl);
    if (fd < 0) return null;
    const addr = Memory.alloc(32);
    const len = Memory.alloc(4);
    len.writeInt(32);
    if (getpeername(fd, addr, len) !== 0) return null;
    const fam = addr.readU16();
    if (fam === 2) {
      const port = (addr.add(2).readU8() << 8) | addr.add(3).readU8();
      const ip = [4, 5, 6, 7].map((o) => addr.add(o).readU8()).join(".");
      return `${ip}:${port}`;
    }
    return `af${fam}`;
  } catch {
    return null;
  }
}

function emit(dir, ssl, buf, len) {
  if (len <= 0) return;
  const n = Math.min(len, MAX);
  try {
    send({ t: "ssl", dir, peer: peerOf(ssl), len }, Memory.readByteArray(buf, n));
  } catch {
    /* transient buffer; skip */
  }
}

// Outbound plaintext is valid on entry (the app hands SSL_write the bytes to send).
if (pWrite) {
  Interceptor.attach(pWrite, {
    onEnter(args) {
      emit("write", args[0], args[1], args[2].toInt32());
    },
  });
}
// Inbound plaintext is valid on return (SSL_read fills buf; retval = byte count).
if (pRead) {
  Interceptor.attach(pRead, {
    onEnter(args) {
      this.ssl = args[0];
      this.buf = args[1];
    },
    onLeave(ret) {
      emit("read", this.ssl, this.buf, ret.toInt32());
    },
  });
}

send({ t: "ready", hooked: { SSL_write: !!pWrite, SSL_read: !!pRead, peer: !!SSL_get_fd } });
