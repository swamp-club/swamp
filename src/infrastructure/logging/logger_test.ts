import { assertEquals } from "@std/assert";
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

Deno.test("initializeLogging is idempotent", async () => {
  // Calling initializeLogging multiple times should not throw an error
  // LogTape can only be configured once, so subsequent calls are no-ops
  await initializeLogging({ debugLogs: false });
  await initializeLogging({ debugLogs: true });
  await initializeLogging({ debugLogs: false });

  // If we get here without errors, the test passes
  assertEquals(true, true);
});
