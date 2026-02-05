import { assertEquals } from "@std/assert";
import { extractCommandInfo, isTelemetryDisabled } from "./telemetry_integration.ts";

Deno.test("extractCommandInfo extracts simple command", () => {
  const info = extractCommandInfo(["model"]);

  assertEquals(info.command, "model");
  assertEquals(info.subcommand, undefined);
  assertEquals(info.args, []);
  assertEquals(info.optionKeys, []);
  assertEquals(info.globalOptions, []);
});

Deno.test("extractCommandInfo extracts command and subcommand", () => {
  const info = extractCommandInfo(["model", "create"]);

  assertEquals(info.command, "model");
  assertEquals(info.subcommand, "create");
  assertEquals(info.args, []);
  assertEquals(info.optionKeys, []);
  assertEquals(info.globalOptions, []);
});

Deno.test("extractCommandInfo extracts command with positional args", () => {
  const info = extractCommandInfo(["model", "create", "my-model", "MyType"]);

  assertEquals(info.command, "model");
  assertEquals(info.subcommand, "create");
  assertEquals(info.args, ["<REDACTED>", "<REDACTED>"]);
  assertEquals(info.optionKeys, []);
  assertEquals(info.globalOptions, []);
});

Deno.test("extractCommandInfo extracts global options", () => {
  const info = extractCommandInfo(["--json", "--debug-logs", "model", "create"]);

  assertEquals(info.command, "model");
  assertEquals(info.subcommand, "create");
  assertEquals(info.globalOptions, ["--json", "--debug-logs"]);
  assertEquals(info.optionKeys, []);
});

Deno.test("extractCommandInfo extracts command-specific options", () => {
  const info = extractCommandInfo([
    "model",
    "create",
    "my-model",
    "--repo-dir",
    "/path/to/repo",
    "--force",
  ]);

  assertEquals(info.command, "model");
  assertEquals(info.subcommand, "create");
  assertEquals(info.args, ["<REDACTED>"]);
  assertEquals(info.optionKeys, ["--repo-dir", "--force"]);
  assertEquals(info.globalOptions, []);
});

Deno.test("extractCommandInfo handles mixed global and command options", () => {
  const info = extractCommandInfo([
    "--json",
    "workflow",
    "run",
    "my-workflow",
    "--repo-dir",
    "/path",
    "-q",
  ]);

  assertEquals(info.command, "workflow");
  assertEquals(info.subcommand, "run");
  assertEquals(info.args, ["<REDACTED>"]);
  assertEquals(info.optionKeys, ["--repo-dir"]);
  assertEquals(info.globalOptions, ["--json", "-q"]);
});

Deno.test("extractCommandInfo handles option=value syntax", () => {
  const info = extractCommandInfo([
    "model",
    "create",
    "--repo-dir=/path/to/repo",
  ]);

  assertEquals(info.command, "model");
  assertEquals(info.subcommand, "create");
  assertEquals(info.optionKeys, ["--repo-dir"]);
});

Deno.test("extractCommandInfo handles --no-telemetry flag", () => {
  const info = extractCommandInfo([
    "--no-telemetry",
    "model",
    "search",
  ]);

  assertEquals(info.command, "model");
  assertEquals(info.subcommand, "search");
  assertEquals(info.globalOptions, ["--no-telemetry"]);
});

Deno.test("isTelemetryDisabled returns true when flag present", () => {
  assertEquals(isTelemetryDisabled(["--no-telemetry", "model", "search"]), true);
  assertEquals(isTelemetryDisabled(["model", "--no-telemetry", "search"]), true);
  assertEquals(isTelemetryDisabled(["model", "search", "--no-telemetry"]), true);
});

Deno.test("isTelemetryDisabled returns false when flag absent", () => {
  assertEquals(isTelemetryDisabled(["model", "search"]), false);
  assertEquals(isTelemetryDisabled(["--json", "model", "search"]), false);
});
