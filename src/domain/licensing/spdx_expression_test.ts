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
import {
  formatSpdxExpression,
  MAX_SPDX_EXPRESSION_LENGTH,
  parseSpdxExpression,
  spdxLeaves,
  SpdxSyntaxError,
} from "./spdx_expression.ts";

Deno.test("parseSpdxExpression: a single id", () => {
  assertEquals(parseSpdxExpression("MIT"), {
    kind: "license",
    id: "MIT",
    orLater: false,
  });
});

Deno.test("parseSpdxExpression: surrounding whitespace is ignored", () => {
  assertEquals(formatSpdxExpression(parseSpdxExpression("  MIT  ")), "MIT");
});

Deno.test("parseSpdxExpression: -only and -or-later are plain ids", () => {
  for (const id of ["AGPL-3.0-only", "GPL-2.0-or-later"]) {
    assertEquals(parseSpdxExpression(id), {
      kind: "license",
      id,
      orLater: false,
    });
  }
});

Deno.test("parseSpdxExpression: a trailing + marks or-later", () => {
  assertEquals(parseSpdxExpression("GPL-2.0+"), {
    kind: "license",
    id: "GPL-2.0",
    orLater: true,
  });
});

Deno.test("parseSpdxExpression: AND binds tighter than OR", () => {
  assertEquals(
    formatSpdxExpression(parseSpdxExpression("MIT OR Apache-2.0 AND ISC")),
    "MIT OR Apache-2.0 AND ISC",
  );
  const tree = parseSpdxExpression("MIT OR Apache-2.0 AND ISC");
  assertEquals(tree.kind, "or");
  if (tree.kind === "or") assertEquals(tree.right.kind, "and");
});

Deno.test("parseSpdxExpression: WITH binds tighter than AND", () => {
  const tree = parseSpdxExpression(
    "AGPL-3.0-only WITH AdditionRef-Swamp-Extension-Exception AND MIT",
  );
  assertEquals(tree.kind, "and");
  if (tree.kind === "and") {
    assertEquals(tree.left, {
      kind: "with",
      license: { kind: "license", id: "AGPL-3.0-only", orLater: false },
      exception: "AdditionRef-Swamp-Extension-Exception",
    });
  }
});

Deno.test("parseSpdxExpression: parentheses group", () => {
  const tree = parseSpdxExpression("(MIT OR Apache-2.0) AND ISC");
  assertEquals(tree.kind, "and");
  if (tree.kind === "and") assertEquals(tree.left.kind, "or");
  assertEquals(
    formatSpdxExpression(tree),
    "(MIT OR Apache-2.0) AND ISC",
  );
});

Deno.test("parseSpdxExpression: nested parentheses", () => {
  assertEquals(
    formatSpdxExpression(
      parseSpdxExpression("((MIT)) AND (ISC OR (0BSD AND Zlib))"),
    ),
    "MIT AND (ISC OR 0BSD AND Zlib)",
  );
});

Deno.test("parseSpdxExpression: DocumentRef ids tokenize", () => {
  assertEquals(
    parseSpdxExpression("DocumentRef-x:LicenseRef-y"),
    { kind: "license", id: "DocumentRef-x:LicenseRef-y", orLater: false },
  );
});

for (
  const [input, term] of [
    ["", undefined],
    ["   ", undefined],
    ["MIT AND", undefined],
    ["AND MIT", "AND"],
    ["MIT Apache-2.0", "Apache-2.0"],
    ["(MIT", undefined],
    ["MIT)", ")"],
    ["MIT WITH", undefined],
    ["MIT WITH (X)", "("],
    ["(MIT) WITH Classpath-exception-2.0", "WITH"],
    ["MIT or Apache-2.0", "or"],
    ["MIT/Apache-2.0", "MIT/Apache-2.0"],
    ["MIT ++", "+"],
  ] as const
) {
  Deno.test(`parseSpdxExpression: rejects ${JSON.stringify(input)}`, () => {
    const error = assertThrows(
      () => parseSpdxExpression(input),
      SpdxSyntaxError,
    );
    assertEquals(error.term, term);
  });
}

Deno.test("parseSpdxExpression: rejects input over the length cap", () => {
  const long = Array(200).fill("MIT").join(" AND ");
  assertEquals(long.length > MAX_SPDX_EXPRESSION_LENGTH, true);
  assertThrows(() => parseSpdxExpression(long), SpdxSyntaxError, "longer");
});

Deno.test("spdxLeaves: lists every license and WITH node in order", () => {
  const leaves = spdxLeaves(
    parseSpdxExpression(
      "MIT OR (ISC AND GPL-2.0-only WITH Classpath-exception-2.0)",
    ),
  );
  assertEquals(leaves.map((l) => l.kind === "with" ? l.license.id : l.id), [
    "MIT",
    "ISC",
    "GPL-2.0-only",
  ]);
});
