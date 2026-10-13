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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { TarStream, type TarStreamInput } from "@std/tar/tar-stream";
import { computeChecksum } from "../../../domain/models/checksum.ts";
import {
  LITESTREAM_TARGETS,
  litestreamArchiveUrl,
  LitestreamPin,
  type LitestreamTarget,
  type LitestreamTargetDigests,
} from "../../../domain/datastore_v3/litestream_release.ts";
import {
  ABANDONED_STAGING_MAX_AGE_MS,
  denoLitestreamFs,
  LITESTREAM_PATH_ENV,
  LitestreamBinaryProvider,
  type LitestreamBinaryProviderOptions,
  type LitestreamFs,
  LitestreamIntegrityError,
  LitestreamUnavailableError,
  modificationTimeMs,
} from "./litestream_binary_provider.ts";

const encoder = new TextEncoder();
const BINARY = encoder.encode("#!/bin/sh\necho litestream\n");
const LICENSE = encoder.encode("Apache License 2.0\n");

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-litestream-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** Builds an upstream-shaped tar.gz: the binary, LICENSE, README, etc/. */
async function buildArchive(binary: Uint8Array): Promise<Uint8Array> {
  const file = (path: string, bytes: Uint8Array): TarStreamInput => ({
    type: "file",
    path,
    size: bytes.byteLength,
    readable: ReadableStream.from([bytes]),
  });
  const entries: TarStreamInput[] = [
    file("LICENSE", LICENSE),
    file("README.md", encoder.encode("readme\n")),
    { type: "directory", path: "etc" },
    file("etc/litestream.yml", encoder.encode("dbs: []\n")),
    file("litestream", binary),
  ];
  const stream = ReadableStream.from(entries)
    .pipeThrough(new TarStream())
    .pipeThrough(
      new CompressionStream("gzip") as unknown as TransformStream<
        Uint8Array,
        Uint8Array
      >,
    );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface Fixture {
  pin: LitestreamPin;
  archive: Uint8Array;
  url: string;
}

async function fixture(
  version = "0.5.17",
  binary = BINARY,
): Promise<Fixture> {
  const archive = await buildArchive(binary);
  const digests: LitestreamTargetDigests = {
    archiveSha256: await computeChecksum(archive),
    binarySha256: await computeChecksum(binary),
  };
  const targets = Object.fromEntries(
    LITESTREAM_TARGETS.map((target) => [target, digests]),
  ) as Record<LitestreamTarget, LitestreamTargetDigests>;
  return {
    pin: LitestreamPin.from({ version, targets }),
    archive,
    url: litestreamArchiveUrl(version, "linux-x86_64"),
  };
}

/** A fetch that serves `body` and counts its calls. */
function servingFetch(body: Uint8Array, status = 200) {
  const calls: string[] = [];
  const fetch = (url: string | URL): Promise<Response> => {
    calls.push(String(url));
    return Promise.resolve(
      new Response(status === 200 ? body.slice() : "not found", { status }),
    );
  };
  return { fetch, calls };
}

function provider(
  dataDir: string,
  fx: Fixture,
  overrides: Partial<LitestreamBinaryProviderOptions> = {},
): LitestreamBinaryProvider {
  return new LitestreamBinaryProvider({
    dataDir,
    pin: fx.pin,
    os: "linux",
    arch: "x86_64",
    fetch: servingFetch(fx.archive).fetch,
    clearQuarantine: () => Promise.resolve(),
    ...overrides,
  });
}

async function listNames(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  return names.sort();
}

Deno.test("LitestreamBinaryProvider.resolve: downloads, verifies and caches the binary on first use", async () => {
  await withTempDir(async (dataDir) => {
    const fx = await fixture();
    const served = servingFetch(fx.archive);
    const resolved = await provider(dataDir, fx, { fetch: served.fetch })
      .resolve();

    const versionDir = join(dataDir, "litestream", "0.5.17");
    assertEquals(resolved, {
      path: join(versionDir, "litestream"),
      version: "0.5.17",
      source: "download",
    });
    assertEquals(served.calls, [fx.url]);
    assertEquals(await Deno.readFile(resolved.path), BINARY);
    assertEquals(await Deno.readFile(join(versionDir, "LICENSE")), LICENSE);
    // Only the binary and its licence are kept, and no staging dir is left.
    assertEquals(await listNames(versionDir), ["LICENSE", "litestream"]);
    assertEquals(await listNames(join(dataDir, "litestream")), ["0.5.17"]);
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(resolved.path)).mode! & 0o777, 0o755);
    }
  });
});

