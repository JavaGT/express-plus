// Durable events may contain framework-only projection metadata. Delivery keeps
// the committed event shape but never exposes the reserved envelope.

export function publicEvent                                                     (event   )    {
  if (!event?.data || !Object.hasOwn(event.data, '__workbench')) return event;
  const { __workbench: _metadata, ...data } = event.data;
  return { ...event, data }     ;
}
