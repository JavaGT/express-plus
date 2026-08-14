// Read and parse a request body. Caps the body to guard against unbounded uploads.
// An empty body parses to {}. Entity CRUD still requires JSON; imperative routes
// can also accept browser forms.
const BODY_LIMIT = 1_000_000; // ~1mb, SPEC §3 body-parse cap.
const claimedBodies = new WeakSet             ();

export class BodyError extends Error {
  status        ;
  constructor(message        , status        ) {
    super(message);
    this.status = status;
  }
}











function readCappedBody(req             , limit = BODY_LIMIT, tooLargeMessage = 'request body exceeds the 1mb limit')                  {
  if (claimedBodies.has(req)) {
    return Promise.reject(new BodyError('request body has already been read', 400));
  }
  claimedBodies.add(req);

  return new Promise((resolve, reject) => {
    const chunks           = [];
    let size = 0;
    let settled = false;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      req.off('close', onClose);
    };
    const succeed = (body        ) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(body);
    };
    const fail = (error       ) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk        ) => {
      size += chunk.length;
      if (size > limit) {
        // Stop consuming and reject so the handler can write a 413. Do NOT
        // destroy the socket — an abrupt close would race the response and the
        // client would see a dropped connection instead of the 413. Pausing and
        // resuming (drain-to-end) lets the response flush cleanly.
        req.pause();
        fail(new BodyError(tooLargeMessage, 413));
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => succeed(Buffer.concat(chunks, size));
    const onError = (error       ) => fail(error);
    const onAborted = () => fail(new BodyError('request body was aborted', 400));
    const onClose = () => fail(new BodyError('request body closed before completion', 400));

    const declaredLength = Number(req.headers['content-length']);
    if (Number.isSafeInteger(declaredLength) && declaredLength > limit) {
      fail(new BodyError(tooLargeMessage, 413));
      req.resume();
      return;
    }
    if (req.aborted || req.destroyed) {
      fail(new BodyError('request body was aborted', 400));
      return;
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    req.on('close', onClose);
  });
}

function contentType(req             )         {
  return (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
}

function contentTypeParam(req             , name        )                {
  const parts = String(req.headers['content-type'] ?? '').split(';').slice(1);
  for (const part of parts) {
    const [key, ...valueParts] = part.split('=');
    if (key?.trim().toLowerCase() !== name) continue;
    const value = valueParts.join('=').trim();
    if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
    return value;
  }
  return null;
}

function assignFormValue(body                         , name        , value         )       {
  if (Object.prototype.hasOwnProperty.call(body, name)) {
    Object.defineProperty(body, name, {
      value: Array.isArray(body[name]) ? [...(body[name]             ), value] : [body[name], value],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  } else {
    Object.defineProperty(body, name, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
}

function parseUrlencodedBody(buffer        )                          {
  const body                          = {};
  const params = new URLSearchParams(buffer.toString('utf8'));
  for (const [name, value] of params) assignFormValue(body, name, value);
  return body;
}

function parseMultipartHeaders(rawHeaders        )                         {
  const headers                         = {};
  for (const line of rawHeaders.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}

function parseContentDisposition(value        )                         {
  const params                         = {};
  for (const part of value.split(';').slice(1)) {
    const [key, ...valueParts] = part.split('=');
    const name = key?.trim().toLowerCase();
    if (!name) continue;
    let paramValue = valueParts.join('=').trim();
    if (paramValue.startsWith('"') && paramValue.endsWith('"')) paramValue = paramValue.slice(1, -1);
    params[name] = paramValue;
  }
  return params;
}









function parseMultipartBody(buffer        , boundary               )                          {
  if (!boundary) throw new BodyError('multipart body is missing a boundary', 400);
  const body                          = {};
  const delimiter = `--${boundary}`;
  const raw = buffer.toString('latin1');
  for (const section of raw.split(delimiter).slice(1)) {
    if (section.startsWith('--')) break;
    const trimmed = section.startsWith('\r\n') ? section.slice(2) : section;
    const splitAt = trimmed.indexOf('\r\n\r\n');
    if (splitAt === -1) continue;
    const headers = parseMultipartHeaders(trimmed.slice(0, splitAt));
    let content = Buffer.from(trimmed.slice(splitAt + 4), 'latin1');
    if (content.subarray(-2).toString('latin1') === '\r\n') content = content.subarray(0, -2);
    const disposition = parseContentDisposition(headers['content-disposition'] ?? '');
    if (!disposition.name) continue;
    if (Object.prototype.hasOwnProperty.call(disposition, 'filename')) {
      assignFormValue(body, disposition.name, {
        name: disposition.name,
        filename: disposition.filename,
        type: headers['content-type'] ?? 'application/octet-stream',
        size: content.length,
        content,
      }                        );
    } else {
      assignFormValue(body, disposition.name, content.toString('utf8'));
    }
  }
  return body;
}





export async function readRequestBody(req             , { jsonOnly = false }                         = {})                   {
  const buffer = await readCappedBody(req);
  if (buffer.length === 0) return {};
  const type = contentType(req);
  if (type === '' || type === 'application/json') {
    const raw = buffer.toString('utf8').trim();
    if (raw === '') return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new BodyError('request body is not valid JSON', 400);
    }
  }
  if (!jsonOnly && type === 'application/x-www-form-urlencoded') return parseUrlencodedBody(buffer);
  if (!jsonOnly && type === 'multipart/form-data') return parseMultipartBody(buffer, contentTypeParam(req, 'boundary'));
  throw new BodyError(jsonOnly ? 'request body must be JSON' : 'unsupported request body content type', 415);
}

// Read a raw (binary) request body into a Buffer, capped at `limit` bytes. Used
// by the /blobs upload route: a blob upload is opaque bytes, not JSON. The same
// cap-and-refuse contract as readRequestBody (a baked-in default) — an oversized
// upload rejects with a 413 and drains to a clean response, never an abrupt
// socket close that would race the response.
export function readRawBody(req             , limit        )                  {
  return readCappedBody(req, limit, 'upload exceeds the size limit');
}