Deno.test("LitestreamBinaryProvider.resolve: a cached binary is re-hashed and served without a download", async () => {
  await withTempDir(async (dataDir) => {
    const fx = await fixture();
    await provider(dataDir, fx).resolve();
    const served = servingFetch(fx.archive);
    const resolved = await provider(dataDir, fx, { fetch: served.fetch })
      .resolve();
    assertEquals(resolved.source, "cache");
    assertEquals(served.calls, []);
  });
});

Deno.test("LitestreamBinaryProvider.resolve: an archive that does not hash to the pin is refused before extraction", async () => {
  await withTempDir(async (dataDir) => {
    const fx = await fixture();
    const tampered = await buildArchive(encoder.encode("evil"));
    let extracted = false;
    await assertRejects(
      () =>
        provider(dataDir, fx, {
          fetch: servingFetch(tampered).fetch,
          extract: () => {
            extracted = true;
            return Promise.resolve();
          },
        }).resolve(),
      LitestreamIntegrityError,
      "did not extract or run it",
    );
    assertEquals(extracted, false);
    assertEquals(
      await denoLitestreamFs.exists(join(dataDir, "litestream", "0.5.17")),
      false,
    );
  });
});

Deno.test("LitestreamBinaryProvider.resolve: a binary that does not hash to the pin is refused and not cached", async () => {
  await withTempDir(async (dataDir) => {
    const fx = await fixture();
    // The archive matches the pin, the binary inside it does not.
    const other = await fixture("0.5.17", encoder.encode("other binary"));
    const pin = LitestreamPin.from({
      version: "0.5.17",
      targets: Object.fromEntries(
        LITESTREAM_TARGETS.map((target) => [target, {
          archiveSha256: other.pin.digests(target).archiveSha256,
          binarySha256: fx.pin.digests(target).binarySha256,
        }]),
      ) as Record<LitestreamTarget, LitestreamTargetDigests>,
    });
    await assertRejects(
      () =>
        provider(dataDir, { ...fx, pin }, {
          fetch: servingFetch(other.archive).fetch,
        }).resolve(),
      LitestreamIntegrityError,
      "swamp will not run it",
    );
    assertEquals(await listNames(join(dataDir, "litestream")), []);
  });
});

Deno.test("LitestreamBinaryProvider.resolve: a tampered cached binary is refused and never re-downloaded", async () => {
  await withTempDir(async (dataDir) => {
    const fx = await fixture();
    const { path } = await provider(dataDir, fx).resolve();
    await Deno.writeFile(path, encoder.encode("swapped"));

    const served = servingFetch(fx.archive);
    const error = await assertRejects(
      () => provider(dataDir, fx, { fetch: served.fetch }).resolve(),
      LitestreamIntegrityError,
    );
    assertStringIncludes(error.message, "not the pinned");
    assertStringIncludes(
      error.message,
      `Delete the directory ${join(dataDir, "litestream", "0.5.17")}`,
    );
    assertEquals(served.calls, []);
    assertEquals(await Deno.readFile(path), encoder.encode("swapped"));
  });
});

Deno.test("LitestreamBinaryProvider.resolve: a version dir whose binary was deleted is refused without a download", async () => {
  await withTempDir(async (dataDir) => {
    const fx = await fixture();
    const { path } = await provider(dataDir, fx).resolve();
    await Deno.remove(path);

    const served = servingFetch(fx.archive);
    await assertRejects(
      () => provider(dataDir, fx, { fetch: served.fetch }).resolve(),
      LitestreamIntegrityError,
      "has no litestream",
    );
    assertEquals(served.calls, []);
  });
});

Deno.test("LitestreamBinaryProvider.resolve: the override is honoured when it hashes to the pin", async () => {
  await withTempDir(async (dataDir) => {
    const fx = await fixture();
    const overridePath = join(dataDir, "my-litestream");
    await Deno.writeFile(overridePath, BINARY);
    const served = servingFetch(fx.archive);

    const resolved = await provider(dataDir, fx, {
      overridePath,
      fetch: served.fetch,
    }).resolve();
    assertEquals(resolved, {
      path: overridePath,
      version: "0.5.17",
      source: "override",
    });
    assertEquals(served.calls, []);
    assertEquals(
      await denoLitestreamFs.exists(join(dataDir, "litestream")),
      false,
    );
  });
});

