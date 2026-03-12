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
import { Command } from "@cliffy/command";
import { buildCliSchema } from "./cli_schema.ts";

Deno.test("buildCliSchema captures root command name and version", () => {
  const root = new Command().name("test-cli").description("A test CLI");
  const schema = buildCliSchema(root, "1.0.0");

  assertEquals(schema.version, "1.0.0");
  assertEquals(schema.root.name, "test-cli");
  assertEquals(schema.root.description, "A test CLI");
});

Deno.test("buildCliSchema captures subcommands recursively", () => {
  const root = new Command()
    .name("cli")
    .description("root")
    .command(
      "parent",
      new Command().description("parent cmd").command(
        "child",
        new Command().description("child cmd"),
      ),
    );

  const schema = buildCliSchema(root, "1.0.0");

  assertEquals(schema.root.subcommands.length, 1);
  assertEquals(schema.root.subcommands[0].name, "parent");
  assertEquals(schema.root.subcommands[0].subcommands.length, 1);
  assertEquals(schema.root.subcommands[0].subcommands[0].name, "child");
  assertEquals(
    schema.root.subcommands[0].subcommands[0].description,
    "child cmd",
  );
});

Deno.test("buildCliSchema excludes hidden commands", () => {
  const hidden = new Command().description("secret").hidden();
  const visible = new Command().description("visible");
  const root = new Command()
    .name("cli")
    .description("root")
    .command("visible", visible)
    .command("hidden", hidden);

  const schema = buildCliSchema(root, "1.0.0");

  assertEquals(schema.root.subcommands.length, 1);
  assertEquals(schema.root.subcommands[0].name, "visible");
});

Deno.test("buildCliSchema captures arguments with required and variadic", () => {
  const root = new Command()
    .name("cli")
    .description("root")
    .command(
      "cmd",
      new Command()
        .description("with args")
        .arguments("<required:string> [optional:string] [...rest:string]"),
    );

  const schema = buildCliSchema(root, "1.0.0");
  const args = schema.root.subcommands[0].arguments;

  assertEquals(args.length, 3);
  assertEquals(args[0].name, "required");
  assertEquals(args[0].required, true);
  assertEquals(args[0].variadic, false);
  assertEquals(args[1].name, "optional");
  assertEquals(args[1].required, false);
  assertEquals(args[1].variadic, false);
  assertEquals(args[2].name, "rest");
  assertEquals(args[2].required, false);
  assertEquals(args[2].variadic, true);
});

Deno.test("buildCliSchema captures options with flags and defaults", () => {
  const root = new Command()
    .name("cli")
    .description("root")
    .command(
      "cmd",
      new Command()
        .description("with opts")
        .option("-n, --name <name:string>", "The name", { required: true })
        .option("--count <count:number>", "Count", { default: 5 })
        .option("--tags <tag:string>", "Tags", { collect: true }),
    );

  const schema = buildCliSchema(root, "1.0.0");
  const opts = schema.root.subcommands[0].options;

  const nameOpt = opts.find((o) => o.flags.includes("--name"));
  assertEquals(nameOpt?.required, true);
  assertEquals(nameOpt?.description, "The name");

  const countOpt = opts.find((o) => o.flags.includes("--count"));
  assertEquals(countOpt?.default, 5);
  assertEquals(countOpt?.required, false);

  const tagsOpt = opts.find((o) => o.flags.includes("--tags"));
  assertEquals(tagsOpt?.collect, true);
});

Deno.test("buildCliSchema filters global options from subcommands", () => {
  const root = new Command()
    .name("cli")
    .description("root")
    .globalOption("--json", "JSON output")
    .command(
      "sub",
      new Command().description("subcommand").option(
        "--local",
        "Local option",
      ),
    );

  const schema = buildCliSchema(root, "1.0.0");

  // Global option appears on root
  const rootJson = schema.root.options.find((o) => o.flags.includes("--json"));
  assertEquals(rootJson !== undefined, true);

  // Global option does NOT appear on subcommand
  const subOpts = schema.root.subcommands[0].options;
  const subJson = subOpts.find((o) => o.flags.includes("--json"));
  assertEquals(subJson, undefined);

  // Local option does appear on subcommand
  const subLocal = subOpts.find((o) => o.flags.includes("--local"));
  assertEquals(subLocal !== undefined, true);
});

Deno.test("buildCliSchema stripGlobalOptions removes globals from root too", () => {
  const sub = new Command().description("subcommand").option(
    "--local",
    "Local option",
  );
  const _root = new Command()
    .name("cli")
    .description("root")
    .globalOption("--json", "JSON output")
    .command("sub", sub);

  // Build schema for the subcommand with stripGlobalOptions
  const schema = buildCliSchema(sub, "1.0.0", { stripGlobalOptions: true });

  // Global option should NOT appear even though sub is the root of this schema
  const jsonOpt = schema.root.options.find((o) => o.flags.includes("--json"));
  assertEquals(jsonOpt, undefined);

  // Local option should still appear
  const localOpt = schema.root.options.find((o) => o.flags.includes("--local"));
  assertEquals(localOpt !== undefined, true);
});

Deno.test("buildCliSchema filters builtin --help and --version flags", () => {
  const root = new Command()
    .name("cli")
    .version("1.0.0")
    .description("root")
    .option("--custom", "Custom option");

  const schema = buildCliSchema(root, "1.0.0");

  const helpOpt = schema.root.options.find((o) => o.flags.includes("--help"));
  assertEquals(helpOpt, undefined);

  const versionOpt = schema.root.options.find((o) =>
    o.flags.includes("--version")
  );
  assertEquals(versionOpt, undefined);

  const customOpt = schema.root.options.find((o) =>
    o.flags.includes("--custom")
  );
  assertEquals(customOpt !== undefined, true);
});
