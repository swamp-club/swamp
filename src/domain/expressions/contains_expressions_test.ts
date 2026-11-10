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

import { assertEquals } from "@std/assert";
import { containsExpressions } from "./contains_expressions.ts";

Deno.test("containsExpressions: finds an expression nested in a record", () => {
  assertEquals(
    containsExpressions({
      auth: { mode: "servicePrincipal", clientSecret: "${{ env.SECRET }}" },
    }),
    true,
  );
});

Deno.test("containsExpressions: finds an expression inside an array", () => {
  assertEquals(
    containsExpressions({
      hosts: ["a.example.com", "https://${{ vault.get(infra, host) }}"],
    }),
    true,
  );
});

Deno.test("containsExpressions: false for plain strings and scalars", () => {
  assertEquals(
    containsExpressions({
      bucket: "my-bucket",
      note: "costs $5 { per } month",
      retries: 3,
      forcePathStyle: true,
      endpoint: null,
      tags: [],
    }),
    false,
  );
});

Deno.test("containsExpressions: walks deep nesting without recursion", () => {
  let nested: unknown = "${{ env.DEEP }}";
  for (let i = 0; i < 50_000; i++) nested = { next: nested };
  assertEquals(containsExpressions(nested), true);
});
