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
import { join, resolve } from "@std/path";
import { UserError } from "../../domain/errors.ts";
import { assertPathEquals } from "../../infrastructure/persistence/path_test_helpers.ts";
import { type HostYamlCreator, locateHostYaml } from "./host_layout.ts";

const CONFIG_DIR = resolve("config-dir");
const DATA_DIR = resolve("data-dir");
const FILE = join(CONFIG_DIR, "host.yaml");

function readerOf(files: Record<string, string | Error>) {
  const asked: string[] = [];
  const read = (path: string): Promise<string | null> => {
    asked.push(path);
    const found = files[path];
    if (found instanceof Error) return Promise.reject(found);
    return Promise.resolve(found ?? null);
  };
  return { read, asked };
}

const neverCreate: HostYamlCreator = (path) =>
  Promise.reject(new Error(`unexpected create of ${path}`));

function creatorOf(text: string, created = true) {
  const asked: string[] = [];
  const create: HostYamlCreator = (path) => {
    asked.push(path);
    return Promise.resolve({ text, created });
  };
  return { create, asked };
}

const dirs = { configDir: CONFIG_DIR, dataDir: DATA_DIR };

Deno.test("locateHostYaml: reads the config dir's host.yaml, takes relative paths from the config dir and keeps state under the data dir", async () => {
  const { read, asked } = readerOf({ [FILE]: "address: http://a\n" });
  const { layout, text, created } = await locateHostYaml(
    dirs,
    read,
    neverCreate,
  );
  assertEquals(text, "address: http://a\n");
  assertEquals(created, false);
  assertPathEquals(layout.configFile, FILE);
  assertPathEquals(layout.baseDir, CONFIG_DIR);
  assertPathEquals(layout.stateDir, join(DATA_DIR, "host"));
  assertEquals(asked, [FILE]);
});

Deno.test("locateHostYaml: with no host.yaml in the config dir, creates it there and runs from it", async () => {
  const { read } = readerOf({});
  const { create, asked } = creatorOf("address: http://made\n");
  const { layout, text, created } = await locateHostYaml(dirs, read, create);
  assertEquals(asked, [FILE]);
  assertEquals(text, "address: http://made\n");
  assertEquals(created, true);
  assertPathEquals(layout.stateDir, join(DATA_DIR, "host"));
});

Deno.test("locateHostYaml: a host.yaml another host created first is reported as not created by this one", async () => {
  const { read } = readerOf({});
  const { create } = creatorOf("address: http://theirs\n", false);
  const { text, created } = await locateHostYaml(dirs, read, create);
  assertEquals(text, "address: http://theirs\n");
  assertEquals(created, false);
});

Deno.test("locateHostYaml: an invalid host.yaml found is returned as it is and nothing is created", async () => {
  const { read } = readerOf({ [FILE]: "not: [valid\n" });
  const { text, created } = await locateHostYaml(dirs, read, neverCreate);
  assertEquals(text, "not: [valid\n");
  assertEquals(created, false);
});

Deno.test("locateHostYaml: an unreadable host.yaml is refused naming it, and nothing is created", async () => {
  const { read } = readerOf({
    [FILE]: new Deno.errors.PermissionDenied("Permission denied"),
  });
  const error = await assertRejects(
    () => locateHostYaml(dirs, read, neverCreate),
    UserError,
  );
  assertStringIncludes(error.message, `Cannot read ${FILE}`);
});
