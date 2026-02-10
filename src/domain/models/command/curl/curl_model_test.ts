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
import { normalizeSpecType } from "../../model.ts";
import type {
  DataHandle,
  DataWriter,
  DataWriterFactory,
  MethodContext,
  SpecBasedWriterOptions,
} from "../../model.ts";
import type { UnifiedDataRepository } from "../../../../infrastructure/persistence/unified_data_repository.ts";
import type { DefinitionRepository } from "../../../definitions/repositories.ts";
import { type DataId, generateDataId } from "../../../data/data_id.ts";
import { getLogger } from "@logtape/logtape";

/**
 * Stored result from mock data writer.
 */
interface MockWriterResult {
  handle: DataHandle;
  content: Uint8Array;
}

/**
 * Creates a mock DataWriterFactory that stores written content in memory.
 */
function createMockDataWriterFactory(): {
  factory: DataWriterFactory;
  getResults: () => MockWriterResult[];
} {
  const results: MockWriterResult[] = [];
  const getResults = (): MockWriterResult[] => results;
  let nextId = 1;

  const factory: DataWriterFactory = (
    options: SpecBasedWriterOptions,
  ): DataWriter => {
    const dataId = `mock-data-${nextId++}` as DataId;

    const buildHandle = (content: Uint8Array): DataHandle => ({
      name: options.name,
      specType: normalizeSpecType(options.specType),
      dataId,
      version: 1,
      size: content.length,
      tags: { ...(options.tags ?? {}) },
      metadata: {
        contentType: options.contentType ?? "application/json",
        lifetime: options.lifetime ?? "infinite",
        garbageCollection: options.garbageCollection ?? 10,
        streaming: options.streaming ?? false,
        tags: { ...(options.tags ?? {}) },
        ownerDefinition: {
          definitionHash: "test-hash",
          ownerType: "model-method",
          ownerRef: "test",
        },
      },
    });

    return {
      dataId,
      name: options.name,
      writeAll(content: Uint8Array): Promise<DataHandle> {
        const handle = buildHandle(content);
        results.push({ handle, content });
        return Promise.resolve(handle);
      },
      writeText(text: string): Promise<DataHandle> {
        const content = new TextEncoder().encode(text);
        const handle = buildHandle(content);
        results.push({ handle, content });
        return Promise.resolve(handle);
      },
      writeLine(_line: string): Promise<void> {
        return Promise.resolve();
      },
      writeStream(
        _stream: ReadableStream<Uint8Array>,
      ): Promise<DataHandle> {
        const content = new Uint8Array();
        const handle = buildHandle(content);
        results.push({ handle, content });
        return Promise.resolve(handle);
      },
      getFilePath(): Promise<string> {
        return Promise.resolve("/tmp/mock");
      },
      finalize(): Promise<DataHandle> {
        const content = new Uint8Array();
        const handle = buildHandle(content);
        results.push({ handle, content });
        return Promise.resolve(handle);
      },
    } as DataWriter;
  };

  return { factory, getResults };
}

/**
 * Helper to get parsed JSON content from mock results by name pattern.
 */
function getResultAttributes(
  results: MockWriterResult[],
  namePattern: string,
): Record<string, unknown> | undefined {
  const result = results.find((r) => r.handle.name.includes(namePattern));
  if (!result) return undefined;
  return JSON.parse(new TextDecoder().decode(result.content));
}

/**
 * Helper to get file content from mock results.
 */
function getFileContent(results: MockWriterResult[]): Uint8Array | undefined {
  const fileResult = results.find((r) => r.handle.name.includes("file"));
  return fileResult?.content;
}

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
    allocateVersion: () =>
      Promise.resolve({ version: 1, contentPath: "/tmp/mock" }),
    finalizeVersion: () =>
      Promise.resolve({ size: 0, checksum: "mock-checksum" }),
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
function createTestContext(): {
  context: MethodContext;
  getResults: () => MockWriterResult[];
} {
  const { factory, getResults } = createMockDataWriterFactory();
  const context: MethodContext = {
    repoDir: "/tmp",
    modelType: CURL_MODEL_TYPE,
    modelId: crypto.randomUUID(),
    logger: getLogger(["test"]),
    dataRepository: createMockDataRepo(),
    definitionRepository: createMockDefinitionRepo(),
    createDataWriter: factory,
  };
  return { context, getResults };
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

  const { context } = createTestContext();
  let error: Error | null = null;
  try {
    await curlModel.methods.download.execute(definition, context);
  } catch (e) {
    error = e as Error;
  }

  assertEquals(error !== null, true);
});

Deno.test("curlModel.methods.download executes correctly", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input: string | URL | Request, _init?: RequestInit) => {
    return Promise.resolve(
      new Response(JSON.stringify({ slideshow: { title: "Sample" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  try {
    const definition = Definition.create({
      name: "test-curl",
      attributes: { url: "https://httpbin.org/json" },
    });

    const { context, getResults } = createTestContext();
    const result = await curlModel.methods.download.execute(
      definition,
      context,
    );

    // Check data handles were created
    assertExists(result.dataHandles);
    assertEquals(result.dataHandles.length >= 1, true);

    // Check metadata output
    const metadata = getResultAttributes(getResults(), "metadata");
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
    const fileContent = getFileContent(getResults());
    assertExists(fileContent);
    assertEquals(fileContent.length > 0, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("curlModel.methods.download handles custom filename", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input: string | URL | Request, _init?: RequestInit) => {
    return Promise.resolve(
      new Response(JSON.stringify({ data: "test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  try {
    const definition = Definition.create({
      name: "test-curl-filename",
      attributes: {
        url: "https://httpbin.org/json",
        outputFilename: "custom-response.json",
      },
    });

    const { context, getResults } = createTestContext();
    const result = await curlModel.methods.download.execute(
      definition,
      context,
    );

    assertExists(result.dataHandles);
    // The file handle should exist
    const fileHandle = result.dataHandles.find((h) => h.name.endsWith("-file"));
    assertExists(fileHandle);

    // The metadata should contain the custom filename
    const metadata = getResultAttributes(getResults(), "metadata");
    assertExists(metadata);
    assertEquals(metadata.filename, "custom-response.json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("curlModel.methods.download handles HTTP errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input: string | URL | Request, _init?: RequestInit) => {
    return Promise.resolve(
      new Response(null, {
        status: 404,
        statusText: "Not Found",
      }),
    );
  };
  try {
    const definition = Definition.create({
      name: "test-curl-error",
      attributes: { url: "https://httpbin.org/status/404" },
    });

    const { context } = createTestContext();
    let error: Error | null = null;
    try {
      await curlModel.methods.download.execute(definition, context);
    } catch (e) {
      error = e as Error;
    }

    assertEquals(error !== null, true);
    assertEquals(error!.message.includes("404"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
