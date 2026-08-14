const DECLARATION_RE = /^[a-z][a-z0-9-]{0,63}$/;
const PRINCIPAL_TYPES = ['user', 'link', 'system', 'apiKey']         ;














export function principalSnapshotScope({ declaration, principal: { type, id } }                        )         {
  if (typeof declaration !== 'string' || !DECLARATION_RE.test(declaration)) {
    throw new Error(`Invalid principal snapshot declaration name '${declaration}'`);
  }
  if (!(PRINCIPAL_TYPES                     ).includes(type)) {
    throw new Error(`Invalid principal type '${type}' for principal snapshot`);
  }
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Principal snapshot principal id must be a non-empty string');
  }
  const encodedId = encodeURIComponent(id);
  return `PrincipalSnapshot:${declaration}/${type}/${encodedId}`;
}

export function parsePrincipalSnapshotScope(key        )                               {
  if (typeof key !== 'string') {
    throw new Error('Principal snapshot scope key must be a string');
  }
  const colon = key.indexOf(':');
  if (colon <= 0 || colon !== 'PrincipalSnapshot'.length) {
    throw new Error(`Invalid principal snapshot scope key '${key}'`);
  }
  const prefix = key.slice(0, colon);
  if (prefix !== 'PrincipalSnapshot') {
    throw new Error(`Invalid principal snapshot scope key '${key}'`);
  }
  const rest = key.slice(colon + 1);
  const parts = rest.split('/');
  if (parts.length !== 3) {
    throw new Error(`Invalid principal snapshot scope key '${key}'`);
  }
  const [declaration, type, encodedId] = parts;
  if (!DECLARATION_RE.test(declaration)) {
    throw new Error(`Invalid declaration name in principal snapshot scope '${key}'`);
  }
  if (!(PRINCIPAL_TYPES                     ).includes(type)) {
    throw new Error(`Invalid principal type in principal snapshot scope '${key}'`);
  }
  let decodedId        ;
  try {
    decodedId = decodeURIComponent(encodedId);
  } catch {
    throw new Error(`Malformed URI encoding in principal snapshot scope '${key}'`);
  }
  if (decodedId.length === 0) {
    throw new Error(`Empty principal id in principal snapshot scope '${key}'`);
  }
  const canonicalEncoded = encodeURIComponent(decodedId);
  if (canonicalEncoded !== encodedId) {
    throw new Error(`Non-canonical encoding in principal snapshot scope '${key}'`);
  }
  return { declaration, type: type                 , id: decodedId };
}
