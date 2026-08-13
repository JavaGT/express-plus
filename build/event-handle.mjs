export const EventKind = Object.freeze({
  created: 'created',
  updated: 'updated',
  removed: 'removed',
  fieldSet: 'fieldSet',
  native: 'native',
}         );

                                                                 

const LIFECYCLE_TYPES = new Set([
  EventKind.created,
  EventKind.updated,
  EventKind.removed,
]);
const LIFECYCLE_VERBS = Object.freeze({
  [EventKind.created]: 'create',
  [EventKind.updated]: 'update',
  [EventKind.removed]: 'remove',
}         );

                           
                                 
                          
                     
 

                                 
                        
                                              
                            
      
                        
                                              
                            
      
                        
                                              
                            
      
                        
                                               
                             
                            
      
                        
                                             
                             
                                  
                            
       

function assertName(label        , value         )       {
  if (typeof value !== 'string' || value.length === 0 || value.includes('.')) {
    throw new Error(`${label} must be a non-empty dot-free string`);
  }
}

                       
                 
                  
                 
                      
               
 

function freezeHandle(parts             )                      {
  const handle                          = { brand: 'event-handle', ...parts };
  Object.defineProperty(handle, 'toString', { value: () => handle.type });
  return Object.freeze(handle)                                  ;
}

export function created(entity        )                      {
  assertName('event entity', entity);
  return freezeHandle({
    entity,
    kind: EventKind.created,
    type: `${entity}.created`,
  });
}

export function updated(entity        )                      {
  assertName('event entity', entity);
  return freezeHandle({
    entity,
    kind: EventKind.updated,
    type: `${entity}.updated`,
  });
}

export function removed(entity        )                      {
  assertName('event entity', entity);
  return freezeHandle({
    entity,
    kind: EventKind.removed,
    type: `${entity}.removed`,
  });
}

export function fieldSet(entity        , field        )                      {
  assertName('event entity', entity);
  assertName('event field', field);
  return freezeHandle({
    entity,
    kind: EventKind.fieldSet,
    field,
    type: `${entity}.${field}.set`,
  });
}

export function native(
  entity        ,
  field        ,
  nativeName        ,
)                      {
  assertName('event entity', entity);
  assertName('event field', field);
  assertName('event native name', nativeName);
  if (nativeName === 'set') return fieldSet(entity, field);
  return freezeHandle({
    entity,
    kind: EventKind.native,
    field,
    nativeName,
    type: `${entity}.${field}.${nativeName}`,
  });
}

export function parseEventType(type        )                      {
  if (typeof type !== 'string') {
    throw new Error(`event type must be a string, got ${typeof type}`);
  }
  const parts = type.split('.');
  if (parts.length === 2) {
    const [entity, kind] = parts;
    if (LIFECYCLE_TYPES.has(kind                            )) {
      if (kind === EventKind.created) return created(entity);
      if (kind === EventKind.updated) return updated(entity);
      return removed(entity);
    }
  }
  if (parts.length === 3) {
    const [entity, field, nativeName] = parts;
    return native(entity, field, nativeName);
  }
  throw new Error(`invalid event type '${type}'`);
}

export function lifecycleVerb(
  handle                                        ,
)                                             {
  if (!handle || handle.brand !== 'event-handle') return undefined;
  // Native field mutations change an existing entity row just like an update.
  // Routing them through the lifecycle admission keeps field actions on the
  // same row-grant authorization path as PATCH.
  if (handle.kind === EventKind.native) return 'update';
  return LIFECYCLE_VERBS[
    handle.kind                                                                                  
  ];
}
