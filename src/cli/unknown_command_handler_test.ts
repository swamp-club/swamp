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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { Command } from "@cliffy/command";
import {
  buildTooManyArgumentsMessage,
  buildUnknownCommandMessage,
  extractPositionalArgs,
  extractUnknownName,
  getSubcommandNames,
  unknownSubcommandBehindOption,
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

Deno.test("buildUnknownCommandMessage - non-typo under model suggests the behavior get/run/validate forms", () => {
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
  assertStringIncludes(msg, "swamp behavior get hetzner-server");
  assertStringIncludes(msg, "swamp behavior run hetzner-server");
  assertStringIncludes(msg, "swamp behavior validate hetzner-server");
  assertEquals(msg.includes("swamp model get"), false);
});

Deno.test("buildUnknownCommandMessage - non-typo under behavior suggests the same get/run/validate forms", () => {
  const cmd = buildCommand("behavior", [
    "run",
    "create",
    "get",
    "validate",
  ]);
  const msg = buildUnknownCommandMessage("hetzner-server", cmd);
  assertStringIncludes(msg, "is not a subcommand");
  assertStringIncludes(msg, "swamp behavior get hetzner-server");
  assertStringIncludes(msg, "swamp behavior run hetzner-server");
  assertStringIncludes(msg, "swamp behavior validate hetzner-server");
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
  assertStringIncludes(msg, "swamp behavior run my-server");
});

Deno.test("buildUnknownCommandMessage - behavior context suggestions (swamp-club#3265)", () => {
  const cmd = buildCommand("behavior", ["run"]);
  const msg = buildUnknownCommandMessage("my-server", cmd);
  assertStringIncludes(msg, "swamp behavior run my-server <method>");
});

Deno.test("buildUnknownCommandMessage - the legacy word under behavior suggests the run the user meant", () => {
  const cmd = buildCommand("behavior", ["run"]);
  const msg = buildUnknownCommandMessage("method", cmd, [
    "behavior",
    "method",
    "run",
    "p1",
    "ping",
  ]);
  assertStringIncludes(msg, "swamp behavior run p1 ping");
  assertEquals(msg.includes("run method"), false);
});

Deno.test("buildUnknownCommandMessage - legacy direct-type form without run does not suggest method as the method name", () => {
  const cmd = buildCommand("model", ["create", "get", "method"]);
  const msg = buildUnknownCommandMessage("@acme/t", cmd, [
    "model",
    "@acme/t",
    "method",
    "ping",
    "name",
    "--input",
    "k=v",
  ]);
  assertStringIncludes(msg, "swamp behavior run @acme/t ping name");
  assertEquals(msg.includes("run @acme/t method"), false);

  const bare = buildUnknownCommandMessage("@acme/t", cmd, [
    "model",
    "@acme/t",
    "method",
  ]);
  assertStringIncludes(bare, "swamp behavior run @acme/t <method> <name>");
});

Deno.test("buildUnknownCommandMessage - legacy named-model order does not suggest method as the method name", () => {
  const cmd = buildCommand("model", ["create", "get", "method"]);
  const msg = buildUnknownCommandMessage("my-model", cmd, [
    "model",
    "my-model",
    "method",
    "run",
    "create",
    "--server",
    "ws://localhost:9999",
  ]);
  assertStringIncludes(msg, "swamp behavior run my-model create");
  assertEquals(msg.includes("run my-model method"), false);

  const bare = buildUnknownCommandMessage("my-model", cmd, [
    "model",
    "my-model",
    "method",
    "run",
  ]);
  assertStringIncludes(bare, "swamp behavior run my-model <method>");
});

Deno.test("buildUnknownCommandMessage - run after the model under behavior does not suggest run as the method name", () => {
  const cmd = buildCommand("behavior", ["run"]);
  const direct = buildUnknownCommandMessage("@acme/t", cmd, [
    "behavior",
    "@acme/t",
    "run",
    "ping",
    "name",
    "--input",
    "k=v",
  ]);
  assertStringIncludes(direct, "swamp behavior run @acme/t ping name");
  assertEquals(direct.includes("@acme/t run"), false);

  const named = buildUnknownCommandMessage("my-server", cmd, [
    "behavior",
    "my-server",
    "run",
    "deploy",
  ]);
  assertStringIncludes(named, "swamp behavior run my-server deploy");
  assertEquals(named.includes("my-server run"), false);
});

Deno.test("buildUnknownCommandMessage - run under model suggests behavior run with the typed model and method", () => {
  const cmd = buildCommand("model", ["create", "get", "method"]);
  const msg = buildUnknownCommandMessage("run", cmd, [
    "--json",
    "model",
    "run",
    "p1",
    "ping",
    "--input",
    "k=v",
  ]);
  assertStringIncludes(msg, "swamp behavior run p1 ping");
  assertEquals(msg.includes("swamp model get run"), false);
});

Deno.test("buildUnknownCommandMessage - the hybrid without raw args falls back to placeholders", () => {
  const cmd = buildCommand("behavior", ["run"]);
  const msg = buildUnknownCommandMessage("method", cmd);
  assertStringIncludes(msg, "swamp behavior run <model> <method>");
});

const UNKNOWN_INPUT = 'Unknown option "--input".';

Deno.test("unknownSubcommandBehindOption - finds the unknown positional a group was given alongside an option", () => {
  const behavior = new Command()
    .name("behavior")
    .alias("behaviour")
    .command("run", new Command().name("run"));
  const root = new Command().name("swamp").command("behavior", behavior);
  const group = root.getCommand("behavior")!;
  assertEquals(
    unknownSubcommandBehindOption(
      group,
      ["behavior", "@acme/t", "run", "ping", "name", "--input", "k=v"],
      UNKNOWN_INPUT,
    ),
    "@acme/t",
  );
  assertEquals(
    unknownSubcommandBehindOption(
      group,
      ["behaviour", "run", "p1", "ping", "--input", "k=v"],
      UNKNOWN_INPUT,
    ),
    undefined,
  );
  assertEquals(
    unknownSubcommandBehindOption(
      group,
      ["behavior", "--input", "k=v"],
      UNKNOWN_INPUT,
    ),
    undefined,
  );
  const model = buildCommand("model", ["create", "get", "method"]);
  assertEquals(
    unknownSubcommandBehindOption(
      model,
      ["model", "p1", "--input", "k=v"],
      UNKNOWN_INPUT,
    ),
    "p1",
  );
  assertEquals(
    unknownSubcommandBehindOption(
      new Command().name("leaf"),
      ["leaf", "x", "--bogus"],
      'Unknown option "--bogus".',
    ),
    undefined,
  );
});

Deno.test("unknownSubcommandBehindOption - leaves a group that takes its own positional alone", () => {
  // Shaped like `swamp model output <output_id_or_model_name>`: subcommands
  // plus an argument of its own, so the positional is legitimate.
  const output = new Command()
    .name("output")
    .arguments("<output_id_or_model_name:string>")
    .command("get", new Command().name("get"))
    .command("search", new Command().name("search"));
  const root = new Command().name("swamp").command("output", output);
  const group = root.getCommand("output")!;
  assertEquals(
    unknownSubcommandBehindOption(
      group,
      ["output", "my-server", "--bogus"],
      'Unknown option "--bogus".',
    ),
    undefined,
  );
});

Deno.test("unknownSubcommandBehindOption - leaves an option typed before the subcommand alone", () => {
  const behavior = new Command()
    .name("behavior")
    .command("run", new Command().name("run"));
  const root = new Command().name("swamp").command("behavior", behavior);
  const group = root.getCommand("behavior")!;
  // A flag-agnostic scan reads `run` as the value of `--skip-checks`; the
  // flag is the real problem, so Cliffy's message must stand.
  assertEquals(
    unknownSubcommandBehindOption(
      group,
      ["behavior", "--skip-checks", "run", "@t", "ping", "name"],
      'Unknown option "--skip-checks".',
    ),
    undefined,
  );
  assertEquals(
    unknownSubcommandBehindOption(
      group,
      ["behavior", "@t", "ping", "name", "--input=k=v"],
      UNKNOWN_INPUT,
    ),
    "@t",
  );
});

Deno.test("buildUnknownCommandMessage - the hybrid keeps the definition name of a direct-type run", () => {
  const cmd = buildCommand("behavior", ["run"]);
  const msg = buildUnknownCommandMessage("method", cmd, [
    "behavior",
    "method",
    "run",
    "@t",
    "ping",
    "name",
  ]);
  assertStringIncludes(msg, "swamp behavior run @t ping name");
});

Deno.test("buildUnknownCommandMessage - run left out echoes the method the user typed", () => {
  const cmd = buildCommand("behavior", ["run"]);
  const msg = buildUnknownCommandMessage("my-server", cmd, [
    "behavior",
    "my-server",
    "deploy",
    "--input",
    "k=v",
  ]);
  assertStringIncludes(msg, "swamp behavior run my-server deploy");
  const typed = buildUnknownCommandMessage("@acme/t", cmd, [
    "behavior",
    "@acme/t",
    "ping",
    "name",
  ]);
  assertStringIncludes(typed, "swamp behavior run @acme/t ping name");
});

Deno.test("buildUnknownCommandMessage - an @type under behavior suggests the direct-type form", () => {
  const cmd = buildCommand("behavior", ["run"]);
  const msg = buildUnknownCommandMessage("@swamp/echo", cmd);
  assertStringIncludes(msg, "swamp behavior run @swamp/echo <method> <name>");
  assertEquals(msg.includes("@swamp/echo <method>\n"), false);
});

Deno.test("buildUnknownCommandMessage - an @type under model suggests only the direct-type run", () => {
  const cmd = buildCommand("model", ["create", "get", "method"]);
  const msg = buildUnknownCommandMessage("@swamp/echo", cmd);
  assertStringIncludes(msg, "swamp behavior run @swamp/echo <method> <name>");
  assertEquals(msg.includes("swamp model get @swamp/echo"), false);
  assertEquals(msg.includes("swamp model validate @swamp/echo"), false);
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

Deno.test("buildUnknownCommandMessage - history context suggestions", () => {
  const cmd = buildCommand("history", ["get", "search", "logs"]);
  const msg = buildUnknownCommandMessage("deploy-pipeline", cmd);
  assertStringIncludes(msg, "history get deploy-pipeline");
  assertStringIncludes(msg, "history logs deploy-pipeline");
  assertStringIncludes(msg, "history search");
});

/** `swamp <group> output`, so the output group has its real parent chain. */
function outputUnder(group: string): Command {
  const output = buildCommand("output", ["get", "search", "logs", "data"]);
  new Command().name("swamp").command(
    group,
    new Command().name(group).command("output", output),
  );
  return output;
}

Deno.test("buildUnknownCommandMessage - output context suggestions name the group as reached", () => {
  const legacy = buildUnknownCommandMessage("my-server", outputUnder("model"));
  assertStringIncludes(legacy, "swamp model output get my-server");
  assertStringIncludes(legacy, "swamp model output search");
  assertStringIncludes(legacy, "swamp model output logs my-server");

  const preferred = buildUnknownCommandMessage(
    "my-server",
    outputUnder("behavior"),
  );
  assertStringIncludes(preferred, "swamp behavior output get my-server");
  assertStringIncludes(preferred, "swamp behavior output search");
  assertStringIncludes(preferred, "swamp behavior output logs my-server");
  assertEquals(preferred.includes("swamp model"), false);
});

Deno.test("buildUnknownCommandMessage - behavior method describe suggests behavior describe (swamp-club#3331)", () => {
  const cmd = buildCommand("behavior", ["run", "describe", "history"]);
  const msg = buildUnknownCommandMessage("method", cmd, [
    "behavior",
    "method",
    "describe",
    "my-server",
    "getSystemInfo",
  ]);
  assertStringIncludes(msg, "swamp behavior describe my-server getSystemInfo");
  assertEquals(msg.includes("swamp behavior run"), false);

  const bare = buildUnknownCommandMessage("method", cmd, [
    "behavior",
    "method",
    "describe",
  ]);
  assertStringIncludes(bare, "swamp behavior describe <model> <method>");
});

Deno.test("buildUnknownCommandMessage - behavior method history suggests behavior history (swamp-club#3331)", () => {
  const cmd: Command = new Command().name("behavior").alias("behaviour");
  for (const sub of ["run", "describe", "history"]) {
    cmd.command(sub, new Command().description(sub));
  }
  const shorthand = buildUnknownCommandMessage("method", cmd, [
    "behaviour",
    "method",
    "history",
    "my-server",
  ]);
  assertStringIncludes(shorthand, "swamp behavior history my-server");

  const get = buildUnknownCommandMessage("method", cmd, [
    "behavior",
    "method",
    "history",
    "get",
    "abc123",
  ]);
  assertStringIncludes(get, "swamp behavior history get abc123");
});

Deno.test("buildUnknownCommandMessage - model describe suggests behavior describe (swamp-club#3331)", () => {
  const cmd = buildCommand("model", ["create", "get", "method"]);
  const msg = buildUnknownCommandMessage("describe", cmd, [
    "model",
    "describe",
    "my-server",
    "getSystemInfo",
  ]);
  assertStringIncludes(msg, "swamp behavior describe my-server getSystemInfo");
  assertEquals(msg.includes("swamp behavior get describe"), false);
});

Deno.test("buildUnknownCommandMessage - model history suggests behavior history (swamp-club#3331)", () => {
  const cmd = buildCommand("model", ["create", "get", "method"]);
  const msg = buildUnknownCommandMessage("history", cmd, [
    "model",
    "history",
    "logs",
    "abc123",
  ]);
  assertStringIncludes(msg, "swamp behavior history logs abc123");
  assertEquals(msg.includes("swamp behavior get history"), false);

  const bare = buildUnknownCommandMessage("history", cmd, ["model", "history"]);
  assertStringIncludes(bare, "swamp behavior history <model>");
});

Deno.test("buildUnknownCommandMessage - a boolean flag between the group and the positionals is not read as taking a value", () => {
  const behavior = buildCommand("behavior", ["run", "describe"]);
  for (const flag of ["--json", "--log", "--skip-checks"]) {
    const msg = buildUnknownCommandMessage("method", behavior, [
      "behavior",
      "method",
      flag,
      "describe",
      "my-server",
      "getSystemInfo",
    ]);
    assertStringIncludes(
      msg,
      "swamp behavior describe my-server getSystemInfo",
      flag,
    );
  }
  const model = buildCommand("model", ["create", "get", "method"]);
  const msg = buildUnknownCommandMessage("run", model, [
    "--log",
    "model",
    "run",
    "--json",
    "p1",
    "ping",
  ]);
  assertStringIncludes(msg, "swamp behavior run p1 ping");
});

Deno.test("extractPositionalArgs - extracts args after command path", () => {
  const args = ["extension", "search", "home", "assistant"];
  const result = extractPositionalArgs(args, "extension search");
  assertEquals(result, ["home", "assistant"]);
});

Deno.test("extractPositionalArgs - skips flags and their values", () => {
  const args = ["extension", "search", "home", "assistant", "--json"];
  const result = extractPositionalArgs(args, "extension search");
  assertEquals(result, ["home", "assistant"]);
});

Deno.test("extractPositionalArgs - skips flag values between positional args", () => {
  const args = [
    "extension",
    "search",
    "--collective",
    "myorg",
    "home",
    "assistant",
  ];
  const result = extractPositionalArgs(args, "extension search");
  assertEquals(result, ["home", "assistant"]);
});

Deno.test("extractPositionalArgs - handles flags before command path", () => {
  const args = ["--json", "extension", "search", "home", "assistant"];
  const result = extractPositionalArgs(args, "extension search");
  assertEquals(result, ["home", "assistant"]);
});

Deno.test("extractPositionalArgs - a boolean flag does not consume the next token", () => {
  assertEquals(
    extractPositionalArgs(
      ["--log", "model", "get", "--json", "my-server"],
      "model get",
    ),
    ["my-server"],
  );
  assertEquals(
    extractPositionalArgs(
      ["behavior", "run", "my-server", "--skip-checks", "deploy"],
      "behavior run",
    ),
    ["my-server", "deploy"],
  );
});

Deno.test("extractPositionalArgs - an option written with = does not consume the next token", () => {
  assertEquals(
    extractPositionalArgs(
      ["behavior", "run", "--log-level=debug", "my-server", "deploy"],
      "behavior run",
    ),
    ["my-server", "deploy"],
  );
});

Deno.test("extractPositionalArgs - returns empty for no positional args", () => {
  const args = ["extension", "search"];
  const result = extractPositionalArgs(args, "extension search");
  assertEquals(result, []);
});

Deno.test("extractPositionalArgs - accepts a typed alias for a path segment (swamp-club#3265)", () => {
  const args = ["behaviour", "run", "my-model", "deploy", "extra1", "extra2"];
  const spellings = [
    new Set(["swamp"]),
    new Set(["behavior", "behaviour"]),
    new Set(["run"]),
  ];
  assertEquals(
    extractPositionalArgs(args, "swamp behavior run", spellings),
    ["my-model", "deploy", "extra1", "extra2"],
  );
});

Deno.test("buildTooManyArgumentsMessage - matches the alias the user typed (swamp-club#3265)", () => {
  const behavior = new Command()
    .name("behavior")
    .alias("behaviour")
    .command("run", new Command().name("run"));
  const root = new Command().name("swamp").command("behavior", behavior);
  const runCmd = root.getCommand("behavior")!.getCommand("run")!;
  const msg = buildTooManyArgumentsMessage(runCmd, [
    "behaviour",
    "run",
    "my-model",
    "deploy",
    "extra1",
    "extra2",
  ]);
  assertStringIncludes(
    msg,
    'swamp behavior run "my-model deploy extra1 extra2"',
  );
});

Deno.test("buildTooManyArgumentsMessage - suggests quoting multi-word input", () => {
  const cmd = new Command().name("search");
  // Simulate cmd.getPath() returning the full path
  const parent = new Command().name("extension").command("search", cmd);
  // Force Cliffy to set the path by accessing the child through parent
  const searchCmd = parent.getCommand("search")!;
  const msg = buildTooManyArgumentsMessage(
    searchCmd,
    ["extension", "search", "home", "assistant"],
  );
  assertStringIncludes(msg, "Too many arguments");
  assertStringIncludes(msg, "wrap it in quotes");
  assertStringIncludes(msg, '"home assistant"');
});

Deno.test("buildTooManyArgumentsMessage - single extra arg shows help fallback", () => {
  const cmd = new Command().name("search");
  const parent = new Command().name("extension").command("search", cmd);
  const searchCmd = parent.getCommand("search")!;
  const msg = buildTooManyArgumentsMessage(
    searchCmd,
    ["extension", "search", "aws"],
  );
  assertStringIncludes(msg, "--help");
});
