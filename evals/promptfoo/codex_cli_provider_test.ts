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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  buildArgs,
  buildPrompt,
  callCodex,
  parseCliOutput,
} from "./codex_cli_provider.mjs";
import { cliProviderEntry, resolveRoute } from "./provider_route.ts";

const config = {
  model: "gpt-6-astra",
  effort: "medium",
  systemPrompt: "Route requests to the matching skill.",
  toolNames: ["swamp", "no_match"],
  tools: [{ function: { name: "swamp", description: "Swamp CLI automation" } }],
};

Deno.test("Codex route: opt-in preserves Claude defaults and rejects an unsupported API route", () => {
  assertEquals(resolveRoute("opus", undefined, {}), "cli");
  assertEquals(
    cliProviderEntry("opus", "sys", []).id,
    "file://claude_cli_provider.mjs",
  );
  assertEquals(resolveRoute("gpt-6-astra", undefined, {}), "cli");
  assertEquals(
    resolveRoute("gpt-6-astra", undefined, { GITHUB_ACTIONS: "true" }),
    "cli",
  );
  assertThrows(() => resolveRoute("gpt-6-astra", "api", {}), Error, "CLI-only");
  const entry = cliProviderEntry(
    "gpt-6-astra",
    "sys",
    config.toolNames,
    config.tools,
  );
  assertEquals(entry.id, "file://codex_cli_provider.mjs");
  assertEquals(entry.config.tools, config.tools);
});

Deno.test("Codex args: isolate cases and request only a schema-constrained final answer", () => {
  const args = buildArgs(config, {
    schema: "schema.json",
    result: "answer.json",
  });
  for (
    const value of [
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "features.shell_tool=false",
      "features.multi_agent=false",
      "features.apps=false",
      "features.hooks=false",
      "project_doc_max_bytes=0",
      'web_search="disabled"',
    ]
  ) {
    assertEquals(args.includes(value), true, value);
  }
  assertEquals(args[args.indexOf("--sandbox") + 1], "read-only");
  assertEquals(args[args.indexOf("--ask-for-approval") + 1], "never");
  assertEquals(args[args.indexOf("--output-last-message") + 1], "answer.json");
  assertEquals(args.at(-1), "-");
  assertStringIncludes(buildPrompt("query", config), "Swamp CLI automation");
  assertStringIncludes(buildPrompt("query", config), "query");
});

Deno.test("Codex output: rejects malformed, missing and out-of-enum choices", () => {
  assertEquals(parseCliOutput('{"tool":"swamp"}', config.toolNames).output, [{
    function: { name: "swamp" },
  }]);
  for (
    const output of [
      "",
      "null",
      "[]",
      "{}",
      '{"tool":"other"}',
      '{"tool":1}',
      '```json\n{"tool":"swamp"}\n```',
    ]
  ) {
    assertEquals(
      typeof parseCliOutput(output, config.toolNames).error,
      "string",
    );
  }
});

Deno.test("callCodex: reads the final file, ignores stdout and cleans up each case", async () => {
  let directory = "";
  const answer = await callCodex(
    "query",
    config,
    async (args: string[], prompt: string, cwd: string) => {
      directory = cwd;
      assertStringIncludes(prompt, "Swamp CLI automation");
      const schema = JSON.parse(
        await Deno.readTextFile(args[args.indexOf("--output-schema") + 1]),
      );
      assertEquals(schema.properties.tool.enum, config.toolNames);
      await Deno.writeTextFile(
        args[args.indexOf("--output-last-message") + 1],
        '{"tool":"swamp"}',
      );
      return { error: null, stdout: '{"tool":"no_match"}', stderr: "" };
    },
  );
  assert("output" in answer);
  assert("metadata" in answer);
  assertEquals(answer.output, [{ function: { name: "swamp" } }]);
  assertEquals(answer.metadata?.requestedModel, "gpt-6-astra");
  await assertRejects(() => Deno.stat(directory), Deno.errors.NotFound);
});

Deno.test("callCodex: failed process rejects even a valid partial answer and cleans up", async () => {
  let directory = "";
  const answer = await callCodex(
    "query",
    config,
    async (_args: string[], _prompt: string, cwd: string) => {
      directory = cwd;
      await Deno.writeTextFile(join(cwd, "answer.json"), '{"tool":"swamp"}');
      return { error: new Error("timeout"), stdout: "", stderr: "" };
    },
  );
  assertStringIncludes(answer.error!, "timeout");
  await assertRejects(() => Deno.stat(directory), Deno.errors.NotFound);
});

Deno.test("callCodex: a missing executable or missing final answer fails the case", async () => {
  const missing = await callCodex("q", config, () => {
    throw new Error("ENOENT");
  });
  assertStringIncludes(missing.error!, "ENOENT");
  const empty = await callCodex(
    "q",
    config,
    () => Promise.resolve({ error: null, stdout: "", stderr: "" }),
  );
  assertEquals(typeof empty.error, "string");
});
