import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  computeChecksum,
  createModelFileId,
  ModelFile,
} from "../../domain/models/model_file.ts";
import { FileSystemFileRepository } from "./fs_file_repository.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function createTestFile(
  content: Uint8Array,
  filename = "test.txt",
  contentType = "text/plain",
): Promise<ModelFile> {
  const checksum = await computeChecksum(content);
  return ModelFile.create({
    filename,
    contentType,
    size: content.length,
    checksum,
  });
}

const testModelId = "test-model-123";
const testMethodName = "download";

Deno.test("FileSystemFileRepository.save creates directory structure", async () => {
  await withTempDir(async (dir) => {
    const repo = new FileSystemFileRepository(dir);
    const type = ModelType.create("swamp/echo");
    const content = new TextEncoder().encode("hello world");
    const file = await createTestFile(content);

    await repo.save(type, testModelId, testMethodName, file, content);

    const expectedDir = join(
      dir,
      "data",
      "files",
      "swamp/echo",
      testModelId,
      testMethodName,
    );
    const stat = await Deno.stat(expectedDir);
    assertEquals(stat.isDirectory, true);
  });
});

Deno.test("FileSystemFileRepository.save creates metadata and content files", async () => {
  await withTempDir(async (dir) => {
    const repo = new FileSystemFileRepository(dir);
    const type = ModelType.create("swamp/echo");
    const content = new TextEncoder().encode("test content");
    const file = await createTestFile(
      content,
      "output.json",
      "application/json",
    );

    await repo.save(type, testModelId, testMethodName, file, content);

    // Check metadata file
    const metadataPath = repo.getPath(
      type,
      testModelId,
      testMethodName,
      file.id,
    );
    const metadataContent = await Deno.readTextFile(metadataPath);
    assertStringIncludes(metadataContent, "filename: output.json");
    assertStringIncludes(metadataContent, "contentType: application/json");

    // Check content file - should use actual filename
    const contentPath = repo.getContentPath(
      type,
      testModelId,
      testMethodName,
      file,
    );
    assertEquals(contentPath.endsWith("output.json"), true);
    const savedContent = await Deno.readFile(contentPath);
    assertEquals(savedContent, content);
  });
});

Deno.test("FileSystemFileRepository.findById returns saved file metadata", async () => {
  await withTempDir(async (dir) => {
    const repo = new FileSystemFileRepository(dir);
    const type = ModelType.create("swamp/echo");
    const content = new TextEncoder().encode("hello");
    const file = await createTestFile(
      content,
      "data.bin",
      "application/octet-stream",
    );

    await repo.save(type, testModelId, testMethodName, file, content);
    const found = await repo.findById(
      type,
      testModelId,
      testMethodName,
      file.id,
    );

    assertEquals(found?.id, file.id);
    assertEquals(found?.filename, "data.bin");
    assertEquals(found?.contentType, "application/octet-stream");
    assertEquals(found?.size, content.length);
    assertEquals(found?.checksum, file.checksum);
  });
});

Deno.test("FileSystemFileRepository.findById returns null for non-existent", async () => {
  await withTempDir(async (dir) => {
    const repo = new FileSystemFileRepository(dir);
    const type = ModelType.create("swamp/echo");
    const id = createModelFileId("550e8400-e29b-41d4-a716-446655440001");

    const found = await repo.findById(type, testModelId, testMethodName, id);
    assertEquals(found, null);
  });
});

Deno.test("FileSystemFileRepository.findAll returns all files of type", async () => {
  await withTempDir(async (dir) => {
    const repo = new FileSystemFileRepository(dir);
    const type = ModelType.create("swamp/echo");

    const content1 = new TextEncoder().encode("file1");
    const content2 = new TextEncoder().encode("file2");
    const file1 = await createTestFile(content1, "file1.txt");
    const file2 = await createTestFile(content2, "file2.txt");

    await repo.save(type, testModelId, testMethodName, file1, content1);
    await repo.save(type, testModelId, testMethodName, file2, content2);

    const all = await repo.findAll(type);
    assertEquals(all.length, 2);
  });
});

Deno.test("FileSystemFileRepository.findAll returns files across models and methods", async () => {
  await withTempDir(async (dir) => {
    const repo = new FileSystemFileRepository(dir);
    const type = ModelType.create("swamp/echo");

    const content1 = new TextEncoder().encode("file1");
    const content2 = new TextEncoder().encode("file2");
    const file1 = await createTestFile(content1, "file1.txt");
    const file2 = await createTestFile(content2, "file2.txt");

    // Save files in different model/method combinations
    await repo.save(type, "model-a", "download", file1, content1);
    await repo.save(type, "model-b", "upload", file2, content2);

    const all = await repo.findAll(type);
    assertEquals(all.length, 2);
  });
});

Deno.test("FileSystemFileRepository.findAll returns empty array when no files", async () => {
  await withTempDir(async (dir) => {
    const repo = new FileSystemFileRepository(dir);
    const type = ModelType.create("swamp/echo");

    const all = await repo.findAll(type);
    assertEquals(all, []);
  });
});

