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
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { UserError } from "../errors.ts";
import { parseExtensionVersionArgument } from "./extension_version_argument.ts";

const NAME = "@svendowideit/systemd-service";
const VERSION = "2026.10.26.1";

Deno.test("parseExtensionVersionArgument: a bare name has no version", () => {
  assertEquals(parseExtensionVersionArgument(NAME), {
    name: NAME,
    version: null,
  });
});

Deno.test("parseExtensionVersionArgument: accepts every spelling swamp prints", () => {
  const spellings = [
    VERSION,
    `v${VERSION}`,
    `V${VERSION}`,
    `v${VERSION} [beta]`,
    `v${VERSION} [beta, following stable]`,
    `v${VERSION}  (pulled 2026-11-08T03:21:49.615Z)`,
    `v${VERSION} [beta]  (pulled 2026-11-08T03:21:49.615Z)`,
    `rc: ${VERSION}`,
    `beta: ${VERSION}`,
    `stable: v${VERSION}`,
    `  ${VERSION}  `,
  ];
  for (const spelling of spellings) {
    assertEquals(
      parseExtensionVersionArgument(NAME, spelling),
      { name: NAME, version: VERSION },
      `positional ${JSON.stringify(spelling)}`,
    );
    assertEquals(
      parseExtensionVersionArgument(`${NAME}@${spelling}`),
      { name: NAME, version: VERSION },
      `inline ${JSON.stringify(spelling)}`,
    );
  }
});

Deno.test("parseExtensionVersionArgument: pads a four-segment unpadded version", () => {
  assertEquals(
    parseExtensionVersionArgument("@stack72/aws-ec2", "2026.3.1.1").version,
    "2026.03.01.1",
  );
});

Deno.test("parseExtensionVersionArgument: an inline and a positional version that agree are accepted", () => {
  assertEquals(
    parseExtensionVersionArgument(`${NAME}@v${VERSION}`, VERSION),
    { name: NAME, version: VERSION },
  );
});

Deno.test("parseExtensionVersionArgument: an inline and a positional version that differ are refused", () => {
  const error = assertThrows(
    () => parseExtensionVersionArgument(`${NAME}@${VERSION}`, "2026.10.26.2"),
    UserError,
  );
  assertStringIncludes(error.message, "Two different versions");
});

Deno.test("parseExtensionVersionArgument: a version constraint passes through, trimmed", () => {
  assertEquals(
    parseExtensionVersionArgument(`${NAME}@^2026.10.26.1`).version,
    "^2026.10.26.1",
  );
  assertEquals(
    parseExtensionVersionArgument(NAME, ">=2026.1").version,
    ">=2026.1",
  );
  assertEquals(
    parseExtensionVersionArgument(NAME, " ^2026.10.26.1 ").version,
    "^2026.10.26.1",
  );
});

Deno.test("parseExtensionVersionArgument: a version that is not CalVer names the expected shape", () => {
  for (const version of ["2026.3.1", "latest", "1.2.3", "v"]) {
    const error = assertThrows(
      () => parseExtensionVersionArgument(NAME, version),
      UserError,
    );
    assertStringIncludes(error.message, "YYYY.MM.DD.MICRO");
  }
});

Deno.test("parseExtensionVersionArgument: a name without @ is refused", () => {
  const error = assertThrows(
    () => parseExtensionVersionArgument("svendowideit/systemd-service"),
    UserError,
  );
  assertStringIncludes(error.message, 'must start with "@"');
});

Deno.test("parseExtensionVersionArgument: an empty version after @ is refused", () => {
  const error = assertThrows(
    () => parseExtensionVersionArgument(`${NAME}@`),
    UserError,
  );
  assertStringIncludes(error.message, "Version cannot be empty");
});
