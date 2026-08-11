                                                // Type-only storage boundary.

// A stored annotation-to-range link joined with its immutable range record.
// Ranges are DOCUMENT-scoped: the UNIQUE(document_id, start_point, end_point)
// constraint interns only within one document, and the membership composite
// FKs (annotation_id, document_id) / (range_id, document_id) enforce at the
// database boundary that an annotation and its range belong to the same row.
                                                                                                                                // Joined immutable range row.

// Canonical endpoint text independent of object property order: the endpoint
// is read BY KEY and re-serialized as the fixed `{ point, basisFrontier }`
// shape, so a reordered-key copy of the same structural endpoint interns to
// the identical range row. Non-object input fails closed.
export function canonicalEndpointJSON(endpoint         )         {
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) {
    throw new Error('annotated-text endpoint must be a structural endpoint object');
  }
  const record = endpoint                                                ;
  return JSON.stringify({ point: record.point, basisFrontier: record.basisFrontier });
}

export function annotationRangeRows(db          , prefix        , documentId        )                       {
  return db.prepare(`SELECT membership.annotation_id, membership.ordinal, range.id AS range_id,
      range.start_point, range.end_point
    FROM ${prefix}_membership AS membership
    JOIN ${prefix}_range AS range ON range.id = membership.range_id
    JOIN ${prefix}_annotation AS annotation ON annotation.id = membership.annotation_id
    WHERE annotation.document_id = ?
    ORDER BY membership.annotation_id, membership.ordinal`).all(documentId)                                   ;
}

export function attachAnnotationRange(db          , prefix        , documentId        , annotationId        , start         , end         , ordinal        )       {
  const startPoint = canonicalEndpointJSON(start);
  const endPoint = canonicalEndpointJSON(end);
  db.prepare(`INSERT OR IGNORE INTO ${prefix}_range (document_id, start_point, end_point) VALUES (?, ?, ?)`).run(documentId, startPoint, endPoint);
  const range = db.prepare(`SELECT id FROM ${prefix}_range WHERE document_id = ? AND start_point = ? AND end_point = ?`).get(documentId, startPoint, endPoint)                              ;
  if (!range) throw new Error('annotated-text range could not be interned');
  db.prepare(`INSERT INTO ${prefix}_membership (annotation_id, range_id, document_id, ordinal) VALUES (?, ?, ?, ?)`).run(annotationId, range.id, documentId, ordinal);
}
