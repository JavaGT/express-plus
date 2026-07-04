// drawing-canvas.mjs — a collaborative drawing canvas (vector editing)
// expressed in the workbench shipped API.
//
// PERSONA: "The Realtime Artist" — needs 60Hz ephemeral live strokes,
// ordered shape layers, polyline CRDT for freedraw, and backpressure.
//
// Key APIs exercised:
//   ephemeral(cells) — per-connection live fields (in-progress stroke)
//   polyline.crdt()   — CRDT-kind field for vector data
//   list(text())      — ordered shape collection with fractional-index keyspace
//   inherit           — Shape inherits Canvas grant
//   field .can        — per-field visibility gating
//   subscribe(Entity,id,{fields}) — field-keyed interest

import { entity, text, number, date, ref, map, boolean, polyline, ephemeral, list, grant, deny, read, write, subscribe, admin, anyOf, scope, never, inherit, router } from 'workbench';

const VIEWER  = [read, subscribe];
const EDITOR  = [read, write, subscribe];
const OWNER   = [read, write, subscribe, admin];

// ═══════════════════════════════════════════════════════════════════════════════
// Canvas — the top-level collaborative drawing surface.
// ═══════════════════════════════════════════════════════════════════════════════

export const Canvas = entity('Canvas', {
    name: text({
    validate: v => v.length <= 200 || 'name too long',
  }),

  owner: ref('User', { role: 'owner', readonly: true }),

  collaborators: map(ref('User'), {
    role: ['viewer', 'collaborator'],
    default: {},
  }).can(async ({ is }) =>
    (await is.owner())
      ? grant(...OWNER)
      : deny('only the owner may manage collaborators')),

  // Shipped: ordered list of text labels for shape layers (z-order).
  // Each shape stores its layer index via fractional-index keyspace.
  // The `list()` field type (kind: ordered) owns insertAt / move / reorder.
  shapeOrder: list(text()),

  // Shipped: ephemeral(cells) — per-connection non-persisting field.
  // Exposes .set({ activeStroke, cursor }) for 60Hz live broadcasts.
  // The pace contract (field-pace.mjs) coalesces at 15fps with latest-wins.
  liveStroke: ephemeral({
    activeStroke: polyline.crdt(),
  }),

  createdAt: date({ default: () => new Date() }),
  updatedAt: date({ touch: true }),

  checks: {
    // `owner` is auto-derived from `owner: ref('User', { role: 'owner' })`
    // above (DECISIONLOG #54) and is NOT redeclared here — redeclaring a
    // ref-role-derived check name is a load-time error.
    collaborator: ({ Canvas: c, principal: p }) => c.collaborators.has(p.id),
  },

  grant: () => [
    scope(({ is }) => anyOf(is.owner(), is.collaborator()))
      .can(async ({ is }) => {
        if (await is.owner())         return grant(...OWNER);
        if (await is.collaborator())  return grant(...EDITOR);
        return deny('no capability for this principal');
      }),
  ],

  routes: (r) => {
    r.resource();
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// Shape — a single shape layer on a canvas (rect, ellipse, freedraw).
//
// Grant inherited from Canvas. The Shape's auth flows from the parent canvas
// membership — no separate grant clause.
// ═══════════════════════════════════════════════════════════════════════════════

const inheritCanvas = inherit(Canvas, { via: 'canvas' });

export const Shape = entity('Shape', {
    canvas: ref('Canvas', { required: true }),

  creator: ref('User', { role: 'creator', readonly: true }),

  name: text({ default: 'Shape' }),

  type: text({
    default: 'rect',
    validate: v =>
      ['rect', 'ellipse', 'freedraw', 'text', 'arrow'].includes(v)
        || 'invalid shape type',
  }),

  // Bounding box (rect/ellipse/arrow)
  x:       number({ default: 0 }),
  y:       number({ default: 0 }),
  width:   number({ default: 100 }),
  height:  number({ default: 100 }),

  // Shipped: polyline.crdt() for freedraw vector data.
  // Whole-value replace for MVP; per-segment CRDT merge DEFERRED per SPEC.
  points: polyline.crdt(),

  // Shipped: field-level visibility gating with is.*() registry checks.
  // Editors/owners see all shapes; collaborators see visible ones.
  visible: boolean({ default: true })
    .can(async ({ is, entity }) => {
      if (await is.editor()) return grant(read, subscribe);
      if (await is.owner()) return grant(read, subscribe);
      if (await is.collaborator() && entity.visible) return grant(read, subscribe);
      return grant(subscribe);
    }),

  fillColor:   text({ default: '#ffffff', max: 9 }),
  strokeColor: text({ default: '#000000', max: 9 }),
  strokeWidth: number({ default: 2, min: 0, max: 100 }),
  opacity:     number({ default: 100, min: 0, max: 100 }),

  createdAt: date({ default: () => new Date() }),
  updatedAt: date({ touch: true }),

  grant: inheritCanvas,

  checks: {
    collaborator: ({ entity, principal: p }) =>
      entity.canvas.collaborators.has(p.id),
    editor: async ({ entity, principal: p }) => {
      const canvas = await entity.canvas;
      return canvas.collaborators.get(p.id)?.role === 'collaborator';
    },
    owner: async ({ entity, principal: p }) => {
      const canvas = await entity.canvas;
      return canvas.owner === p.id;
    },
  },

  routes: (r) => {
    r.resource();
  },
});
