export function mayFieldOp(
  record: unknown,
  fieldName: string,
  capability: string,
  row: unknown,
  principal: unknown,
): boolean | Promise<boolean>;
export function mayVerb(...args: any[]): boolean | Promise<boolean>;
export function mayRow(...args: any[]): boolean | Promise<boolean>;
export function rowCapabilities(...args: any[]): any;
export function fieldCapabilities(...args: any[]): any;
export function authorizeRow(...args: any[]): any;
