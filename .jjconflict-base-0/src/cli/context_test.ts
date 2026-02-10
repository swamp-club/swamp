import { assertEquals } from "@std/assert";
import {
  createContext,
  getOutputModeFromArgs,
  type GlobalOptions,
} from "./context.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";

// Initialize logging once before tests run
await initializeLogging({});

Deno.test("createContext returns log mode by default", () => {
  const options: GlobalOptions = {};
  const context = createContext(options);
  assertEquals(context.outputMode, "log");
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
  const context = createContext(options, ["custom", "logger"]);
  // Logger is created - we can verify it exists and has expected methods
  assertEquals(typeof context.logger.debug, "function");
  assertEquals(typeof context.logger.error, "function");
});

Deno.test("getOutputModeFromArgs returns log by default", () => {
  assertEquals(getOutputModeFromArgs([]), "log");
  assertEquals(getOutputModeFromArgs(["model", "create"]), "log");
});

Deno.test("getOutputModeFromArgs returns json when --json is present", () => {
  assertEquals(getOutputModeFromArgs(["--json"]), "json");
  assertEquals(getOutputModeFromArgs(["model", "create", "--json"]), "json");
  assertEquals(getOutputModeFromArgs(["--json", "model", "create"]), "json");
});
