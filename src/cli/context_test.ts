import { assertEquals } from "@std/assert";
import {
  createContext,
  getOutputModeFromArgs,
  type GlobalOptions,
} from "./context.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";

// Initialize logging once before tests run
await initializeLogging({ debugLogs: false });

Deno.test("createContext returns json mode in non-TTY environment", () => {
  // Tests run in a non-TTY environment, so auto-detection defaults to JSON
  const options: GlobalOptions = {};
  const context = createContext(options);
  assertEquals(context.outputMode, "json");
});

Deno.test("createContext returns json mode when json option is true", () => {
  const options: GlobalOptions = { json: true };
  const context = createContext(options);
  assertEquals(context.outputMode, "json");
});

Deno.test("createContext returns normal verbosity by default", () => {
  const options: GlobalOptions = {};
  const context = createContext(options);
  assertEquals(context.verbosity, "normal");
});

Deno.test("createContext returns quiet verbosity when quiet option is true", () => {
  const options: GlobalOptions = { quiet: true };
  const context = createContext(options);
  assertEquals(context.verbosity, "quiet");
});

Deno.test("createContext returns verbose verbosity when verbose option is true", () => {
  const options: GlobalOptions = { verbose: true };
  const context = createContext(options);
  assertEquals(context.verbosity, "verbose");
});

Deno.test("createContext prefers quiet over verbose when both are true", () => {
  const options: GlobalOptions = { quiet: true, verbose: true };
  const context = createContext(options);
  assertEquals(context.verbosity, "quiet");
});

Deno.test("createContext returns a logger object", () => {
  const options: GlobalOptions = {};
  const context = createContext(options);
  assertEquals(typeof context.logger, "object");
  assertEquals(typeof context.logger.info, "function");
});

Deno.test("createContext uses custom logger name when provided", () => {
  const options: GlobalOptions = {};
  const context = createContext(options, "custom-logger");
  // Logger is created - we can verify it exists and has expected methods
  assertEquals(typeof context.logger.debug, "function");
  assertEquals(typeof context.logger.error, "function");
});

Deno.test("getOutputModeFromArgs returns json in non-TTY environment", () => {
  // Tests run in a non-TTY environment, so auto-detection defaults to JSON
  assertEquals(getOutputModeFromArgs([]), "json");
  assertEquals(getOutputModeFromArgs(["model", "create"]), "json");
});

Deno.test("getOutputModeFromArgs returns json when --json is present", () => {
  assertEquals(getOutputModeFromArgs(["--json"]), "json");
  assertEquals(getOutputModeFromArgs(["model", "create", "--json"]), "json");
  assertEquals(getOutputModeFromArgs(["--json", "model", "create"]), "json");
});

Deno.test("createContext returns stream mode when stream option is true", () => {
  const options: GlobalOptions = { stream: true };
  const context = createContext(options);
  assertEquals(context.outputMode, "stream");
});

Deno.test("createContext prefers stream over json when both are true", () => {
  const options: GlobalOptions = { stream: true, json: true };
  const context = createContext(options);
  assertEquals(context.outputMode, "stream");
});

Deno.test("getOutputModeFromArgs returns stream when --stream is present", () => {
  assertEquals(getOutputModeFromArgs(["--stream"]), "stream");
  assertEquals(
    getOutputModeFromArgs(["workflow", "run", "--stream"]),
    "stream",
  );
  assertEquals(
    getOutputModeFromArgs(["--stream", "workflow", "run"]),
    "stream",
  );
});

Deno.test("getOutputModeFromArgs prefers stream over json when both are present", () => {
  assertEquals(getOutputModeFromArgs(["--stream", "--json"]), "stream");
  assertEquals(getOutputModeFromArgs(["--json", "--stream"]), "stream");
});
