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
import { fileRouteProblem } from "./webhook_route.ts";

Deno.test("fileRouteProblem: accepts canonical routes under the webhook prefix", () => {
  for (
    const route of ["/hooks/github", "/hooks/ci/deploy", "/hooks/a_b-c.d~e"]
  ) {
    assertEquals(fileRouteProblem(route), undefined, route);
  }
});

Deno.test("fileRouteProblem: refuses routes outside the webhook prefix", () => {
  for (
    const route of ["/deploy", "/hook/x", "/hooksx/y", "/api/x", "hooks/x"]
  ) {
    assertStringIncludes(fileRouteProblem(route) ?? "", "not under", route);
  }
});

Deno.test("fileRouteProblem: refuses the bare prefix", () => {
  assertStringIncludes(fileRouteProblem("/hooks/") ?? "", "bare");
});

Deno.test("fileRouteProblem: refuses empty segments, including a trailing slash", () => {
  for (const route of ["/hooks/a//b", "/hooks/a/"]) {
    assertStringIncludes(fileRouteProblem(route) ?? "", "empty segment", route);
  }
});

Deno.test("fileRouteProblem: refuses dot and dot-dot segments", () => {
  for (const route of ["/hooks/.", "/hooks/../api/x", "/hooks/a/./b"]) {
    assertStringIncludes(fileRouteProblem(route) ?? "", "'.' or '..'", route);
  }
});

Deno.test("fileRouteProblem: refuses percent-encoding and other non-canonical characters", () => {
  for (
    const route of ["/hooks/a%20b", "/hooks/a b", "/hooks/a?b", "/hooks/a#b"]
  ) {
    assertStringIncludes(fileRouteProblem(route) ?? "", "characters", route);
  }
});
