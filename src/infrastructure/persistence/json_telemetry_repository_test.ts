import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { JsonTelemetryRepository } from "./json_telemetry_repository.ts";
import { TelemetryEntry } from "../../domain/telemetry/telemetry_entry.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

function createTestEntry(
  overrides: { id?: string; date?: Date; platform?: string } = {},
): TelemetryEntry {
  const startedAt = overrides.date ?? new Date("2024-01-15T10:00:00Z");
  const completedAt = new Date(startedAt.getTime() + 1000);

  return TelemetryEntry.create({
    id: overrides.id ?? "550e8400-e29b-41d4-a716-446655440000",
    invocation: {
      command: "model",
      subcommand: "create",
      args: ["arg1"],
      optionKeys: ["--json"],
      globalOptions: ["--debug"],
    },
    result: {
      status: "success",
      exitCode: 0,
    },
    startedAt,
    completedAt,
    swampVersion: "1.0.0",
    denoVersion: "1.40.0",
    platform: overrides.platform ?? "linux",
  });
}

Deno.test("JsonTelemetryRepository.save creates directory structure and file", async () => {
  await withTempDir(async (dir) => {
    const repo = new JsonTelemetryRepository(dir);
    const entry = createTestEntry();

    await repo.save(entry);

    const telemetryDir = join(dir, ".swamp", "telemetry");
    const dirInfo = await Deno.stat(telemetryDir);
    assertEquals(dirInfo.isDirectory, true);

    // Check that file was created
    const files: string[] = [];
    for await (const f of Deno.readDir(telemetryDir)) {
      files.push(f.name);
    }
    assertEquals(files.length, 1);
  });
});

Deno.test("JsonTelemetryRepository.save creates correctly named file", async () => {
  await withTempDir(async (dir) => {
    const repo = new JsonTelemetryRepository(dir);
    const entry = createTestEntry({
      id: "abc12345-e29b-41d4-a716-446655440000",
      date: new Date("2024-02-20T15:30:00Z"),
    });

    await repo.save(entry);

    const telemetryDir = join(dir, ".swamp", "telemetry");
    const expectedFilename =
      "telemetry-2024-02-20-abc12345-e29b-41d4-a716-446655440000.json";
    const filePath = join(telemetryDir, expectedFilename);

    const fileInfo = await Deno.stat(filePath);
    assertEquals(fileInfo.isFile, true);
  });
});

Deno.test("JsonTelemetryRepository.save never throws on errors", async () => {
  // Use a path that cannot be written to (non-existent parent of non-writable dir)
  const repo = new JsonTelemetryRepository(
    "/nonexistent/path/that/cannot/exist",
  );
  const entry = createTestEntry();

  // Should not throw
  await repo.save(entry);
});

Deno.test("JsonTelemetryRepository.findByDate returns entries for specific date", async () => {
  await withTempDir(async (dir) => {
    const repo = new JsonTelemetryRepository(dir);
    const date = new Date("2024-03-10T12:00:00Z");
    const entry = createTestEntry({ id: "entry-1-uuid-1234", date });

    await repo.save(entry);

    const entries = await repo.findByDate(date);
    assertEquals(entries.length, 1);
    assertEquals(entries[0].id, "entry-1-uuid-1234");
  });
});

Deno.test("JsonTelemetryRepository.findByDate returns empty array if no files exist", async () => {
  await withTempDir(async (dir) => {
    const repo = new JsonTelemetryRepository(dir);
    // Create the telemetry directory but don't add any files
    await Deno.mkdir(join(dir, ".swamp", "telemetry"), { recursive: true });

    const entries = await repo.findByDate(new Date("2024-01-01"));
    assertEquals(entries, []);
  });
});

Deno.test("JsonTelemetryRepository.findByDate returns empty array if directory doesn't exist", async () => {
  await withTempDir(async (dir) => {
    const repo = new JsonTelemetryRepository(dir);

    const entries = await repo.findByDate(new Date("2024-01-01"));
    assertEquals(entries, []);
  });
});

Deno.test("JsonTelemetryRepository.findByDate skips unparseable JSON files", async () => {
  await withTempDir(async (dir) => {
    const repo = new JsonTelemetryRepository(dir);
    const telemetryDir = join(dir, ".swamp", "telemetry");
    await Deno.mkdir(telemetryDir, { recursive: true });

    // Create a valid entry
    const validEntry = createTestEntry({
      id: "valid-entry-uuid",
      date: new Date("2024-04-15T10:00:00Z"),
    });
    await repo.save(validEntry);

    // Create an invalid JSON file
    const invalidFilename = "telemetry-2024-04-15-invalid-entry-uuid.json";
    await Deno.writeTextFile(
      join(telemetryDir, invalidFilename),
      "not valid json{{{",
    );

    const entries = await repo.findByDate(new Date("2024-04-15"));
    assertEquals(entries.length, 1);
    assertEquals(entries[0].id, "valid-entry-uuid");
  });
});

