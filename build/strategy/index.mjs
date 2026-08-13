                                                              
                                             
import { MAP_SIDE_TABLE_STRATEGY } from './map.mjs';
import { ORDERED_SIDE_TABLE_STRATEGY } from './ordered.mjs';
import { LOG_SIDE_TABLE_STRATEGY } from './log.mjs';
import { EPHEMERAL_SIDE_TABLE_STRATEGY } from './ephemeral.mjs';
import { FTS_STRATEGY } from '../fts-strategy.mjs';

// Shared strategy helpers. Re-exported here so consumers that import from the
// strategy barrel (annotated-text-admit, auth/invitation via side-table-strategy)
// keep working; the per-strategy modules import them from ./shared.mjs directly.
export {
  authorizeFieldOp,
  mapMutationAction,
} from './shared.mjs';

// ---------------------------------------------------------------------------
// Shared strategy types
// ---------------------------------------------------------------------------

// The declared shape of a field. Each side-table strategy reads only the
// sub-shape it owns (kind/type/entry/of/roles); the index signature keeps
// unknown declared keys from closing the type to specific stores.
                                  
               
                
                   
                            
                                                    
                                                                    
                         
 

// [string, FieldDescriptor] pairs — the fieldEntries shape every strategy
// receives for its matched fields.
                                                       

// The minimal principal handle a strategy reads: just the requesting identity.
                                    
               
                         
 

// A hydrated target entity: the map strategy's toArray resolves a ref's target
// through entityOf and hydrates each member row with the requesting principal.
                               
               
                                                                      
 

// A committed field event as seen by a projection consumer. Strategies read
// only data; identity is concentrated in the event handle.
                             
               
                 
               
                                        
 

// The dispatch result side-table handles read emitted events from.
                                 
              
                    
                                 
 

// The dispatch function a handle must forward its field mutation to.
                           
           
                     
                 
                     
                        
                   
                              
 

// The input a strategy's handle factory receives from the entity hydrator.
                                       
                  
                     
                    
                              
                                         
                                                  
                     
               
                                                                
 

// The event/handle subset a strategy projection reader needs. `handle` is the
// full event handle — narrowing it by kind (as the projections do) exposes the
// field/nativeName variants — and `event` carries only the committed data.
                                  
                                 
 

// The input a strategy's projectionApply receives.
                                           
                     
                             
                              
                         
               
 

// The input a strategy's generated mutate handler receives.
                                  
                                                      
  

// The one shape every side-table strategy implements. Matches decides whether a
// declared field belongs to the strategy; the rest derives DDL, event types,
// dispatch-level handlers, and the row projection from declared field entries.
                                    
                                                
                                                
                                                                       
                 
                       
                               
                                                            
                                                            
                                                                                         
 

// ---------------------------------------------------------------------------
// Strategy collection
// ---------------------------------------------------------------------------

const SIDE_TABLE_STRATEGIES                               = Object.freeze([
  FTS_STRATEGY,
  MAP_SIDE_TABLE_STRATEGY,
  ORDERED_SIDE_TABLE_STRATEGY,
  LOG_SIDE_TABLE_STRATEGY,
  EPHEMERAL_SIDE_TABLE_STRATEGY,
]);

                                         
                              
                       
 

export function collectSideTableStrategies(fields                                 )                           {
  return SIDE_TABLE_STRATEGIES
    .map((strategy) => ({
      strategy,
      fields: Object.entries(fields).filter(([, descriptor]) => strategy.matches(descriptor)),
    }))
    .filter((entry) => entry.fields.length > 0);
}

export function sideTableDDL(entity                  , fieldName        , descriptor                 )                {
  const strategy = SIDE_TABLE_STRATEGIES.find((candidate) => candidate.matches(descriptor));
  return strategy ? strategy.ddl(entity.name, fieldName, descriptor) : null;
}

// ---------------------------------------------------------------------------
// Strategy constants
// ---------------------------------------------------------------------------

export { MAP_SIDE_TABLE_STRATEGY, ORDERED_SIDE_TABLE_STRATEGY, LOG_SIDE_TABLE_STRATEGY, EPHEMERAL_SIDE_TABLE_STRATEGY, FTS_STRATEGY };
