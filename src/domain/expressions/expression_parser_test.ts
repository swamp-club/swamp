// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
  containsExpression,
  extractCelExpression,
  extractExpressions,
  extractInputReferences,
  extractInputReferencesFromCel,
  isTaskInputsPath,
  replaceExpressions,
} from "./expression_parser.ts";

Deno.test("containsExpression returns true for strings with expressions", () => {
  assertEquals(containsExpression("${{ model.foo.input.x }}"), true);
  assertEquals(containsExpression("Hello ${{ self.name }}!"), true);
  assertEquals(containsExpression("${{x}}"), true);
});

Deno.test("containsExpression returns false for strings without expressions", () => {
  assertEquals(containsExpression("Hello world"), false);
  assertEquals(containsExpression("${ not an expression }"), false);
  assertEquals(containsExpression("{{ also not }}"), false);
  assertEquals(containsExpression(""), false);
});

Deno.test("extractExpressions finds expressions in string values", () => {
  const data = {
    message: "${{ model.source.input.attributes.text }}",
  };

  const locations = extractExpressions(data);
  assertEquals(locations.length, 1);
  assertEquals(locations[0].path, "message");
  assertEquals(locations[0].raw, "${{ model.source.input.attributes.text }}");
  assertEquals(
    locations[0].celExpression,
    "model.source.input.attributes.text",
  );
});

Deno.test("extractExpressions finds multiple expressions in same string", () => {
  const data = {
    message: "${{ a }} and ${{ b }}",
  };

  const locations = extractExpressions(data);
  assertEquals(locations.length, 2);
  assertEquals(locations[0].celExpression, "a");
  assertEquals(locations[1].celExpression, "b");
});

Deno.test("extractExpressions traverses nested objects", () => {
  const data = {
    level1: {
      level2: {
        value: "${{ deep.expression }}",
      },
    },
  };

  const locations = extractExpressions(data);
  assertEquals(locations.length, 1);
  assertEquals(locations[0].path, "level1.level2.value");
  assertEquals(locations[0].celExpression, "deep.expression");
});

Deno.test("extractExpressions traverses arrays", () => {
  const data = {
    items: ["${{ first }}", "plain", "${{ third }}"],
  };

  const locations = extractExpressions(data);
  assertEquals(locations.length, 2);
  assertEquals(locations[0].path, "items[0]");
  assertEquals(locations[0].celExpression, "first");
  assertEquals(locations[1].path, "items[2]");
  assertEquals(locations[1].celExpression, "third");
});

Deno.test("extractExpressions ignores non-string values", () => {
  const data = {
    number: 42,
    boolean: true,
    nullValue: null,
    expression: "${{ valid }}",
  };

  const locations = extractExpressions(data);
  assertEquals(locations.length, 1);
  assertEquals(locations[0].path, "expression");
});

Deno.test("replaceExpressions replaces single expression with value", () => {
  const data = {
    message: "${{ model.foo.input.x }}",
  };
  const values = new Map<string, unknown>([
    ["${{ model.foo.input.x }}", "Hello World"],
  ]);

  const result = replaceExpressions(data, values) as typeof data;
  assertEquals(result.message, "Hello World");
});

Deno.test("replaceExpressions preserves non-string types", () => {
  const data = {
    count: "${{ model.foo.input.n }}",
  };
  const values = new Map<string, unknown>([
    ["${{ model.foo.input.n }}", 42],
  ]);

  const result = replaceExpressions(data, values) as { count: unknown };
  assertEquals(result.count, 42);
});

Deno.test("replaceExpressions handles inline expressions in strings", () => {
  const data = {
    greeting: "Hello ${{ self.name }}, version ${{ self.version }}!",
  };
  const values = new Map<string, unknown>([
    ["${{ self.name }}", "Test"],
    ["${{ self.version }}", 1],
  ]);

  const result = replaceExpressions(data, values) as typeof data;
  assertEquals(result.greeting, "Hello Test, version 1!");
});

Deno.test("replaceExpressions traverses nested structures", () => {
  const data = {
    outer: {
      inner: "${{ x }}",
    },
    array: ["${{ y }}", "${{ z }}"],
  };
  const values = new Map<string, unknown>([
    ["${{ x }}", "a"],
    ["${{ y }}", "b"],
    ["${{ z }}", "c"],
  ]);

  const result = replaceExpressions(data, values) as typeof data;
  assertEquals(result.outer.inner, "a");
  assertEquals(result.array[0], "b");
  assertEquals(result.array[1], "c");
});

Deno.test("replaceExpressions leaves unmatched expressions unchanged", () => {
  const data = {
    known: "${{ known }}",
    unknown: "${{ unknown }}",
  };
  const values = new Map<string, unknown>([
    ["${{ known }}", "replaced"],
  ]);

  const result = replaceExpressions(data, values) as typeof data;
  assertEquals(result.known, "replaced");
  assertEquals(result.unknown, "${{ unknown }}");
});

Deno.test("replaceExpressions JSON stringifies arrays in inline expressions", () => {
  const data = {
    message: "Items: ${{ items }}",
  };
  const values = new Map<string, unknown>([
    ["${{ items }}", ["apple", "banana", "cherry"]],
  ]);

  const result = replaceExpressions(data, values) as typeof data;
  assertEquals(
    result.message,
    `Items: [
  "apple",
  "banana",
  "cherry"
]`,
  );
});

