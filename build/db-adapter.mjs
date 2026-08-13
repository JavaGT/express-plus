// db-adapter.mjs — the database adapter contract (epic scope#23, S1/A1).
//
// CONTRACT: an adapter opens a workbench database from LOGICAL configuration —
// a directory plus a logical name (or a memory database) — never from a
// physical filename. Opening returns the sync single-writer DbHandle (see
// driver.ts) plus a closed capability set and the maintenance surface
// (close/checkpoint/integrityCheck). Non-SQLite backends must satisfy the same
// shape, so the default is expressible but never hardwired here.
//
// This module is a PURE typed contract: no node:sqlite import, no filesystem
// side effects, no I/O. It declares shapes and the `capabilitiesOf()`
// normalizer only. The SQLite adapter implementation lives in S1/A5.

                                            

// Physical-path keys an adapter-options shape must never declare: a backend
// could otherwise smuggle a file path through the config's `options` slot,
// breaking the logical-config contract (the adapter resolves the file from the
// logical request, never from an option).
                                                     

// Adapter options a config may carry. Any record shape is welcome, but a
// physical-path key is banned at the type level — `DbAdapterOptions` can never
// express where a database physically lives.
                                                                    
                                             
  

// Logical configuration: apps request a database by directory + logical name,
// never by a physical filename. A file path is deliberately absent — the
// adapter resolves it from the logical request.
                            
                                                      
     
                              
                         
                                    
                             
  

// Closed capability set a backend declares after opening. `encryption` is
// always `false` in this release (owner decision): no backend supports it yet.
                              
                                     
                                 
                                        
                                   
                                
                             
  

// The boolean flags a backend may declare; encryption is never a choice.
                                                                           

                                
                                         
                           
  

                               
                       
                             
                                                 
  

// A controlled, READ-ONLY connection description for external readers (e.g.
// Prisma). It carries no write authority and never exposes a write path — only
// the read-only mirror surface. `mode` and `readOnly` are literals the S1/A5
// adapter pins, and `options` (if any) are read-only connection knobs in the
// same path-key-free shape as a config's options. (Interface only here; the
// SQLite form is produced by the S1/A5 adapter.)
                                     
                               
                             
                          
                                    
                                      
  

                              
                            
                                        
                
                     
                                    
  

                            
                                                         
                                      
 

// Normalize a partial capability declaration into the closed DbCapabilities
// shape. Unspecified flags default to false and encryption stays false.
export function capabilitiesOf(
  flags                                             = {},
)                 {
  return {
    transactionalDdl: flags.transactionalDdl ?? false,
    onlineBackup: flags.onlineBackup ?? false,
    readOnlyConnections: flags.readOnlyConnections ?? false,
    integrityCheck: flags.integrityCheck ?? false,
    maintenance: flags.maintenance ?? false,
    encryption: false,
  };
}