Deno.test("JsonTelemetryRepository.findByDateRange returns entries across multiple days", async () => {
  await withTempDir(async (dir) => {
    const repo = new JsonTelemetryRepository(dir);

    // Create entries on different days - use noon UTC to avoid timezone edge cases
    const entry1 = createTestEntry({
      id: "day1-entry-uuid",
      date: new Date("2024-05-01T12:00:00Z"),
    });
    const entry2 = createTestEntry({
      id: "day2-entry-uuid",
      date: new Date("2024-05-02T12:00:00Z"),
    });
    const entry3 = createTestEntry({
      id: "day3-entry-uuid",
      date: new Date("2024-05-03T12:00:00Z"),
    });

    await repo.save(entry1);
    await repo.save(entry2);
    await repo.save(entry3);

    const entries = await repo.findByDateRange(
      new Date("2024-05-01T00:00:00Z"),
      new Date("2024-05-03T23:59:59Z"),
    );
    assertEquals(entries.length, 3);
  });
});

Deno.test("JsonTelemetryRepository.findByDateRange includes both boundary dates", async () => {
  await withTempDir(async (dir) => {
    const repo = new JsonTelemetryRepository(dir);

    // Use noon UTC to avoid timezone edge cases with file naming
    const startEntry = createTestEntry({
      id: "start-entry-uuid",
      date: new Date("2024-06-01T12:00:00Z"),
    });
    const endEntry = createTestEntry({
      id: "end-entry-uuid",
      date: new Date("2024-06-05T12:00:00Z"),
    });

    await repo.save(startEntry);
    await repo.save(endEntry);

    const entries = await repo.findByDateRange(
      new Date("2024-06-01T00:00:00Z"),
      new Date("2024-06-05T23:59:59Z"),
    );
    assertEquals(entries.length, 2);

    const ids = entries.map((e) => e.id).sort();
    assertEquals(ids, ["end-entry-uuid", "start-entry-uuid"]);
  });
});

Deno.test("JsonTelemetryRepository.deleteOlderThan deletes files older than cutoff", async () => {
  await withTempDir(async (dir) => {
    const repo = new JsonTelemetryRepository(dir);

    // Create an old entry and a recent entry
    const oldEntry = createTestEntry({
      id: "old-entry-uuid",
      date: new Date("2024-01-01T10:00:00Z"),
    });
    const recentEntry = createTestEntry({
      id: "recent-entry-uuid",
      date: new Date("2024-06-15T10:00:00Z"),
    });

    await repo.save(oldEntry);
    await repo.save(recentEntry);

    // Delete entries older than June 1st
    const deletedCount = await repo.deleteOlderThan(new Date("2024-06-01"));
    assertEquals(deletedCount, 1);

    // Verify only recent entry remains
    const oldEntries = await repo.findByDate(new Date("2024-01-01"));
    assertEquals(oldEntries.length, 0);

    const recentEntries = await repo.findByDate(new Date("2024-06-15"));
    assertEquals(recentEntries.length, 1);
  });
});

Deno.test("JsonTelemetryRepository.deleteOlderThan keeps files on/after cutoff date", async () => {
  await withTempDir(async (dir) => {
    const repo = new JsonTelemetryRepository(dir);

    // Create entry on the cutoff date
    const cutoffEntry = createTestEntry({
      id: "cutoff-entry-uuid",
      date: new Date("2024-07-01T10:00:00Z"),
    });
    // Create entry after the cutoff date
    const afterEntry = createTestEntry({
      id: "after-entry-uuid",
      date: new Date("2024-07-02T10:00:00Z"),
    });

    await repo.save(cutoffEntry);
    await repo.save(afterEntry);

    // Delete entries older than July 1st - should keep both
    const deletedCount = await repo.deleteOlderThan(new Date("2024-07-01"));
    assertEquals(deletedCount, 0);

    // Verify both entries still exist
    const cutoffEntries = await repo.findByDate(new Date("2024-07-01"));
    assertEquals(cutoffEntries.length, 1);

    const afterEntries = await repo.findByDate(new Date("2024-07-02"));
    assertEquals(afterEntries.length, 1);
  });
});

Deno.test("JsonTelemetryRepository.deleteOlderThan returns correct deletion count", async () => {
  await withTempDir(async (dir) => {
    const repo = new JsonTelemetryRepository(dir);

    // Create multiple old entries
    const oldEntry1 = createTestEntry({
      id: "old-entry-1-uuid",
      date: new Date("2024-01-10T10:00:00Z"),
    });
    const oldEntry2 = createTestEntry({
      id: "old-entry-2-uuid",
      date: new Date("2024-01-15T10:00:00Z"),
    });
    const oldEntry3 = createTestEntry({
      id: "old-entry-3-uuid",
      date: new Date("2024-01-20T10:00:00Z"),
    });

    await repo.save(oldEntry1);
    await repo.save(oldEntry2);
    await repo.save(oldEntry3);

    const deletedCount = await repo.deleteOlderThan(new Date("2024-06-01"));
    assertEquals(deletedCount, 3);
  });
});

Deno.test("JsonTelemetryRepository.deleteOlderThan returns 0 if directory doesn't exist", async () => {
  await withTempDir(async (dir) => {
    const repo = new JsonTelemetryRepository(dir);
    // Don't create any files or directories

    const deletedCount = await repo.deleteOlderThan(new Date("2024-06-01"));
    assertEquals(deletedCount, 0);
  });
});