Deno.test("LitestreamBinaryProvider.resolve: an override that does not hash to the pin is refused", async () => {
  await withTempDir(async (dataDir) => {
    const fx = await fixture();
    const overridePath = join(dataDir, "my-litestream");
    await Deno.writeFile(overridePath, encoder.encode("some other build"));
    const served = servingFetch(fx.archive);

    const error = await assertRejects(
      () =>
        provider(dataDir, fx, { overridePath, fetch: served.fetch }).resolve(),
      LitestreamIntegrityError,
    );
    assertStringIncludes(error.message, LITESTREAM_PATH_ENV);
    assertStringIncludes(
      error.message,
      fx.pin.digests("linux-x86_64").binarySha256,
    );
    assertEquals(served.calls, []);
  });
});

Deno.test("LitestreamBinaryProvider.resolve: an override that does not exist is refused", async () => {
  await withTempDir(async (dataDir) => {
    const fx = await fixture();
    await assertRejects(
      () =>
        provider(dataDir, fx, { overridePath: join(dataDir, "missing") })
          .resolve(),
      LitestreamUnavailableError,
      "does not exist",
    );
  });
});

Deno.test("LitestreamBinaryProvider.resolve: offline, the error says exactly what to download and where to put it", async () => {
  await withTempDir(async (dataDir) => {
    const fx = await fixture();
    const digests = fx.pin.digests("linux-x86_64");
    const error = await assertRejects(
      () =>
        provider(dataDir, fx, {
          fetch: () => Promise.reject(new TypeError("dns error")),
        }).resolve(),
      LitestreamUnavailableError,
    );
    assertStringIncludes(error.message, "network error: dns error");
    assertStringIncludes(error.message, fx.url);
    assertStringIncludes(error.message, digests.archiveSha256);
    assertStringIncludes(error.message, digests.binarySha256);
    assertStringIncludes(
      error.message,
      join(dataDir, "litestream", "0.5.17", "litestream"),
    );
    assertStringIncludes(error.message, LITESTREAM_PATH_ENV);
  });
});

Deno.test("LitestreamBinaryProvider.resolve: an HTTP error and a timeout are reported as distinct causes", async () => {
  await withTempDir(async (dataDir) => {
    const fx = await fixture();
    await assertRejects(
      () =>
        provider(dataDir, fx, { fetch: servingFetch(fx.archive, 404).fetch })
          .resolve(),
      LitestreamUnavailableError,
      "(HTTP 404)",
    );
    await assertRejects(
      () =>
        provider(dataDir, fx, {
          downloadTimeoutMs: 1,
          fetch: (_url, init) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => reject(init.signal?.reason),
              );
            }),
        }).resolve(),
      LitestreamUnavailableError,
      "timed out after",
    );
  });
});

Deno.test("LitestreamBinaryProvider.resolve: a response larger than the cap is aborted", async () => {
  await withTempDir(async (dataDir) => {
    const fx = await fixture();
    await assertRejects(
      () =>
        provider(dataDir, fx, { maxDownloadBytes: fx.archive.byteLength - 1 })
          .resolve(),
      LitestreamUnavailableError,
      `exceeded ${fx.archive.byteLength - 1} bytes`,
    );
    assertEquals(await listNames(dataDir), []);
  });
});

Deno.test("LitestreamBinaryProvider.resolve: concurrent first use settles on one verified binary", async () => {
  await withTempDir(async (dataDir) => {
    const fx = await fixture();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => provider(dataDir, fx).resolve()),
    );
    const path = join(dataDir, "litestream", "0.5.17", "litestream");
    for (const result of results) assertEquals(result.path, path);
    assertEquals(await Deno.readFile(path), BINARY);
    assertEquals(await listNames(join(dataDir, "litestream")), ["0.5.17"]);
  });
});

Deno.test("LitestreamBinaryProvider.resolve: losing the rename race hashes the winner's binary and removes its own staging", async () => {
  await withTempDir(async (dataDir) => {
    const fx = await fixture();
    // Another process installs the version just before this one renames.
    const fs: LitestreamFs = {
      ...denoLitestreamFs,
      async rename(from, to) {
        if (to === join(dataDir, "litestream", "0.5.17")) {
          await Deno.mkdir(to);
          await Deno.writeFile(join(to, "litestream"), BINARY);
        }
        await denoLitestreamFs.rename(from, to);
      },
    };
    const resolved = await provider(dataDir, fx, { fs }).resolve();
    assertEquals(resolved.source, "cache");
    assertEquals(await listNames(join(dataDir, "litestream")), ["0.5.17"]);
  });
});

