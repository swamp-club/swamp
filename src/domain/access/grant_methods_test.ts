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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { findGrantMethodIssues } from "./grant_methods.ts";

Deno.test("findGrantMethodIssues: an unscoped grant or an empty list has no finding", () => {
  for (
    const kind of ["model", "workflow", "data", "access", "vault"] as const
  ) {
    assertEquals(
      findGrantMethodIssues({ resource: { kind, pattern: "*" } }),
      [],
    );
    assertEquals(
      findGrantMethodIssues({ resource: { kind, pattern: "*" }, methods: [] }),
      [],
    );
  }
});

Deno.test("findGrantMethodIssues: methods on workflow and data grants are reported", () => {
  for (const kind of ["workflow", "data"] as const) {
    const findings = findGrantMethodIssues({
      resource: { kind, pattern: "*" },
      methods: ["run"],
    });
    assertEquals(findings.length, 1, kind);
    assertStringIncludes(findings[0].message, `${kind} grant`);
  }
});

Deno.test("findGrantMethodIssues: model and access grants accept any method name", () => {
  for (const kind of ["model", "access"] as const) {
    assertEquals(
      findGrantMethodIssues({
        resource: { kind, pattern: "*" },
        methods: ["deploy", "create"],
      }),
      [],
    );
  }
});

Deno.test("findGrantMethodIssues: a vault grant reports each method that is not a vault verb", () => {
  const findings = findGrantMethodIssues({
    resource: { kind: "vault", pattern: "prod" },
    methods: ["put", "read", "get", "write"],
  });
  assertEquals(findings.length, 2);
  assertStringIncludes(findings[0].message, "'read'");
  assertStringIncludes(findings[1].message, "'write'");
});
