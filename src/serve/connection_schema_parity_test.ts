// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

// compile-time parity of protocol.ts ServerRequest with the zod schemas:
// z.object strips unknown keys, so a field missing from a schema is silently
// dropped; pinned to exact sets so a new or fixed gap fails

import type { ServerRequest } from "./protocol.ts";
import type { ValidatedServerRequest } from "./connection.ts";

type MutuallyAssignable<A, B> = [A] extends [B] ? [B] extends [A] ? true
  : false
  : false;

/**
 * index-signature payloads (Record<string, never>) count as keyless, otherwise
 * keyof yields string and every empty payload reports drift
 */
type DeclaredKeys<P> = P extends unknown
  ? string extends keyof P ? never : keyof P & string
  : never;

type PayloadOf<R> = R extends { payload?: infer P } ? NonNullable<P> : never;

type SchemaLessTypes = Exclude<
  ServerRequest["type"],
  ValidatedServerRequest["type"]
>;

const _schemaLessTypes: MutuallyAssignable<SchemaLessTypes, never> = true;
void _schemaLessTypes;

type SchemaCoveredTypes = Exclude<ServerRequest["type"], SchemaLessTypes>;

type DroppedFields = {
  [K in SchemaCoveredTypes]: Exclude<
    DeclaredKeys<PayloadOf<Extract<ServerRequest, { type: K }>>>,
    DeclaredKeys<PayloadOf<Extract<ValidatedServerRequest, { type: K }>>>
  > extends infer F ? [F] extends [never] ? never : `${K}.${F & string}`
    : never;
}[SchemaCoveredTypes];

// Fields dropped on purpose. Group membership is taken from the
// authenticated connection (getConnectionGroups), never from the client, so
// accepting `groups` on the wire would let a caller assert its own groups.
const _droppedFields: MutuallyAssignable<
  DroppedFields,
  "access.check.groups"
> = true;
void _droppedFields;

// A tiny runtime smoke test so this file registers in the test summary
// rather than passing as a silent no-op. The real assertions are the
// type-level constants above, enforced by `deno check`.
Deno.test("serve request schemas stay in sync with src/serve/protocol.ts (compile-time)", () => {
  // Intentionally trivial: reaching this line means the compile-time
  // checks above type-checked.
});
