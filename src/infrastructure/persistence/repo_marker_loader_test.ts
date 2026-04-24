// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals, assertStrictEquals } from "@std/assert";
import { createRepoMarkerLoader } from "./repo_marker_loader.ts";
import type {
  RepoMarkerData,
  RepoMarkerRepository,
} from "./repo_marker_repository.ts";

const sampleMarker: RepoMarkerData = {
  swampVersion: "1.0.0",
  initializedAt: "2024-01-15T10:30:00.000Z",
  defaultDriver: "docker",
};

function createLatchedRepo(): {
  repo: RepoMarkerRepository;
  readCount: () => number;
  release: (value: RepoMarkerData | null) => void;
} {
  const deferred = Promise.withResolvers<RepoMarkerData | null>();
  let count = 0;
  const repo = {
    read: () => {
      count++;
      return deferred.promise;
    },
  } as unknown as RepoMarkerRepository;
  return {
    repo,
    readCount: () => count,
    release: (value) => deferred.resolve(value),
  };
}

Deno.test("createRepoMarkerLoader: concurrent calls share one in-flight read", async () => {
  const { repo, readCount, release } = createLatchedRepo();
  const load = createRepoMarkerLoader(repo, "/fake/repo");

  const first = load();
  const second = load();
  release(sampleMarker);

  const [a, b] = await Promise.all([first, second]);
  assertEquals(readCount(), 1);
  assertStrictEquals(a, b);
  assertEquals(a, sampleMarker);
});

Deno.test("createRepoMarkerLoader: resolved value is cached for later callers", async () => {
  const { repo, readCount, release } = createLatchedRepo();
  const load = createRepoMarkerLoader(repo, "/fake/repo");

  release(sampleMarker);
  const first = await load();
  const second = await load();

  assertEquals(readCount(), 1);
  assertEquals(first, sampleMarker);
  assertEquals(second, sampleMarker);
});

Deno.test("createRepoMarkerLoader: null result is cached (file absent)", async () => {
  const { repo, readCount, release } = createLatchedRepo();
  const load = createRepoMarkerLoader(repo, "/fake/repo");

  release(null);
  assertEquals(await load(), null);
  assertEquals(await load(), null);
  assertEquals(readCount(), 1);
});
