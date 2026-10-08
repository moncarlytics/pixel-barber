// tests/db/rbac/types.ts
// The permission matrix's vocabulary (Docs/superpowers/specs/2026-10-08-role-permission-check-design.md).
export const ROLES = [
  'anon',
  'customer',
  'barber',
  'receptionist',
  'manager',
  'analyst',
  'owner',
  'otherManager',
] as const;
export type Role = (typeof ROLES)[number];

export type ReadScope = 'none' | 'own' | 'branch' | 'all';
export type WriteScope = 'deny' | 'own' | 'branch' | 'all';
export type Outcome = 'allow' | 'deny' | 'empty' | 'internal';

/** One expectation: intended access, today's access when it differs, and why. */
export interface Expect<T> {
  expect: T;
  currently?: T;
  /** Stable id: G-… for clear gaps (to fix), J-… for judgment calls (pending the user). */
  gap?: string;
  why: string;
}

export type PerRole<T> = Record<Role, Expect<T>>;

/** Fixture row ids for one table: rows at branch A, at branch B, and the row(s) "own" means. */
export interface RowSet {
  a: string[];
  b: string[];
  /** Rows owned by the customer or barber login (subset of a or b). */
  own: string[];
}

export interface TableEntry {
  table: string;
  /** Column holding the row identity used in RowSet (usually 'id'). */
  key: string;
  /** Key into the fixture's row sets when it differs from `table` (default `table`). */
  rowsKey?: string;
  read: PerRole<ReadScope>;
}

/** The value a runner asserts. */
export const effective = <T>(e: Expect<T>): T => e.currently ?? e.expect;
