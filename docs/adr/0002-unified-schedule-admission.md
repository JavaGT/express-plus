# Schedule admission is one declared-trigger seam

Status: accepted

Tick and schedule system principals are admitted by `admitSystemMutation`, which discriminates by the entity's declared trigger kind rather than by parsing source string shape in `serve.mjs`. The schedule module owns the source grammar, row re-read, due or while re-check, and payload comparison; effect-originated admission stays in the dispatch spine because it is not schedule grammar.