export function mayFieldOp(
  record: unknown,
  fieldName: string,
  capability: string,
  row: unknown,
  principal: unknown,
): boolean | Promise<boolean>;
export function mayVerb(...args: unknown[]): boolean | Promise<boolean>;
