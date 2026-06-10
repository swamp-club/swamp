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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { createTarGz, extractTarGz, listTarGzEntries } from "./tar_archive.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "tar-archive-test-" });
  try {
    return await fn(dir);
  } finally {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // Windows occasionally throws EBUSY when V8 hasn't released file
      // handles. Best-effort cleanup.
    }
  }
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

Deno.test("createTarGz + extractTarGz: round-trip preserves regular files", async () => {
  await withTempDir(async (root) => {
    const src = join(root, "src");
    const top = join(src, "thing");
    await ensureDir(top);
    await Deno.writeTextFile(join(top, "a.txt"), "alpha");
    await ensureDir(join(top, "sub"));
    await Deno.writeTextFile(join(top, "sub", "b.txt"), "beta");

    const archive = join(root, "out.tar.gz");
    await createTarGz(top, archive);

    const dst = join(root, "dst");
    await ensureDir(dst);
    const archiveBytes = await Deno.readFile(archive);
    await extractTarGz(streamFromBytes(archiveBytes), dst);

    assertEquals(
      await Deno.readTextFile(join(dst, "thing", "a.txt")),
      "alpha",
    );
    assertEquals(
      await Deno.readTextFile(join(dst, "thing", "sub", "b.txt")),
      "beta",
    );
  });
});

Deno.test({
  name: "createTarGz + extractTarGz: preserves symlinks",
  // Windows symlink creation requires elevated privileges by default; skip
  // this test there. Pull/push only target macOS/Linux for symlink-bearing
  // archives in production.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (root) => {
      const top = join(root, "src", "ext");
      await ensureDir(top);
      await Deno.writeTextFile(join(top, "real.txt"), "linked");
      await Deno.symlink("real.txt", join(top, "link.txt"), { type: "file" });

      const archive = join(root, "out.tar.gz");
      await createTarGz(top, archive);

      const dst = join(root, "dst");
      await ensureDir(dst);
      const bytes = await Deno.readFile(archive);
      await extractTarGz(streamFromBytes(bytes), dst);

      const linkPath = join(dst, "ext", "link.txt");
      const stat = await Deno.lstat(linkPath);
      assert(stat.isSymlink, "link.txt should be a symlink");
      const target = await Deno.readLink(linkPath);
      assertEquals(target, "real.txt");
    });
  },
});

Deno.test("extractTarGz: rejects archive entries that escape via ../", async () => {
  await withTempDir(async (root) => {
    // Build a malicious archive by hand using TarStream (we can't ask the
    // platform tar to do this safely).
    const { TarStream } = await import("@std/tar/tar-stream");
    const archivePath = join(root, "bad.tar.gz");
    const file = await Deno.open(archivePath, {
      write: true,
      create: true,
      truncate: true,
    });
    const payload = new TextEncoder().encode("malicious");
    await ReadableStream.from([
      {
        type: "file" as const,
        path: "../escape.txt",
        size: payload.length,
        readable: new ReadableStream({
          start(controller) {
            controller.enqueue(payload);
            controller.close();
          },
        }),
      },
    ])
      .pipeThrough(new TarStream())
      .pipeThrough(new CompressionStream("gzip"))
      .pipeTo(file.writable);

    const dst = join(root, "dst");
    await ensureDir(dst);
    const bytes = await Deno.readFile(archivePath);
    await assertRejects(
      () => extractTarGz(streamFromBytes(bytes), dst),
      Error,
      "unsafe path",
    );
  });
});

Deno.test("listTarGzEntries: returns the archive paths without writing to disk", async () => {
  await withTempDir(async (root) => {
    const top = join(root, "src", "thing");
    await ensureDir(top);
    await Deno.writeTextFile(join(top, "a.txt"), "alpha");

    const archive = join(root, "out.tar.gz");
    await createTarGz(top, archive);

    const bytes = await Deno.readFile(archive);
    const entries = await listTarGzEntries(streamFromBytes(bytes));
    // The exact set: directory entry "thing/" + file "thing/a.txt"
    assert(entries.includes("thing/a.txt"));
    assert(entries.some((e) => e === "thing/" || e === "thing"));
  });
});

Deno.test({
  name:
    "createTarGz: does not produce AppleDouble (._foo) entries on macOS source trees",
  // Only meaningful on darwin where BSD tar would otherwise inject them.
  // Verifies the new code path doesn't introduce any.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (root) => {
      const top = join(root, "src", "ext");
      await ensureDir(top);
      await Deno.writeTextFile(join(top, "main.txt"), "real content");
      // Hand-place an AppleDouble companion to confirm we filter it.
      await Deno.writeTextFile(join(top, "._main.txt"), "fork goo");

      const archive = join(root, "out.tar.gz");
      await createTarGz(top, archive);

      const bytes = await Deno.readFile(archive);
      const entries = await listTarGzEntries(streamFromBytes(bytes));
      for (const entry of entries) {
        assert(
          !entry.split("/").some((seg) => seg.startsWith("._")),
          `archive should not contain AppleDouble entry; saw: ${entry}`,
        );
      }
    });
  },
});

