import { assertEquals } from "@std/assert";
import { LogEntry, ModelLog } from "./model_log.ts";

// LogEntry tests

Deno.test("LogEntry.create stores message", () => {
  const entry = LogEntry.create("test message");
  assertEquals(entry.message, "test message");
});

Deno.test("LogEntry.create handles empty message", () => {
  const entry = LogEntry.create("");
  assertEquals(entry.message, "");
});

Deno.test("LogEntry.create handles multiline message", () => {
  const message = "line 1\nline 2\nline 3";
  const entry = LogEntry.create(message);
  assertEquals(entry.message, message);
});

Deno.test("LogEntry toData/fromData roundtrip", () => {
  const entry = LogEntry.create("Test message");
  const data = entry.toData();
  const restored = LogEntry.fromData(data);

  assertEquals(restored.message, entry.message);
});

Deno.test("LogEntry toJsonLine returns raw message", () => {
  const entry = LogEntry.create("Raw log line");
  const line = entry.toJsonLine();

  assertEquals(line, "Raw log line");
});

Deno.test("LogEntry fromJsonLine parses raw line", () => {
  const line = "Jan 01 12:00:00 host systemd[1]: Started service";
  const entry = LogEntry.fromJsonLine(line);

  assertEquals(entry.message, line);
});

Deno.test("LogEntry toJsonLine/fromJsonLine roundtrip", () => {
  const original = LogEntry.create("Debug info");
  const line = original.toJsonLine();
  const restored = LogEntry.fromJsonLine(line);

  assertEquals(restored.message, original.message);
});

// ModelLog tests

Deno.test("ModelLog.create generates UUID if not provided", () => {
  const log = ModelLog.create({});
  assertEquals(typeof log.id, "string");
  assertEquals(log.id.length, 36);
});

Deno.test("ModelLog.create uses provided ID", () => {
  const id = "550e8400-e29b-41d4-a716-446655440001";
  const log = ModelLog.create({ id });
  assertEquals(log.id, id);
});

Deno.test("ModelLog.create sets default version to 1", () => {
  const log = ModelLog.create({});
  assertEquals(log.version, 1);
});

Deno.test("ModelLog.create uses provided version", () => {
  const log = ModelLog.create({ version: 3 });
  assertEquals(log.version, 3);
});

Deno.test("ModelLog.create sets createdAt to now if not provided", () => {
  const before = new Date();
  const log = ModelLog.create({});
  const after = new Date();

  assertEquals(log.createdAt >= before, true);
  assertEquals(log.createdAt <= after, true);
});

Deno.test("ModelLog.create uses provided createdAt", () => {
  const createdAt = new Date("2023-01-01T00:00:00Z");
  const log = ModelLog.create({ createdAt });
  assertEquals(log.createdAt, createdAt);
});

Deno.test("ModelLog.create sets empty entries by default", () => {
  const log = ModelLog.create({});
  assertEquals(log.entries, []);
  assertEquals(log.entryCount, 0);
});

Deno.test("ModelLog.create uses provided entries", () => {
  const entries = [
    LogEntry.create("First"),
    LogEntry.create("Second"),
  ];
  const log = ModelLog.create({ entries });

  assertEquals(log.entryCount, 2);
  assertEquals(log.entries[0].message, "First");
  assertEquals(log.entries[1].message, "Second");
});

Deno.test("ModelLog.append adds entry", () => {
  const log = ModelLog.create({});
  const entry = LogEntry.create("test");

  log.append(entry);

  assertEquals(log.entryCount, 1);
  assertEquals(log.entries[0].message, "test");
});

Deno.test("ModelLog.log creates and appends entry", () => {
  const log = ModelLog.create({});

  log.log("Log message");

  assertEquals(log.entryCount, 1);
  assertEquals(log.entries[0].message, "Log message");
});

Deno.test("ModelLog.log handles multiple messages", () => {
  const log = ModelLog.create({});

  log.log("First line");
  log.log("Second line");
  log.log("Third line");

  assertEquals(log.entryCount, 3);
  assertEquals(log.entries[0].message, "First line");
  assertEquals(log.entries[1].message, "Second line");
  assertEquals(log.entries[2].message, "Third line");
});

