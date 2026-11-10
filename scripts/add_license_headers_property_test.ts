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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { applyHeader, HEADER, headerStatus } from "./add_license_headers.ts";

const HEADER_LINES = HEADER.slice(0, -1).split("\n");

const escapeLine = (line: string) => "//" + line.slice(2).replaceAll("/", "\\/");

// A first line starting with // would read as part of the header block.
const arbBody = fc.tuple(
  fc.string({ minLength: 1 }).filter((first) =>
    !first.includes("\n") && first.trim() !== "" &&
    !first.startsWith("//") && !first.startsWith("#!")
  ),
  fc.array(fc.string()),
).map(([first, more]) => [first, ...more].join("\n"));

const arbDamagedHeader = fc.tuple(
  fc.integer({ min: 1, max: HEADER_LINES.length }),
  fc.boolean(),
  fc.boolean(),
).map(([keep, escaped, blank]) => {
  const lines = HEADER_LINES.slice(0, keep).map((l) =>
    escaped ? escapeLine(l) : l
  );
  return lines.join("\n") + "\n" + (blank ? "\n" : "");
});

function assertRepairedKeepingBody(result: string, body: string) {
  assertEquals(headerStatus(result), "ok");
  assert(result.startsWith(HEADER));
  assertEquals(result.slice(HEADER.length).replace(/^\n+/, ""), body);
}

Deno.test("applyHeader: a missing header is added and the body kept", () => {
  fc.assert(
    fc.property(arbBody, (body) => {
      const once = applyHeader(body);
      assertEquals(once.kind, "added");
      assertRepairedKeepingBody(once.content, body);
      assertEquals(applyHeader(once.content).kind, "unchanged");
    }),
  );
});

Deno.test("applyHeader: a truncated or escaped header is repaired and the body kept", () => {
  fc.assert(
    fc.property(arbDamagedHeader, arbBody, (header, body) => {
      const once = applyHeader(header + body);
      assert(once.kind === "repaired" || once.kind === "unchanged");
      assertRepairedKeepingBody(once.content, body);
      assertEquals(applyHeader(once.content), {
        kind: "unchanged",
        content: once.content,
      });
    }),
  );
});

Deno.test("applyHeader: a header changed part-way through is returned untouched", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: HEADER_LINES.length - 1 }),
      fc.string().filter((s) => !s.includes("\n")),
      arbBody,
      (line, replacement, body) => {
        const mutated = "// " + replacement;
        fc.pre(
          mutated.replaceAll("\\/", "/").trimEnd() !== HEADER_LINES[line],
        );
        const lines = [...HEADER_LINES];
        lines[line] = mutated;
        const content = lines.join("\n") + "\n\n" + body;
        assertEquals(applyHeader(content), { kind: "unrepairable", content });
      },
    ),
  );
});
