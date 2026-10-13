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

// Unit tests for the pure helpers in refresh_litestream_pin.ts, plus one
// opt-in network test that checks the checked-in pin against upstream.

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  LITESTREAM_TARGETS,
  LitestreamPin,
  type LitestreamTarget,
  type LitestreamTargetDigests,
} from "../src/domain/datastore_v3/litestream_release.ts";
import { LITESTREAM_PIN } from "../src/infrastructure/datastore_v3/litestream/litestream_pin.ts";
import {
  DOCKERFILE,
  findDrift,
  parseChecksumsTxt,
  PIN_FILE,
  pinnedVersionOf,
  renderPinFile,
  rewriteDockerfilePins,
} from "./refresh_litestream_pin.ts";

function digestsOf(
  pin: LitestreamPin,
): Record<LitestreamTarget, LitestreamTargetDigests> {
  return Object.fromEntries(
    LITESTREAM_TARGETS.map((target) => [target, pin.digests(target)]),
  ) as Record<LitestreamTarget, LitestreamTargetDigests>;
}

Deno.test("parseChecksumsTxt: reads upstream's sha256sum format", () => {
  const sums = parseChecksumsTxt(
    `${"a".repeat(64)}  litestream-0.5.17-linux-x86_64.tar.gz\n` +
      `${"b".repeat(64)} *litestream-0.5.17-windows-x86_64.zip\n\n`,
  );
  assertEquals(sums.get("litestream-0.5.17-linux-x86_64.tar.gz"), "a".repeat(64));
  assertEquals(sums.get("litestream-0.5.17-windows-x86_64.zip"), "b".repeat(64));
});

Deno.test("parseChecksumsTxt: refuses a line it does not understand", () => {
  assertThrows(() => parseChecksumsTxt("not a checksum line"), Error, "Unrecognised");
});

Deno.test("renderPinFile: reproduces the checked-in pin file byte for byte", async () => {
  assertEquals(
    renderPinFile(LITESTREAM_PIN.version, digestsOf(LITESTREAM_PIN)),
    await Deno.readTextFile(PIN_FILE),
  );
});

Deno.test("pinnedVersionOf: reads the version from the checked-in pin file", async () => {
  assertEquals(
    pinnedVersionOf(await Deno.readTextFile(PIN_FILE)),
    LITESTREAM_PIN.version,
  );
});

Deno.test("rewriteDockerfilePins: the checked-in Dockerfile already matches the pin", async () => {
  const dockerfile = await Deno.readTextFile(DOCKERFILE);
  assertEquals(
    rewriteDockerfilePins(
      dockerfile,
      LITESTREAM_PIN.version,
      digestsOf(LITESTREAM_PIN),
    ),
    dockerfile,
  );
});

Deno.test("rewriteDockerfilePins: rewrites both linux stages to a new version", async () => {
  const dockerfile = await Deno.readTextFile(DOCKERFILE);
  const digests = Object.fromEntries(
    LITESTREAM_TARGETS.map((target) => [target, {
      archiveSha256: "c".repeat(64),
      binarySha256: "d".repeat(64),
    }]),
  ) as Record<LitestreamTarget, LitestreamTargetDigests>;
  const rewritten = rewriteDockerfilePins(dockerfile, "0.6.0", digests);
  assertStringIncludes(
    rewritten,
    `ADD --checksum=sha256:${"c".repeat(64)} https://github.com/benbjohnson/litestream/releases/download/v0.6.0/litestream-0.6.0-linux-x86_64.tar.gz /litestream.tar.gz`,
  );
  assertStringIncludes(rewritten, "litestream-0.6.0-linux-arm64.tar.gz");
  assertEquals(rewritten.includes("0.5.17"), false);
});

Deno.test("rewriteDockerfilePins: refuses a Dockerfile missing a stage", () => {
  assertThrows(
    () =>
      rewriteDockerfilePins(
        "FROM denoland/deno:2.9.7\n",
        "0.5.17",
        digestsOf(LITESTREAM_PIN),
      ),
    Error,
    "litestream-amd64",
  );
});

Deno.test({
  name:
    "refresh_litestream_pin --check: the pin matches upstream's release (network, opt-in)",
  ignore: Deno.env.get("SWAMP_LITESTREAM_NETWORK_TEST") === undefined,
  async fn() {
    assertEquals(await findDrift(LITESTREAM_PIN.version), []);
  },
});
