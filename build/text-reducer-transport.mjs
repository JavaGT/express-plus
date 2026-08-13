import { textCheckpoint, createTextState } from './annotated-text.mjs';

const TEXT_REDUCER = 'workbench.text';

                           
                
                
 

                        
               
                                           
 

                     
                      
                           
 

function textFields(entity                                 )                              {
  if (!entity) return [];
  return Object.entries(entity.fields ?? {}).filter(([, descriptor]) =>
    descriptor.kind === 'crdt' && descriptor.type === 'text');
}

                                  
                 
             
                
                  
                  
                      
 

export function textReducerSeeds(entity                                 , id         )                    {
  if (id === null || id === undefined) return [];
  return textFields(entity).map(([field]) => ({
    entity: entity .name          ,
    id: String(id),
    field,
    reducer: TEXT_REDUCER,
    version: 1,
    checkpoint: textCheckpoint(createTextState()),
  }));
}

// SQLite retains the canonical checkpoint while hydrated rows deliberately
// expose only visible application values. Transport is the sole bridge.
export function textReducerCheckpoints(entity                                 , storedRow                              )                    {
  if (!storedRow) return [];
  return textFields(entity).map(([field]) => ({
    entity: entity .name,
    id: String(storedRow.id),
    field,
    reducer: TEXT_REDUCER,
    version: 1,
    checkpoint: JSON.parse(storedRow[field]          ),
  }));
}

                          
                             
                
                          
 

export function createdTextReducerSeeds(entity                                 , event                                   )                                {
  if (event?.handle?.kind !== 'created' && !event?.type?.endsWith('.created')) return undefined;
  const reducers = textReducerSeeds(entity, event.data?.id);
  return reducers.length > 0 ? reducers : undefined;
}
