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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { Command } from "@cliffy/command";
import {
  buildUnknownCommandMessage,
  extractUnknownName,
  getSubcommandNames,
} from "./unknown_command_handler.ts";

// Helper to build a command with subcommands for testing.
// Builds subcommands in a way that avoids Cliffy's deep generic inference issues.
function buildCommand(name: string, subcommandNames: string[]): Command {
  const cmd = new Command().name(name);
  for (const sub of subcommandNames) {
    cmd.command(sub, new Command().description(sub));
  }
  return cmd;
}

Deno.test("extractUnknownName - extracts name from Cliffy error", () => {
  assertEquals(
    extractUnknownName('Unknown command "hetzner-server".'),
    "hetzner-server",
  );
});

Deno.test("extractUnknownName - extracts name with Did you mean suffix", () => {
  assertEquals(
    extractUnknownName(
      'Unknown command "creat". Did you mean command "create"?',
    ),
    "creat",
  );
});

Deno.test("extractUnknownName - returns undefined for non-matching", () => {
  assertEquals(
    extractUnknownName("Some other error message"),
    undefined,
  );
});

Deno.test("getSubcommandNames - lists visible subcommands", () => {
  const cmd = buildCommand("model", [
    "create",
    "delete",
    "get",
    "search",
    "method",
    "type",
  ]);
  const names = getSubcommandNames(cmd);
  assertEquals(names.includes("create"), true);
  assertEquals(names.includes("get"), true);
  assertEquals(names.includes("method"), true);
});

Deno.test("buildUnknownCommandMessage - typo suggests correct command", () => {
  const cmd = buildCommand("model", [
    "create",
    "delete",
    "get",
    "search",
    "method",
    "type",
  ]);
  const msg = buildUnknownCommandMessage("creat", cmd);
  assertStringIncludes(msg, 'Did you mean "create"');
});

Deno.test("buildUnknownCommandMessage - non-typo suggests model get/method run/validate", () => {
  const cmd = buildCommand("model", [
    "create",
    "delete",
    "get",
    "search",
    "method",
    "type",
  ]);
  const msg = buildUnknownCommandMessage("hetzner-server", cmd);
  assertStringIncludes(msg, "is not a subcommand");
  assertStringIncludes(msg, "swamp model get hetzner-server");
  assertStringIncludes(msg, "swamp model method run hetzner-server");
  assertStringIncludes(msg, "swamp model validate hetzner-server");
});

Deno.test("buildUnknownCommandMessage - workflow context suggestions", () => {
  const cmd = buildCommand("workflow", ["create", "run", "get"]);
  const msg = buildUnknownCommandMessage("deploy-app", cmd);
  assertStringIncludes(msg, "swamp workflow get deploy-app");
  assertStringIncludes(msg, "swamp workflow run deploy-app");
  assertStringIncludes(msg, "swamp workflow validate deploy-app");
});

Deno.test("buildUnknownCommandMessage - generic fallback for unknown context", () => {
  const cmd = buildCommand("data", ["search", "get"]);
  const msg = buildUnknownCommandMessage("something-random", cmd);
  assertStringIncludes(msg, "Available subcommands:");
  assertStringIncludes(msg, "search");
});

Deno.test("buildUnknownCommandMessage - method context suggestions", () => {
  const cmd = buildCommand("method", ["run", "history"]);
  const msg = buildUnknownCommandMessage("my-server", cmd);
  assertStringIncludes(msg, "swamp model method run my-server");
});

Deno.test("buildUnknownCommandMessage - vault context suggestions", () => {
  const cmd = buildCommand("vault", [
    "create",
    "get",
    "put",
    "list-keys",
    "search",
    "type",
  ]);
  const msg = buildUnknownCommandMessage("my-vault", cmd);
  assertStringIncludes(msg, "swamp vault get my-vault");
  assertStringIncludes(msg, "swamp vault put my-vault");
  assertStringIncludes(msg, "swamp vault list-keys my-vault");
});

Deno.test("buildUnknownCommandMessage - repo context suggestions", () => {
  const cmd = buildCommand("repo", ["init", "upgrade"]);
  const msg = buildUnknownCommandMessage("my-project", cmd);
  assertStringIncludes(msg, "swamp repo init my-project");
  assertStringIncludes(msg, "swamp repo upgrade");
  assertStringIncludes(msg, "swamp update");
});

Deno.test("buildUnknownCommandMessage - repo typo suggests upgrade", () => {
  const cmd = buildCommand("repo", ["init", "upgrade"]);
  const msg = buildUnknownCommandMessage("update", cmd);
  assertStringIncludes(msg, 'Did you mean "upgrade"');
});
