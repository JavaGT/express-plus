// Node/test entrypoint for the browser family module. The server serves the
// dependency-free family source at this same URL (with the annotated-text import
// rewritten to the browser SDK path) so browser and server fold one grammar.
export * from '../src/annotated-text-family.mjs';
