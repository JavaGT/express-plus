// The async `is.*` guard (SPEC §6.1, §13; ADR #16).
//
// A check is a per-entity named fact — a plain, awaitable function. The
// foot-gun it guards: an UNAWAITED check used in boolean position
// (`is.author() || is.blogOwner()`, `if (is.owner())`, `!is.owner()`) coerces a
// pending promise to a truthy value and silently grants everyone.
//
// ADR #16: the originally-imagined mechanism — a thenable that throws when
// coerced to a boolean — is IMPOSSIBLE in JavaScript. `ToBoolean(object)` is
// always `true` and invokes no hook; `||`, `&&`, `!`, `if (...)`, and the
// ternary test all use `ToBoolean`, none call `Symbol.toPrimitive`/`valueOf`/
// `toString`. So `is.author() || is.blogOwner()` still yields the first
// (truthy) promise. The guard that IS possible has two fail-closed layers:
//
//   (1) RUNTIME BACKSTOP — the grant engine inspects the value a `.can`/`scope`
//       body resolves to. If that value is itself a thenable (the body did
//       `return is.owner()` or `return is.a() || is.b()` without `await`), the
//       decision is an `UnawaitedCheckError`, never a silent grant. Catches
//       every case where the un-awaited check escapes AS the decision.
//   (2) LOAD-TIME STATIC ANALYSIS (primary) — scan `.can`/`scope` bodies at
//       entity-load and reject any `is.*` call not lexically inside an `await`.
//       Catches the mid-expression foot-gun before any request runs.





export class UnawaitedCheckError extends Error {
  check               ;

  constructor(message        , { check = null }                             = {}) {
    super(message);
    this.name = 'UnawaitedCheckError';
    this.check = check;
  }
}

// check(fn, { name }) -> a callable check. Calling it runs `fn` (sync or async)
// and returns a normal promise resolving to a boolean fact. A check is awaited
// at the use site: `(await is.owner()) ? grant(...) : deny(...)`.
const CHECK_RESULT                = Symbol('workbench.checkResult');











export function check(fn         , { name }                    = {})              {
  const callable = (...args           )                     => {
    // The result is a real promise (so `await` works and `||`/`&&` over two
    // results still yields a promise), tagged so the runtime backstop can tell
    // "a check escaped as the decision" from "an async body returned a boolean".
    const promise                     = Promise.resolve(fn(...args)).then(Boolean)                      ;
    promise[CHECK_RESULT] = name ?? true;
    return promise;
  };
  (callable                 ).checkName = name ?? null;
  return callable                          ;
}

// True when a value is a check's own result that escaped without `await` (the
// body returned `is.owner()` or `is.a() || is.b()` directly as the decision).
const isEscapedCheck = (v         )                          =>
  v !== null && typeof v === 'object' && CHECK_RESULT in v;

// A value is "thenable" if it has a callable `.then` (a promise or a check
// result that escaped without `await`).
const isThenable = (v         )          => typeof (v                             )?.then === 'function';

// Layer (1): RUNTIME BACKSTOP. The grant engine wraps every `.can`/`scope` body
// with this. It awaits the body once, then inspects the resolved decision: if
// the decision is itself a thenable, the body returned an un-awaited check
// (`return is.owner()` / `return is.a() || is.b()`) — fail closed.
export async function resolveDecision(
  fn         ,
  args            = [],
  { where = 'a grant' }                     = {},
)                   {
  // Inspect the body's RAW return value synchronously, before `await` collapses
  // the thenable chain. A correct body either returns a boolean directly or is
  // `async` and returns a Promise<boolean>. The foot-gun signature is a body
  // whose own returned promise resolves to ANOTHER thenable — i.e. an un-awaited
  // check escaped as the decision (`return is.owner()`, `return is.a()||is.b()`).
  const returned = fn(...args);
  if (isEscapedCheck(returned)) {
    const tag = returned[CHECK_RESULT];
    throw new UnawaitedCheckError(
      `${where} returned a check result without \`await\` (e.g. ` +
        `\`return is.owner()\` or \`return is.a() || is.b()\`), which would ` +
        `silently grant access. Await each check: ` +
        `\`(await is.owner()) ? grant(...) : deny(...)\`.`,
      { check: typeof tag === 'string' ? tag : null },
    );
  }
  const decision = await returned;
  if (isThenable(decision)) {
    throw new UnawaitedCheckError(
      `${where} resolved to a promise, not a boolean. A check was used without ` +
        `\`await\`, which would silently grant access. Await each check.`,
    );
  }
  return Boolean(decision);
}