Deno.test({
  name: "extractTarGz: rejects symlink with absolute target",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (root) => {
      const { TarStream } = await import("@std/tar/tar-stream");
      const archivePath = join(root, "bad.tar.gz");
      const file = await Deno.open(archivePath, {
        write: true,
        create: true,
        truncate: true,
      });
      await ReadableStream.from([
        {
          type: "directory" as const,
          path: "extension/",
        },
        {
          type: "symlink" as const,
          path: "extension/escape",
          linkname: "/tmp/evil",
        },
      ])
        .pipeThrough(new TarStream())
        .pipeThrough(new CompressionStream("gzip"))
        .pipeTo(file.writable);

      const dst = join(root, "dst");
      await ensureDir(dst);
      const bytes = await Deno.readFile(archivePath);
      await assertRejects(
        () => extractTarGz(streamFromBytes(bytes), dst),
        Error,
        "absolute target",
      );
    });
  },
});

Deno.test({
  name: "extractTarGz: rejects symlink with relative target escaping root",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (root) => {
      const { TarStream } = await import("@std/tar/tar-stream");
      const archivePath = join(root, "bad.tar.gz");
      const file = await Deno.open(archivePath, {
        write: true,
        create: true,
        truncate: true,
      });
      await ReadableStream.from([
        {
          type: "directory" as const,
          path: "extension/",
        },
        {
          type: "symlink" as const,
          path: "extension/escape",
          linkname: "../../../../../../tmp/evil",
        },
      ])
        .pipeThrough(new TarStream())
        .pipeThrough(new CompressionStream("gzip"))
        .pipeTo(file.writable);

      const dst = join(root, "dst");
      await ensureDir(dst);
      const bytes = await Deno.readFile(archivePath);
      await assertRejects(
        () => extractTarGz(streamFromBytes(bytes), dst),
        Error,
        "escapes extract root",
      );
    });
  },
});

Deno.test({
  name: "extractTarGz: allows symlink with target staying within root",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (root) => {
      const { TarStream } = await import("@std/tar/tar-stream");
      const archivePath = join(root, "good.tar.gz");
      const file = await Deno.open(archivePath, {
        write: true,
        create: true,
        truncate: true,
      });
      const payload = new TextEncoder().encode("hello");
      await ReadableStream.from([
        {
          type: "directory" as const,
          path: "extension/",
        },
        {
          type: "file" as const,
          path: "extension/real.txt",
          size: payload.length,
          readable: streamFromBytes(payload),
        },
        {
          type: "symlink" as const,
          path: "extension/link.txt",
          linkname: "real.txt",
        },
      ])
        .pipeThrough(new TarStream())
        .pipeThrough(new CompressionStream("gzip"))
        .pipeTo(file.writable);

      const dst = join(root, "dst");
      await ensureDir(dst);
      const bytes = await Deno.readFile(archivePath);
      await extractTarGz(streamFromBytes(bytes), dst);

      const linkPath = join(dst, "extension", "link.txt");
      const stat = await Deno.lstat(linkPath);
      assert(stat.isSymlink, "link.txt should be a symlink");
      assertEquals(await Deno.readLink(linkPath), "real.txt");
    });
  },
});

Deno.test({
  name: "extractTarGz: blocks file write through symlink that escapes root",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (root) => {
      // Craft an archive where a symlink points outside root,
      // followed by a file write through that symlink.
      // The symlink validation should catch this before the file is written.
      const { TarStream } = await import("@std/tar/tar-stream");
      const archivePath = join(root, "bad.tar.gz");
      const file = await Deno.open(archivePath, {
        write: true,
        create: true,
        truncate: true,
      });
      const payload = new TextEncoder().encode("malicious");
      await ReadableStream.from([
        {
          type: "directory" as const,
          path: "extension/",
        },
        {
          type: "symlink" as const,
          path: "extension/escape",
          linkname: "../../../../../../tmp",
        },
        {
          type: "file" as const,
          path: "extension/escape/payload.txt",
          size: payload.length,
          readable: streamFromBytes(payload),
        },
      ])
        .pipeThrough(new TarStream())
        .pipeThrough(new CompressionStream("gzip"))
        .pipeTo(file.writable);

      const dst = join(root, "dst");
      await ensureDir(dst);
      const bytes = await Deno.readFile(archivePath);
      await assertRejects(
        () => extractTarGz(streamFromBytes(bytes), dst),
        Error,
        "escapes extract root",
      );
    });
  },
});

Deno.test("extractTarGz: applies file mode bits on POSIX", async () => {
  await withTempDir(async (root) => {
    const top = join(root, "src", "ext");
    await ensureDir(top);
    const exePath = join(top, "exe.sh");
    await Deno.writeTextFile(exePath, "#!/bin/sh\necho hi\n");
    if (Deno.build.os !== "windows") {
      await Deno.chmod(exePath, 0o755);
    }

    const archive = join(root, "out.tar.gz");
    await createTarGz(top, archive);

    const dst = join(root, "dst");
    await ensureDir(dst);
    const bytes = await Deno.readFile(archive);
    await extractTarGz(streamFromBytes(bytes), dst);

    const stat = await Deno.stat(join(dst, "ext", "exe.sh"));
    if (Deno.build.os !== "windows") {
      // Executable bits should round-trip on POSIX.
      assert(
        (stat.mode! & 0o111) !== 0,
        `expected exe bits set; got 0o${(stat.mode! & 0o777).toString(8)}`,
      );
    } else {
      // On Windows, chmod is a no-op; just assert file exists with content.
      assertEquals(stat.isFile, true);
    }
  });
});
