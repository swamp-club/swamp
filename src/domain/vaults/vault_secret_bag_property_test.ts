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
import fc from "fast-check";
import { VaultSecretBag } from "./vault_secret_bag.ts";

type Quote = "unquoted" | "double" | "single";

/** One use of the sentinel, wrapped the way `quote` names. */
function use(sentinel: string, quote: Quote): string {
  switch (quote) {
    case "double":
      return `echo "${sentinel}"`;
    case "single":
      return `echo '${sentinel}'`;
    default:
      return `echo ${sentinel}`;
  }
}

const arbQuotes = fc.array(
  fc.constantFrom<Quote>("unquoted", "double", "single"),
  { minLength: 1, maxLength: 6 },
);

/** Separators between uses, some with comments holding stray quotes. */
const arbSeparator = fc.constantFrom(
  "; ",
  "\n",
  "\n# don't log it\n",
  '\n# say "hi\n',
  "\ncat <<EOF\nit's\nEOF\n",
);

Deno.test("VaultSecretBag.resolveForShell: a vault.get reference depends only on its own occurrence's quote context", () => {
  fc.assert(
    fc.property(arbQuotes, arbSeparator, (quotes, separator) => {
      const bag = new VaultSecretBag();
      const s = bag.addSecret("two  words *");
      const uses = quotes.map((quote) => use(s, quote));
      assertEquals(
        bag.resolveForShell(uses.join(separator)).command,
        uses.map((u) => bag.resolveForShell(u).command).join(separator),
      );
      assertEquals(
        bag.resolveForPowerShell(uses.join("; ")).command,
        uses.map((u) => bag.resolveForPowerShell(u).command).join("; "),
      );
    }),
  );
});

Deno.test("VaultSecretBag.resolveForShell: singleQuoted reports a vault.get sentinel when any occurrence is single-quoted", () => {
  fc.assert(
    fc.property(arbQuotes, arbSeparator, (quotes, separator) => {
      const bag = new VaultSecretBag();
      const s = bag.addSecret("from-vault");
      const command = quotes.map((quote) => use(s, quote)).join(separator);
      assertEquals(
        bag.resolveForShell(command).singleQuoted,
        quotes.includes("single") ? [s] : [],
      );
    }),
  );
});

/**
 * A here-document body fragment. `inString` records, per vault.get use in
 * the fragment, whether the author placed it inside a double-quoted string.
 */
interface BodyFragment {
  lines: string[];
  inString: boolean[];
}

const fragment = (lines: string[], inString: boolean[] = []): BodyFragment => ({
  lines,
  inString,
});

const USE = "@USE@";

const arbBodyFragment = fc.constantFrom<BodyFragment>(
  fragment(["it's here"]),
  fragment(["# Don't commit this file"]),
  fragment([`don't say "it's" twice`]),
  fragment([`he said "hi" and left`]),
  fragment([`screen is 5" wide`]),
  fragment([`tr -d '"' < in > out`]),
  fragment([`sed 's/"//g' f`]),
  fragment([`IFS='"'`]),
  fragment([`grep -c '"' f`]),
  fragment([`x='a"b'`]),
  fragment([`echo "it's"`]),
  fragment([`{"a": "x\\"y"}`]),
  fragment([`{"k": "${USE}"}`], [true]),
  fragment([`KEY="${USE}"`], [true]),
  fragment([`--opt="${USE}"`], [true]),
  fragment([`raw ${USE}`], [false]),
  fragment([`set -- ${USE}`], [false]),
  fragment([`echo "line1`, `${USE}"`], [true]),
  fragment([`echo "line1`, `it's in the string`, `${USE}"`], [true]),
  fragment([`msg="first`, `second ${USE} third"`], [true]),
);

Deno.test("VaultSecretBag.resolveForShell: a vault.get use in a here-document body is bare exactly when the author's text has it in a double-quoted string", () => {
  fc.assert(
    fc.property(
      fc.array(arbBodyFragment, { minLength: 1, maxLength: 7 }),
      (fragments) => {
        const bag = new VaultSecretBag();
        const s = bag.addSecret("two  words *");
        const body = fragments.flatMap((f) => f.lines).join("\n");
        const inString = fragments.flatMap((f) => f.inString);
        let use = 0;
        const expected = body.replaceAll(
          USE,
          () => inString[use++] ? "${__SWAMP_VAULT_0}" : '"${__SWAMP_VAULT_0}"',
        );
        assertEquals(
          bag.resolveForShell(`cat <<EOF\n${body.replaceAll(USE, s)}\nEOF`)
            .command,
          `cat <<EOF\n${expected}\nEOF`,
        );
      },
    ),
  );
});
