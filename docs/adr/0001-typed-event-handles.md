# Typed event handles own event-name grammar

Status: accepted

Express+ event identity is a typed handle that derives the persisted event string; `_Log.eventType` remains the durable string serialization for compatibility. This concentrates the event-name grammar behind one module so entity projection, live fan-out, and pipeline authorization no longer parse dotted strings independently, while generic pipeline string events remain a narrow compatibility adapter.