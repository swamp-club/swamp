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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { extractZipEntry, ZipArchiveError } from "./zip_archive.ts";
import { buildZip, type TestZipEntry } from "./zip_test_helpers.ts";

const TESTDATA = fromFileUrl(new URL("./testdata/", import.meta.url));

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "zip-archive-test-" });
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

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function fixtureContent(): Uint8Array {
  let text = "";
  for (let i = 0; i < 300; i++) text += `fake swamp.exe line ${i}\n`;
  return new TextEncoder().encode(text);
}

const payload = new TextEncoder().encode("MZ fake swamp.exe ".repeat(500));

async function extractFrom(
  dir: string,
  zip: Uint8Array,
  entryName = "swamp.exe",
): Promise<Uint8Array> {
  const archive = join(dir, "update.zip");
  const dest = join(dir, "out.exe");
  await Deno.writeFile(archive, zip);
  await extractZipEntry(archive, entryName, dest);
  return await Deno.readFile(dest);
}

async function assertRefused(
  entries: TestZipEntry[],
  message: string,
  mutate: (zip: Uint8Array) => Uint8Array = (zip) => zip,
  options: Parameters<typeof buildZip>[1] = {},
): Promise<void> {
  await withTempDir(async (dir) => {
    const archive = join(dir, "update.zip");
    const dest = join(dir, "out.exe");
    await Deno.writeFile(archive, mutate(await buildZip(entries, options)));
    const error = await assertRejects(
      () => extractZipEntry(archive, "swamp.exe", dest),
      ZipArchiveError,
    );
    assertStringIncludes(error.message, message);
    assertEquals(await exists(dest), false, "no partial output left behind");
  });
}

Deno.test("extractZipEntry: reads a deflated entry written by Info-ZIP zip -j", async () => {
  await withTempDir(async (dir) => {
    const dest = join(dir, "swamp.exe");
    await extractZipEntry(
      join(TESTDATA, "info_zip_deflated.zip"),
      "swamp.exe",
      dest,
    );
    assertEquals(await Deno.readFile(dest), fixtureContent());
  });
});

Deno.test("extractZipEntry: reads a stored entry written by Info-ZIP zip -0 -j", async () => {
  await withTempDir(async (dir) => {
    const dest = join(dir, "swamp.exe");
    await extractZipEntry(
      join(TESTDATA, "info_zip_stored.zip"),
      "swamp.exe",
      dest,
    );
    assertEquals(await Deno.readFile(dest), fixtureContent());
  });
});

Deno.test("extractZipEntry: reads deflated and stored entries", async () => {
  await withTempDir(async (dir) => {
    for (const method of [0, 8] as const) {
      const zip = await buildZip([{
        name: "swamp.exe",
        data: payload,
        method,
      }]);
      assertEquals(await extractFrom(dir, zip), payload);
    }
  });
});

Deno.test("extractZipEntry: reads an empty entry", async () => {
  await withTempDir(async (dir) => {
    for (const method of [0, 8] as const) {
      const zip = await buildZip([
        { name: "swamp.exe", data: new Uint8Array(), method },
      ]);
      assertEquals(await extractFrom(dir, zip), new Uint8Array());
    }
  });
});

Deno.test("extractZipEntry: takes sizes from the central directory when the entry has a data descriptor", async () => {
  await withTempDir(async (dir) => {
    const zip = await buildZip([
      { name: "swamp.exe", data: payload, dataDescriptor: true },
    ]);
    assertEquals(await extractFrom(dir, zip), payload);
  });
});

Deno.test("extractZipEntry: finds the data past a local extra field longer than the central one", async () => {
  await withTempDir(async (dir) => {
    const zip = await buildZip([{
      name: "swamp.exe",
      data: payload,
      localExtra: new Uint8Array(37).fill(0x55),
      centralExtra: new Uint8Array(5).fill(0x55),
    }]);
    assertEquals(await extractFrom(dir, zip), payload);
  });
});

Deno.test("extractZipEntry: picks the named entry among several", async () => {
  await withTempDir(async (dir) => {
    const other = new TextEncoder().encode("readme");
    const zip = await buildZip([
      { name: "README.txt", data: other },
      { name: "swamp.exe", data: payload },
      { name: "swamp.exe.sig", data: other, method: 0 },
    ]);
    assertEquals(await extractFrom(dir, zip), payload);
  });
});

Deno.test("extractZipEntry: an archive comment holding the end-record signature is not taken for the record", async () => {
  await withTempDir(async (dir) => {
    const comment = new Uint8Array(40);
    // a fake end record inside the comment, whose own comment length is 0
    new DataView(comment.buffer).setUint32(4, 0x06054b50, true);
    const zip = await buildZip([{ name: "swamp.exe", data: payload }], {
      comment,
    });
    assertEquals(await extractFrom(dir, zip), payload);
  });
});

Deno.test("extractZipEntry: refuses an archive without the entry", async () => {
  await assertRefused(
    [{ name: "other.exe", data: payload }],
    "archive has no entry named swamp.exe",
  );
});

Deno.test("extractZipEntry: matches the entry name exactly", async () => {
  await assertRefused(
    [{ name: "bin/swamp.exe", data: payload }, {
      name: "SWAMP.EXE",
      data: payload,
    }],
    "archive has no entry named swamp.exe",
  );
});

Deno.test("extractZipEntry: refuses two entries under the same name", async () => {
  await assertRefused(
    [{ name: "swamp.exe", data: payload }, {
      name: "swamp.exe",
      data: payload,
    }],
    "more than one entry named swamp.exe",
  );
});

