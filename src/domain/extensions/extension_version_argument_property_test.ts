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
import { UserError } from "../errors.ts";
import { parseExtensionVersionArgument } from "./extension_version_argument.ts";

const NAME = "@collective/ext";

const arbVersion = fc
  .record({
    date: fc.date({
      min: new Date(Date.UTC(2000, 0, 1)),
      max: new Date(Date.UTC(2099, 11, 31)),
      noInvalidDate: true,
    }),
    micro: fc.integer({ min: 1, max: 2_000_000_000 }),
  })
  .map(({ date, micro }) =>
    [
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
      String(micro),
    ].join(".")
  );

// The spellings the extension renderers print around a version.
const arbDisplayed = fc
  .record({
    version: arbVersion,
    v: fc.boolean(),
    label: fc.constantFrom("", "rc: ", "beta: ", "stable: "),
    tag: fc.constantFrom(
      "",
      " [beta]",
      " [rc]",
      " [beta, following stable]",
      " [rc, following beta]",
    ),
    pulled: fc.constantFrom("", "  (pulled 2026-11-08T03:21:49.615Z)"),
  })
  .map(({ version, v, label, tag, pulled }) => ({
    version,
    displayed: `${label}${v ? "v" : ""}${version}${tag}${pulled}`,
  }));

Deno.test("parseExtensionVersionArgument: every displayed spelling parses back to the bare version", () => {
  fc.assert(
    fc.property(arbDisplayed, ({ version, displayed }) => {
      assertEquals(parseExtensionVersionArgument(NAME, displayed), {
        name: NAME,
        version,
      });
      assertEquals(parseExtensionVersionArgument(`${NAME}@${displayed}`), {
        name: NAME,
        version,
      });
    }),
  );
});

Deno.test("parseExtensionVersionArgument: arbitrary input either parses to valid CalVer or is refused", () => {
  fc.assert(
    fc.property(fc.string(), (raw) => {
      try {
        const { version } = parseExtensionVersionArgument(NAME, raw);
        if (version !== null && !/^[><=^~!]/.test(raw.trim())) {
          assertEquals(/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(version), true);
        }
      } catch (error) {
        if (!(error instanceof UserError)) throw error;
      }
    }),
  );
});

Deno.test("parseExtensionVersionArgument: a long input built from decoration fragments is refused", () => {
  const hostile = `${"(pulled ".repeat(20_000)}${" [".repeat(20_000)}${
    "beta:".repeat(20_000)
  }`;
  assertThrows(() => parseExtensionVersionArgument(NAME, hostile), UserError);
});
