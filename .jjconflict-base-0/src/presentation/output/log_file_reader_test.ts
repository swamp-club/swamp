import { assertEquals } from "@std/assert";
import { readLogFile } from "./log_file_reader.ts";

Deno.test("readLogFile - reads file lines", async () => {
  const tmpFile = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(tmpFile, "line 1\nline 2\nline 3\n");
    const result = await readLogFile(tmpFile);
    assertEquals(result.lines, ["line 1", "line 2", "line 3"]);
    assertEquals(result.path, tmpFile);
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("readLogFile - handles missing file", async () => {
  const result = await readLogFile("/nonexistent/path/file.log");
  assertEquals(result.lines, []);
  assertEquals(result.path, "/nonexistent/path/file.log");
});

Deno.test("readLogFile - tail option returns last N lines", async () => {
  const tmpFile = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(
      tmpFile,
      "line 1\nline 2\nline 3\nline 4\nline 5\n",
    );
    const result = await readLogFile(tmpFile, { tail: 2 });
    assertEquals(result.lines, ["line 4", "line 5"]);
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("readLogFile - empty file", async () => {
  const tmpFile = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(tmpFile, "");
    const result = await readLogFile(tmpFile);
    assertEquals(result.lines, []);
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("readLogFile - tail larger than file returns all lines", async () => {
  const tmpFile = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(tmpFile, "line 1\nline 2\n");
    const result = await readLogFile(tmpFile, { tail: 100 });
    assertEquals(result.lines, ["line 1", "line 2"]);
  } finally {
    await Deno.remove(tmpFile);
  }
});
