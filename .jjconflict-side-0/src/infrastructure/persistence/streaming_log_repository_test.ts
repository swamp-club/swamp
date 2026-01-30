import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  createModelLogId,
  LogEntry,
  ModelLog,
} from "../../domain/models/model_log.ts";
import { StreamingLogRepository } from "./streaming_log_repository.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("StreamingLogRepository.save creates directory structure", async () => {
  await withTempDir(async (dir) => {
    const repo = new StreamingLogRepository(dir);
    const type = ModelType.create("swamp/echo");
    const log = ModelLog.create({});

    await repo.save(type, log);

    const expectedDir = join(dir, "logs", "swamp/echo");
    const stat = await Deno.stat(expectedDir);
    assertEquals(stat.isDirectory, true);
  });
});

Deno.test("StreamingLogRepository.save creates metadata and entries files", async () => {
  await withTempDir(async (dir) => {
    const repo = new StreamingLogRepository(dir);
    const type = ModelType.create("swamp/echo");
    const log = ModelLog.create({});
    log.log("First entry");
    log.log("Second entry");

    await repo.save(type, log);

    // Check metadata file
    const metadataPath = join(dir, "logs", "swamp/echo", `${log.id}.yaml`);
    const metadataContent = await Deno.readTextFile(metadataPath);
    assertStringIncludes(metadataContent, `id: ${log.id}`);
    assertStringIncludes(metadataContent, "version: 1");

    // Check entries file
    const entriesPath = repo.getPath(type, log.id);
    const entriesContent = await Deno.readTextFile(entriesPath);
    assertStringIncludes(entriesContent, "First entry");
    assertStringIncludes(entriesContent, "Second entry");
  });
});

Deno.test("StreamingLogRepository.findById returns saved log", async () => {
  await withTempDir(async (dir) => {
    const repo = new StreamingLogRepository(dir);
    const type = ModelType.create("swamp/echo");
    const log = ModelLog.create({});
    log.log("Test message");
    log.log("Warning message");

    await repo.save(type, log);
    const found = await repo.findById(type, log.id);

    assertEquals(found?.id, log.id);
    assertEquals(found?.version, log.version);
    assertEquals(found?.entryCount, 2);
    assertEquals(found?.entries[0].message, "Test message");
    assertEquals(found?.entries[1].message, "Warning message");
  });
});

Deno.test("StreamingLogRepository.findById returns null for non-existent", async () => {
  await withTempDir(async (dir) => {
    const repo = new StreamingLogRepository(dir);
    const type = ModelType.create("swamp/echo");
    const id = createModelLogId("550e8400-e29b-41d4-a716-446655440001");

    const found = await repo.findById(type, id);
    assertEquals(found, null);
  });
});

Deno.test("StreamingLogRepository.findAll returns all logs of type", async () => {
  await withTempDir(async (dir) => {
    const repo = new StreamingLogRepository(dir);
    const type = ModelType.create("swamp/echo");

    const log1 = ModelLog.create({});
    log1.log("Log 1");
    const log2 = ModelLog.create({});
    log2.log("Log 2");

    await repo.save(type, log1);
    await repo.save(type, log2);

    const all = await repo.findAll(type);
    assertEquals(all.length, 2);
  });
});

Deno.test("StreamingLogRepository.findAll returns empty array when no logs", async () => {
  await withTempDir(async (dir) => {
    const repo = new StreamingLogRepository(dir);
    const type = ModelType.create("swamp/echo");

    const all = await repo.findAll(type);
    assertEquals(all, []);
  });
});

Deno.test("StreamingLogRepository.append adds entry without reading file", async () => {
  await withTempDir(async (dir) => {
    const repo = new StreamingLogRepository(dir);
    const type = ModelType.create("swamp/echo");
    const log = ModelLog.create({});
    log.log("Initial entry");

    await repo.save(type, log);

    // Append new entries
    const entry1 = LogEntry.create("Appended 1");
    const entry2 = LogEntry.create("Appended 2");
    await repo.append(type, log.id, entry1);
    await repo.append(type, log.id, entry2);

    const found = await repo.findById(type, log.id);
    assertEquals(found?.entryCount, 3);
    assertEquals(found?.entries[0].message, "Initial entry");
    assertEquals(found?.entries[1].message, "Appended 1");
    assertEquals(found?.entries[2].message, "Appended 2");
  });
});

Deno.test("StreamingLogRepository.append creates file if not exists", async () => {
  await withTempDir(async (dir) => {
    const repo = new StreamingLogRepository(dir);
    const type = ModelType.create("swamp/echo");
    const id = createModelLogId(crypto.randomUUID());

    const entry = LogEntry.create("First append");
    await repo.append(type, id, entry);

    // File should be created
    const entriesPath = repo.getPath(type, id);
    const content = await Deno.readTextFile(entriesPath);
    assertStringIncludes(content, "First append");
  });
});

