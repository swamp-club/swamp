import { assertEquals, assertThrows } from "@std/assert";
import { computeChecksum, ModelFile } from "./model_file.ts";

Deno.test("ModelFile.create generates UUID if not provided", () => {
  const file = ModelFile.create({
    filename: "test.txt",
    contentType: "text/plain",
    size: 100,
    checksum: "abc123",
  });
  assertEquals(typeof file.id, "string");
  assertEquals(file.id.length, 36);
});

Deno.test("ModelFile.create uses provided ID", () => {
  const id = "550e8400-e29b-41d4-a716-446655440001";
  const file = ModelFile.create({
    id,
    filename: "test.txt",
    contentType: "text/plain",
    size: 100,
    checksum: "abc123",
  });
  assertEquals(file.id, id);
});

Deno.test("ModelFile.create sets default version to 1", () => {
  const file = ModelFile.create({
    filename: "test.txt",
    contentType: "text/plain",
    size: 100,
    checksum: "abc123",
  });
  assertEquals(file.version, 1);
});

Deno.test("ModelFile.create uses provided version", () => {
  const file = ModelFile.create({
    version: 3,
    filename: "test.txt",
    contentType: "text/plain",
    size: 100,
    checksum: "abc123",
  });
  assertEquals(file.version, 3);
});

Deno.test("ModelFile.create sets createdAt to now if not provided", () => {
  const before = new Date();
  const file = ModelFile.create({
    filename: "test.txt",
    contentType: "text/plain",
    size: 100,
    checksum: "abc123",
  });
  const after = new Date();

  assertEquals(file.createdAt >= before, true);
  assertEquals(file.createdAt <= after, true);
});

Deno.test("ModelFile.create uses provided createdAt", () => {
  const createdAt = new Date("2023-01-01T00:00:00Z");
  const file = ModelFile.create({
    createdAt,
    filename: "test.txt",
    contentType: "text/plain",
    size: 100,
    checksum: "abc123",
  });
  assertEquals(file.createdAt, createdAt);
});

Deno.test("ModelFile.create stores file properties", () => {
  const file = ModelFile.create({
    filename: "config.json",
    contentType: "application/json",
    size: 2048,
    checksum: "sha256hash",
  });

  assertEquals(file.filename, "config.json");
  assertEquals(file.contentType, "application/json");
  assertEquals(file.size, 2048);
  assertEquals(file.checksum, "sha256hash");
});

Deno.test("ModelFile.create throws on invalid version", () => {
  assertThrows(
    () =>
      ModelFile.create({
        version: 0,
        filename: "test.txt",
        contentType: "text/plain",
        size: 100,
        checksum: "abc123",
      }),
    Error,
    "Too small: expected number to be >0",
  );
});

Deno.test("ModelFile.create throws on empty filename", () => {
  assertThrows(
    () =>
      ModelFile.create({
        filename: "",
        contentType: "text/plain",
        size: 100,
        checksum: "abc123",
      }),
    Error,
    "Too small: expected string to have >=1 characters",
  );
});

Deno.test("ModelFile.create throws on empty contentType", () => {
  assertThrows(
    () =>
      ModelFile.create({
        filename: "test.txt",
        contentType: "",
        size: 100,
        checksum: "abc123",
      }),
    Error,
    "Too small: expected string to have >=1 characters",
  );
});

Deno.test("ModelFile.create throws on negative size", () => {
  assertThrows(
    () =>
      ModelFile.create({
        filename: "test.txt",
        contentType: "text/plain",
        size: -1,
        checksum: "abc123",
      }),
    Error,
    "Too small: expected number to be >=0",
  );
});

Deno.test("ModelFile.create allows zero size", () => {
  const file = ModelFile.create({
    filename: "empty.txt",
    contentType: "text/plain",
    size: 0,
    checksum:
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  });
  assertEquals(file.size, 0);
});

Deno.test("ModelFile toData/fromData roundtrip", () => {
  const file = ModelFile.create({
    filename: "output.bin",
    contentType: "application/octet-stream",
    size: 1024,
    checksum: "deadbeef",
  });
  const data = file.toData();
  const restored = ModelFile.fromData(data);

  assertEquals(restored.id, file.id);
  assertEquals(restored.version, file.version);
  assertEquals(restored.createdAt.getTime(), file.createdAt.getTime());
  assertEquals(restored.filename, file.filename);
  assertEquals(restored.contentType, file.contentType);
  assertEquals(restored.size, file.size);
  assertEquals(restored.checksum, file.checksum);
});

Deno.test("ModelFile fromData with explicit data", () => {
  const id = "550e8400-e29b-41d4-a716-446655440000";
  const createdAt = "2023-01-01T00:00:00.000Z";

  const data = {
    id,
    version: 2,
    createdAt,
    filename: "report.pdf",
    contentType: "application/pdf",
    size: 4096,
    checksum: "abc123def456",
  };

  const file = ModelFile.fromData(data);
  assertEquals(file.id, id);
  assertEquals(file.version, 2);
  assertEquals(file.createdAt, new Date(createdAt));
  assertEquals(file.filename, "report.pdf");
  assertEquals(file.contentType, "application/pdf");
  assertEquals(file.size, 4096);
  assertEquals(file.checksum, "abc123def456");
});

Deno.test("ModelFile.extension extracts file extension", () => {
  const file = ModelFile.create({
    filename: "document.pdf",
    contentType: "application/pdf",
    size: 100,
    checksum: "abc",
  });
  assertEquals(file.extension, "pdf");
});

Deno.test("ModelFile.extension handles no extension", () => {
  const file = ModelFile.create({
    filename: "Dockerfile",
    contentType: "text/plain",
    size: 100,
    checksum: "abc",
  });
  assertEquals(file.extension, "");
});

Deno.test("ModelFile.extension handles multiple dots", () => {
  const file = ModelFile.create({
    filename: "archive.tar.gz",
    contentType: "application/gzip",
    size: 100,
    checksum: "abc",
  });
  assertEquals(file.extension, "gz");
});

Deno.test("computeChecksum produces correct SHA-256", async () => {
  // "hello" in UTF-8
  const content = new TextEncoder().encode("hello");
  const checksum = await computeChecksum(content);

  // Known SHA-256 hash of "hello"
  assertEquals(
    checksum,
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});

Deno.test("computeChecksum produces correct hash for empty content", async () => {
  const content = new Uint8Array(0);
  const checksum = await computeChecksum(content);

  // Known SHA-256 hash of empty string
  assertEquals(
    checksum,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});