Deno.test("ModelLog.lastEntries returns last N entries", () => {
  const log = ModelLog.create({});
  log.log("First");
  log.log("Second");
  log.log("Third");

  const last2 = log.lastEntries(2);

  assertEquals(last2.length, 2);
  assertEquals(last2[0].message, "Second");
  assertEquals(last2[1].message, "Third");
});

Deno.test("ModelLog.lastEntries returns all if count exceeds length", () => {
  const log = ModelLog.create({});
  log.log("Only one");

  const last10 = log.lastEntries(10);

  assertEquals(last10.length, 1);
  assertEquals(last10[0].message, "Only one");
});

Deno.test("ModelLog toData/fromData roundtrip", () => {
  const log = ModelLog.create({});
  log.log("Entry 1");
  log.log("Entry 2");

  const data = log.toData();
  const restored = ModelLog.fromData(data);

  assertEquals(restored.id, log.id);
  assertEquals(restored.version, log.version);
  assertEquals(restored.createdAt.getTime(), log.createdAt.getTime());
  assertEquals(restored.entryCount, 2);
  assertEquals(restored.entries[0].message, "Entry 1");
  assertEquals(restored.entries[1].message, "Entry 2");
});

Deno.test("ModelLog fromData with explicit data", () => {
  const id = "550e8400-e29b-41d4-a716-446655440000";
  const createdAt = "2023-01-01T00:00:00.000Z";

  const data = {
    id,
    version: 2,
    createdAt,
    entries: [
      { message: "Test entry" },
    ],
  };

  const log = ModelLog.fromData(data);
  assertEquals(log.id, id);
  assertEquals(log.version, 2);
  assertEquals(log.createdAt, new Date(createdAt));
  assertEquals(log.entryCount, 1);
  assertEquals(log.entries[0].message, "Test entry");
});

Deno.test("ModelLog toJsonLines/fromJsonLines roundtrip", () => {
  const log = ModelLog.create({});
  log.log("Line 1");
  log.log("Line 2");
  log.log("Line 3");

  const lines = log.toJsonLines();
  const restored = ModelLog.fromJsonLines(
    log.id,
    log.version,
    log.createdAt,
    lines,
  );

  assertEquals(restored.entryCount, 3);
  assertEquals(restored.entries[0].message, "Line 1");
  assertEquals(restored.entries[1].message, "Line 2");
  assertEquals(restored.entries[2].message, "Line 3");
});

Deno.test("ModelLog.toJsonLines returns plain text lines", () => {
  const log = ModelLog.create({});
  log.log("first line");
  log.log("second line");

  const lines = log.toJsonLines();

  assertEquals(lines, "first line\nsecond line");
});

Deno.test("ModelLog.fromJsonLines handles empty lines in input", () => {
  const lines = `Line 1

Line 2
`;
  const log = ModelLog.fromJsonLines(
    "550e8400-e29b-41d4-a716-446655440000",
    1,
    new Date(),
    lines,
  );

  assertEquals(log.entryCount, 2);
  assertEquals(log.entries[0].message, "Line 1");
  assertEquals(log.entries[1].message, "Line 2");
});

Deno.test("ModelLog entries are immutable via getter", () => {
  const log = ModelLog.create({});
  log.log("Original");

  const entries = log.entries;
  entries.push(LogEntry.create("Added"));

  assertEquals(log.entryCount, 1);
});

Deno.test("ModelLog handles journalctl-style output", () => {
  const log = ModelLog.create({});
  log.log("Jan 01 12:00:00 myhost sshd[1234]: Accepted publickey");
  log.log("Jan 01 12:00:01 myhost sshd[1234]: Starting session");
  log.log("Jan 01 12:00:02 myhost sshd[1234]: Session closed");

  assertEquals(log.entryCount, 3);
  assertEquals(
    log.entries[0].message,
    "Jan 01 12:00:00 myhost sshd[1234]: Accepted publickey",
  );
});
