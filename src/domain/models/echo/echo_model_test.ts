import { assertEquals } from "@std/assert";
import { ModelInput } from "../model_input.ts";
import {
  ECHO_MODEL_TYPE,
  EchoInputAttributesSchema,
  echoModel,
  EchoResourceAttributesSchema,
} from "./echo_model.ts";

Deno.test("ECHO_MODEL_TYPE has correct normalized type", () => {
  assertEquals(ECHO_MODEL_TYPE.normalized, "swamp/echo");
});

Deno.test("echoModel has correct version", () => {
  assertEquals(echoModel.version, 1);
});

Deno.test("echoModel.type equals ECHO_MODEL_TYPE", () => {
  assertEquals(echoModel.type.equals(ECHO_MODEL_TYPE), true);
});

Deno.test("EchoInputAttributesSchema validates message", () => {
  const result = EchoInputAttributesSchema.safeParse({ message: "hello" });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.message, "hello");
  }
});

Deno.test("EchoInputAttributesSchema rejects empty message", () => {
  const result = EchoInputAttributesSchema.safeParse({ message: "" });
  assertEquals(result.success, false);
});

Deno.test("EchoInputAttributesSchema rejects missing message", () => {
  const result = EchoInputAttributesSchema.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("EchoResourceAttributesSchema validates correct data", () => {
  const result = EchoResourceAttributesSchema.safeParse({
    message: "hello",
    timestamp: "2024-01-15T10:30:00.000Z",
  });
  assertEquals(result.success, true);
});

Deno.test("EchoResourceAttributesSchema rejects invalid timestamp", () => {
  const result = EchoResourceAttributesSchema.safeParse({
    message: "hello",
    timestamp: "not-a-date",
  });
  assertEquals(result.success, false);
});

Deno.test("echoModel has write method", () => {
  assertEquals("write" in echoModel.methods, true);
  assertEquals(
    echoModel.methods.write.description,
    "Write the input message to a resource with a timestamp",
  );
});

Deno.test("echoModel.methods.write executes correctly", async () => {
  const input = ModelInput.create({
    name: "test-echo",
    attributes: { message: "hello world" },
  });

  const result = await echoModel.methods.write.execute(input, {
    repoDir: "/tmp",
  });

  assertEquals(result.resource.inputId, input.id);
  assertEquals(result.resource.attributes.message, "hello world");
  assertEquals(typeof result.resource.attributes.timestamp, "string");

  // Verify timestamp is valid ISO date
  const timestamp = new Date(result.resource.attributes.timestamp as string);
  assertEquals(isNaN(timestamp.getTime()), false);
});

Deno.test("echoModel.methods.write validates input attributes", async () => {
  const input = ModelInput.create({
    name: "test-echo",
    attributes: { notAMessage: "value" },
  });

  let error: Error | null = null;
  try {
    await echoModel.methods.write.execute(input, { repoDir: "/tmp" });
  } catch (e) {
    error = e as Error;
  }

  assertEquals(error !== null, true);
});

Deno.test("echoModel.methods.write rejects empty message", async () => {
  const input = ModelInput.create({
    name: "test-echo",
    attributes: { message: "" },
  });

  let error: Error | null = null;
  try {
    await echoModel.methods.write.execute(input, { repoDir: "/tmp" });
  } catch (e) {
    error = e as Error;
  }

  assertEquals(error !== null, true);
});
