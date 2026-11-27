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
import type { MergedServeOptions } from "../../serve/serve_config.ts";
import {
  FingerprintFactsCache,
  type ServeFingerprintSources,
  type StaticFingerprintFacts,
} from "./serve_federation_fingerprint.ts";

const FACTS: StaticFingerprintFacts = {
  datastore: {} as StaticFingerprintFacts["datastore"],
  vaultTypes: [],
  extensions: [],
};

Deno.test("FingerprintFactsCache: reads once, and again after a settings reload or a lockfile change", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const lockfilePath = join(dir, "upstream_extensions.json");
    await Deno.writeTextFile(lockfilePath, "{}");
    let settings = {} as MergedServeOptions;
    const sources = {
      lockfilePath,
      settings: () => settings,
    } as ServeFingerprintSources;
    const cache = new FingerprintFactsCache();
    let reads = 0;
    const read = () => {
      reads++;
      return Promise.resolve(FACTS);
    };
    await cache.facts(sources, read);
    await cache.facts(sources, read);
    assertEquals(reads, 1);
    settings = {} as MergedServeOptions;
    await cache.facts(sources, read);
    assertEquals(reads, 2);
    const later = new Date(Date.now() + 60_000);
    await Deno.utime(lockfilePath, later, later);
    await cache.facts(sources, read);
    await cache.facts(sources, read);
    assertEquals(reads, 3);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("FingerprintFactsCache: a failed read is not kept", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const sources = {
      lockfilePath: join(dir, "missing.json"),
      settings: () => ({}) as MergedServeOptions,
    } as ServeFingerprintSources;
    const cache = new FingerprintFactsCache();
    await assertRejects(() =>
      cache.facts(sources, () => Promise.reject(new Error("down")))
    );
    assertEquals(
      await cache.facts(sources, () => Promise.resolve(FACTS)),
      FACTS,
    );
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
