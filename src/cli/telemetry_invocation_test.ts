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
import { Command } from "@cliffy/command";
import {
  REDACTED,
  resolveTelemetryInvocation,
  UNKNOWN_OPTION,
} from "./telemetry_invocation.ts";

const noop = () => {};

/** A small tree shaped like the real one, covering each resolution rule. */
function buildTree() {
  const history = new Command()
    .command(
      "get",
      new Command().arguments("<model_id_or_name:string>").action(noop),
    )
    .command(
      "search",
      new Command().alias("find").arguments("[query:string]").action(noop),
    );

  const method = new Command()
    .command(
      "run",
      new Command()
        .arguments("<model_id_or_name:string> <method_name:string>")
        .option("--input <value:string>", "input", { collect: true })
        .option("--last-evaluated", "flag")
        .action(noop),
    )
    .command("history", history);

  const model = new Command()
    .command(
      "get",
      new Command().arguments("<model_id_or_name:string>").action(noop),
    )
    .command("method", method);

  return new Command()
    .name("swamp")
    .globalOption("--json", "json")
    .globalOption("--log-level <level:string>", "level")
    .globalOption("-v, --verbose", "verbose")
    .globalOption("-q, --quiet", "quiet")
    .globalOption("--no-color", "color")
    .command("model", model)
    .command("init", new Command().arguments("[path:string]").action(noop))
    .command(
      "data",
      new Command().command(
        "query",
        new Command().arguments("<predicate:string>").action(noop),
      ),
    )
    .command(
      "vault",
      new Command().command(
        "put",
        new Command()
          .arguments("<vault_name:string> <key:string> [value:string]")
          .action(noop),
      ),
    )
    .command(
      "access",
      new Command().command(
        "group",
        new Command().command(
          "create",
          new Command().arguments("<name:string>").action(noop),
        ),
      ),
    )
    .command(
      "config",
      new Command().command(
        "set",
        new Command().arguments("<key:string> <value:string>").action(noop),
      ),
    )
    .command(
      "help",
      new Command().arguments("[command...:string]").action(noop),
    )
    .command(
      "source",
      new Command().command(
        "add",
        new Command().arguments("<path...:string>").action(noop),
      ),
    );
}

Deno.test("resolveTelemetryInvocation: sends names and keeps every command word", () => {
  const result = resolveTelemetryInvocation(buildTree(), [
    "model",
    "method",
    "history",
    "get",
    "acme-prod",
  ]);
  assertEquals(result.command, "model");
  assertEquals(result.subcommand, "method");
  assertEquals(result.args, ["history", "get", "acme-prod"]);
  assertEquals(result.commandPath, ["model", "method", "history", "get"]);
});

Deno.test("resolveTelemetryInvocation: keeps the historical args shape for method run", () => {
  const result = resolveTelemetryInvocation(buildTree(), [
    "model",
    "method",
    "run",
    "acme-prod",
    "deploy",
    "--input",
    "token=s3cr3t",
    "--last-evaluated",
  ]);
  assertEquals(result.args, ["run", "acme-prod", "deploy"]);
  assertEquals(result.optionKeys, ["--input", "--last-evaluated"]);
});

Deno.test("resolveTelemetryInvocation: canonicalises aliases in commandPath only", () => {
  const result = resolveTelemetryInvocation(buildTree(), [
    "model",
    "method",
    "history",
    "find",
    "deploy",
  ]);
  assertEquals(result.commandPath, ["model", "method", "history", "search"]);
  // swamp-club scores on the typed spelling; it must not move.
  assertEquals(result.args, ["history", "find", "deploy"]);
});

Deno.test("resolveTelemetryInvocation: keeps a typed subcommand alias", () => {
  const tree = buildTree();
  tree.getCommand("model")!.getCommand("get")!.alias("show");
  const result = resolveTelemetryInvocation(tree, ["model", "show", "acme"]);
  assertEquals(result.subcommand, "show");
  assertEquals(result.commandPath, ["model", "get"]);
  assertEquals(result.args, ["acme"]);
});

