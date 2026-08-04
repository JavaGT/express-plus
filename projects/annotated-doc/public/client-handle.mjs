// Browser-safe Doc/body handles for createAnnotatedTextHttpSession.
// Keep aligned with projects/annotated-doc/server.mjs body declaration.

export const DocClientField = Object.freeze({
  fieldName: 'body',
  annotations: Object.freeze({
    note: Object.freeze({
      family: 'note',
      annotationName: 'note',
      appliesTo: 'block',
      cardinality: 'many',
      actions: Object.freeze([]),
      empty: 'delete',
    }),
  }),
  measurements: Object.freeze({
    words: Object.freeze({
      family: 'words',
      measurementName: 'words',
    }),
  }),
  capabilities: null,
});

export const DocClient = Object.freeze({
  name: 'Doc',
  fields: Object.freeze({
    body: Object.freeze({ kind: 'annotatedText' }),
    project: Object.freeze({ kind: 'value' }),
    owner: Object.freeze({ kind: 'value' }),
  }),
  body: DocClientField,
});
