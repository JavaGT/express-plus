// Decision traces for the authorization adapter (S5/A2).
//
// Admission decisions are two-valued on their PUBLIC surface (admitted +
// reasonCode + capabilities); the named checks that ran are a DEV-only
// diagnostic. When tracing is enabled (env/test flag), the adapter attaches a
// `trace` listing each check and its boolean outcome — never payload values (no
// principal ids, no row content, no failure strings, no denied-reason text).
// Production decisions carry `trace: null` and the generic failure strings the
// transports already render (401 unauthorized / 403 forbidden / 404 not found),
// matching the opaque pre-adapter responses.

export interface DecisionTraceEntry {
  readonly check: string;
  readonly outcome: boolean;
}

// A per-decision trace collector. A fresh collector is used per admit() call;
// `take()` freezes and detaches the recorded checks once, so the returned
// decision is immutable and no later record can mutate it. A disabled
// collector records nothing and returns null — the production default.
export class DecisionTrace {
  readonly enabled: boolean;
  #entries: DecisionTraceEntry[];
  #taken: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
    this.#entries = [];
    this.#taken = false;
  }

  record(check: string, outcome: boolean): void {
    if (!this.enabled || this.#taken) return;
    this.#entries.push(Object.freeze({ check, outcome }));
  }

  take(): readonly DecisionTraceEntry[] | null {
    if (!this.enabled) return null;
    if (!this.#taken) {
      this.#taken = true;
      Object.freeze(this.#entries);
    }
    return this.#entries;
  }
}