Deno.test("resolveTelemetryInvocation: a path is never promoted to subcommand", () => {
  const result = resolveTelemetryInvocation(buildTree(), ["init", "/srv/acme"]);
  assertEquals(result.command, "init");
  assertEquals(result.subcommand, undefined);
  assertEquals(result.args, [REDACTED]);
});

Deno.test("resolveTelemetryInvocation: redacts everything after data query", () => {
  const result = resolveTelemetryInvocation(buildTree(), [
    "data",
    "query",
    "attributes.ip == '10.0.0.1'",
  ]);
  assertEquals(result.args, [REDACTED]);
});

Deno.test("resolveTelemetryInvocation: redacts vault keys and values but sends the vault name", () => {
  const result = resolveTelemetryInvocation(buildTree(), [
    "vault",
    "put",
    "prod",
    "DB_PASSWORD",
    "hunter2",
  ]);
  assertEquals(result.args, ["prod", REDACTED, REDACTED]);
});

Deno.test("resolveTelemetryInvocation: sends a config key but redacts its value", () => {
  const result = resolveTelemetryInvocation(buildTree(), [
    "config",
    "set",
    "logLevel",
    "debug",
  ]);
  assertEquals(result.args, ["logLevel", REDACTED]);
});

Deno.test("resolveTelemetryInvocation: redacts every value of a variadic path argument", () => {
  const result = resolveTelemetryInvocation(buildTree(), [
    "source",
    "add",
    "/a",
    "/b",
  ]);
  assertEquals(result.args, [REDACTED, REDACTED]);
});

Deno.test("resolveTelemetryInvocation: an unknown option's value is dropped and later positionals are untrusted", () => {
  const result = resolveTelemetryInvocation(buildTree(), [
    "model",
    "get",
    "--inptu",
    "token=s3cr3t",
    "acme-prod",
  ]);
  assertEquals(result.args, [REDACTED]);
  assertEquals(result.optionKeys, [UNKNOWN_OPTION]);
});

Deno.test("resolveTelemetryInvocation: key=value options never leak the value", () => {
  const result = resolveTelemetryInvocation(buildTree(), [
    "--log-level=debug",
    "model",
    "get",
    "--input=token=s3cr3t",
    "acme-prod",
  ]);
  assertEquals(result.commandPath, ["model", "get"]);
  assertEquals(result.args, ["acme-prod"]);
  assertEquals(result.optionKeys, ["--log-level", UNKNOWN_OPTION]);
});

Deno.test("resolveTelemetryInvocation: global, short and negatable flags do not consume the command", () => {
  const result = resolveTelemetryInvocation(buildTree(), [
    "-v",
    "--no-color",
    "--json",
    "model",
    "get",
    "acme-prod",
  ]);
  assertEquals(result.commandPath, ["model", "get"]);
  assertEquals(result.args, ["acme-prod"]);
  assertEquals(result.globalOptions, ["-v", "--no-color", "--json"]);
});

Deno.test("resolveTelemetryInvocation: an unknown command and what follows are redacted", () => {
  const result = resolveTelemetryInvocation(buildTree(), [
    "model",
    "bogus",
    "acme-prod",
  ]);
  assertEquals(result.commandPath, ["model"]);
  assertEquals(result.subcommand, undefined);
  assertEquals(result.args, [REDACTED, REDACTED]);
});

Deno.test("resolveTelemetryInvocation: positionals beyond the declared arguments are redacted", () => {
  const result = resolveTelemetryInvocation(buildTree(), [
    "model",
    "get",
    "acme-prod",
    "extra",
  ]);
  assertEquals(result.args, ["acme-prod", REDACTED]);
});

Deno.test("resolveTelemetryInvocation: everything after -- is redacted", () => {
  const result = resolveTelemetryInvocation(buildTree(), [
    "model",
    "get",
    "--",
    "acme-prod",
  ]);
  assertEquals(result.args, [REDACTED]);
});

Deno.test("resolveTelemetryInvocation: an empty invocation resolves to no command", () => {
  const result = resolveTelemetryInvocation(buildTree(), ["--json"]);
  assertEquals(result.command, "");
  assertEquals(result.commandPath, []);
  assertEquals(result.globalOptions, ["--json"]);
});