Deno.test("StreamingLogRepository.stream yields entries", async () => {
  await withTempDir(async (dir) => {
    const repo = new StreamingLogRepository(dir);
    const type = ModelType.create("swamp/echo");
    const log = ModelLog.create({});
    log.log("Entry 1");
    log.log("Entry 2");
    log.log("Entry 3");

    await repo.save(type, log);

    const entries: LogEntry[] = [];
    for await (const entry of repo.stream(type, log.id)) {
      entries.push(entry);
    }

    assertEquals(entries.length, 3);
    assertEquals(entries[0].message, "Entry 1");
    assertEquals(entries[1].message, "Entry 2");
    assertEquals(entries[2].message, "Entry 3");
  });
});

Deno.test("StreamingLogRepository.stream handles non-existent file", async () => {
  await withTempDir(async (dir) => {
    const repo = new StreamingLogRepository(dir);
    const type = ModelType.create("swamp/echo");
    const id = createModelLogId("550e8400-e29b-41d4-a716-446655440001");

    const entries: LogEntry[] = [];
    for await (const entry of repo.stream(type, id)) {
      entries.push(entry);
    }

    assertEquals(entries.length, 0);
  });
});

Deno.test("StreamingLogRepository.stream handles large files", async () => {
  await withTempDir(async (dir) => {
    const repo = new StreamingLogRepository(dir);
    const type = ModelType.create("swamp/echo");
    const log = ModelLog.create({});

    // Add many entries
    for (let i = 0; i < 100; i++) {
      log.log(`Message ${i}`);
    }

    await repo.save(type, log);

    const entries: LogEntry[] = [];
    for await (const entry of repo.stream(type, log.id)) {
      entries.push(entry);
    }

    assertEquals(entries.length, 100);
    assertEquals(entries[0].message, "Message 0");
    assertEquals(entries[99].message, "Message 99");
  });
});

Deno.test("StreamingLogRepository.delete removes both files", async () => {
  await withTempDir(async (dir) => {
    const repo = new StreamingLogRepository(dir);
    const type = ModelType.create("swamp/echo");
    const log = ModelLog.create({});
    log.log("To be deleted");

    await repo.save(type, log);
    assertEquals(await repo.findById(type, log.id) !== null, true);

    await repo.delete(type, log.id);
    assertEquals(await repo.findById(type, log.id), null);
  });
});

Deno.test("StreamingLogRepository.delete is idempotent", async () => {
  await withTempDir(async (dir) => {
    const repo = new StreamingLogRepository(dir);
    const type = ModelType.create("swamp/echo");
    const id = createModelLogId("550e8400-e29b-41d4-a716-446655440001");

    // Should not throw even if files don't exist
    await repo.delete(type, id);
  });
});

Deno.test("StreamingLogRepository.nextId generates valid UUID", () => {
  const repo = new StreamingLogRepository("/tmp");
  const id = repo.nextId();
  assertEquals(typeof id, "string");
  assertEquals(id.length, 36);
});

Deno.test("StreamingLogRepository.getPath returns correct path", () => {
  const repo = new StreamingLogRepository("/repo");
  const type = ModelType.create("swamp/echo");
  const id = createModelLogId("550e8400-e29b-41d4-a716-446655440001");

  const path = repo.getPath(type, id);
  assertEquals(
    path,
    "/repo/logs/swamp/echo/550e8400-e29b-41d4-a716-446655440001.log",
  );
});

Deno.test("StreamingLogRepository stores raw lines", async () => {
  await withTempDir(async (dir) => {
    const repo = new StreamingLogRepository(dir);
    const type = ModelType.create("swamp/echo");
    const log = ModelLog.create({});
    log.log("Jan 01 12:00:00 host sshd[1234]: Accepted publickey");

    await repo.save(type, log);

    // Check entries file contains raw line
    const entriesPath = repo.getPath(type, log.id);
    const content = await Deno.readTextFile(entriesPath);
    assertEquals(
      content,
      "Jan 01 12:00:00 host sshd[1234]: Accepted publickey\n",
    );
  });
});

Deno.test("StreamingLogRepository handles empty log", async () => {
  await withTempDir(async (dir) => {
    const repo = new StreamingLogRepository(dir);
    const type = ModelType.create("swamp/echo");
    const log = ModelLog.create({});

    await repo.save(type, log);
    const found = await repo.findById(type, log.id);

    assertEquals(found?.entryCount, 0);
    assertEquals(found?.entries, []);
  });
});
