// Pure annotated-text action builder. Zero imports — browser-safe. This is the
// single source of truth for the operation-path action grammar shared by the
// server package entry and the browser SDK. The browser is served THIS file at
// /workbench-annotated-text-action.mjs; the server package thin-wraps it with a
// private temporaryBlock mint.

const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

                    
                        
                 
                             
 

                
                                       
                                                              

                      
             
                 
                                  
 

                            
             
                 
                
                     
 

                        
                                                       
                                                         
                                                                        
                                                                 
                                                                                  
                                                                                      
                                                                              
                                                       
                                                                    
                                                                                        
                                                                                  
                                                                                                     

                                      
             
             
                              
                          
 

                                      
                                     
 

function opaqueToken(value         )                  {
  return typeof value === 'string' && OPAQUE_TOKEN.test(value);
}

function deepFreeze   (value   )    {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value)     ;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return value;
  for (const v of Object.values(value                           )) deepFreeze(v);
  return Object.freeze(value)     ;
}

function exactKeys(value                         , keys                   )          {
  return Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function position(value         , label        )           {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !exactKeys(value                           , ['positionToken', 'offset', 'affinity']) || !opaqueToken((value                               ).positionToken) ||
      !Number.isSafeInteger((value                        ).offset) || (value                      ).offset < 0 ||
      ((value                          ).affinity !== 'left' && (value                          ).affinity !== 'right')) {
    throw new Error(`annotatedTextAction: ${label} must be { positionToken, offset, affinity }`);
  }
  return { positionToken: (value                             ).positionToken, offset: (value                      ).offset, affinity: (value                                  ).affinity };
}

function selection(value         )            {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('annotatedTextAction: selection must be an object');
  }
  const keys = Object.keys(value);
  const kind = (value                      ).kind;
  const groupToken = (value                            ).groupToken;
  if (kind === 'one' && keys.length === 2 && opaqueToken(groupToken)) {
    return { kind: 'one', groupToken };
  }
  const groupTokens = (value                             ).groupTokens;
  if ((kind === 'consecutive' || kind === 'listed') && keys.length === 2 &&
      Array.isArray(groupTokens) && groupTokens.length > 0 &&
      groupTokens.every(opaqueToken) &&
      new Set(groupTokens).size === groupTokens.length) {
    return { kind, groupTokens: [...groupTokens] };
  }
  throw new Error('annotatedTextAction: selection must be one, consecutive, or listed with exact keys');
}

function annotation(value         )             {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 ||
      typeof (value                    ).id !== 'string' || (value                  ).id.length === 0 ||
      typeof (value                        ).family !== 'string' || (value                      ).family.length === 0 ||
      !(value                        ).fields || typeof (value                        ).fields !== 'object' || Array.isArray((value                        ).fields)) {
    throw new Error('annotatedTextAction: annotation must be { id, family, fields }');
  }
  return { id: (value                  ).id, family: (value                      ).family, fields: (value                                       ).fields };
}

// A kind that needs a private temporary block. Uses the command's valid opaque
// token when present; otherwise mints one via options.mintTemporaryBlock (the
// server's Node-only crypto), or fails closed.
function temporaryBlock(command                         , options                            )         {
  if (opaqueToken(command.temporaryBlock)) return command.temporaryBlock;
  if (typeof options.mintTemporaryBlock === 'function') {
    const minted = options.mintTemporaryBlock();
    if (typeof minted === 'string' && minted.length > 0) return minted;
    throw new Error('annotatedTextAction: mintTemporaryBlock must return a non-empty string');
  }
  throw new Error('annotatedTextAction: this kind requires a private temporary block');
}

