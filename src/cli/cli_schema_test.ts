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
  assertEquals(schema.root.subcommands[0].hidden, false);
});

Deno.test("buildCliSchema includeHidden lists hidden commands marked hidden", () => {
  const hidden = new Command().description("secret").hidden();
  const visible = new Command().description("visible");
  const root = new Command()
    .name("cli")
    .description("root")
    .command("visible", visible)
    .command("hidden", hidden);

  const schema = buildCliSchema(root, "1.0.0", { includeHidden: true });

  assertEquals(
    schema.root.subcommands.map((c) => [c.name, c.hidden]),
    [["visible", false], ["hidden", true]],
  );
  assertEquals(schema.root.hidden, false);
});

Deno.test("buildCliSchema marks a hidden subtree root and its visible children", () => {
  // reset() reselects the group: hidden() applies to the command a chain last
  // selected, which after command("child", …) is the child.
  const group = new Command()
    .description("group")
    .command("child", new Command().description("child"))
    .reset()
    .hidden();
  const root = new Command().name("cli").description("root");
  root.command("group", group);

  const target = root.getCommand("group", true)!;
  const schema = buildCliSchema(target, "1.0.0", { includeHidden: true });

  assertEquals(schema.root.name, "group");
  assertEquals(schema.root.hidden, true);
  assertEquals(
    schema.root.subcommands.map((c) => [c.name, c.hidden]),
    [["child", false]],
  );
});

Deno.test("buildCliSchema captures command aliases", () => {
  const root = new Command()
    .name("cli")
    .description("root")
    .command("none", new Command().description("no alias"))
    .command("one", new Command().description("one alias").alias("o"))
    .command(
      "many",
      new Command().description("two aliases").alias("m").alias("several"),
    );

  const schema = buildCliSchema(root, "1.0.0");
  const aliases = Object.fromEntries(
    schema.root.subcommands.map((c) => [c.name, c.aliases]),
  );

  assertEquals(aliases, { none: [], one: ["o"], many: ["m", "several"] });
});

Deno.test("buildCliSchema reports whether an option takes a value", () => {
  const root = new Command()
    .name("cli")
    .description("root")
    .option("--json", "Bare flag")
    .option("--log-level <level:string>", "Required value")
    .option("--tag [tag:string]", "Optional value");

  const opts = buildCliSchema(root, "1.0.0").root.options;
  const byFlag = (flag: string) => opts.find((o) => o.flags === flag)!;

  assertEquals(byFlag("--json").takesValue, false);
  assertEquals("value" in byFlag("--json"), false);
  assertEquals(byFlag("--log-level").takesValue, true);
  assertEquals(byFlag("--log-level").value, "<level:string>");
  assertEquals(byFlag("--tag").takesValue, true);
  assertEquals(byFlag("--tag").value, "[tag:string]");
});

Deno.test("buildCliSchema lists hidden options only with includeHidden", () => {
  const root = new Command()
    .name("cli")
    .description("root")
    .option("--shown", "Visible option")
    .option("--secret", "Hidden option", { hidden: true });

  const byDefault = buildCliSchema(root, "1.0.0").root.options;
  assertEquals(byDefault.map((o) => [o.flags, o.hidden]), [["--shown", false]]);

  const all = buildCliSchema(root, "1.0.0", { includeHidden: true }).root
    .options;
  assertEquals(
    all.map((o) => [o.flags, o.hidden]),
    [["--shown", false], ["--secret", true]],
  );
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

Deno.test("buildCliSchema stripGlobalOptions removes globals from options and populates globalOptions", () => {
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

  // Global option should NOT appear in options
  const jsonOpt = schema.root.options.find((o) => o.flags.includes("--json"));
  assertEquals(jsonOpt, undefined);

  // Local option should still appear in options
  const localOpt = schema.root.options.find((o) => o.flags.includes("--local"));
  assertEquals(localOpt !== undefined, true);

  // Global option should appear in globalOptions
  assertEquals(schema.root.globalOptions !== undefined, true);
  const globalJson = schema.root.globalOptions!.find((o) =>
    o.flags.includes("--json")
  );
  assertEquals(globalJson !== undefined, true);
  assertEquals(globalJson!.description, "JSON output");
  assertEquals(globalJson!.takesValue, false);
  assertEquals(globalJson!.hidden, false);

  // Local option should NOT appear in globalOptions
  const globalLocal = schema.root.globalOptions!.find((o) =>
    o.flags.includes("--local")
  );
  assertEquals(globalLocal, undefined);
});

Deno.test("buildCliSchema without stripGlobalOptions does not set globalOptions", () => {
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

  assertEquals(schema.root.globalOptions, undefined);
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

Deno.test("buildCliSchema globalOptions carry value and hidden details", () => {
  const sub = new Command().description("subcommand");
  const _root = new Command()
    .name("cli")
    .description("root")
    .globalOption("--log-level <level:string>", "Log level")
    .globalOption("--internal", "Internal", { hidden: true })
    .command("sub", sub);

  const byDefault = buildCliSchema(sub, "1.0.0", { stripGlobalOptions: true })
    .root.globalOptions!;
  assertEquals(byDefault.length, 1);
  assertEquals(byDefault[0].flags, "--log-level");
  assertEquals(byDefault[0].takesValue, true);
  assertEquals(byDefault[0].value, "<level:string>");

  const all = buildCliSchema(sub, "1.0.0", {
    stripGlobalOptions: true,
    includeHidden: true,
  }).root.globalOptions!;
  assertEquals(
    all.map((o) => [o.flags, o.hidden]),
    [["--log-level", false], ["--internal", true]],
  );
});
