# Durable History Cursor Policy

**Status**: `[IMPLEMENTED — TERRA APPROVED 2026-07-25]`

## Fact vs Cursor Semantics

Durable history has two orthogonal concerns:

- **Receipt metadata** — every action produces an `_ActionReceipt` row regardless of session or cursor policy. This is the permanent record of the action having been committed, preserving `actionType`, `actionData`, `principalKey`, `sessionId`, and `operation`. This metadata is always stored, even for sessionless actions and cursor-excluded actions.

- **Cursor entry** — the undo/redo cursor (`_HistoryCursor`) is only written for actions with a session whose cursor policy is `eligible`. The cursor tracks the position in the undo/redo stack for a given `(principalKey, sessionId, scope)` triple.

## Cursor Policy

Cursor policy is a `Map<actionType, 'eligible' | 'excluded'>` passed to `createServer` (via `kernel.mjs`). It determines whether an action type participates in the undo/redo cursor.

- Default policy for any action type not in the map: **eligible**.
- Generated native CRDT text actions are explicitly registered as **excluded** by
  `createCrudHandlers`; `collectAppEntities` reads that trusted generated metadata.
- Registered actions may declare `history: { cursor: 'excluded' }` in their declaration metadata, which is validated at load time (closed keys, known values only).
- A batch whose **any** child action is excluded produces no cursor entry for the batch.

## Annotated Text Eligibility Prerequisites

For an annotated text field's native CRDT action to be cursor-excluded, its generated
action declaration must explicitly carry cursor policy `'excluded'`. The action name
does not determine policy. A future composite annotated-text action can therefore use
any name and become cursor-eligible only after its composite inverse and redo are ready.

## Key Design Points

- **No type-suffix inference.** Cursor policy is purely metadata-based. The old approach of inferring exclusion from suffix patterns (`.apply`) in the history runtime is removed. All exclusion is governed by the explicit `cursorPolicy` map.
- **Request cannot override policy.** The `history.session` field on a dispatch request enables cursor tracking for eligible actions, but no request field can change an action's eligibility — that is server-declared policy only.
- **Sessionless actions always produce receipt metadata** but never produce a cursor entry, regardless of cursor policy.
