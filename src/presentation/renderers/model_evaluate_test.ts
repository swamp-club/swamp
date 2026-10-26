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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type {
  ModelEvaluateAllData,
  ModelEvaluateItemData,
} from "../../libswamp/models/evaluate.ts";
import type { CommandSurface } from "../command_surface.ts";
import { createModelEvaluateRenderer } from "./model_evaluate.ts";

await initializeLogging({});

const item: ModelEvaluateItemData = {
  id: "def-1",
  name: "my-server",
  type: "aws-ec2",
  hadExpressions: true,
  outputPath: ".swamp/definitions-evaluated/my-server.yaml",
};

const all: ModelEvaluateAllData = { items: [item], total: 2, evaluated: 1 };

/** The message part of each LogTape record the console sink prints. */
function render(
  data: ModelEvaluateItemData | ModelEvaluateAllData,
  surface?: CommandSurface,
): string[] {
  const messages: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    messages.push(line.slice(line.indexOf(": ") + 2));
  };
  try {
    createModelEvaluateRenderer("log", surface).handlers().completed({
      kind: "completed",
      data,
    });
  } finally {
    console.info = original;
  }
  return messages;
}

Deno.test("LogModelEvaluateRenderer: the legacy surface keeps its exact text", () => {
  assertEquals(render(item), [
    'Evaluated model definition: "my-server" ("aws-ec2")',
    "  Expressions evaluated",
    '  Output: ".swamp/definitions-evaluated/my-server.yaml"',
  ]);
  assertEquals(render(all), [
    "Evaluated 1 of 2 model definitions",
    '  "my-server" ("aws-ec2") "[evaluated]"',
    '    Output: ".swamp/definitions-evaluated/my-server.yaml"',
  ]);
  assertEquals(render(item, "model"), render(item));
  assertEquals(render(all, "model"), render(all));
});

Deno.test("LogModelEvaluateRenderer: the behavior surface says behavior", () => {
  assertEquals(
    render(item, "behavior")[0],
    'Evaluated behavior definition: "my-server" ("aws-ec2")',
  );
  assertEquals(
    render(all, "behavior")[0],
    "Evaluated 1 of 2 behavior definitions",
  );
  assertEquals(render(item, "behavior").slice(1), render(item).slice(1));
  assertEquals(render(all, "behavior").slice(1), render(all).slice(1));
});

Deno.test("LogModelEvaluateRenderer: an unsaved evaluation says why it was not saved", () => {
  const unsaved: ModelEvaluateItemData = {
    id: "def-1",
    name: "my-server",
    type: "aws-ec2",
    hadExpressions: true,
    saved: false,
  };
  assertEquals(render(unsaved, "behavior"), [
    'Evaluated behavior definition: "my-server" ("aws-ec2")',
    "  Expressions evaluated",
    "  Not saved: saving needs run on the behavior",
  ]);
  assertEquals(
    render({ items: [unsaved], total: 1, evaluated: 1 })[2],
    "    Not saved: saving needs run on the model",
  );
});
