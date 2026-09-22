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

// Compile-time parity check between the serve wire protocol
// (./protocol.ts, `ServerRequest`) and the zod schemas that validate
// incoming requests (./connection.ts, `ValidatedServerRequest`).
//
// zod `z.object` strips unknown keys, so a payload field declared in
// protocol.ts but missing from its schema is silently dropped before the
// handler sees it. The CLI sends it, the type checker is happy (the
// validated value is cast to `ServerRequest`), and the flag just does
// nothing over serve. That is how `workflow resume --from` came to refuse
// every failed run through serve (swamp-club#2356).
//
// Two pinned checks, both enforced by `deno check`:
//   1. Schema coverage: the request types with no schema at all.
//   2. Field parity: for every request type that has a schema, the payload
//      fields protocol.ts declares that the schema drops.
// Each is pinned to an exact set, so both a new gap and a fixed one fail to
// type-check. When you close a gap, remove it from the pin.

import type { ServerRequest } from "./protocol.ts";
import type { ValidatedServerRequest } from "./connection.ts";

type MutuallyAssignable<A, B> = [A] extends [B] ? [B] extends [A] ? true
  : false
  : false;

/**
 * The named keys of a payload type. Distributes over union payloads, and
 * treats index-signature payloads (`Record<string, never>`) as keyless —
 * otherwise `keyof` yields `string` and every empty payload reports drift.
 */
type DeclaredKeys<P> = P extends unknown
  ? string extends keyof P ? never : keyof P & string
  : never;

type PayloadOf<R> = R extends { payload?: infer P } ? NonNullable<P> : never;

// ── 1. Schema coverage ───────────────────────────────────────────────────

type SchemaLessTypes = Exclude<
  ServerRequest["type"],
  ValidatedServerRequest["type"]
>;

// Request types in the protocol with no zod schema: validateServerRequest
// would reject them outright with invalid_request. Every type has one
// (swamp-club#2347 closed the last gaps, tracked in swamp-club#2361).
const _schemaLessTypes: MutuallyAssignable<SchemaLessTypes, never> = true;
void _schemaLessTypes;

// ── 2. Field parity ──────────────────────────────────────────────────────

type SchemaCoveredTypes = Exclude<ServerRequest["type"], SchemaLessTypes>;

/** `"<request type>.<field>"` for every protocol field its schema drops. */
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
  "access.check.groups" | "access.can-i.groups"
> = true;
void _droppedFields;

// A tiny runtime smoke test so this file registers in the test summary
// rather than passing as a silent no-op. The real assertions are the
// type-level constants above, enforced by `deno check`.
Deno.test("serve request schemas stay in sync with src/serve/protocol.ts (compile-time)", () => {
  // Intentionally trivial: reaching this line means the compile-time
  // checks above type-checked.
});
