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
import { waitFor } from "@swamp-club/swamp-testing";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import {
  ArchiveSizeLimitError,
  createTarGz,
  extractTarGz,
  listTarGzEntries,
} from "./tar_archive.ts";

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

/** Builds a small `.tar.gz` (one zero-filled file) and its decompressed length. */
async function buildSizedArchive(
  root: string,
  fileBytes: number,
): Promise<{ bytes: Uint8Array; decompressedLength: number }> {
  const top = join(root, "src", "ext");
  await ensureDir(top);
  await Deno.writeFile(join(top, "payload.bin"), new Uint8Array(fileBytes));
  const archive = join(root, "sized.tar.gz");
  await createTarGz(top, archive);
  const bytes = await Deno.readFile(archive);
  const decompressed = await new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
  ).bytes();
  return { bytes, decompressedLength: decompressed.byteLength };
}

async function dirNames(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  return names.sort();
}

Deno.test("listTarGzEntries: rejects an archive that decompresses past maxDecompressedBytes", async () => {
  await withTempDir(async (root) => {
    const { bytes, decompressedLength } = await buildSizedArchive(
      root,
      64 * 1024,
    );
    // The fixture compresses heavily, so a limit well under its expanded
    // size is still far above its compressed size — the gzip-bomb shape.
    assert(bytes.byteLength < decompressedLength / 10);
    const error = await assertRejects(
      () =>
        listTarGzEntries(streamFromBytes(bytes), {
          maxDecompressedBytes: decompressedLength - 1,
        }),
      ArchiveSizeLimitError,
    );
    assertEquals(error.maxDecompressedBytes, decompressedLength - 1);
  });
});

Deno.test("extractTarGz: rejects an archive that decompresses past maxDecompressedBytes and writes nothing outside the extract root", async () => {
  await withTempDir(async (root) => {
    const { bytes, decompressedLength } = await buildSizedArchive(
      root,
      64 * 1024,
    );
    const sandbox = join(root, "sandbox");
    const dst = join(sandbox, "dst");
    await ensureDir(dst);
    await assertRejects(
      () =>
        extractTarGz(streamFromBytes(bytes), dst, undefined, {
          maxDecompressedBytes: decompressedLength - 1,
        }),
      ArchiveSizeLimitError,
    );
    assertEquals(await dirNames(sandbox), ["dst"]);
  });
});

Deno.test("listTarGzEntries + extractTarGz: accept an archive whose decompressed length equals maxDecompressedBytes", async () => {
  await withTempDir(async (root) => {
    const { bytes, decompressedLength } = await buildSizedArchive(
      root,
      64 * 1024,
    );
    const options = { maxDecompressedBytes: decompressedLength };
    assertEquals(
      await listTarGzEntries(streamFromBytes(bytes), options),
      ["ext/", "ext/payload.bin"],
    );
    const dst = join(root, "dst");
    await extractTarGz(streamFromBytes(bytes), dst, undefined, options);
    assertEquals(
      (await Deno.stat(join(dst, "ext", "payload.bin"))).size,
      64 * 1024,
    );
  });
});

// The tests below read from a real FsFile and fail if a failure path leaves
// the file handle open. Deno's resource sanitizer does not track FsFile
// handles, so each test probes the handle with a non-destructive stat, which
// throws BadResource once the stream has released it. Cancellation reaches
// the source asynchronously after the error surfaces, so the probe polls.

async function isReleased(file: Deno.FsFile): Promise<boolean> {
  try {
    await file.stat();
    return false;
  } catch (error) {
    if (error instanceof Deno.errors.BadResource) return true;
    throw error;
  }
}

function handleTest(
  name: string,
  fn: (root: string) => Promise<Deno.FsFile>,
): void {
  Deno.test(name, () =>
    withTempDir(async (root) => {
      const file = await fn(root);
      await waitFor(() => isReleased(file), "the archive file handle to close");
    }));
}

async function writeCorruptGzip(path: string): Promise<void> {
  await Deno.writeFile(
    path,
    new Uint8Array([0x1F, 0x8B, 0x08, 0x00, 0xFF, 0xFF, 0xFF, 0xFF]),
  );
}

