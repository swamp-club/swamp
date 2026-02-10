import { assertEquals } from "@std/assert";
import {
  extractCommandInfo,
  isTelemetryDisabled,
} from "./telemetry_integration.ts";

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

Deno.test("extractCommandInfo records categorical args for model create", () => {
  const info = extractCommandInfo([
    "model",
    "create",
    "prompt",
    "my-model",
  ]);

  assertEquals(info.command, "model");
  assertEquals(info.subcommand, "create");
  assertEquals(info.args, ["prompt", "<REDACTED>"]);
  assertEquals(info.optionKeys, []);
  assertEquals(info.globalOptions, []);
});

Deno.test("extractCommandInfo extracts global options", () => {
  const info = extractCommandInfo([
    "--json",
    "--verbose",
    "model",
    "create",
  ]);

  assertEquals(info.command, "model");
  assertEquals(info.subcommand, "create");
  assertEquals(info.globalOptions, ["--json", "--verbose"]);
  assertEquals(info.optionKeys, []);
});

Deno.test("extractCommandInfo extracts command-specific options", () => {
  const info = extractCommandInfo([
    "model",
    "create",
    "prompt",
    "--repo-dir",
    "/path/to/repo",
    "--force",
  ]);

  assertEquals(info.command, "model");
  assertEquals(info.subcommand, "create");
  assertEquals(info.args, ["prompt"]);
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
  assertEquals(
    isTelemetryDisabled(["--no-telemetry", "model", "search"]),
    true,
  );
  assertEquals(
    isTelemetryDisabled(["model", "--no-telemetry", "search"]),
    true,
  );
  assertEquals(
    isTelemetryDisabled(["model", "search", "--no-telemetry"]),
    true,
  );
});

Deno.test("isTelemetryDisabled returns false when flag absent", () => {
  assertEquals(isTelemetryDisabled(["model", "search"]), false);
  assertEquals(isTelemetryDisabled(["--json", "model", "search"]), false);
});

Deno.test("extractCommandInfo records categorical args for model method", () => {
  const info = extractCommandInfo([
    "model",
    "method",
    "run",
    "my-model",
    "train",
  ]);

  assertEquals(info.command, "model");
  assertEquals(info.subcommand, "method");
  assertEquals(info.args, ["run", "<REDACTED>", "train"]);
});

Deno.test("extractCommandInfo redacts all args for commands without schema", () => {
  const info = extractCommandInfo(["model", "get", "my-model"]);

  assertEquals(info.command, "model");
  assertEquals(info.subcommand, "get");
  assertEquals(info.args, ["<REDACTED>"]);
});

Deno.test("extractCommandInfo redacts all args for unknown commands", () => {
  const info = extractCommandInfo(["foo", "bar", "baz"]);

  assertEquals(info.command, "foo");
  assertEquals(info.subcommand, "bar");
  assertEquals(info.args, ["<REDACTED>"]);
});

Deno.test("extractCommandInfo redacts args beyond schema length", () => {
  const info = extractCommandInfo([
    "model",
    "create",
    "prompt",
    "my-model",
    "extra",
  ]);

  assertEquals(info.command, "model");
  assertEquals(info.subcommand, "create");
  assertEquals(info.args, ["prompt", "<REDACTED>", "<REDACTED>"]);
});

Deno.test("extractCommandInfo records categorical arg for type describe", () => {
  const info = extractCommandInfo(["type", "describe", "prompt"]);

  assertEquals(info.command, "type");
  assertEquals(info.subcommand, "describe");
  assertEquals(info.args, ["prompt"]);
});

Deno.test("extractCommandInfo records categorical arg for vault create", () => {
  const info = extractCommandInfo(["vault", "create", "aws", "my-vault"]);

  assertEquals(info.command, "vault");
  assertEquals(info.subcommand, "create");
  assertEquals(info.args, ["aws", "<REDACTED>"]);
});
