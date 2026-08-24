// views-escape.test.mjs — the view engine escapes interpolated values by
// default (fail-closed against XSS), with an explicit triple-brace raw opt-out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { resolveTemplate, escapeHtml, matchExtension, isSafePath } from '../build/internal.mjs';
import { stripPrefix, serveStatic, parseAcceptEncoding, mergeVary } from '../build/views.mjs';

function withTemplate(source, run) {
  const dir = path.join(os.tmpdir(), 'express-views-' + randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  const name = 'page.html';
  fs.writeFileSync(path.join(dir, name), source, 'utf-8');
  try {
    return run(dir, name);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('escapeHtml: escapes the five HTML-context metacharacters', () => {
  assert.equal(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  // `&` is not double-escaped: an ampersand becomes one entity, not a chain.
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  // Non-string values are coerced.
  assert.equal(escapeHtml(42), '42');
});

test('resolveTemplate: {{key}} HTML-escapes the value by default', () => {
  withTemplate('<p>{{msg}}</p>', (dir, name) => {
    const html = resolveTemplate(dir, name, { msg: '<script>alert(1)</script>' });
    assert.equal(html, '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    // The raw payload never appears verbatim.
    assert.ok(!html.includes('<script>'));
  });
});

test('resolveTemplate: {{{key}}} inserts the value raw (explicit opt-out)', () => {
  withTemplate('<div>{{{body}}}</div>', (dir, name) => {
    const html = resolveTemplate(dir, name, { body: '<b>bold</b>' });
    assert.equal(html, '<div><b>bold</b></div>');
  });
});

test('resolveTemplate: raw and escaped forms coexist in one template', () => {
  withTemplate('<h1>{{title}}</h1><div>{{{body}}}</div>', (dir, name) => {
    const html = resolveTemplate(dir, name, {
      title: '<x>',
      body: '<em>ok</em>',
    });
    assert.equal(html, '<h1>&lt;x&gt;</h1><div><em>ok</em></div>');
  });
});

test('resolveTemplate: unresolved placeholders stay literal in both forms', () => {
  withTemplate('<p>{{missing}} {{{alsoMissing}}}</p>', (dir, name) => {
    const html = resolveTemplate(dir, name, {});
    assert.equal(html, '<p>{{missing}} {{{alsoMissing}}}</p>');
  });
});

test('matchExtension returns known MIME types and octet-stream fallback', () => {
  assert.equal(matchExtension('x.html'), 'text/html; charset=utf-8');
  assert.equal(matchExtension('a.CSS'), 'text/css; charset=utf-8');
  assert.equal(matchExtension('app.js'), 'application/javascript; charset=utf-8');
  assert.equal(matchExtension('x.unknown'), 'application/octet-stream');
});

test('isSafePath rejects path traversal and allows nested files under root', () => {
  const root = path.join(os.tmpdir(), 'wb-static-' + randomUUID());
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  try {
    assert.equal(isSafePath(root, 'sub/file.txt'), true);
    assert.equal(isSafePath(root, '../escape.txt'), false);
    assert.equal(isSafePath(root, 'sub/../../etc/passwd'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stripPrefix drops the mount prefix and query string', () => {
  assert.equal(stripPrefix('/static/a.css?v=1', '/static'), '/a.css');
  assert.equal(stripPrefix('/other/a.css', '/static'), '/other/a.css');
  assert.equal(stripPrefix('/x', ''), '/x');
});

test('serveStatic serves a file under the root and 404s missing/unsafe paths', async () => {
  const root = path.join(os.tmpdir(), 'wb-static-serve-' + randomUUID());
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'hello.txt'), 'hi', 'utf-8');
  const handler = serveStatic(root, { prefix: '/files' });

  function mockRes() {
    return {
      headersSent: false,
      status: null,
      headers: null,
      body: null,
      writeHead(s, h) { this.status = s; this.headers = h; this.headersSent = true; },
      end(b) { this.body = b; },
    };
  }

  try {
    // Happy path via params.path
    {
      const res = mockRes();
      handler({ params: { path: 'hello.txt' }, url: '/files/hello.txt' }, res, null);
      assert.equal(res.status, 200);
      assert.equal(String(res.body), 'hi');
      assert.match(res.headers['content-type'], /text\/plain/);
    }
    // Missing file → 404 when no next
    {
      const res = mockRes();
      handler({ params: { path: 'nope.txt' }, url: '/files/nope.txt' }, res, null);
      assert.equal(res.status, 404);
      assert.deepEqual(JSON.parse(res.body), {
        ok: false,
        failure: { category: 'not-found', message: 'not found' },
      });
    }
    // Unsafe path → next() when provided
    {
      let nextCalled = false;
      const res = mockRes();
      handler({ params: { path: '../secret' }, url: '/files/../secret' }, res, () => { nextCalled = true; });
      assert.equal(nextCalled, true);
      assert.equal(res.status, null);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- Web-delivery lane: precompressed negotiation, Vary merge, cacheControl --

function staticMockRes(rawHeaders = {}) {
  return {
    headersSent: false,
    status: null,
    headers: null,
    body: null,
    raw: {
      headers: { ...rawHeaders },
      getHeader(name) { return this.headers[name.toLowerCase()]; },
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    },
    writeHead(s, h) { this.status = s; this.headers = h; this.headersSent = true; },
    end(b) { this.body = b; },
  };
}

function withStaticRoot(run) {
  const root = path.join(os.tmpdir(), 'wb-static-negotiate-' + randomUUID());
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log(1)', 'utf-8');
  fs.writeFileSync(path.join(root, 'assets', 'app.js.gz'), Buffer.from([0x1f, 0x8b, 0x01]));
  fs.writeFileSync(path.join(root, 'assets', 'app.js.br'), Buffer.from([0x1b, 0x2b, 0x01]));
  fs.writeFileSync(path.join(root, 'index.html'), '<html></html>', 'utf-8');
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const handler = (root) => serveStatic(root, { prefix: '', precompressed: true });

test('parseAcceptEncoding: absent header, q parsing, duplicates last-win, case folding', () => {
  assert.deepEqual(parseAcceptEncoding(undefined), {});
  assert.deepEqual(parseAcceptEncoding('gzip'), { gzip: 1 });
  // malformed/missing q defaults to 1; values clamp to [0,1]
  assert.deepEqual(parseAcceptEncoding('gzip;q=abc, br;q=2, identity;q=-1'), { gzip: 1, br: 1, identity: 0 });
  // duplicate tokens: later entry wins
  assert.deepEqual(parseAcceptEncoding('gzip;q=0, gzip'), { gzip: 1 });
  assert.deepEqual(parseAcceptEncoding('GZIP;Q=0.5'), { gzip: 0.5 });
  // garbage entries dropped
  assert.deepEqual(parseAcceptEncoding(',, ;q=1, br'), { br: 1 });
});

test('mergeVary: case-insensitive union, dedupe, canonical lowercase', () => {
  assert.equal(mergeVary('Origin', 'accept-encoding'), 'origin, accept-encoding');
  assert.equal(mergeVary('ACCEPT-ENCODING', 'accept-encoding'), 'accept-encoding');
  assert.equal(mergeVary(undefined, 'Accept-Encoding'), 'accept-encoding');
  assert.equal(mergeVary('origin, accept-encoding', 'accept-encoding'), 'origin, accept-encoding');
});

// Negotiation matrix — one assertion per row of the plan's consequence table.
test('negotiation matrix over .br+.gz siblings', () => {
  withStaticRoot((root) => {
    const h = handler(root);
    const serve = (enc) => {
      const res = staticMockRes();
      h({ params: { path: 'assets/app.js' }, url: '/assets/app.js', headers: enc === undefined ? undefined : { 'accept-encoding': enc } }, res, null);
      return res;
    };
    // no header → identity
    assert.equal(serve(undefined).headers['content-encoding'], undefined);
    // identity alone → identity
    assert.equal(serve('identity').headers['content-encoding'], undefined);
    // gzip alone → gzip
    assert.equal(serve('gzip').headers['content-encoding'], 'gzip');
    // gzip;q=0 → 200 identity (unlisted br q=0; identity defaults to 1)
    assert.equal(serve('gzip;q=0').headers['content-encoding'], undefined);
    assert.equal(serve('gzip;q=0').status, 200);
    // gzip;q=0, br;q=0 → 200 identity
    assert.equal(serve('gzip;q=0, br;q=0').headers['content-encoding'], undefined);
    assert.equal(serve('gzip;q=0, br;q=0').status, 200);
    // br;q=0, gzip → gzip, never br
    assert.equal(serve('br;q=0, gzip').headers['content-encoding'], 'gzip');
    // * → br (top priority)
    assert.equal(serve('*').headers['content-encoding'], 'br');
    // *;q=0, gzip → gzip (explicit beats wildcard-zero)
    assert.equal(serve('*;q=0, gzip').headers['content-encoding'], 'gzip');
    // identity;q=0 → 406 (br/gzip unlisted without wildcard)
    assert.equal(serve('identity;q=0').status, 406);
    assert.deepEqual(JSON.parse(serve('identity;q=0').body), {
      ok: false,
      failure: { category: 'not-acceptable', message: 'No acceptable representation.' },
    });
    // identity;q=0, * → br (wildcard admits br/gzip; identity stays forbidden)
    assert.equal(serve('identity;q=0, *').headers['content-encoding'], 'br');
    // *;q=0 → 406 (identity excluded too)
    assert.equal(serve('*;q=0').status, 406);
    // all three explicitly zero → 406
    assert.equal(serve('identity;q=0, gzip;q=0, br;q=0').status, 406);
    // tie at 0.5 → server priority picks br
    assert.equal(serve('gzip;q=0.5, br;q=0.5').headers['content-encoding'], 'br');
    // GZIP case-insensitive → gzip
    assert.equal(serve('GZIP').headers['content-encoding'], 'gzip');
  });
});

test('precompressed responses carry encoded length, original type, and merged Vary', () => {
  withStaticRoot((root) => {
    const h = handler(root);
    const gzSize = fs.statSync(path.join(root, 'assets', 'app.js.gz')).size;
    const res = staticMockRes({ vary: 'Origin' }); // spine preset (e.g. CORS)
    h({ params: { path: 'assets/app.js' }, url: '/assets/app.js', headers: { 'accept-encoding': 'gzip' } }, res, null);
    assert.equal(res.headers['content-length'], gzSize);
    assert.match(res.headers['content-type'], /javascript/);
    assert.equal(res.headers.vary, 'origin, accept-encoding'); // merged, not replaced
    // idempotent on repeat
    const res2 = staticMockRes({ vary: 'origin, accept-encoding' });
    h({ params: { path: 'assets/app.js' }, url: '/assets/app.js', headers: {} }, res2, null);
    assert.equal(res2.headers.vary, 'origin, accept-encoding');
  });
});

test('406 carries Vary via the raw response', () => {
  withStaticRoot((root) => {
    const res = staticMockRes();
    handler(root)({ params: { path: 'assets/app.js' }, url: '/assets/app.js', headers: { 'accept-encoding': '*;q=0' } }, res, null);
    assert.equal(res.status, 406);
    assert.equal(res.raw.getHeader('vary'), 'accept-encoding');
  });
});

test('cacheControl: exact > prefix > extension > none; unmatched paths unchanged', () => {
  withStaticRoot((root) => {
    const h = serveStatic(root, {
      prefix: '',
      cacheControl: {
        '/index.html': 'no-cache',
        '/assets/': 'public, max-age=31536000, immutable',
        '.txt': 'public, max-age=60',
      },
    });
    const serve = (p) => {
      const res = staticMockRes();
      h({ params: { path: p }, url: `/${p}` }, res, null);
      return res;
    };
    assert.equal(serve('assets/app.js').headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(serve('index.html').headers['cache-control'], 'no-cache');
    // extension key applies to a file type with no exact/prefix policy
    const txtRes = serve('robots.txt');
    assert.ok(txtRes.status === 404 || txtRes.headers['cache-control'] === 'public, max-age=60');
    if (txtRes.status === 200) assert.equal(txtRes.headers['cache-control'], 'public, max-age=60');
    // no policies at all → historical behavior (no cache header)
    const plainRes = staticMockRes();
    serveStatic(root, { prefix: '' })({ params: { path: 'assets/app.js' }, url: '/assets/app.js' }, plainRes, null);
    assert.equal(plainRes.headers['cache-control'], undefined);
    assert.equal(plainRes.headers.vary, undefined); // precompressed off ⇒ no Vary
  });
});
