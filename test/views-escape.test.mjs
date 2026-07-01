// views-escape.test.mjs — the view engine escapes interpolated values by
// default (fail-closed against XSS), with an explicit triple-brace raw opt-out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { resolveTemplate, escapeHtml } from '../src/index.mjs';

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
