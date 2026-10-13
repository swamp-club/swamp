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
import { outputSearchPickerLabels } from "./model_output_search.tsx";

const LEGACY = { itemLabel: "outputs", commandName: undefined };

Deno.test("outputSearchPickerLabels: both legacy pickers keep their labels and default title", () => {
  // No commandName, so the picker titles itself "outputs search" as before.
  assertEquals(outputSearchPickerLabels("model", "output"), LEGACY);
  assertEquals(outputSearchPickerLabels("model", "history"), LEGACY);
});

Deno.test("outputSearchPickerLabels: behavior output search keeps the output labels", () => {
  assertEquals(outputSearchPickerLabels("behavior", "output"), LEGACY);
});

Deno.test("outputSearchPickerLabels: behavior history search lists runs under history search (swamp-club#3409)", () => {
  assertEquals(outputSearchPickerLabels("behavior", "history"), {
    itemLabel: "runs",
    commandName: "history search",
  });
});