export function annotatedTextAction(
  entity                                                    ,
  field                       ,
  command                     ,
  options                             = {},
)                                                        {
  if (!entity || typeof entity !== 'object' || Array.isArray(entity)) {
    throw new Error('annotatedTextAction: entity must be a non-null object');
  }
  if (typeof entity.name !== 'string' || entity.name.length === 0) {
    throw new Error('annotatedTextAction: entity name must be a non-empty string');
  }
  if (!field || typeof field !== 'object' || typeof field.fieldName !== 'string' || field.fieldName.length === 0) {
    throw new Error('annotatedTextAction: field must be an annotatedText field handle');
  }
  const fieldName = field.fieldName;
  if ((entity.fields?.[fieldName]                                  )?.kind !== 'annotatedText') {
    throw new Error(`annotatedTextAction: '${entity.name}.${fieldName}' is not an annotatedText field`);
  }

  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new Error('annotatedTextAction: command must be a non-null object');
  }
  if (typeof command.id !== 'string' || command.id.length === 0) {
    throw new Error('annotatedTextAction: command must include a non-empty document id');
  }
  if (!command.authoring || typeof command.authoring !== 'object' || Array.isArray(command.authoring) ||
      !exactKeys(command.authoring, ['version', 'stream', 'lease', 'mutationId']) ||
      command.authoring.version !== 1 || !opaqueToken(command.authoring.stream) ||
      !opaqueToken(command.authoring.lease) ||
      typeof command.authoring.mutationId !== 'string' || command.authoring.mutationId.length === 0) {
    throw new Error('annotatedTextAction: command requires an authoring stream binding');
  }

  let edit                   ;
  switch (command.kind) {
    case 'text.insert':
      if (typeof command.text !== 'string' || command.text.length === 0) throw new Error('annotatedTextAction: inserted text must be non-empty');
      edit = { kind: command.kind, at: position(command.at, 'at'), text: command.text };
      break;
    case 'text.delete':
      edit = { kind: command.kind, from: position(command.from, 'from'), to: position(command.to, 'to') };
      break;
    case 'text.replace':
      if (typeof command.text !== 'string' || command.text.length === 0) throw new Error('annotatedTextAction: replacement text must be non-empty');
      edit = { kind: command.kind, from: position(command.from, 'from'), to: position(command.to, 'to'), text: command.text };
      break;
    case 'block.split':
      edit = { kind: command.kind, at: position(command.at, 'at'), temporaryBlock: temporaryBlock(command, options) };
      break;
    case 'block.merge':
      if (!opaqueToken(command.leftPositionToken) || !opaqueToken(command.rightPositionToken)) {
        throw new Error('annotatedTextAction: block.merge requires position tokens');
      }
      edit = { kind: command.kind, leftPositionToken: command.leftPositionToken, rightPositionToken: command.rightPositionToken };
      break;
    case 'annotation.apply':
      if (!command.annotation || typeof command.annotation !== 'object' || Array.isArray(command.annotation)) {
        throw new Error('annotatedTextAction: annotation.apply requires annotation');
      }
      edit = { kind: command.kind, annotation: command.annotation, from: position(command.from, 'from'), to: position(command.to, 'to') };
      break;
    case 'annotation.detach':
      if (typeof command.annotationId !== 'string' || command.annotationId.length === 0 || !opaqueToken(command.positionToken)) {
        throw new Error('annotatedTextAction: annotation.detach requires annotationId and positionToken');
      }
      edit = { kind: command.kind, annotationId: command.annotationId, positionToken: command.positionToken };
      break;
    case 'annotation.remove':
      if (typeof command.annotationId !== 'string' || command.annotationId.length === 0) {
        throw new Error('annotatedTextAction: annotation.remove requires annotationId');
      }
      edit = { kind: command.kind, annotationId: command.annotationId };
      break;
    case 'block.continue':
      edit = { kind: command.kind, at: position(command.at, 'at'), temporaryBlock: temporaryBlock(command, options) };
      break;
    case 'block-group.assignment.set':
      edit = { kind: command.kind, selection: selection(command.selection), annotation: annotation(command.annotation) };
      break;
    case 'block-group.assignment.clear':
      if (typeof command.family !== 'string' || command.family.length === 0) {
        throw new Error('annotatedTextAction: block-group.assignment.clear requires a non-empty family');
      }
      edit = { kind: command.kind, selection: selection(command.selection), family: command.family };
      break;
    case 'block.split-and-assign':
      edit = { kind: command.kind, at: position(command.at, 'at'), temporaryBlock: temporaryBlock(command, options), annotation: annotation(command.annotation) };
      break;
    default:
      throw new Error(`annotatedTextAction: unsupported command kind '${String(command.kind)}'`);
  }

  const payload = deepFreeze                            ({
    version: 9,
    id: command.id,
    authoring: { ...command.authoring },
    edit,
  });

  return deepFreeze({
    type: `${entity.name}.${fieldName}.operation`,
    payload,
  });
}