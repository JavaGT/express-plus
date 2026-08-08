// Identity marker for annotated projections. It remains package-private so
// ordinary consumers cannot opt into annotated projection behavior.
const annotatedEntityProjections = new WeakSet<object>();

export function markAnnotatedEntityProjection<T extends object>(projection: T): T {
  annotatedEntityProjections.add(projection);
  return projection;
}