handleTest(
  "listTarGzEntries: releases the source file when gunzip fails",
  async (root) => {
    const path = join(root, "corrupt.tar.gz");
    await writeCorruptGzip(path);
    const file = await Deno.open(path, { read: true });
    await assertRejects(() => listTarGzEntries(file.readable));
    return file;
  },
);

handleTest(
  "extractTarGz: releases the source file when gunzip fails",
  async (root) => {
    const path = join(root, "corrupt.tar.gz");
    await writeCorruptGzip(path);
    const file = await Deno.open(path, { read: true });
    await assertRejects(() => extractTarGz(file.readable, join(root, "dst")));
    return file;
  },
);

handleTest(
  "listTarGzEntries: releases the source file when the size limit aborts",
  async (root) => {
    const { decompressedLength } = await buildSizedArchive(root, 64 * 1024);
    const file = await Deno.open(join(root, "sized.tar.gz"), { read: true });
    await assertRejects(
      () =>
        listTarGzEntries(file.readable, {
          maxDecompressedBytes: decompressedLength - 1,
        }),
      ArchiveSizeLimitError,
    );
    return file;
  },
);

handleTest(
  "extractTarGz: releases the source file when the size limit aborts",
  async (root) => {
    const { decompressedLength } = await buildSizedArchive(root, 64 * 1024);
    const file = await Deno.open(join(root, "sized.tar.gz"), { read: true });
    await assertRejects(
      () =>
        extractTarGz(file.readable, join(root, "dst"), undefined, {
          maxDecompressedBytes: decompressedLength - 1,
        }),
      ArchiveSizeLimitError,
    );
    return file;
  },
);

/**
 * Writes a `.tar.gz` whose first entry is `firstPath`, followed by 4 MiB of
 * incompressible data. The tail is larger than the stream buffers, so a
 * failure on the first entry leaves most of the file unread.
 */
async function writeArchiveWithLargeTail(
  path: string,
  firstPath: string,
): Promise<void> {
  const { TarStream } = await import("@std/tar/tar-stream");
  const tail = new Uint8Array(4 * 1024 * 1024);
  for (let i = 0; i < tail.length; i += 65536) {
    crypto.getRandomValues(tail.subarray(i, i + 65536));
  }
  const payload = new TextEncoder().encode("first");
  const bytes = await new Response(
    ReadableStream.from([
      {
        type: "file" as const,
        path: firstPath,
        size: payload.length,
        readable: ReadableStream.from([payload]),
      },
      {
        type: "file" as const,
        path: "tail.bin",
        size: tail.length,
        readable: ReadableStream.from([tail]),
      },
    ])
      .pipeThrough(new TarStream())
      .pipeThrough(new CompressionStream("gzip")),
  ).bytes();
  await Deno.writeFile(path, bytes);
}

handleTest(
  "extractTarGz: releases the source file when an entry is rejected",
  async (root) => {
    const path = join(root, "bad.tar.gz");
    await writeArchiveWithLargeTail(path, "../escape.txt");
    const file = await Deno.open(path, { read: true });
    await assertRejects(
      () => extractTarGz(file.readable, join(root, "dst")),
      Error,
      "unsafe path",
    );
    return file;
  },
);

handleTest(
  "extractTarGz: releases the source file when onEntry throws",
  async (root) => {
    const path = join(root, "a.tar.gz");
    await writeArchiveWithLargeTail(path, "first.txt");
    const file = await Deno.open(path, { read: true });
    await assertRejects(
      () =>
        extractTarGz(file.readable, join(root, "dst"), () => {
          throw new Error("rejected by caller");
        }),
      Error,
      "rejected by caller",
    );
    return file;
  },
);

handleTest(
  "extractTarGz: releases the source file when the extract root cannot be created",
  async (root) => {
    await buildSizedArchive(root, 1024);
    // A regular file where the extract root's parent should be makes
    // ensureDir fail before the source stream is read.
    await Deno.writeTextFile(join(root, "blocker"), "");
    const file = await Deno.open(join(root, "sized.tar.gz"), { read: true });
    await assertRejects(() =>
      extractTarGz(file.readable, join(root, "blocker", "dst"))
    );
    return file;
  },
);
