import { assertEquals } from "@std/assert";
import {
  getRunLogger,
  getSwampLogger,
  getWorkflowRunLogger,
  initializeLogging,
} from "./logger.ts";

// Note: LogTape can only be configured once per process.
// These tests are structured to work within that limitation.

Deno.test("initializeLogging and getSwampLogger", async (t) => {
  await t.step("initializeLogging succeeds", async () => {
    // Should complete without error
    await initializeLogging({});
  });

  await t.step("getSwampLogger returns a logger object", () => {
    const logger = getSwampLogger(["test"]);
    assertEquals(typeof logger, "object");
  });

  await t.step("getSwampLogger returns logger with expected methods", () => {
    const logger = getSwampLogger(["test", "methods"]);
    assertEquals(typeof logger.debug, "function");
    assertEquals(typeof logger.info, "function");
    assertEquals(typeof logger.warn, "function");
    assertEquals(typeof logger.error, "function");
  });

  await t.step("getSwampLogger can create multiple loggers", () => {
    const logger1 = getSwampLogger(["logger1"]);
    const logger2 = getSwampLogger(["logger2"]);
    assertEquals(typeof logger1.info, "function");
    assertEquals(typeof logger2.info, "function");
  });
});

Deno.test("getRunLogger", async (t) => {
  await t.step("returns a logger object", () => {
    const logger = getRunLogger("mymodel", "write");
    assertEquals(typeof logger, "object");
  });

  await t.step("returns logger with expected methods", () => {
    const logger = getRunLogger("mymodel", "write");
    assertEquals(typeof logger.debug, "function");
    assertEquals(typeof logger.info, "function");
    assertEquals(typeof logger.warn, "function");
    assertEquals(typeof logger.error, "function");
  });

  await t.step("can create loggers for different models", () => {
    const logger1 = getRunLogger("model-a", "read");
    const logger2 = getRunLogger("model-b", "write");
    assertEquals(typeof logger1.info, "function");
    assertEquals(typeof logger2.info, "function");
  });
});

Deno.test("initializeLogging is idempotent", async () => {
  // Calling initializeLogging multiple times should not throw an error
  // LogTape can only be configured once, so subsequent calls are no-ops
  await initializeLogging({});
  await initializeLogging({ prettyOutput: true });
  await initializeLogging({});

  // If we get here without errors, the test passes
  assertEquals(true, true);
});

Deno.test("initializeLogging accepts prettyOutput option", async () => {
  // prettyOutput should be accepted without error (idempotent, first call wins)
  await initializeLogging({ prettyOutput: true });
  assertEquals(true, true);
});

Deno.test("initializeLogging accepts showProperties option", async () => {
  // showProperties should be accepted without error (idempotent, first call wins)
  await initializeLogging({
    prettyOutput: true,
    showProperties: true,
  });
  assertEquals(true, true);
});

Deno.test("initializeLogging accepts logLevel option", async () => {
  // logLevel should be accepted without error (idempotent, first call wins)
  await initializeLogging({ logLevel: "warning" });
  assertEquals(true, true);
});

Deno.test("getWorkflowRunLogger", async (t) => {
  await t.step("returns a logger with workflow name only", () => {
    const logger = getWorkflowRunLogger("deploy-stack");
    assertEquals(typeof logger, "object");
    assertEquals(typeof logger.info, "function");
    assertEquals(typeof logger.error, "function");
  });

  await t.step("returns a logger with workflow and job name", () => {
    const logger = getWorkflowRunLogger("deploy-stack", "provision");
    assertEquals(typeof logger, "object");
    assertEquals(typeof logger.info, "function");
  });

  await t.step("returns a logger with workflow, job, and step name", () => {
    const logger = getWorkflowRunLogger(
      "deploy-stack",
      "provision",
      "create-server",
    );
    assertEquals(typeof logger, "object");
    assertEquals(typeof logger.info, "function");
  });

  await t.step("can create loggers for different workflows", () => {
    const logger1 = getWorkflowRunLogger("workflow-a");
    const logger2 = getWorkflowRunLogger("workflow-b", "job-1");
    assertEquals(typeof logger1.info, "function");
    assertEquals(typeof logger2.info, "function");
  });
});
