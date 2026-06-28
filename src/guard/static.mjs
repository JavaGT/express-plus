// Layer (2) of the async `is.*` guard: LOAD-TIME STATIC ANALYSIS (ADR #16).
//
// The primary guard. At entity-load, the framework scans every `.can`/`scope`
// body and rejects any `is.*` check call that is not lexically inside an
// `await`. This catches the foot-gun mid-expression — `is.author() ||
// is.blogOwner()` — before any request runs, the same discipline as a
// non-compilable `scope` being a load-time error.
//
// This is a deliberately lightweight lexical scan over `Function.prototype
// .toString()`, not a full parser: it strips comments and strings, then checks
// every `is.<name>(` occurrence for a preceding `await`. A lexical scan can
// have false positives on pathological source (e.g. a method literally named
// `is`), so it is paired with the runtime backstop in check.mjs — defense in
// depth, fail-closed at both layers.

import { UnawaitedCheckError } from '../check.mjs';

// Remove line/block comments and string/template literals so their contents are
// never mistaken for code. Replaces each with equivalent-length whitespace so
// reported offsets stay roughly aligned.
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += ' ';
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          out += ' ';
          i++;
        }
        out += ' ';
        i++;
      }
      out += ' ';
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Find every `is.<name>(` call and report any not immediately preceded by
// `await` (ignoring whitespace). Returns an array of unguarded check names.
function findUnawaitedChecks(code) {
  const unguarded = [];
  const callRe = /\bis\.([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = callRe.exec(code)) !== null) {
    const before = code.slice(0, m.index).replace(/\s+$/, '');
    if (!/\bawait$/.test(before)) {
      unguarded.push(m[1]);
    }
  }
  return unguarded;
}

// assertGuarded(fn, { where }) — throws UnawaitedCheckError if the function
// body calls any `is.*` check without `await`. Call this at entity-load for
// every `.can`/`scope` body.
export function assertGuarded(fn, { where = 'a grant body' } = {}) {
  const code = stripCommentsAndStrings(Function.prototype.toString.call(fn));
  const unguarded = findUnawaitedChecks(code);
  if (unguarded.length > 0) {
    const list = unguarded.map((name) => `is.${name}()`).join(', ');
    throw new UnawaitedCheckError(
      `${where} calls ${list} without \`await\`. An un-awaited check is a ` +
        `pending promise — always truthy in boolean position, silently ` +
        `granting access. Await each check: \`(await is.owner()) ? ... : ...\`.`,
      { check: unguarded[0] },
    );
  }
}

export { findUnawaitedChecks, stripCommentsAndStrings };
