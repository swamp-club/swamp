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
import { parseCommand } from "./command_parser.ts";

Deno.test("parseCommand: full /swamp prefix", () => {
  const result = parseCommand("/swamp workflow run deploy");
  assertEquals(result?.domain, "workflow");
  assertEquals(result?.verb, "run");
  assertEquals(result?.target, "deploy");
});

Deno.test("parseCommand: shortcut /run", () => {
  const result = parseCommand("/run deploy");
  assertEquals(result?.domain, "workflow");
  assertEquals(result?.verb, "run");
  assertEquals(result?.target, "deploy");
});

Deno.test("parseCommand: shortcut /status", () => {
  const result = parseCommand("/status");
  assertEquals(result?.domain, "auth");
  assertEquals(result?.verb, "whoami");
  assertEquals(result?.target, "");
});

Deno.test("parseCommand: bare command without slash", () => {
  const result = parseCommand("workflow run deploy");
  assertEquals(result?.domain, "workflow");
  assertEquals(result?.verb, "run");
  assertEquals(result?.target, "deploy");
});

Deno.test("parseCommand: options with equals", () => {
  const result = parseCommand("/swamp workflow run deploy --input env=prod");
  assertEquals(result?.domain, "workflow");
  assertEquals(result?.options.get("input"), "env=prod");
});

Deno.test("parseCommand: options with space-separated value", () => {
  const result = parseCommand("/swamp workflow run deploy --driver docker");
  assertEquals(result?.options.get("driver"), "docker");
});

Deno.test("parseCommand: returns null for empty string", () => {
  assertEquals(parseCommand(""), null);
});

Deno.test("parseCommand: returns null for unrecognized command", () => {
  assertEquals(parseCommand("/swamp foobar baz"), null);
});

Deno.test("parseCommand: returns null for bare /swamp with no subcommand", () => {
  assertEquals(parseCommand("/swamp"), null);
});

Deno.test("parseCommand: data search with target", () => {
  const result = parseCommand("data search vpc");
  assertEquals(result?.domain, "data");
  assertEquals(result?.verb, "search");
  assertEquals(result?.target, "vpc");
});

Deno.test("parseCommand: quoted arguments preserved", () => {
  const result = parseCommand('/run "my workflow"');
  assertEquals(result?.target, "my workflow");
});
