// passkey.mjs — WebAuthn (passkey) challenge and verification logic.
//
// Zero runtime dependencies: implemented on `node:crypto` only. The framework
// owns challenge issue/verify + credential storage as framework auth entities;
// the app owns the UI (button, prompt, error display).
//
// Registration uses `navigator.credentials.create()` (attestation); login uses
// `navigator.credentials.get()` (assertion). The server issues challenges,
// stores them with TTL, and verifies the client's response against the stored
// challenge + the stored credential's public key.
//
//   - generateChallenge() → random bytes, base64url-encoded
//   - challengeStore — an in-memory Map with TTL cleanup
//   - verifyRegistration(challenge, credential, rp) → parses attestation,
//     validates RP ID hash, extracts credential ID + public key
//   - verifyAuthentication(challenge, credential, storedCredential, rp) →
//     validates assertion, verifies signature against stored public key
//   - parseClientDataJSON(base64url) → decoded JSON with { challenge, origin, type }
//   - parseAuthenticatorData(buf) → { rpIdHash, flags, signCount }

import crypto from 'node:crypto';


// ---- RP configuration --------------------------------------------------------
// Sensible defaults; overridable via config.rp per-app.

// The RP identity an app overrides per-app (cfg.rp) and the frozen default.






const defaultRp                     = Object.freeze({
  name: 'workbench',
  id: 'localhost',
  origin: 'http://localhost:3000',
});





// rpConfig(cfg) → frozen { name, id, origin }. Picks per-app overrides from
// cfg.rp; absent keys fall back to the defaultRp. The shape is frozen so no
// later layer can mutate the RP identity.
export function rpConfig(cfg            = {})                     {
  const rp = cfg?.rp ?? {};
  return Object.freeze({
    name: rp.name ?? defaultRp.name,
    id: rp.id ?? defaultRp.id,
    origin: rp.origin ?? defaultRp.origin,
  });
}

// ---- challenge generation ----------------------------------------------------

// generateChallenge(length) → base64url-encoded random bytes. The default
// 32 bytes (256 bits of entropy) is the WebAuthn recommendation.
export function generateChallenge(length = 32)         {
  return crypto.randomBytes(length).toString('base64url');
}

// ---- challenge store ---------------------------------------------------------

const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// A stored challenge entry: the caller's data plus the creation timestamp the
// TTL sweep and the expiry check read.












// createChallengeStore(ttlMs) → { set, get, consume, destroy }. An in-memory Map
// with TTL-based expiry: entries older than ttlMs are dropped. `consume` is a
// single-use read (get + delete) so a challenge cannot be replayed.
export function createChallengeStore(ttlMs = DEFAULT_CHALLENGE_TTL_MS)                 {
  const store = new Map                        ();

  // Periodic cleanup sweeps expired entries every 60 seconds. The interval is
  // unref'd so it doesn't keep the process alive.
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [challenge, entry] of store) {
      if (now - entry.created > ttlMs) store.delete(challenge);
    }
  }, 60_000);
  cleanup.unref();

  return {
    set(challenge, data = {}) {
      store.set(challenge, Object.freeze({ ...data, created: Date.now() }));
      return challenge;
    },
    get(challenge) {
      const entry = store.get(challenge);
      if (!entry) return null;
      if (Date.now() - entry.created > ttlMs) {
        store.delete(challenge);
        return null;
      }
      return entry;
    },
    consume(challenge) {
      const entry = this.get(challenge);
      if (entry) store.delete(challenge);
      return entry;
    },
    destroy() {
      clearInterval(cleanup);
      store.clear();
    },
  };
}

// The default singleton challenge store — used by the built-in auth routes.
export const challengeStore = createChallengeStore();

// ---- base64url helpers -------------------------------------------------------

