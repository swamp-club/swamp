import { assertEquals, assertExists } from "@std/assert";
import {
  createDefinitionId,
  Definition,
} from "../../../definitions/definition.ts";
import {
  CURL_MODEL_TYPE,
  CurlInputAttributesSchema,
  curlModel,
  CurlResourceAttributesSchema,
} from "./curl_model.ts";
import type { MethodContext } from "../../model.ts";
import type { UnifiedDataRepository } from "../../../../infrastructure/persistence/unified_data_repository.ts";
import type { DefinitionRepository } from "../../../definitions/repositories.ts";
import { generateDataId } from "../../../data/data_id.ts";
import { getLogger } from "@logtape/logtape";

// Check if we have network permission for integration tests
const hasNetworkPermission = await (async () => {
  const status = await Deno.permissions.query({
    name: "net",
    host: "httpbin.org",
  });
  return status.state === "granted";
})();

/**
 * Creates a mock UnifiedDataRepository for testing.
 */
function createMockDataRepo(): UnifiedDataRepository {
  return {
    findAllGlobal: () => Promise.resolve([]),
    findByName: () => Promise.resolve(null),
    findById: () => Promise.resolve(null),
    listVersions: () => Promise.resolve([]),
    findAllForModel: () => Promise.resolve([]),
    save: () => Promise.resolve({ version: 1 }),
    append: () => Promise.resolve(),
    stream: async function* () {},
    getContent: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
    removeLatestSymlink: () => Promise.resolve(),
    nextId: () => generateDataId(),
    getPath: () => "",
    getContentPath: () => "",
    collectGarbage: () =>
      Promise.resolve({ versionsRemoved: 0, bytesReclaimed: 0 }),
  };
}

/**
 * Creates a mock DefinitionRepository for testing.
 */
function createMockDefinitionRepo(): DefinitionRepository {
  return {
    findById: () => Promise.resolve(null),
    findAll: () => Promise.resolve([]),
    findByName: () => Promise.resolve(null),
    findByNameGlobal: () => Promise.resolve(null),
    findAllGlobal: () => Promise.resolve([]),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    nextId: () => createDefinitionId(crypto.randomUUID()),
    getPath: () => "",
  };
}

/**
 * Creates a test MethodContext with mocked repositories.
 */
function createTestContext(): MethodContext {
  return {
    repoDir: "/tmp",
    modelType: CURL_MODEL_TYPE,
    modelId: crypto.randomUUID(),
    logger: getLogger(["test"]),
    dataRepository: createMockDataRepo(),
    definitionRepository: createMockDefinitionRepo(),
  };
}

/**
 * Helper to get attributes from a DataOutput by name pattern.
 */
function getDataOutputAttributes(
  dataOutputs: { name: string; content: Uint8Array }[] | undefined,
  namePattern: string,
): Record<string, unknown> | undefined {
  const dataOutput = dataOutputs?.find((d) => d.name.includes(namePattern));
  if (!dataOutput) return undefined;
  const content = new TextDecoder().decode(dataOutput.content);
  return JSON.parse(content);
}

/**
 * Helper to get file content from DataOutputs.
 */
function getFileContent(
  dataOutputs: { name: string; content: Uint8Array }[] | undefined,
): Uint8Array | undefined {
  const fileOutput = dataOutputs?.find((d) => d.name.includes("file"));
  return fileOutput?.content;
}

Deno.test("CURL_MODEL_TYPE has correct normalized type", () => {
  assertEquals(CURL_MODEL_TYPE.normalized, "command/curl");
});

Deno.test("curlModel has correct version", () => {
  assertEquals(curlModel.version, "2026.02.09.1");
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
    "Download a file from the URL and store it as a data artifact",
  );
});

Deno.test("curlModel.methods.download validates input attributes", async () => {
  const definition = Definition.create({
    name: "test-curl",
    attributes: { notAUrl: "value" },
  });

  const context = createTestContext();
  let error: Error | null = null;
  try {
    await curlModel.methods.download.execute(definition, context);
  } catch (e) {
    error = e as Error;
  }

  assertEquals(error !== null, true);
});

Deno.test({
  name: "curlModel.methods.download executes correctly",
  ignore: !hasNetworkPermission,
  fn: async () => {
    const definition = Definition.create({
      name: "test-curl",
      attributes: { url: "https://httpbin.org/json" },
    });

    const context = createTestContext();
    const result = await curlModel.methods.download.execute(
      definition,
      context,
    );

    // Check data outputs were created
    assertExists(result.dataOutputs);
    assertEquals(result.dataOutputs.length >= 1, true);

    // Check metadata output
    const metadata = getDataOutputAttributes(result.dataOutputs, "metadata");
    assertExists(metadata);
    assertEquals(metadata.url, "https://httpbin.org/json");
    assertEquals(metadata.statusCode, 200);
    assertEquals(typeof metadata.contentType, "string");
    assertEquals(typeof metadata.contentLength, "number");
    assertEquals(typeof metadata.downloadedAt, "string");
    assertEquals(typeof metadata.durationMs, "number");

    // Verify downloadedAt is valid ISO date
    const downloadedAt = new Date(metadata.downloadedAt as string);
    assertEquals(isNaN(downloadedAt.getTime()), false);

    // Check file content was included
    const fileContent = getFileContent(result.dataOutputs);
    assertExists(fileContent);
    assertEquals(fileContent.length > 0, true);
  },
});

Deno.test({
  name: "curlModel.methods.download handles custom filename",
  ignore: !hasNetworkPermission,
  fn: async () => {
    const definition = Definition.create({
      name: "test-curl-filename",
      attributes: {
        url: "https://httpbin.org/json",
        outputFilename: "custom-response.json",
      },
    });

    const context = createTestContext();
    const result = await curlModel.methods.download.execute(
      definition,
      context,
    );

    assertExists(result.dataOutputs);
    // The file output should exist
    const fileOutput = result.dataOutputs.find((d) => d.name.endsWith("-file"));
    assertExists(fileOutput);

    // The metadata should contain the custom filename
    const metadata = getDataOutputAttributes(result.dataOutputs, "metadata");
    assertExists(metadata);
    assertEquals(metadata.filename, "custom-response.json");
  },
});

Deno.test({
  name: "curlModel.methods.download handles HTTP errors",
  ignore: !hasNetworkPermission,
  fn: async () => {
    const definition = Definition.create({
      name: "test-curl-error",
      attributes: { url: "https://httpbin.org/status/404" },
    });

    const context = createTestContext();
    let error: Error | null = null;
    try {
      await curlModel.methods.download.execute(definition, context);
    } catch (e) {
      error = e as Error;
    }

    assertEquals(error !== null, true);
    assertEquals(error!.message.includes("404"), true);
  },
});
