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
import {
  buildArgs,
  buildSchema,
  parseCliOutput,
} from "../evals/promptfoo/claude_cli_provider.mjs";
import {
  assertRouteSupports,
  cliProviderEntry,
  defaultRoute,
  resolveRoute,
} from "../evals/promptfoo/provider_route.ts";

const TOOLS = ["swamp", "swamp-getting-started", "no_match"];

function cliJson(over: Record<string, unknown>): string {
  return JSON.stringify({
    is_error: false,
    structured_output: { tool: "swamp" },
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 10,
      output_tokens: 5,
    },
    modelUsage: { "claude-opus-5-5": {} },
    ...over,
  });
}

Deno.test("buildSchema: enumerates the tool names", () => {
  assertEquals(buildSchema(TOOLS).properties.tool.enum, TOOLS);
});

Deno.test("buildArgs: runs tool-less, settings-less, schema-constrained", () => {
  const args: string[] = buildArgs("q", {
    model: "opus",
    effort: "medium",
    systemPrompt: "route",
    toolNames: TOOLS,
  });
  assertEquals(args.slice(0, 2), ["-p", "q"]);
  assertEquals(args[args.indexOf("--tools") + 1], "");
  assertEquals(args[args.indexOf("--setting-sources") + 1], "");
  assertEquals(args.includes("--strict-mcp-config"), true);
  assertEquals(args.includes("--bare"), false);
  assertEquals(args[args.indexOf("--model") + 1], "opus");
  assertEquals(args[args.indexOf("--effort") + 1], "medium");
  assertEquals(args[args.indexOf("--output-format") + 1], "json");
});

Deno.test("parseCliOutput: returns the pick as a function-call array", () => {
  const out = parseCliOutput(cliJson({}), TOOLS);
  assertEquals(out.output, [{ function: { name: "swamp" } }]);
  assertEquals(out.tokenUsage, { total: 117, prompt: 112, completion: 5 });
  assertEquals(out.metadata?.resolvedModel, "claude-opus-5-5");
});

Deno.test("parseCliOutput: a missing or out-of-enum pick is an error", () => {
  for (
    const stdout of [
      cliJson({ structured_output: undefined }),
      cliJson({ structured_output: { tool: "other" } }),
      cliJson({ is_error: true, result: "boom" }),
      "not json",
    ]
  ) {
    assertEquals(typeof parseCliOutput(stdout, TOOLS).error, "string");
  }
});

Deno.test("defaultRoute: API in Actions and for models without a CLI route", () => {
  assertEquals(defaultRoute("opus", {}), "cli");
  assertEquals(defaultRoute("sonnet", {}), "cli");
  assertEquals(defaultRoute("opus", { GITHUB_ACTIONS: "true" }), "api");
  assertEquals(defaultRoute("gpt-5.4", {}), "api");
  assertEquals(defaultRoute("fable", {}), "api");
});

Deno.test("assertRouteSupports: rejects models with no CLI route", () => {
  assertThrows(() => assertRouteSupports("fable", "cli"), Error, "no CLI route");
  assertRouteSupports("opus", "cli");
  assertRouteSupports("fable", "api");
});

Deno.test("cliProviderEntry: points promptfoo at the local provider file", () => {
  const entry = cliProviderEntry("sonnet", "sys", TOOLS);
  assertEquals(entry.id, "file://claude_cli_provider.mjs");
  assertEquals(entry.config.model, "sonnet");
  assertEquals(entry.config.toolNames, TOOLS);
});

Deno.test("resolveRoute: honors a request, else the default, and rejects bad ones", () => {
  assertEquals(resolveRoute("opus", undefined, {}), "cli");
  assertEquals(resolveRoute("opus", "api", {}), "api");
  assertEquals(resolveRoute("opus", undefined, { GITHUB_ACTIONS: "true" }), "api");
  assertThrows(() => resolveRoute("opus", "bogus", {}), Error, "unknown route");
  assertThrows(() => resolveRoute("fable", "cli", {}), Error, "no CLI route");
});
