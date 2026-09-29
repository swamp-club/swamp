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

import { assertEquals, assertThrows } from "@std/assert";
import fc from "fast-check";
import {
  parsePrincipal,
  PrincipalKindSchema,
  principalToString,
  SERVICE_PRINCIPAL_IDS,
} from "./principal.ts";

const arbKind = fc.constantFrom(...PrincipalKindSchema.options);

const arbId = fc.stringOf(
  fc.constantFrom(..."abcdefgh0123-_@/.:".split("")),
  { minLength: 1, maxLength: 20 },
);

Deno.test("parsePrincipal: round-trips through principalToString for every kind", () => {
  fc.assert(
    fc.property(arbKind, arbId, fc.constantFrom(...SERVICE_PRINCIPAL_IDS), (
      kind,
      anyId,
      serviceId,
    ) => {
      // A service principal is one of the built-ins; other kinds take any id.
      const id = kind === "service" ? serviceId : anyId;
      const text = `${kind}:${id}`;
      const parsed = parsePrincipal(text);
      assertEquals(parsed, { kind, id });
      assertEquals(principalToString(parsed), text);
    }),
  );
});

Deno.test("parsePrincipal: rejects any kind outside PrincipalKindSchema", () => {
  const known = new Set<string>(PrincipalKindSchema.options);
  const arbUnknownKind = fc.stringOf(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz-".split("")),
    { minLength: 1, maxLength: 12 },
  ).filter((kind) => !known.has(kind));
  fc.assert(
    fc.property(arbUnknownKind, arbId, (kind, id) => {
      assertThrows(
        () => parsePrincipal(`${kind}:${id}`),
        Error,
        "Invalid principal kind",
      );
    }),
  );
});
