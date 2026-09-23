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
import { referencesOnlySwampNamespaces } from "./swamp_namespaces.ts";

Deno.test("referencesOnlySwampNamespaces: true for expressions rooted in swamp namespaces", () => {
  for (
    const cel of [
      "inputs.cidrBlock",
      "data.latest('producer', 'log').nope",
      "model.web-1a.resource.state.main.attributes.id",
      "self.globalArguments.target + '-' + inputs.host",
      "1 + 'a'",
    ]
  ) {
    assertEquals(referencesOnlySwampNamespaces(cel), true, cel);
  }
});

Deno.test("referencesOnlySwampNamespaces: false when any root belongs to another templating system", () => {
  for (
    const cel of [
      "github.sha",
      "secrets.TOKEN",
      "matrix.os",
      "parameters.env",
      "inputs.a + github.sha",
    ]
  ) {
    assertEquals(referencesOnlySwampNamespaces(cel), false, cel);
  }
});

Deno.test("referencesOnlySwampNamespaces: macro-bound variables are not roots", () => {
  assertEquals(
    referencesOnlySwampNamespaces("inputs.hosts.map(h, h + '.local')"),
    true,
  );
  assertEquals(
    referencesOnlySwampNamespaces("cel.bind(v, inputs.a, v + 1)"),
    true,
  );
  // The bound name only shadows inside the macro body.
  assertEquals(
    referencesOnlySwampNamespaces("inputs.hosts.map(h, h) + h"),
    false,
  );
});

Deno.test("referencesOnlySwampNamespaces: false when the expression does not parse", () => {
  assertEquals(referencesOnlySwampNamespaces("not valid cel !!!"), false);
});
