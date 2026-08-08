export function lawsOf(kind: string): { invertible?: boolean; [key: string]: unknown };
export function resolveStrategy(kind: string): any;
export function deserializeField(...args: any[]): any;
export function serializeField(...args: any[]): any;
export function structCellColumn(...args: any[]): string;
export function verifyHash(...args: any[]): any;
export function flattenStruct(...args: any[]): any;
export function validateMutation(...args: any[]): any;
export function validateMaterializedField(...args: any[]): any;
export class ValidationError extends Error {
  constructor(...args: any[]);
}
