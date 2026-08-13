// Deferred-value tokens — typed handles the engine resolves at commit time, not
// at declaration time. They are frozen and never magic strings.
//
// `now` is the commit instant: when a mutation commits, the engine substitutes
// the wall-clock time. It is usable directly as an effect value (e.g.
// `with: { archivedAt: now }`) — the declaration carries the TOKEN, the engine
// carries the resolution.

                           
                            
                                     
                     
  

export const now              = Object.freeze({
  kind: 'deferred',
  resolve: 'commit-instant',
  toString() {
    return 'now:commit';
  },
});