Deno.test("resolveTelemetryInvocation: a required option value starting with - is not recorded as a key", () => {
  const result = resolveTelemetryInvocation(buildTree(), [
    "model",
    "method",
    "run",
    "acme-prod",
    "deploy",
    "--input",
    "-hunter2",
  ]);
  assertEquals(result.optionKeys, ["--input"]);
  assertEquals(result.args, ["run", "acme-prod", "deploy"]);
});

Deno.test("resolveTelemetryInvocation: combined short flags do not consume the next token", () => {
  const result = resolveTelemetryInvocation(buildTree(), [
    "-vq",
    "model",
    "get",
    "acme-prod",
  ]);
  assertEquals(result.commandPath, ["model", "get"]);
  assertEquals(result.args, ["acme-prod"]);
});

Deno.test("resolveTelemetryInvocation: too few positionals redacts them all", () => {
  // `vault put KEY=VALUE` without the vault name would otherwise put the
  // secret in the vault_name slot, which is sent.
  const result = resolveTelemetryInvocation(buildTree(), [
    "vault",
    "put",
    "API_KEY=sk-live-123",
  ]);
  assertEquals(result.args, [REDACTED]);
});

Deno.test("resolveTelemetryInvocation: access group names are redacted even as a plain name", () => {
  const result = resolveTelemetryInvocation(buildTree(), [
    "access",
    "group",
    "create",
    "release-managers",
  ]);
  assertEquals(result.commandPath, ["access", "group", "create"]);
  assertEquals(result.args, ["create", REDACTED]);
});

Deno.test("resolveTelemetryInvocation: a value typed as an option is not recorded as a key", () => {
  const result = resolveTelemetryInvocation(buildTree(), [
    "model",
    "get",
    "acme-prod",
    "-abc123",
  ]);
  assertEquals(result.optionKeys, [UNKNOWN_OPTION]);
});

Deno.test("resolveTelemetryInvocation: an unknown flag before the command does not swallow it", () => {
  const result = resolveTelemetryInvocation(buildTree(), [
    "--typo",
    "model",
    "get",
    "acme-prod",
  ]);
  assertEquals(result.commandPath, ["model", "get"]);
  assertEquals(result.optionKeys, [UNKNOWN_OPTION]);
  assertEquals(result.args, ["acme-prod"]);
});

Deno.test("resolveTelemetryInvocation: help sends only the command words it names", () => {
  const vault = resolveTelemetryInvocation(buildTree(), [
    "help",
    "vault",
    "put",
    "prod",
    "DB_PASSWORD",
    "hunter2",
  ]);
  assertEquals(vault.args, ["vault", "put", REDACTED, REDACTED, REDACTED]);

  const query = resolveTelemetryInvocation(buildTree(), [
    "help",
    "data",
    "query",
    "attributes.ip == '10.0.0.1'",
  ]);
  assertEquals(query.args, ["data", "query", REDACTED]);
});

Deno.test("resolveTelemetryInvocation: an unknown option makes every positional untrusted", () => {
  const result = resolveTelemetryInvocation(buildTree(), [
    "vault",
    "put",
    "--typo",
    "prod",
    "STRIPE_LIVE_KEY",
    "sk-live",
  ]);
  assertEquals(result.args, [REDACTED, REDACTED]);
});

Deno.test("resolveTelemetryInvocation: an ambiguous shift never sends a vault key", () => {
  // `<vault_name> <key> [value]` with two given: DB_PASSWORD may be the key.
  const result = resolveTelemetryInvocation(buildTree(), [
    "vault",
    "put",
    "DB_PASSWORD",
    "hunter2",
  ]);
  assertEquals(result.args, [REDACTED, REDACTED]);
});

Deno.test("resolveTelemetryInvocation: a value shaped like a long option is not recorded", () => {
  const result = resolveTelemetryInvocation(buildTree(), [
    "vault",
    "put",
    "prod",
    "--sk-live-abc123",
  ]);
  assertEquals(result.optionKeys, [UNKNOWN_OPTION]);
});
