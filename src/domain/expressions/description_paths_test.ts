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
  definitionDescriptionPaths,
  inputDescriptionPaths,
} from "./description_paths.ts";
import { extractExpressions } from "./expression_parser.ts";

Deno.test("inputDescriptionPaths: collects schema annotations, not default values", () => {
  const paths = inputDescriptionPaths({
    type: "object",
    description: "root",
    properties: {
      "dotted.name": { type: "string", description: "escaped" },
      list: { type: "array", items: { description: "item" } },
      map: { type: "object", additionalProperties: { description: "extra" } },
      cfg: { type: "object", default: { description: "a value" } },
    },
  });
  assertEquals([...paths].sort(), [
    "inputs.description",
    "inputs.properties.list.items.description",
    "inputs.properties.map.additionalProperties.description",
    'inputs.properties["dotted.name"].description',
  ]);
});

Deno.test("inputDescriptionPaths: reads the flat map form of named property schemas", () => {
  assertEquals(
    [...inputDescriptionPaths({ later: { type: "string", description: "x" } })],
    ["inputs.later.description"],
  );
});

Deno.test("definitionDescriptionPaths: matches the paths extractExpressions reports for description prose only", () => {
  const data = {
    description: "${{ dyn(vault).get('a', 'b') }}",
    inputs: {
      type: "object",
      properties: {
        later: { type: "string", description: "${{ env.HOME }}" },
        cfg: {
          type: "object",
          default: { description: "${{ vault.get('a', 'c') }}" },
        },
      },
    },
    globalArguments: { description: "${{ vault.get('a', 'd') }}" },
    methods: {
      run: { arguments: { description: "${{ vault.get('a', 'e') }}" } },
    },
  };
  const isDescription = definitionDescriptionPaths(data);
  const prose = extractExpressions(data)
    .filter((expr) => isDescription(expr.path))
    .map((expr) => expr.path)
    .sort();
  assertEquals(prose, ["description", "inputs.properties.later.description"]);
});