Deno.test("extractZipEntry: refuses an encrypted entry", async () => {
  await assertRefused(
    [{ name: "swamp.exe", data: payload, flags: 0x0001 }],
    "is encrypted",
  );
});

Deno.test("extractZipEntry: refuses an unsupported compression method", async () => {
  await assertRefused(
    [{ name: "swamp.exe", data: payload, method: 12, rawBody: payload }],
    "unsupported compression method 12",
  );
});

Deno.test("extractZipEntry: refuses zip64 markers", async () => {
  await assertRefused(
    [{ name: "swamp.exe", data: payload, uncompressedSize: 0xffffffff }],
    "zip64",
  );
  await assertRefused(
    [{ name: "swamp.exe", data: payload, compressedSize: 0xffffffff }],
    "zip64",
  );
  await assertRefused(
    [{ name: "swamp.exe", data: payload }],
    "zip64",
    undefined,
    { totalEntries: 0xffff },
  );
  await assertRefused(
    [{ name: "swamp.exe", data: payload }],
    "zip64",
    undefined,
    { zip64Locator: true },
  );
});

Deno.test("extractZipEntry: refuses a file with no end record", async () => {
  await assertRefused(
    [{ name: "swamp.exe", data: payload }],
    "not a zip archive",
    (zip) => zip.subarray(0, zip.length - 10),
  );
  await withTempDir(async (dir) => {
    const archive = join(dir, "update.zip");
    await Deno.writeFile(archive, new Uint8Array());
    await assertRejects(
      () => extractZipEntry(archive, "swamp.exe", join(dir, "out.exe")),
      ZipArchiveError,
      "not a zip archive",
    );
  });
});

Deno.test("extractZipEntry: refuses an archive truncated from the front", async () => {
  await assertRefused(
    [{ name: "swamp.exe", data: payload, method: 0 }],
    "central directory runs past",
    (zip) => zip.subarray(200),
  );
});

Deno.test("extractZipEntry: refuses entry data that runs past the central directory", async () => {
  await assertRefused(
    [{
      name: "swamp.exe",
      data: payload,
      method: 0,
      compressedSize: payload.length + 1,
      uncompressedSize: payload.length + 1,
    }],
    "data runs past the central directory",
  );
});

Deno.test("extractZipEntry: refuses a CRC mismatch", async () => {
  await assertRefused(
    [{ name: "swamp.exe", data: payload, crc32: 0x12345678 }],
    "failed its CRC-32 check",
  );
});

Deno.test("extractZipEntry: refuses an entry that decompresses past its declared size", async () => {
  await assertRefused(
    [{ name: "swamp.exe", data: payload, uncompressedSize: 10 }],
    "more than its declared 10 bytes",
  );
});

Deno.test("extractZipEntry: refuses an entry that decompresses short of its declared size", async () => {
  await assertRefused(
    [{
      name: "swamp.exe",
      data: payload,
      uncompressedSize: payload.length + 1,
    }],
    "expected " + (payload.length + 1),
  );
});

Deno.test("extractZipEntry: refuses a stored entry whose sizes differ", async () => {
  await assertRefused(
    [{
      name: "swamp.exe",
      data: payload,
      method: 0,
      uncompressedSize: payload.length - 1,
    }],
    "stored but its sizes differ",
  );
});

Deno.test("extractZipEntry: refuses corrupt compressed data", async () => {
  await assertRefused(
    [{
      name: "swamp.exe",
      data: payload,
      rawBody: new Uint8Array([0xff, 0xff, 0xff, 0x12, 0x34]),
    }],
    "corrupt compressed data",
  );
});

Deno.test("extractZipEntry: refuses a corrupt local header", async () => {
  await assertRefused(
    [{ name: "swamp.exe", data: payload }],
    "corrupt local header",
    (zip) => {
      const copy = zip.slice();
      copy[0] = 0;
      return copy;
    },
  );
});

Deno.test("extractZipEntry: an aborted signal rejects with its reason and leaves no output", async () => {
  await withTempDir(async (dir) => {
    const archive = join(dir, "update.zip");
    const dest = join(dir, "out.exe");
    await Deno.writeFile(
      archive,
      await buildZip([{ name: "swamp.exe", data: payload }]),
    );
    const reason = new Error("cancelled");
    const controller = new AbortController();
    controller.abort(reason);
    const error = await assertRejects(() =>
      extractZipEntry(archive, "swamp.exe", dest, {
        signal: controller.signal,
      })
    );
    assertEquals(error, reason);
    assertEquals(await exists(dest), false);
  });
});

Deno.test("extractZipEntry: an abort during extraction rejects with its reason and leaves no output", async () => {
  await withTempDir(async (dir) => {
    const big = new Uint8Array(1024 * 1024).fill(7);
    const archive = join(dir, "update.zip");
    const dest = join(dir, "out.exe");
    await Deno.writeFile(
      archive,
      await buildZip([{ name: "swamp.exe", data: big, method: 0 }]),
    );
    const reason = new Error("cancelled mid-way");
    const controller = new AbortController();
    const signal = controller.signal;
    const check = signal.throwIfAborted.bind(signal);
    let checks = 0;
    signal.throwIfAborted = () => {
      if (++checks === 4) {
        assertEquals(Deno.statSync(dest).size > 0, true, "writing had begun");
        controller.abort(reason);
      }
      check();
    };
    const error = await assertRejects(() =>
      extractZipEntry(archive, "swamp.exe", dest, { signal })
    );
    assertEquals(error, reason);
    assertEquals(checks, 4);
    assertEquals(await exists(dest), false);
  });
});
