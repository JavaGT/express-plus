// views-escape.test.mjs — the view engine escapes interpolated values by
// default (fail-closed against XSS), with an explicit triple-brace raw opt-out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { resolveTemplate, escapeHtml, matchExtension, isSafePath } from '../src/internal.mjs';
import { stripPrefix, serveStatic } from '../src/views.mjs';

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
