import { assertEquals } from "@std/assert";
import { existsSync } from "@std/fs";
import { getSwampLogger, initializeLogging } from "./logger.ts";

// Note: LogTape can only be configured once per process.
// These tests are structured to work within that limitation.

Deno.test("initializeLogging and getSwampLogger", async (t) => {
  await t.step("initializeLogging with debugLogs false succeeds", async () => {
    // Should complete without error
    await initializeLogging({ debugLogs: false });
  });

  await t.step("getSwampLogger returns a logger object", () => {
    const logger = getSwampLogger("test");
    assertEquals(typeof logger, "object");
  });

  await t.step("getSwampLogger returns logger with expected methods", () => {
    const logger = getSwampLogger("test-methods");
    assertEquals(typeof logger.debug, "function");
    assertEquals(typeof logger.info, "function");
    assertEquals(typeof logger.warn, "function");
    assertEquals(typeof logger.error, "function");
  });

  await t.step("getSwampLogger can create multiple loggers", () => {
    const logger1 = getSwampLogger("logger1");
    const logger2 = getSwampLogger("logger2");
    assertEquals(typeof logger1.info, "function");
    assertEquals(typeof logger2.info, "function");
  });
});

// Test debugLogs: true in isolation - this creates the dev-logs directory
Deno.test({
  name: "initializeLogging with debugLogs true creates dev-logs directory",
  ignore: existsSync("dev-logs"), // Skip if already exists from previous runs
  fn: async () => {
    // This test is designed to run only when dev-logs doesn't exist
    // In practice, the directory may already exist from normal CLI usage
    await initializeLogging({ debugLogs: true });
    assertEquals(existsSync("dev-logs"), true);
  },
});