function base64urlToBuffer(str        )         {
  // Replace URL-safe chars, pad to multiple of 4.
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

// ---- client data JSON --------------------------------------------------------

// parseClientDataJSON(base64urlStr) → decoded JSON object. `clientDataJSON` is
// a base64url-encoded JSON string with { challenge, origin, type, ... }.
export function parseClientDataJSON(base64urlStr        )                          {
  const buf = base64urlToBuffer(base64urlStr);
  return JSON.parse(buf.toString('utf-8'));
}

// ---- SHA-256 helper ----------------------------------------------------------

function sha256(data        )         {
  return crypto.createHash('sha256').update(data).digest();
}

// ---- authenticator data parser -----------------------------------------------

// parseAuthenticatorData(authData) → { rpIdHash, flags, signCount }.
// `authData` is a Buffer whose first 37 bytes are the fixed header:
//   bytes 0–31:  SHA-256 of RP ID
//   byte 32:     flags (bit 0: UP, bit 2: UV, bit 6: AT, bit 7: ED)
//   bytes 33–36: sign counter (32-bit big-endian)
export function parseAuthenticatorData(authData        )                                                         {
  const rpIdHash = authData.slice(0, 32);
  const flags = authData[32];
  const signCount = authData.readUInt32BE(33);
  return { rpIdHash, flags, signCount };
}

// ---- minimal CBOR decoder ----------------------------------------------------
// Only the types needed to parse a WebAuthn attestation object:
//   - unsigned integer (major 0)
//   - negative integer (major 1)
//   - byte string (major 2)
//   - text string (major 3)
//   - map (major 5)

// The decoder's return shape: the decoded value (number, string, Buffer, or a
// map record) plus the offset just past the consumed bytes.





function decodeCborLen(buf        , offset        )                               {
  const ai = buf[offset] & 0x1f;
  if (ai < 24) return { len: ai, pos: offset + 1 };
  if (ai === 24) return { len: buf[offset + 1], pos: offset + 2 };
  if (ai === 25) return { len: buf.readUInt16BE(offset + 1), pos: offset + 3 };
  if (ai === 26) return { len: buf.readUInt32BE(offset + 1), pos: offset + 5 };
  if (ai === 27) {
    const hi = buf.readUInt32BE(offset + 1);
    const lo = buf.readUInt32BE(offset + 5);
    return { len: Number((BigInt(hi) << 32n) | BigInt(lo)), pos: offset + 9 };
  }
  throw new Error(`unsupported CBOR length encoding: ${ai}`);
}

function decodeCbor(buf        , offset = 0)             {
  const byte = buf[offset];
  const major = byte >> 5;

  switch (major) {
    case 0: { // unsigned integer
      const { len, pos } = decodeCborLen(buf, offset);
      return { value: len, pos };
    }
    case 1: { // negative integer: value = -1 - n
      const { len, pos } = decodeCborLen(buf, offset);
      return { value: -1 - len, pos };
    }
    case 2: { // byte string
      const { len, pos } = decodeCborLen(buf, offset);
      return { value: buf.slice(pos, pos + len), pos: pos + len };
    }
    case 3: { // text string
      const { len, pos } = decodeCborLen(buf, offset);
      return { value: buf.slice(pos, pos + len).toString('utf-8'), pos: pos + len };
    }
    case 5: { // map
      const { len: count, pos: afterLen } = decodeCborLen(buf, offset);
      const map                          = {};
      let p = afterLen;
      for (let i = 0; i < count; i++) {
        const key = decodeCbor(buf, p);
        const val = decodeCbor(buf, key.pos);
        map[String(key.value)] = val.value;
        p = val.pos;
      }
      return { value: map, pos: p };
    }
    default:
      throw new Error(`unsupported CBOR major type: ${major} (byte 0x${byte.toString(16)} at offset ${offset})`);
  }
}

// ---- attestation object parsing ----------------------------------------------

// parseAttestationObject(base64urlStr) → { fmt, attStmt, authData }.
// Decodes the base64url-encoded CBOR attestation object from the client.
function parseAttestationObject(base64urlStr        )                                                       {
  const buf = base64urlToBuffer(base64urlStr);
  const { value } = decodeCbor(buf, 0);
  if (value == null || typeof value !== 'object') {
    throw new Error('attestation object is not a CBOR map');
  }
  const { fmt, attStmt, authData } = value                           ;
  if (!Buffer.isBuffer(authData)) {
    throw new Error('attestation object missing authData byte string');
  }
  return { fmt: fmt ?? null, attStmt: attStmt ?? {}, authData };
}

// ---- attested credential data extraction -------------------------------------

// extractAttestedCredentialData(authData, offset) → { credentialId, publicKey }
// authData is the authenticator data Buffer; offset is the start of the attested
// credential data section (byte 37 of the full authData). Extracts the
// credential ID and the COSE-encoded public key.
function extractAttestedCredentialData(authData        , offset = 37)                                              {
  // AAGUID: 16 bytes
  const aaguidOffset = offset + 16;
  // Credential ID length: 2 bytes big-endian
  const credIdLen = authData.readUInt16BE(aaguidOffset);
  const credIdStart = aaguidOffset + 2;
  const credentialId = authData.slice(credIdStart, credIdStart + credIdLen);
  // Remaining bytes: COSE public key
  const coseKeyBuf = authData.slice(credIdStart + credIdLen);
  const publicKey = decodeCosePublicKey(coseKeyBuf);
  return { credentialId, publicKey };
}

// ---- COSE public key conversion ----------------------------------------------
// Converts a COSE_Key-encoded EC P-256 (ES256) public key to DER/SPKI format.
// The stored format (per the entity spec) is base64url of DER/SubjectPublicKeyInfo.
//
// COSE_Key for P-256:
//   { 1: 2 (kty: EC2), 3: -7 (alg: ES256), -1: 1 (crv: P-256),
//     -2: x (bytes), -3: y (bytes) }
//
// SPKI for P-256 (DER):
//   30 59  — SEQUENCE (89 bytes)
//     30 13 — SEQUENCE (19 bytes) — algorithm identifier
//       06 07 — OID 2A8648CE3D0201 (ecPublicKey)
//       06 08 — OID 2A8648CE3D030107 (prime256v1)
//     03 42 — BIT STRING (66 bytes)
//       00   — unused bits
//       04   — uncompressed point prefix
//       <x> <y> — 32 bytes each

function decodeCosePublicKey(coseBuf        )         {
  const { value } = decodeCbor(coseBuf, 0);
  if (value == null || typeof value !== 'object') {
    throw new Error('credential public key is not a CBOR map');
  }
  const coseKey = value                                    ;

  // Validate it's an EC2 P-256 key
  if (coseKey[1] !== 2) throw new Error('COSE key kty is not EC2');
  if (coseKey[-1] !== 1) throw new Error('COSE key crv is not P-256');
  const x = coseKey[-2];
  const y = coseKey[-3];
  if (!Buffer.isBuffer(x) || x.length !== 32) throw new Error('invalid COSE key x coordinate');
  if (!Buffer.isBuffer(y) || y.length !== 32) throw new Error('invalid COSE key y coordinate');

  // Build DER/SPKI encoding
  const ecPublicKeyOid = Buffer.from('2a8648ce3d0201', 'hex');    // 1.2.840.10045.2.1
  const prime256v1Oid = Buffer.from('2a8648ce3d030107', 'hex');   // 1.2.840.10045.3.1.7

  // AlgorithmIdentifier SEQUENCE
  const algoSeq = Buffer.concat([
    Buffer.from([0x30, 0x13]),                                   // SEQUENCE (19)
    Buffer.from([0x06, ecPublicKeyOid.length, ...ecPublicKeyOid]),
    Buffer.from([0x06, prime256v1Oid.length, ...prime256v1Oid]),
  ]);

  // Uncompressed point: 04 || x || y
  const point = Buffer.concat([Buffer.from([0x04]), x, y]);

  // BIT STRING wrapper
  const bitString = Buffer.concat([
    Buffer.from([0x00]), // unused bits
    point,
  ]);

  // Wrap in SEQUENCE for the SPKI
  const spki = Buffer.concat([
    Buffer.from([0x30]),                                          // SEQUENCE tag
    encodeDerLength(algoSeq.length + 2 + bitString.length),       // length
    algoSeq,
    Buffer.from([0x03]),                                         // BIT STRING tag
    encodeDerLength(bitString.length),                            // length
    bitString,
  ]);

  return spki;
}

// encodeDerLength(n) → DER length encoding bytes
function encodeDerLength(n        )         {
  if (n < 0x80) return Buffer.from([n]);
  // Long form: first byte = 0x80 | numOctets, then the octets
  const octets           = [];
  let rem = n;
  while (rem > 0) {
    octets.unshift(rem & 0xff);
    rem >>>= 8;
  }
  return Buffer.from([0x80 | octets.length, ...octets]);
}

// ---- registration verification -----------------------------------------------

// The client-supplied credential in a WebAuthn ceremony (registration or
// assertion). `response` carries the base64url-encoded ceremony payloads the
// server verifies; the optional metadata (name/transports/backedUp) is stored
// alongside the credential on registration.
















// The stored Credential entity row the assertion verifier reads: the credential
// id (base64url), the public key (DER/SPKI, base64url), and the last-seen sign
// counter (replay protection).






// verifyRegistration(challenge, credential, rp) → { credentialId, publicKey, signCount }
// Verifies a WebAuthn registration (attestation) response.
//
// credential shape (from client):
//   { id, rawId, response: { clientDataJSON, attestationObject }, type }
//
// Throws on any validation failure (fail closed). On success, returns the
// extracted credential material to store in the Credential entity.
export function verifyRegistration(challenge        , credential                     , rp                    )                                                                 {
  // 1. Parse and validate clientDataJSON
  const clientData = parseClientDataJSON(credential.response.clientDataJSON);

  if (clientData.challenge !== challenge) {
    throw new Error('challenge mismatch in clientDataJSON');
  }
  if (clientData.origin !== rp.origin) {
    throw new Error(`origin mismatch: expected ${rp.origin}, got ${clientData.origin}`);
  }
  if (clientData.type !== 'webauthn.create') {
    throw new Error(`invalid clientData type for registration: ${clientData.type}`);
  }

  // 2. Parse attestation object (CBOR)
  const attObj = parseAttestationObject(credential.response.attestationObject );
  const authData = attObj.authData;

  // 3. Parse authenticator data header
  const parsed = parseAuthenticatorData(authData);

  // 4. Verify RP ID hash
  const expectedRpIdHash = sha256(Buffer.from(rp.id));
  if (!crypto.timingSafeEqual(parsed.rpIdHash, expectedRpIdHash)) {
    throw new Error('RP ID hash mismatch in authenticator data');
  }

  // 5. Verify user present flag (UP, bit 0)
  if (!(parsed.flags & 0x01)) {
    throw new Error('user not present (UP flag not set)');
  }

  // 6. Verify attested credential data is present (AT, bit 6)
  if (!(parsed.flags & 0x40)) {
    throw new Error('attested credential data not present (AT flag not set)');
  }

  // 7. Extract credential ID and public key from attested credential data
  const { credentialId, publicKey } = extractAttestedCredentialData(authData);

  return {
    credentialId: credentialId.toString('base64url'),
    publicKey: publicKey.toString('base64url'),
    signCount: parsed.signCount,
  };
}

// ---- authentication verification ---------------------------------------------

// verifyAuthentication(challenge, credential, storedCredential, rp) → { signCount }
// Verifies a WebAuthn assertion response against a stored Credential entity row.
//
// credential shape (from client):
//   { id, rawId, response: { clientDataJSON, authenticatorData, signature, userHandle }, type }
//
// storedCredential shape: { credentialId, publicKey (base64url SPKI), signCount }
//
// Throws on any validation failure; on success returns the new signCount to
// update the stored credential (replay protection).
export function verifyAuthentication(challenge        , credential                     , storedCredential                  , rp                    )                        {
  // 1. Parse and validate clientDataJSON
  const clientData = parseClientDataJSON(credential.response.clientDataJSON);

  if (clientData.challenge !== challenge) {
    throw new Error('challenge mismatch in clientDataJSON');
  }
  if (clientData.origin !== rp.origin) {
    throw new Error(`origin mismatch: expected ${rp.origin}, got ${clientData.origin}`);
  }
  if (clientData.type !== 'webauthn.get') {
    throw new Error(`invalid clientData type for authentication: ${clientData.type}`);
  }

  // 2. Parse authenticator data
  const authData = base64urlToBuffer(credential.response.authenticatorData );
  const parsed = parseAuthenticatorData(authData);

  // 3. Verify RP ID hash
  const expectedRpIdHash = sha256(Buffer.from(rp.id));
  if (!crypto.timingSafeEqual(parsed.rpIdHash, expectedRpIdHash)) {
    throw new Error('RP ID hash mismatch in authenticator data');
  }

  // 4. Verify user present flag (UP, bit 0)
  if (!(parsed.flags & 0x01)) {
    throw new Error('user not present (UP flag not set)');
  }

  // 5. Counter check (replay protection). If both are zero (first use of a
  //    fresh credential), allow it. Otherwise the new counter must be strictly
  //    greater.
  const storedCount = storedCredential.signCount ?? 0;
  if (!(parsed.signCount === 0 && storedCount === 0) && parsed.signCount <= storedCount) {
    throw new Error(
      `signature counter not incremented: stored=${storedCount}, received=${parsed.signCount}`,
    );
  }

  // 6. Verify signature over authenticatorData || SHA256(clientDataJSON)
  const clientDataHash = sha256(base64urlToBuffer(credential.response.clientDataJSON));
  const signatureBase = Buffer.concat([authData, clientDataHash]);
  const signature = base64urlToBuffer(credential.response.signature );

  const publicKey = crypto.createPublicKey({
    key: base64urlToBuffer(storedCredential.publicKey),
    format: 'der',
    type: 'spki',
  });

  const valid = crypto.verify('sha256', signatureBase, publicKey, signature);
  if (!valid) {
    throw new Error('invalid signature on authentication assertion');
  }

  return { signCount: parsed.signCount };
}

// ---- synthetic credential builders (for testing) -----------------------------
// These construct minimal authenticatorData sequences for test usage, avoiding
// the need for real hardware. Exported so tests can construct assertions to feed
// through the real verify path.

// buildRpIdHash(rpId) → SHA-256 of the RP ID string.
export function buildRpIdHash(rpId        )         {
  return sha256(Buffer.from(rpId));
}

// buildAuthenticatorData({ rpIdHash, flags, signCount, credentialId, publicKey })
// → Buffer. Constructs a complete authenticatorData binary from the named parts.
// When credentialId and publicKey are provided, the attested credential data
// section is included (flags should have AT bit 0x40 set).
export function buildAuthenticatorData({ rpIdHash, flags, signCount, credentialId, publicKey }





 )         {
  const parts = [rpIdHash, Buffer.from([flags])];
  // 4-byte big-endian sign counter
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(signCount, 0);
  parts.push(counter);

  if (credentialId && publicKey) {
    // Attested credential data:
    //   AAGUID: 16 zero bytes
    //   credential id length: 2 bytes big-endian
    //   credential id: raw bytes
    //   public key: COSE-encoded bytes
    const aaguid = Buffer.alloc(16, 0);
    const idBuf = base64urlToBuffer(credentialId);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(idBuf.length, 0);
    const pkBuf = base64urlToBuffer(publicKey);
    parts.push(aaguid, idLen, idBuf, pkBuf);
  }

  return Buffer.concat(parts);
}

// buildClientDataJSON({ challenge, origin, type }) → base64url-encoded string.
export function buildClientDataJSON({ challenge, origin, type }



 )         {
  const json = JSON.stringify({ challenge, origin, type });
  return Buffer.from(json, 'utf-8').toString('base64url');
}

// signAssertion(privateKey, authenticatorData, clientDataJSON) → base64url sig.
// Signs authenticatorData || SHA256(clientDataJSON) with the given privateKey.
export function signAssertion(privateKey           , authenticatorDataBuf        , clientDataJSONBase64url        )         {
  const clientDataHash = sha256(base64urlToBuffer(clientDataJSONBase64url));
  const signatureBase = Buffer.concat([authenticatorDataBuf, clientDataHash]);
  return crypto.sign('sha256', signatureBase, privateKey).toString('base64url');
}

// cosePublicKeyFromKeyPair(keypair) → base64url of COSE-encoded P-256 public key.
// For constructing synthetic attestation authData with the keypair's public key
// in the COSE format an authenticator would embed.
export function cosePublicKeyFromKeyPair(keypair

 )         {
  const jwk = keypair.publicKey.export({ format: 'jwk' });
  const x = base64urlToBuffer(jwk.x );
  const y = base64urlToBuffer(jwk.y );

  // Build COSE_Key for P-256 (ES256):
  //   { 1: 2, 3: -7, -1: 1, -2: h'x', -3: h'y' }
  // CBOR encoding:
  //   A5          # map(5)
  //     01 02     # 1: 2
  //     03 26     # 3: -7 (0x20 + 6 = 0x26)
  //     20 01     # -1: 1 (0x20 + 0 = 0x20)
  //     21 58 20  # -2: bytes(32)  (0x20 + 1 = 0x21)
  //        <x bytes 32>
  //     22 58 20  # -3: bytes(32)  (0x20 + 2 = 0x22)
  //        <y bytes 32>
  const parts = [
    Buffer.from([0xa5]),                     // map(5)
    Buffer.from([0x01, 0x02]),              // 1: 2
    Buffer.from([0x03, 0x26]),              // 3: -7
    Buffer.from([0x20, 0x01]),              // -1: 1
    Buffer.from([0x21, 0x58, 0x20, ...x]), // -2: bytes(32)
    Buffer.from([0x22, 0x58, 0x20, ...y]), // -3: bytes(32)
  ];
  return Buffer.concat(parts).toString('base64url');
}

// buildAttestationObject({ fmt, authData }) → base64url-encoded CBOR.
// Constructs a minimal CBOR attestation object for test registration.
//   { "fmt": fmt, "attStmt": {}, "authData": authData }
export function buildAttestationObject({ fmt = 'none', authData }


 )         {
  const authDataBuf = typeof authData === 'string' ? base64urlToBuffer(authData) : authData;
  const fmtBuf = Buffer.from(fmt, 'utf-8');

  // Build CBOR: A3 — map(3)
  //   key "fmt" (text(3)) → value text(len(fmt))
  //   key "attStmt" (text(7)) → value map(0) = A0
  //   key "authData" (text(8)) → value bytes(len(authData))
  const cborFmtKey = Buffer.from([0x63, 0x66, 0x6d, 0x74]); // text(3) "fmt"
  const cborFmtVal = Buffer.concat([Buffer.from([0x60 + fmtBuf.length]), fmtBuf]);
  const cborAttStmtKey = Buffer.from([0x67, 0x61, 0x74, 0x74, 0x53, 0x74, 0x6d, 0x74]); // text(7) "attStmt"
  const cborAttStmtVal = Buffer.from([0xa0]); // map(0)
  const cborAuthDataKey = Buffer.from([0x68, 0x61, 0x75, 0x74, 0x68, 0x44, 0x61, 0x74, 0x61]); // text(8) "authData"

  // Byte string encoding for authData
  let byteStrHeader;
  if (authDataBuf.length < 24) {
    byteStrHeader = Buffer.from([0x40 + authDataBuf.length]);
  } else if (authDataBuf.length < 0x100) {
    byteStrHeader = Buffer.from([0x58, authDataBuf.length]);
  } else if (authDataBuf.length < 0x10000) {
    const h = Buffer.alloc(3);
    h[0] = 0x59;
    h.writeUInt16BE(authDataBuf.length, 1);
    byteStrHeader = h;
  } else {
    const h = Buffer.alloc(5);
    h[0] = 0x5a;
    h.writeUInt32BE(authDataBuf.length, 1);
    byteStrHeader = h;
  }

  // Count elements in the map for the header
  const cborHeader = Buffer.from([0xa3]); // map(3)

  return Buffer.concat([
    cborHeader,
    cborFmtKey, cborFmtVal,
    cborAttStmtKey, cborAttStmtVal,
    cborAuthDataKey, byteStrHeader, authDataBuf,
  ]).toString('base64url');
}