Deno.test("replaceExpressions JSON stringifies objects in inline expressions", () => {
  const data = {
    message: "Config: ${{ config }}",
  };
  const values = new Map<string, unknown>([
    ["${{ config }}", { host: "localhost", port: 8080 }],
  ]);

  const result = replaceExpressions(data, values) as typeof data;
  assertEquals(
    result.message,
    `Config: {
  "host": "localhost",
  "port": 8080
}`,
  );
});

Deno.test("replaceExpressions handles null and undefined in inline expressions", () => {
  const data = {
    withNull: "Value: ${{ nullVal }}",
    withUndefined: "Value: ${{ undefinedVal }}",
  };
  const values = new Map<string, unknown>([
    ["${{ nullVal }}", null],
    ["${{ undefinedVal }}", undefined],
  ]);

  const result = replaceExpressions(data, values) as typeof data;
  assertEquals(result.withNull, "Value: ");
  assertEquals(result.withUndefined, "Value: ");
});

Deno.test("replaceExpressions preserves array type for single expression", () => {
  const data = {
    items: "${{ items }}",
  };
  const values = new Map<string, unknown>([
    ["${{ items }}", ["apple", "banana"]],
  ]);

  const result = replaceExpressions(data, values) as { items: unknown };
  assertEquals(result.items, ["apple", "banana"]);
});

Deno.test("replaceExpressions preserves object type for single expression", () => {
  const data = {
    config: "${{ config }}",
  };
  const values = new Map<string, unknown>([
    ["${{ config }}", { host: "localhost", port: 8080 }],
  ]);

  const result = replaceExpressions(data, values) as { config: unknown };
  assertEquals(result.config, { host: "localhost", port: 8080 });
});

Deno.test("extractCelExpression extracts expression from wrapper", () => {
  assertEquals(
    extractCelExpression("${{ model.foo.input.x }}"),
    "model.foo.input.x",
  );
  assertEquals(
    extractCelExpression("${{   spaced   }}"),
    "spaced",
  );
});

Deno.test("extractCelExpression returns null for invalid format", () => {
  assertEquals(extractCelExpression("no expression"), null);
  assertEquals(extractCelExpression("${ single braces }"), null);
  assertEquals(extractCelExpression("{{ no dollar }}"), null);
});

// Tests for isTaskInputsPath

Deno.test("isTaskInputsPath returns true for task.inputs with dot path", () => {
  assertEquals(
    isTaskInputsPath("jobs[0].steps[1].task.inputs.vpc_id"),
    true,
  );
});

Deno.test("isTaskInputsPath returns true for task.inputs with bracket path", () => {
  assertEquals(
    isTaskInputsPath("jobs[0].steps[0].task.inputs[0]"),
    true,
  );
});

Deno.test("isTaskInputsPath returns false for task.modelIdOrName", () => {
  assertEquals(
    isTaskInputsPath("jobs[0].steps[0].task.modelIdOrName"),
    false,
  );
});

Deno.test("isTaskInputsPath returns false for step name", () => {
  assertEquals(
    isTaskInputsPath("jobs[0].steps[0].name"),
    false,
  );
});

Deno.test("isTaskInputsPath returns false for model definition attribute", () => {
  assertEquals(
    isTaskInputsPath("attributes.vpc_id"),
    false,
  );
});

// Tests for extractInputReferences

Deno.test("extractInputReferences finds dot notation references", () => {
  const data = {
    run: "echo ${{ inputs.region }}",
  };
  assertEquals(extractInputReferences(data), new Set(["region"]));
});

Deno.test("extractInputReferences finds bracket notation references", () => {
  const data = {
    run: 'deploy to ${{ inputs["environment-name"] }}',
  };
  assertEquals(
    extractInputReferences(data),
    new Set(["environment-name"]),
  );
});

Deno.test("extractInputReferences deduplicates multiple refs to same input", () => {
  const data = {
    arg1: "${{ inputs.region }}",
    arg2: "also uses ${{ inputs.region }}",
  };
  assertEquals(extractInputReferences(data), new Set(["region"]));
});

Deno.test("extractInputReferences returns empty set when no input references", () => {
  const data = {
    run: "echo hello",
    value: "${{ self.name }}",
  };
  assertEquals(extractInputReferences(data), new Set());
});

Deno.test("extractInputReferences excludes cross-model references", () => {
  const data = {
    arg: "${{ model.vpc.input.cidr }}",
  };
  assertEquals(extractInputReferences(data), new Set());
});

Deno.test("extractInputReferences handles nested and array structures", () => {
  const data = {
    nested: {
      deep: {
        value: "${{ inputs.name }}",
      },
    },
    list: ["${{ inputs.count }}", "plain", "${{ inputs.name }}"],
  };
  assertEquals(
    extractInputReferences(data),
    new Set(["name", "count"]),
  );
});

Deno.test("extractInputReferences handles mixed dot and bracket notation", () => {
  const data = {
    cmd: '${{ inputs.region }} and ${{ inputs["drop-name"] }}',
  };
  assertEquals(
    extractInputReferences(data),
    new Set(["region", "drop-name"]),
  );
});

// Documents why extractInputReferencesFromCel must not be used as a skip gate
// for expression evaluation. It reports all inputs in ALL branches of a ternary,
// regardless of which branch CEL would actually evaluate at runtime.
// This was the root cause of the #814 regression introduced in #655.
Deno.test("extractInputReferencesFromCel: returns all branch inputs in ternary regardless of which branch runs", () => {
  assertEquals(
    extractInputReferencesFromCel(
      `inputs.transport == "lan" ? inputs.lan_host : inputs.tailnet_host`,
    ),
    new Set(["transport", "lan_host", "tailnet_host"]),
  );
});