Deno.test("FileSystemFileRepository.getContent returns file content", async () => {
  await withTempDir(async (dir) => {
    const repo = new FileSystemFileRepository(dir);
    const type = ModelType.create("swamp/echo");
    const originalContent = new TextEncoder().encode("binary content here");
    const file = await createTestFile(originalContent);

    await repo.save(type, testModelId, testMethodName, file, originalContent);
    const retrievedContent = await repo.getContent(
      type,
      testModelId,
      testMethodName,
      file,
    );

    assertEquals(retrievedContent, originalContent);
  });
});

Deno.test("FileSystemFileRepository.getContent returns null for non-existent", async () => {
  await withTempDir(async (dir) => {
    const repo = new FileSystemFileRepository(dir);
    const type = ModelType.create("swamp/echo");
    const file = await createTestFile(new Uint8Array(0), "nonexistent.txt");

    const content = await repo.getContent(
      type,
      testModelId,
      testMethodName,
      file,
    );
    assertEquals(content, null);
  });
});

Deno.test("FileSystemFileRepository.delete removes both files", async () => {
  await withTempDir(async (dir) => {
    const repo = new FileSystemFileRepository(dir);
    const type = ModelType.create("swamp/echo");
    const content = new TextEncoder().encode("to be deleted");
    const file = await createTestFile(content);

    await repo.save(type, testModelId, testMethodName, file, content);
    assertEquals(
      await repo.findById(type, testModelId, testMethodName, file.id) !== null,
      true,
    );
    assertEquals(
      await repo.getContent(type, testModelId, testMethodName, file) !== null,
      true,
    );

    await repo.delete(type, testModelId, testMethodName, file);

    assertEquals(
      await repo.findById(type, testModelId, testMethodName, file.id),
      null,
    );
    assertEquals(
      await repo.getContent(type, testModelId, testMethodName, file),
      null,
    );
  });
});

Deno.test("FileSystemFileRepository.delete is idempotent", async () => {
  await withTempDir(async (dir) => {
    const repo = new FileSystemFileRepository(dir);
    const type = ModelType.create("swamp/echo");
    const file = await createTestFile(new Uint8Array(0), "nonexistent.txt");

    // Should not throw even if files don't exist
    await repo.delete(type, testModelId, testMethodName, file);
  });
});

Deno.test("FileSystemFileRepository.nextId generates valid UUID", () => {
  const repo = new FileSystemFileRepository("/tmp");
  const id = repo.nextId();
  assertEquals(typeof id, "string");
  assertEquals(id.length, 36);
});

Deno.test("FileSystemFileRepository.getPath returns correct path", () => {
  const repo = new FileSystemFileRepository("/repo");
  const type = ModelType.create("swamp/echo");
  const id = createModelFileId("550e8400-e29b-41d4-a716-446655440001");

  const path = repo.getPath(type, testModelId, testMethodName, id);
  assertEquals(
    path,
    `/repo/data/files/swamp/echo/${testModelId}/${testMethodName}/550e8400-e29b-41d4-a716-446655440001.yaml`,
  );
});

Deno.test("FileSystemFileRepository.getContentPath returns correct path with actual filename", async () => {
  const repo = new FileSystemFileRepository("/repo");
  const type = ModelType.create("swamp/echo");
  const file = await createTestFile(
    new Uint8Array(0),
    "my-downloaded-file.tar.gz",
  );

  const path = repo.getContentPath(type, testModelId, testMethodName, file);
  assertEquals(
    path,
    `/repo/data/files/swamp/echo/${testModelId}/${testMethodName}/my-downloaded-file.tar.gz`,
  );
});

Deno.test("FileSystemFileRepository handles binary content", async () => {
  await withTempDir(async (dir) => {
    const repo = new FileSystemFileRepository(dir);
    const type = ModelType.create("swamp/binary");

    // Create binary content with all byte values
    const binaryContent = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      binaryContent[i] = i;
    }

    const file = await createTestFile(
      binaryContent,
      "data.bin",
      "application/octet-stream",
    );

    await repo.save(type, testModelId, testMethodName, file, binaryContent);
    const retrieved = await repo.getContent(
      type,
      testModelId,
      testMethodName,
      file,
    );

    assertEquals(retrieved, binaryContent);
  });
});

Deno.test("FileSystemFileRepository handles empty content", async () => {
  await withTempDir(async (dir) => {
    const repo = new FileSystemFileRepository(dir);
    const type = ModelType.create("swamp/echo");

    const emptyContent = new Uint8Array(0);
    const file = await createTestFile(emptyContent, "empty.txt");

    await repo.save(type, testModelId, testMethodName, file, emptyContent);

    const foundMeta = await repo.findById(
      type,
      testModelId,
      testMethodName,
      file.id,
    );
    assertEquals(foundMeta?.size, 0);

    const retrieved = await repo.getContent(
      type,
      testModelId,
      testMethodName,
      file,
    );
    assertEquals(retrieved?.length, 0);
  });
});
