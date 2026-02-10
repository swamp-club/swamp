import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Initialize logging for tests
await initializeLogging({});

// Note: Full CLI integration tests are in integration/model_validate_test.ts
// These tests verify the command module loads correctly

Deno.test("modelValidateCommand module loads", async () => {
  const { modelValidateCommand } = await import("./model_validate.ts");
  assertEquals(modelValidateCommand.getName(), "validate");
});

Deno.test("modelValidateCommand has correct description", async () => {
  const { modelValidateCommand } = await import("./model_validate.ts");
  assertEquals(
    modelValidateCommand.getDescription(),
    "Validate a model definition against its schema",
  );
});
