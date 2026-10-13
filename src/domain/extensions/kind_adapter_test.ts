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
import { primaryExport, primaryExportNames } from "./kind_adapter.ts";
import { UserError } from "../errors.ts";

const models = {
  primaryExportKey: "model",
  primaryExportAliases: ["behavior"],
};
const def = { type: "@acme/x", version: "2026.01.01.1", methods: {} };

Deno.test("primaryExportNames: the key first, then its aliases", () => {
  assertEquals(primaryExportNames(models), ["model", "behavior"]);
  assertEquals(primaryExportNames({ primaryExportKey: "vault" }), ["vault"]);
});

Deno.test("primaryExport: reads the key or its alias", () => {
  assertEquals(primaryExport({ model: def }, models), def);
  assertEquals(primaryExport({ behavior: def }, models), def);
  assertEquals(primaryExport({ extension: def }, models), undefined);
  assertEquals(primaryExport({}, models), undefined);
  // An adapter without aliases ignores the name entirely.
  assertEquals(
    primaryExport({ behavior: def }, { primaryExportKey: "model" }),
    undefined,
  );
});

Deno.test("primaryExport: the key and an alias both exported as definitions are refused", () => {
  const error = assertThrows(
    () => primaryExport({ model: def, behavior: { ...def } }, models),
    UserError,
  );
  assertEquals(
    error.message,
    "Module exports both 'model' and 'behavior'; export only one of them. 'behavior' is another spelling of 'model'.",
  );
});

Deno.test("primaryExport: an unrelated binding under the alias name is not a definition", () => {
  for (
    const unrelated of [
      "strict",
      3,
      true,
      null,
      { retries: 3 },
      { type: "backoff" },
      () => {},
    ]
  ) {
    assertEquals(
      primaryExport({ model: def, behavior: unrelated }, models),
      def,
    );
  }
  for (const unrelated of ["strict", 3, { retries: 3 }, () => {}]) {
    assertEquals(primaryExport({ behavior: unrelated }, models), undefined);
  }
  // Alone, an alias with a type is the definition, so validation reports
  // what it is missing instead of skipping it as a helper.
  assertEquals(primaryExport({ behavior: { type: "@acme/x" } }, models), {
    type: "@acme/x",
  });
});
