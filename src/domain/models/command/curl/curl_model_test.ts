import { assertEquals, assertExists } from "@std/assert";
import { ModelInput } from "../../model_input.ts";
import {
  CURL_MODEL_TYPE,
  CurlInputAttributesSchema,
  curlModel,
  CurlResourceAttributesSchema,
} from "./curl_model.ts";

// Check if we have network permission for integration tests
const hasNetworkPermission = await (async () => {
  const status = await Deno.permissions.query({
    name: "net",
    host: "httpbin.org",
  });
  return status.state === "granted";
})();

Deno.test("CURL_MODEL_TYPE has correct normalized type", () => {
  assertEquals(CURL_MODEL_TYPE.normalized, "command/curl");
});

Deno.test("curlModel has correct version", () => {
  assertEquals(curlModel.version, 1);
});

Deno.test("curlModel.type equals CURL_MODEL_TYPE", () => {
  assertEquals(curlModel.type.equals(CURL_MODEL_TYPE), true);
});

Deno.test("CurlInputAttributesSchema validates url", () => {
  const result = CurlInputAttributesSchema.safeParse({
    url: "https://example.com/file.txt",
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.url, "https://example.com/file.txt");
    assertEquals(result.data.method, "GET"); // default
    assertEquals(result.data.followRedirects, true); // default
  }
});

Deno.test("CurlInputAttributesSchema validates with all options", () => {
  const result = CurlInputAttributesSchema.safeParse({
    url: "https://example.com/api",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    outputFilename: "response.json",
    followRedirects: false,
    timeout: 5000,
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.url, "https://example.com/api");
    assertEquals(result.data.method, "POST");
    assertEquals(result.data.headers?.["Content-Type"], "application/json");
    assertEquals(result.data.outputFilename, "response.json");
    assertEquals(result.data.followRedirects, false);
    assertEquals(result.data.timeout, 5000);
  }
});

Deno.test("CurlInputAttributesSchema rejects invalid url", () => {
  const result = CurlInputAttributesSchema.safeParse({
    url: "not-a-valid-url",
  });
  assertEquals(result.success, false);
});

Deno.test("CurlInputAttributesSchema rejects missing url", () => {
  const result = CurlInputAttributesSchema.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("CurlInputAttributesSchema rejects invalid method", () => {
  const result = CurlInputAttributesSchema.safeParse({
    url: "https://example.com",
    method: "INVALID",
  });
  assertEquals(result.success, false);
});

Deno.test("CurlInputAttributesSchema rejects negative timeout", () => {
  const result = CurlInputAttributesSchema.safeParse({
    url: "https://example.com",
    timeout: -1000,
  });
  assertEquals(result.success, false);
});

Deno.test("CurlResourceAttributesSchema validates correct data", () => {
  const result = CurlResourceAttributesSchema.safeParse({
    url: "https://example.com/file.txt",
    statusCode: 200,
    contentType: "text/plain",
    contentLength: 1024,
    downloadedAt: "2024-01-15T10:30:00.000Z",
    durationMs: 150,
    fileId: "a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d",
  });
  assertEquals(result.success, true);
});

Deno.test("CurlResourceAttributesSchema rejects invalid fileId", () => {
  const result = CurlResourceAttributesSchema.safeParse({
    url: "https://example.com/file.txt",
    statusCode: 200,
    contentType: "text/plain",
    contentLength: 1024,
    downloadedAt: "2024-01-15T10:30:00.000Z",
    durationMs: 150,
    fileId: "not-a-uuid",
  });
  assertEquals(result.success, false);
});

Deno.test("CurlResourceAttributesSchema rejects invalid timestamp", () => {
  const result = CurlResourceAttributesSchema.safeParse({
    url: "https://example.com/file.txt",
    statusCode: 200,
    contentType: "text/plain",
    contentLength: 1024,
    downloadedAt: "not-a-date",
    durationMs: 150,
    fileId: "a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d",
  });
  assertEquals(result.success, false);
});

Deno.test("curlModel has download method", () => {
  assertEquals("download" in curlModel.methods, true);
  assertEquals(
    curlModel.methods.download.description,
    "Download a file from the URL and store it as a file artifact",
  );
});

Deno.test("curlModel.methods.download validates input attributes", async () => {
  const input = ModelInput.create({
    name: "test-curl",
    attributes: { notAUrl: "value" },
  });

  let error: Error | null = null;
  try {
    await curlModel.methods.download.execute(input, { repoDir: "/tmp" });
  } catch (e) {
    error = e as Error;
  }

  assertEquals(error !== null, true);
});

Deno.test({
  name: "curlModel.methods.download executes correctly",
  ignore: !hasNetworkPermission,
  fn: async () => {
    const input = ModelInput.create({
      name: "test-curl",
      attributes: { url: "https://httpbin.org/json" },
    });

    const result = await curlModel.methods.download.execute(input, {
      repoDir: "/tmp",
    });

    // Check resource was created
    assertExists(result.resource);
    assertEquals(result.resource.attributes.url, "https://httpbin.org/json");
    assertEquals(result.resource.attributes.statusCode, 200);
    assertEquals(typeof result.resource.attributes.contentType, "string");
    assertEquals(typeof result.resource.attributes.contentLength, "number");
    assertEquals(typeof result.resource.attributes.downloadedAt, "string");
    assertEquals(typeof result.resource.attributes.durationMs, "number");
    assertEquals(typeof result.resource.attributes.fileId, "string");

    // Verify downloadedAt is valid ISO date
    const downloadedAt = new Date(
      result.resource.attributes.downloadedAt as string,
    );
    assertEquals(isNaN(downloadedAt.getTime()), false);

    // Check file artifact was created
    assertExists(result.file);
    assertExists(result.file.metadata);
    assertExists(result.file.content);
    assertEquals(result.file.content.length > 0, true);
    assertEquals(result.file.metadata.id, result.resource.attributes.fileId);
  },
});

Deno.test({
  name: "curlModel.methods.download handles custom filename",
  ignore: !hasNetworkPermission,
  fn: async () => {
    const input = ModelInput.create({
      name: "test-curl-filename",
      attributes: {
        url: "https://httpbin.org/json",
        outputFilename: "custom-response.json",
      },
    });

    const result = await curlModel.methods.download.execute(input, {
      repoDir: "/tmp",
    });

    assertExists(result.file);
    assertEquals(result.file.metadata.filename, "custom-response.json");
  },
});

Deno.test({
  name: "curlModel.methods.download handles HTTP errors",
  ignore: !hasNetworkPermission,
  fn: async () => {
    const input = ModelInput.create({
      name: "test-curl-error",
      attributes: { url: "https://httpbin.org/status/404" },
    });

    let error: Error | null = null;
    try {
      await curlModel.methods.download.execute(input, { repoDir: "/tmp" });
    } catch (e) {
      error = e as Error;
    }

    assertEquals(error !== null, true);
    assertEquals(error!.message.includes("404"), true);
  },
});
