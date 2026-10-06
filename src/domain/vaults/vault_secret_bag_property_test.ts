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
