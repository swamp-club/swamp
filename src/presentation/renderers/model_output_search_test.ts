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
  createModelOutputSearchRenderer,
  outputSearchPickerLabels,
} from "./model_output_search.tsx";
import { captureLog } from "./search_list_test_helpers.ts";
import type { ModelOutputSearchItem } from "../../libswamp/models/output_search.ts";

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

const OUTPUTS: ModelOutputSearchItem[] = [
  {
    id: "o1",
    definitionId: "d1",
    modelName: "web",
    type: "command/shell",
    methodName: "execute",
    status: "succeeded",
    startedAt: "2026-10-25T00:00:00.000Z",
  },
  {
    id: "o2",
    definitionId: "d2",
    modelName: "db",
    type: "swamp/echo",
    methodName: "run",
    status: "failed",
    startedAt: "2026-10-25T00:00:00.000Z",
  },
];

Deno.test("createModelOutputSearchRenderer: non-interactive log lists matching outputs under the command label", async () => {
  for (
    const [command, label] of [["output", "outputs"], [
      "history",
      "runs",
    ]] as const
  ) {
    const renderer = createModelOutputSearchRenderer(
      "log",
      undefined,
      outputSearchPickerLabels("behavior", command),
      { interactive: false },
    );
    const lines = await captureLog(() =>
      renderer.handlers().completed({
        kind: "completed",
        data: { query: "web", results: OUTPUTS },
      })
    );
    assertEquals(lines.length, 3);
    assertEquals(lines[0].startsWith("web - execute [succeeded]"), true);
    assertEquals(lines[0].includes("db - run"), false);
    assertEquals(lines[2], `${label}: 1`);
  }
});
