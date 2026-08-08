// Identity marker for annotated projections. It remains package-private so
// ordinary consumers cannot opt into annotated projection behavior.
const annotatedEntityProjections = new WeakSet        ();

export function markAnnotatedEntityProjection                  (projection   )    {
  annotatedEntityProjections.add(projection);
  return projection;
}
