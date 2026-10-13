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
import {
  asFlag,
  asNullableString,
  oneOf,
  queryParamValue,
} from "./useQueryState.ts";

Deno.test("queryParamValue: parses the named param of a query string", () => {
  assertEquals(
    queryParamValue("?focus=failure&step=build", "step", asNullableString),
    "build",
  );
  assertEquals(
    queryParamValue("?focus=failure", "step", asNullableString),
    null,
  );
  assertEquals(queryParamValue("", "open", asFlag), false);
  assertEquals(queryParamValue("?open=1", "open", asFlag), true);
});

Deno.test("queryParamValue: an invalid value falls back to the parser's default", () => {
  const parse = oneOf(["graph", "logs"] as const, "graph");
  assertEquals(queryParamValue("?tab=logs", "tab", parse), "logs");
  assertEquals(queryParamValue("?tab=nope", "tab", parse), "graph");
});