Deno.test("LitestreamBinaryProvider.resolve: losing the race to a bad binary is still refused", async () => {
  await withTempDir(async (dataDir) => {
    const fx = await fixture();
    const fs: LitestreamFs = {
      ...denoLitestreamFs,
      async rename(from, to) {
        if (to === join(dataDir, "litestream", "0.5.17")) {
          await Deno.mkdir(to);
          await Deno.writeFile(join(to, "litestream"), encoder.encode("bad"));
        }
        await denoLitestreamFs.rename(from, to);
      },
    };
    await assertRejects(
      () => provider(dataDir, fx, { fs }).resolve(),
      LitestreamIntegrityError,
    );
  });
});

Deno.test("LitestreamBinaryProvider.resolve: a rename failure with no winner surfaces", async () => {
  await withTempDir(async (dataDir) => {
    const fx = await fixture();
    const fs: LitestreamFs = {
      ...denoLitestreamFs,
      rename(from, to) {
        if (to === join(dataDir, "litestream", "0.5.17")) {
          return Promise.reject(new Deno.errors.PermissionDenied("denied"));
        }
        return denoLitestreamFs.rename(from, to);
      },
    };
    await assertRejects(
      () => provider(dataDir, fx, { fs }).resolve(),
      Deno.errors.PermissionDenied,
    );
    assertEquals(await listNames(join(dataDir, "litestream")), []);
  });
});

Deno.test("LitestreamBinaryProvider.resolve: two pinned versions coexist in their own directories", async () => {
  await withTempDir(async (dataDir) => {
    const older = await fixture("0.5.17");
    const newer = await fixture("0.5.18", encoder.encode("newer binary"));
    const a = await provider(dataDir, older).resolve();
    const b = await provider(dataDir, newer).resolve();
    assert(a.path !== b.path);
    assertEquals(await listNames(join(dataDir, "litestream")), [
      "0.5.17",
      "0.5.18",
    ]);
    assertEquals((await provider(dataDir, older).resolve()).source, "cache");
  });
});

Deno.test("LitestreamBinaryProvider.resolve: abandoned staging dirs are swept and young ones kept", async () => {
  await withTempDir(async (dataDir) => {
    const fx = await fixture();
    const root = join(dataDir, "litestream");
    await Deno.mkdir(join(root, ".tmp-0.5.17-old"), { recursive: true });
    await Deno.mkdir(join(root, ".tmp-0.5.17-young"));
    const old = new Date(Date.now() - ABANDONED_STAGING_MAX_AGE_MS - 60_000);
    await Deno.utime(join(root, ".tmp-0.5.17-old"), old, old);

    await provider(dataDir, fx).resolve();
    assertEquals(await listNames(root), [".tmp-0.5.17-young", "0.5.17"]);
  });
});

Deno.test("LitestreamBinaryProvider.resolve: Windows below 0.5.18 is unavailable before any download or filesystem access", async () => {
  await withTempDir(async (dataDir) => {
    const fx = await fixture("0.5.17");
    const served = servingFetch(fx.archive);
    await assertRejects(
      () =>
        provider(dataDir, fx, {
          os: "windows",
          arch: "x86_64",
          fetch: served.fetch,
        }).resolve(),
      LitestreamUnavailableError,
      "litestream#1542",
    );
    assertEquals(served.calls, []);
    assertEquals(await listNames(dataDir), []);
  });
});

Deno.test("LitestreamBinaryProvider.resolve: an unshipped platform is unavailable", async () => {
  await withTempDir(async (dataDir) => {
    const fx = await fixture();
    await assertRejects(
      () => provider(dataDir, fx, { os: "windows", arch: "aarch64" }).resolve(),
      LitestreamUnavailableError,
      "windows/aarch64",
    );
  });
});

Deno.test("modificationTimeMs: a path removed by another process reads as gone, not an error", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, ".tmp-0.5.17-other");
    await Deno.mkdir(path);
    assert((await modificationTimeMs(path)) !== undefined);
    await Deno.remove(path);
    assertEquals(await modificationTimeMs(path), undefined);
  });
});

Deno.test("denoLitestreamFs.listDirs: lists only directories with the prefix", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(join(dir, ".tmp-0.5.17-a"));
    await Deno.mkdir(join(dir, "0.5.17"));
    await Deno.writeFile(join(dir, ".tmp-file"), BINARY);
    const names = (await denoLitestreamFs.listDirs(dir, ".tmp-")).map((d) =>
      d.name
    );
    assertEquals(names, [".tmp-0.5.17-a"]);
  });
});
