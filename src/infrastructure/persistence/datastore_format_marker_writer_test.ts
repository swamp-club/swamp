// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  datastoreFormatMarkerText,
  writeControlPlaneFormatMarker,
  writeDatastoreFormatMarker,
} from "./datastore_format_marker_writer.ts";
import { readDatastoreFormatMarker } from "./datastore_format_marker_reader.ts";
import { ensureSupportedDatastoreFormat } from "./datastore_format_guard.ts";
import { UserError } from "../../domain/errors.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-marker-writer-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("writeDatastoreFormatMarker: writes a marker the reader and guard accept as v3", async () => {
  await withTempDir(async (dir) => {
    const path = await writeDatastoreFormatMarker(dir, {
      format: 3,
      minReaderFormat: 3,
      writtenBy: "2026.10.12.1",
    });
    assertEquals(path, join(dir, "datastore-format.json"));
    const read = await readDatastoreFormatMarker(dir, {
      type: "filesystem",
      path: dir,
    });
    assertEquals(read.kind, "present");
    const engine = await ensureSupportedDatastoreFormat(dir, {
      type: "filesystem",
      path: dir,
    });
    assertEquals(engine, "v3");
  });
});

Deno.test("writeDatastoreFormatMarker: refuses to replace an existing marker", async () => {
  await withTempDir(async (dir) => {
    await writeDatastoreFormatMarker(dir, { format: 3, minReaderFormat: 3 });
    await assertRejects(
      () => writeDatastoreFormatMarker(dir, { format: 2 }),
      UserError,
      "already exists",
    );
    const text = await Deno.readTextFile(join(dir, "datastore-format.json"));
    assertEquals(JSON.parse(text).format, 3);
  });
});

Deno.test("writeDatastoreFormatMarker: leaves no temp file behind", async () => {
  await withTempDir(async (dir) => {
    await writeDatastoreFormatMarker(dir, { format: 3, minReaderFormat: 3 });
    const names = [];
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
    assertEquals(names, ["datastore-format.json"]);
  });
});

Deno.test("writeDatastoreFormatMarker: of two concurrent writes exactly one succeeds", async () => {
  await withTempDir(async (dir) => {
    const results = await Promise.allSettled([
      writeDatastoreFormatMarker(dir, { format: 3, minReaderFormat: 3 }),
      writeDatastoreFormatMarker(dir, { format: 3, minReaderFormat: 3 }),
    ]);
    assertEquals(
      results.map((r) => r.status).sort(),
      ["fulfilled", "rejected"],
    );
    const names = [];
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
    assertEquals(names, ["datastore-format.json"]);
  });
});

Deno.test("writeDatastoreFormatMarker: without hard links it creates the marker exclusively", async () => {
  await withTempDir(async (dir) => {
    const noLinks = () =>
      Promise.reject(new Deno.errors.NotSupported("no hard links here"));
    await writeDatastoreFormatMarker(dir, { format: 3, minReaderFormat: 3 }, {
      link: noLinks,
    });
    assertEquals(
      await ensureSupportedDatastoreFormat(dir, {
        type: "filesystem",
        path: dir,
      }),
      "v3",
    );
    // No temp file is left, and a second write is still refused.
    const names = [];
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
    assertEquals(names, ["datastore-format.json"]);
    await assertRejects(
      () => writeDatastoreFormatMarker(dir, { format: 2 }, { link: noLinks }),
      UserError,
      "already exists",
    );
  });
});

Deno.test("writeDatastoreFormatMarker: syncs and closes the marker's content before linking it, then syncs the directory (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const events: string[] = [];
    let synced: Deno.FsFile | undefined;
    await writeDatastoreFormatMarker(dir, { format: 3, minReaderFormat: 3 }, {
      syncFile: (file) => {
        events.push("sync file");
        synced = file;
        return Promise.resolve();
      },
      link: async (from, to) => {
        // The synced handle is closed by now: closing it again fails.
        let closed = false;
        try {
          synced?.close();
        } catch (error) {
          closed = error instanceof Deno.errors.BadResource;
        }
        events.push(closed ? "link closed file" : "link open file");
        await Deno.link(from, to);
      },
      syncDirectory: async (synced) => {
        assertEquals(synced, dir);
        // The link is in place and the temp file gone when the directory
        // is synced.
        const names = [];
        for await (const entry of Deno.readDir(dir)) names.push(entry.name);
        events.push(`sync dir ${names.join(",")}`);
      },
    });
    assertEquals(events, [
      "sync file",
      "link closed file",
      "sync dir datastore-format.json",
    ]);
  });
});

Deno.test("writeDatastoreFormatMarker: without hard links the created marker is synced, then the directory (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const events: string[] = [];
    await writeDatastoreFormatMarker(dir, { format: 3, minReaderFormat: 3 }, {
      link: () =>
        Promise.reject(new Deno.errors.NotSupported("no hard links here")),
      syncFile: () => {
        events.push("sync file");
        return Promise.resolve();
      },
      syncDirectory: () => {
        events.push("sync dir");
        return Promise.resolve();
      },
    });
    assertEquals(events, ["sync file", "sync file", "sync dir"]);
  });
});

Deno.test("writeControlPlaneFormatMarker: writes the marker once, as the filesystem marker reads, and reports a second write (swamp-club#3534)", async () => {
  const records = new Map<string, Uint8Array>();
  const store = {
    putIfAbsent(key: string, data: Uint8Array): Promise<boolean> {
      if (records.has(key)) return Promise.resolve(false);
      records.set(key, data);
      return Promise.resolve(true);
    },
  };
  const marker = { format: 3, minReaderFormat: 3, writtenBy: "1.2.3" };
  assertEquals(await writeControlPlaneFormatMarker(store, marker), true);
  assertEquals(
    await writeControlPlaneFormatMarker(store, { ...marker, format: 4 }),
    false,
  );
  const written = new TextDecoder().decode(records.get("datastore-format"));
  assertEquals(written, datastoreFormatMarkerText(marker));
  assertEquals(JSON.parse(written), marker);
});
