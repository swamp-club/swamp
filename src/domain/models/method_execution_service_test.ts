import { assertEquals, assertThrows } from "@std/assert";
import { DefaultMethodExecutionService } from "./method_execution_service.ts";
import { ModelInput } from "./model_input.ts";
import { echoModel } from "./echo/echo_model.ts";

Deno.test("execute with valid input returns method result", async () => {
  const service = new DefaultMethodExecutionService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: { message: "Hello, world!" },
  });

  const result = await service.execute(
    input,
    echoModel.methods.write,
    { repoDir: "." },
  );

  assertEquals(result.resource.inputId, input.id);
  assertEquals(result.resource.attributes.message, "Hello, world!");
  assertEquals(typeof result.resource.attributes.timestamp, "string");
});

Deno.test("execute with missing required attribute throws error", () => {
  const service = new DefaultMethodExecutionService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: {}, // Missing required 'message'
  });

  assertThrows(
    () =>
      service.execute(
        input,
        echoModel.methods.write,
        { repoDir: "." },
      ),
    Error,
    "Input validation failed",
  );
});

Deno.test("execute with invalid attribute type throws error", () => {
  const service = new DefaultMethodExecutionService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: { message: 123 }, // Should be string
  });

  assertThrows(
    () =>
      service.execute(
        input,
        echoModel.methods.write,
        { repoDir: "." },
      ),
    Error,
    "Input validation failed",
  );
});

Deno.test("execute with empty message throws error", () => {
  const service = new DefaultMethodExecutionService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: { message: "" }, // Empty message fails min(1) validation
  });

  assertThrows(
    () =>
      service.execute(
        input,
        echoModel.methods.write,
        { repoDir: "." },
      ),
    Error,
    "Input validation failed",
  );
});

Deno.test("execute error message includes Zod details", () => {
  const service = new DefaultMethodExecutionService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: { wrongField: "value" },
  });

  try {
    service.execute(
      input,
      echoModel.methods.write,
      { repoDir: "." },
    );
    throw new Error("Expected error to be thrown");
  } catch (error) {
    const message = (error as Error).message;
    assertEquals(message.startsWith("Input validation failed:"), true);
    // Should mention the missing 'message' field
    assertEquals(message.includes("message"), true);
  }
});
