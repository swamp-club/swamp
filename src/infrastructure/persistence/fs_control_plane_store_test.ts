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
import { FileSystemControlPlaneStore } from "./fs_control_plane_store.ts";
import { PathTraversalError } from "./safe_path.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({
    prefix: "swamp-control-plane-store-test-",
  });
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

const encoder = new TextEncoder();
const decoder = new TextDecoder();

Deno.test("FileSystemControlPlaneStore: put and get round-trip", async () => {
  await withTempDir(async (dir) => {
    const store = new FileSystemControlPlaneStore(dir);
    const data = encoder.encode('{"instance":"i-1","ts":1234}');

    await store.put("heartbeats/i-1", data);
    const result = await store.get("heartbeats/i-1");

    assertEquals(result !== null, true);
    assertEquals(decoder.decode(result!), '{"instance":"i-1","ts":1234}');
  });
});

Deno.test("FileSystemControlPlaneStore: get returns null for missing key", async () => {
  await withTempDir(async (dir) => {
    const store = new FileSystemControlPlaneStore(dir);

    const result = await store.get("heartbeats/nonexistent");
    assertEquals(result, null);
  });
});

Deno.test("FileSystemControlPlaneStore: put overwrites existing key", async () => {
  await withTempDir(async (dir) => {
    const store = new FileSystemControlPlaneStore(dir);

    await store.put("heartbeats/i-1", encoder.encode("v1"));
    await store.put("heartbeats/i-1", encoder.encode("v2"));
    const result = await store.get("heartbeats/i-1");

    assertEquals(decoder.decode(result!), "v2");
  });
});

Deno.test("FileSystemControlPlaneStore: delete removes key", async () => {
  await withTempDir(async (dir) => {
    const store = new FileSystemControlPlaneStore(dir);

    await store.put("heartbeats/i-1", encoder.encode("data"));
    await store.delete("heartbeats/i-1");
    const result = await store.get("heartbeats/i-1");

    assertEquals(result, null);
  });
});

Deno.test("FileSystemControlPlaneStore: delete is idempotent", async () => {
  await withTempDir(async (dir) => {
    const store = new FileSystemControlPlaneStore(dir);

    await store.delete("heartbeats/nonexistent");
    await store.delete("heartbeats/nonexistent");
    const result = await store.get("heartbeats/nonexistent");

    assertEquals(result, null);
  });
});

Deno.test("FileSystemControlPlaneStore: list with prefix filtering", async () => {
  await withTempDir(async (dir) => {
    const store = new FileSystemControlPlaneStore(dir);

    await store.put("heartbeats/i-1", encoder.encode("h1"));
    await store.put("heartbeats/i-2", encoder.encode("h2"));
    await store.put("pending-runs/r-1", encoder.encode("p1"));

    const heartbeats = await store.list("heartbeats");
    assertEquals(heartbeats, ["heartbeats/i-1", "heartbeats/i-2"]);

    const pending = await store.list("pending-runs");
    assertEquals(pending, ["pending-runs/r-1"]);
  });
});

Deno.test("FileSystemControlPlaneStore: list returns empty for missing prefix", async () => {
  await withTempDir(async (dir) => {
    const store = new FileSystemControlPlaneStore(dir);

    const result = await store.list("nonexistent");
    assertEquals(result, []);
  });
});

Deno.test("FileSystemControlPlaneStore: nested key paths", async () => {
  await withTempDir(async (dir) => {
    const store = new FileSystemControlPlaneStore(dir);

    await store.put("deep/nested/path/key", encoder.encode("deep-value"));
    const result = await store.get("deep/nested/path/key");

    assertEquals(decoder.decode(result!), "deep-value");

    const keys = await store.list("deep/nested");
    assertEquals(keys, ["deep/nested/path/key"]);
  });
});

Deno.test("FileSystemControlPlaneStore: list returns sorted keys", async () => {
  await withTempDir(async (dir) => {
    const store = new FileSystemControlPlaneStore(dir);

    await store.put("heartbeats/z-last", encoder.encode("z"));
    await store.put("heartbeats/a-first", encoder.encode("a"));
    await store.put("heartbeats/m-middle", encoder.encode("m"));

    const keys = await store.list("heartbeats");
    assertEquals(keys, [
      "heartbeats/a-first",
      "heartbeats/m-middle",
      "heartbeats/z-last",
    ]);
  });
});

Deno.test("FileSystemControlPlaneStore: put/get binary data", async () => {
  await withTempDir(async (dir) => {
    const store = new FileSystemControlPlaneStore(dir);
    const binary = new Uint8Array([0, 1, 2, 255, 128, 64]);

    await store.put("binary/record", binary);
    const result = await store.get("binary/record");

    assertEquals(result, binary);
  });
});

Deno.test("FileSystemControlPlaneStore: delete then put same key", async () => {
  await withTempDir(async (dir) => {
    const store = new FileSystemControlPlaneStore(dir);

    await store.put("key", encoder.encode("v1"));
    await store.delete("key");
    await store.put("key", encoder.encode("v2"));

    const result = await store.get("key");
    assertEquals(decoder.decode(result!), "v2");
  });
});

Deno.test("FileSystemControlPlaneStore: list with empty prefix returns all keys", async () => {
  await withTempDir(async (dir) => {
    const store = new FileSystemControlPlaneStore(dir);

    await store.put("heartbeats/i-1", encoder.encode("h1"));
    await store.put("pending-runs/r-1", encoder.encode("p1"));

    const all = await store.list("");
    assertEquals(all, ["heartbeats/i-1", "pending-runs/r-1"]);
  });
});

Deno.test("FileSystemControlPlaneStore: rejects path traversal via ..", async () => {
  await withTempDir(async (dir) => {
    const store = new FileSystemControlPlaneStore(dir);

    await assertRejects(
      () => store.put("../../etc/passwd", encoder.encode("bad")),
      PathTraversalError,
    );
    await assertRejects(
      () => store.get("../secret"),
      PathTraversalError,
    );
    await assertRejects(
      () => store.delete("heartbeats/../../outside"),
      PathTraversalError,
    );
    await assertRejects(
      () => store.list(".."),
      PathTraversalError,
    );
  });
});

Deno.test("FileSystemControlPlaneStore: rejects absolute path keys", async () => {
  await withTempDir(async (dir) => {
    const store = new FileSystemControlPlaneStore(dir);

    await assertRejects(
      () => store.put("/etc/passwd", encoder.encode("bad")),
      PathTraversalError,
    );
  });
});

Deno.test("FileSystemControlPlaneStore: rejects empty key", async () => {
  await withTempDir(async (dir) => {
    const store = new FileSystemControlPlaneStore(dir);

    await assertRejects(
      () => store.put("", encoder.encode("bad")),
      PathTraversalError,
    );
  });
});
