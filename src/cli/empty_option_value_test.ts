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
import { findEmptyOptionValue } from "./empty_option_value.ts";
import { buildEmptyOptionTree } from "./empty_option_value_test_helpers.ts";

function find(...args: string[]): string | undefined {
  return findEmptyOptionValue(buildEmptyOptionTree(), args);
}

Deno.test("findEmptyOptionValue: flags an empty value followed by another option", () => {
  assertEquals(find("issue", "bug", "--title=", "--body", "desc"), "--title");
});

Deno.test("findEmptyOptionValue: flags the flag Cliffy would have swallowed into a title", () => {
  assertEquals(
    find("issue", "bug", "--title=", "--no-redact", "--body", "desc"),
    "--title",
  );
});

Deno.test("findEmptyOptionValue: flags a trailing empty value", () => {
  assertEquals(find("issue", "bug", "--title", "probe", "--body="), "--body");
});

Deno.test("findEmptyOptionValue: flags an empty next token as the value", () => {
  assertEquals(
    find("issue", "bug", "--title", "probe", "--body", ""),
    "--body",
  );
  assertEquals(find("issue", "bug", "-b", "", "-t", "probe"), "--body");
  assertEquals(find("issue", "bug", "--since", "", "--force"), "--since");
  assertEquals(find("issue", "bug", "-qt", "", "-b", "desc"), "--title");
});

Deno.test("findEmptyOptionValue: ignores an empty token after a flag that takes no value", () => {
  assertEquals(find("issue", "bug", "--force", ""), undefined);
  assertEquals(find("issue", "bug", "--no-cache", ""), undefined);
});

Deno.test("findEmptyOptionValue: reports a short option by its long name", () => {
  assertEquals(find("issue", "bug", "-t=", "-b", "desc"), "--title");
  assertEquals(find("issue", "bug", "-b=", "-t", "probe"), "--body");
});

Deno.test("findEmptyOptionValue: flags an empty optional value", () => {
  assertEquals(find("issue", "bug", "--since=", "--force"), "--since");
});

Deno.test("findEmptyOptionValue: flags a global option given after the subcommand", () => {
  assertEquals(
    find("issue", "bug", "--log-level=", "--title", "probe"),
    "--log-level",
  );
});

Deno.test("findEmptyOptionValue: flags a root option given before the subcommand", () => {
  assertEquals(find("--log-level=", "issue", "bug"), "--log-level");
});

Deno.test("findEmptyOptionValue: does not look up a leaf option at the root", () => {
  // `--title` is not an option of the root, so Cliffy rejects it there.
  assertEquals(find("--title=", "issue", "bug"), undefined);
});

Deno.test("findEmptyOptionValue: ignores negated options, which never take a value", () => {
  assertEquals(find("issue", "bug", "--no-cache=", "--force"), undefined);
  assertEquals(find("issue", "bug", "--no-redact=", "--force"), undefined);
  assertEquals(find("--no-color=", "issue", "bug"), undefined);
});

Deno.test("findEmptyOptionValue: flags the last letter of a combined short group", () => {
  assertEquals(find("issue", "bug", "-qt=", "-b", "desc"), "--title");
  assertEquals(find("issue", "bug", "-qvt=", "-b", "desc"), "--title");
});

Deno.test("findEmptyOptionValue: ignores a combined short group with a value", () => {
  assertEquals(find("issue", "bug", "-qt=probe", "-b", "desc"), undefined);
});

Deno.test("findEmptyOptionValue: leaves a group whose earlier letter takes a value to Cliffy", () => {
  // Cliffy gives `-t` the next letter as its value, not the empty `=`.
  assertEquals(find("issue", "bug", "-tq=", "-b", "desc"), undefined);
});

Deno.test("findEmptyOptionValue: ignores a combined group of value-less flags", () => {
  assertEquals(find("issue", "bug", "-qf=", "-t", "x"), undefined);
});

Deno.test("findEmptyOptionValue: ignores boolean flags", () => {
  assertEquals(find("issue", "bug", "--force=", "--title", "x"), undefined);
  assertEquals(find("-q=", "issue", "bug"), undefined);
});

Deno.test("findEmptyOptionValue: ignores unknown options", () => {
  assertEquals(find("issue", "bug", "--nope=", "--title", "x"), undefined);
});

Deno.test("findEmptyOptionValue: ignores non-empty values", () => {
  assertEquals(find("issue", "bug", "--title=probe", "--body=desc"), undefined);
  assertEquals(find("issue", "bug", "--title=a=", "--body", "b"), undefined);
});

Deno.test("findEmptyOptionValue: skips a token taken as an option's value", () => {
  assertEquals(
    find("issue", "bug", "--body", "--title=", "-t", "x"),
    undefined,
  );
});

Deno.test("findEmptyOptionValue: reads nothing after --", () => {
  assertEquals(find("issue", "bug", "-t", "x", "--", "--body="), undefined);
});

Deno.test("findEmptyOptionValue: looks options up on the leaf after a positional", () => {
  assertEquals(find("issue", "get", "bug", "--format="), "--format");
  assertEquals(find("issue", "get", "bug", "--title="), undefined);
});

Deno.test("findEmptyOptionValue: returns undefined for a well-formed invocation", () => {
  assertEquals(
    find("issue", "bug", "-t", "probe", "--body", "desc", "--no-redact"),
    undefined,
  );
  assertEquals(find(), undefined);
});
