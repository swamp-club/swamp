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
import { findEmptyOptionValue } from "./empty_option_value.ts";
import { buildEmptyOptionTree } from "./empty_option_value_test_helpers.ts";

const VALUE_FLAGS = [
  "--title",
  "--body",
  "--since",
  "--cache",
  "--log-level",
  "--format",
];

const arbToken = fc.oneof(
  fc.constantFrom(
    "issue",
    "bug",
    "get",
    "--",
    "--title",
    "-t",
    "--body",
    "-b",
    "--force",
    "-qt",
    "--no-redact",
    "--no-cache",
    "--log-level",
    "--since",
    "--format",
    "--nope",
    "probe",
  ),
  fc.string(),
);

/** A token that is, or ends a flag with, an empty value. */
function isEmptyValue(token: string): boolean {
  return token === "" || (token.startsWith("-") && token.endsWith("="));
}

Deno.test("findEmptyOptionValue: argv with no empty value is never flagged", () => {
  const tree = buildEmptyOptionTree();
  fc.assert(
    fc.property(
      fc.array(arbToken.filter((t) => !isEmptyValue(t)), { maxLength: 12 }),
      (args) => {
        assertEquals(findEmptyOptionValue(tree, args), undefined);
      },
    ),
  );
});

Deno.test("findEmptyOptionValue: a flag it reports is a value-taking option given empty", () => {
  const tree = buildEmptyOptionTree();
  const arbWithEmpty = fc.oneof(
    arbToken,
    arbToken.map((t) => `${t}=`),
    fc.constant(""),
  );
  fc.assert(
    fc.property(fc.array(arbWithEmpty, { maxLength: 12 }), (args) => {
      const flag = findEmptyOptionValue(tree, args);
      if (flag === undefined) return;
      assert(VALUE_FLAGS.includes(flag), `unexpected flag ${flag}`);
      assert(
        args.some(isEmptyValue),
        `flagged ${flag} without an empty value`,
      );
    }),
  );
});
