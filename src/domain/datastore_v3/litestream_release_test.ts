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

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  compareLitestreamVersions,
  LITESTREAM_TARGETS,
  litestreamArchiveName,
  litestreamArchiveUrl,
  litestreamAvailability,
  litestreamBinaryName,
  LitestreamPin,
  type LitestreamPinData,
  type LitestreamTarget,
  type LitestreamTargetDigests,
  litestreamTargetFor,
} from "./litestream_release.ts";

const DIGESTS: LitestreamTargetDigests = {
  archiveSha256: "a".repeat(64),
  binarySha256: "b".repeat(64),
};

function pinData(version: string): LitestreamPinData {
  const targets = Object.fromEntries(
    LITESTREAM_TARGETS.map((target) => [target, DIGESTS]),
  ) as Record<LitestreamTarget, LitestreamTargetDigests>;
  return { version, targets };
}

Deno.test("litestreamTargetFor: maps Deno.build names to upstream asset names", () => {
  assertEquals(litestreamTargetFor("darwin", "aarch64"), "darwin-arm64");
  assertEquals(litestreamTargetFor("darwin", "x86_64"), "darwin-x86_64");
  assertEquals(litestreamTargetFor("linux", "aarch64"), "linux-arm64");
  assertEquals(litestreamTargetFor("linux", "x86_64"), "linux-x86_64");
  assertEquals(litestreamTargetFor("windows", "x86_64"), "windows-x86_64");
});

Deno.test("litestreamTargetFor: is undefined for a platform swamp ships no Litestream for", () => {
  assertEquals(litestreamTargetFor("windows", "aarch64"), undefined);
  assertEquals(litestreamTargetFor("freebsd", "x86_64"), undefined);
});

Deno.test("litestreamArchiveName: tar.gz everywhere but Windows, which is zip", () => {
  assertEquals(
    litestreamArchiveName("0.5.17", "linux-x86_64"),
    "litestream-0.5.17-linux-x86_64.tar.gz",
  );
  assertEquals(
    litestreamArchiveName("0.5.17", "windows-x86_64"),
    "litestream-0.5.17-windows-x86_64.zip",
  );
});

Deno.test("litestreamArchiveUrl: points at upstream's GitHub release for the version", () => {
  assertEquals(
    litestreamArchiveUrl("0.5.17", "darwin-arm64"),
    "https://github.com/benbjohnson/litestream/releases/download/v0.5.17/litestream-0.5.17-darwin-arm64.tar.gz",
  );
});

Deno.test("litestreamBinaryName: adds .exe on Windows only", () => {
  assertEquals(litestreamBinaryName("linux-arm64"), "litestream");
  assertEquals(litestreamBinaryName("windows-x86_64"), "litestream.exe");
});

Deno.test("compareLitestreamVersions: compares numerically, not lexically", () => {
  assert(compareLitestreamVersions("0.5.9", "0.5.18") < 0);
  assert(compareLitestreamVersions("0.5.18", "0.5.17") > 0);
  assert(compareLitestreamVersions("1.0.0", "0.9.99") > 0);
  assertEquals(compareLitestreamVersions("0.5.18", "0.5.18"), 0);
});

Deno.test("LitestreamPin.from: accepts a complete pin", () => {
  const pin = LitestreamPin.from(pinData("0.5.17"));
  assertEquals(pin.version, "0.5.17");
  assertEquals(pin.digests("linux-x86_64"), DIGESTS);
});

Deno.test("LitestreamPin.from: refuses a malformed version", () => {
  assertThrows(() => LitestreamPin.from(pinData("v0.5.17")), Error, "version");
  assertThrows(() => LitestreamPin.from(pinData("0.5")), Error, "version");
});

Deno.test("LitestreamPin.from: refuses a missing target", () => {
  const data = pinData("0.5.17");
  const targets: Partial<Record<LitestreamTarget, LitestreamTargetDigests>> = {
    ...data.targets,
  };
  delete targets["windows-x86_64"];
  assertThrows(
    () =>
      LitestreamPin.from({
        version: "0.5.17",
        targets: targets as Record<LitestreamTarget, LitestreamTargetDigests>,
      }),
    Error,
    "no digests for windows-x86_64",
  );
});

Deno.test("LitestreamPin.from: refuses a digest that is not lowercase hex SHA-256", () => {
  for (const bad of ["A".repeat(64), "a".repeat(63), "g".repeat(64)]) {
    const data = pinData("0.5.17");
    assertThrows(
      () =>
        LitestreamPin.from({
          version: data.version,
          targets: {
            ...data.targets,
            "linux-arm64": { ...DIGESTS, binarySha256: bad },
          },
        }),
      Error,
      "linux-arm64 binarySha256",
    );
  }
});

Deno.test("litestreamAvailability: available on macOS and Linux at any pinned version", () => {
  const pin = LitestreamPin.from(pinData("0.5.17"));
  for (
    const [os, arch] of [
      ["darwin", "aarch64"],
      ["darwin", "x86_64"],
      ["linux", "aarch64"],
      ["linux", "x86_64"],
    ]
  ) {
    const availability = litestreamAvailability(pin, os, arch);
    assert(availability.available, `${os}/${arch}`);
  }
});

Deno.test("litestreamAvailability: Windows below 0.5.18 is unavailable and names litestream#1542", () => {
  const availability = litestreamAvailability(
    LitestreamPin.from(pinData("0.5.17")),
    "windows",
    "x86_64",
  );
  assert(!availability.available);
  assert(availability.reason.includes("litestream#1542"));
  assert(availability.reason.includes("not available on Windows yet"));
});

Deno.test("litestreamAvailability: Windows at 0.5.18 or later is available", () => {
  for (const version of ["0.5.18", "0.6.0"]) {
    const availability = litestreamAvailability(
      LitestreamPin.from(pinData(version)),
      "windows",
      "x86_64",
    );
    assertEquals(availability, {
      available: true,
      target: "windows-x86_64",
    });
  }
});

Deno.test("litestreamAvailability: an unshipped platform is unavailable", () => {
  const availability = litestreamAvailability(
    LitestreamPin.from(pinData("0.5.18")),
    "windows",
    "aarch64",
  );
  assert(!availability.available);
  assert(availability.reason.includes("windows/aarch64"));
});
