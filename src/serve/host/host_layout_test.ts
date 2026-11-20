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

const CWD = resolve("cwd");
const CONFIG_DIR = resolve("config-dir");
const DATA_DIR = resolve("data-dir");

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

const dirs = { cwd: CWD, configDir: CONFIG_DIR, dataDir: DATA_DIR };

const samePath = (path: string) => Promise.resolve(path);

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

function locate(
  input: Parameters<typeof locateHostYaml>[0],
  read: Parameters<typeof locateHostYaml>[1],
  realPath: (path: string) => Promise<string> = samePath,
  create: HostYamlCreator = neverCreate,
) {
  return locateHostYaml(input, read, realPath, create);
}

Deno.test("locateHostYaml: --host-dir names the host folder, whose workspaces/ is the state folder", async () => {
  const hostDir = resolve("srv", "host");
  const { read, asked } = readerOf({
    [join(hostDir, "host.yaml")]: "address: http://a\n",
    [join(CONFIG_DIR, "host.yaml")]: "address: http://other\n",
  });
  const { layout, text } = await locate(
    { ...dirs, hostDir },
    read,
  );
  assertEquals(text, "address: http://a\n");
  assertPathEquals(layout.hostFolder!, hostDir);
  assertPathEquals(layout.baseDir, hostDir);
  assertPathEquals(layout.stateDir, join(hostDir, "workspaces"));
  assertEquals(asked.length, 1);
});

Deno.test("locateHostYaml: a relative --host-dir is taken from the current folder", async () => {
  const { read } = readerOf({
    [join(CWD, "host", "host.yaml")]: "address: http://a\n",
  });
  const { layout } = await locate({ ...dirs, hostDir: "host" }, read);
  assertPathEquals(layout.hostFolder!, join(CWD, "host"));
});

Deno.test("locateHostYaml: --host-dir without a host.yaml does not fall back to the config dir nor create one", async () => {
  const hostDir = resolve("srv", "host");
  const { read } = readerOf({
    [join(CONFIG_DIR, "host.yaml")]: "address: http://other\n",
  });
  const { create, asked } = creatorOf("address: http://made\n");
  const error = await assertRejects(
    () => locate({ ...dirs, hostDir }, read, samePath, create),
    UserError,
  );
  assertStringIncludes(error.message, join(hostDir, "host.yaml"));
  assertEquals(error.message.includes(CONFIG_DIR), false);
  assertEquals(asked, []);
});

Deno.test("locateHostYaml: a host.yaml in the current folder is used over the config dir's", async () => {
  const { read } = readerOf({
    [join(CWD, "host.yaml")]: "address: http://here\n",
    [join(CONFIG_DIR, "host.yaml")]: "address: http://other\n",
  });
  const { layout, text } = await locate(dirs, read);
  assertEquals(text, "address: http://here\n");
  assertPathEquals(layout.hostFolder!, CWD);
  assertPathEquals(layout.stateDir, join(CWD, "workspaces"));
});

Deno.test("locateHostYaml: with neither --host-dir nor a host.yaml here, the config dir's is read and the state folder is under the data dir", async () => {
  const { read } = readerOf({
    [join(CONFIG_DIR, "host.yaml")]: "address: http://a\n",
  });
  const { layout, text } = await locate(dirs, read);
  assertEquals(text, "address: http://a\n");
  assertEquals(layout.hostFolder, null);
  assertPathEquals(layout.configFile, join(CONFIG_DIR, "host.yaml"));
  assertPathEquals(layout.baseDir, CONFIG_DIR);
  assertPathEquals(layout.stateDir, join(DATA_DIR, "host"));
});

Deno.test("locateHostYaml: with no host.yaml anywhere, the config dir's is created and run with no host folder", async () => {
  const { read } = readerOf({});
  const { create, asked } = creatorOf("address: http://made\n");
  const { layout, text, created } = await locate(dirs, read, samePath, create);
  assertEquals(asked.length, 1);
  assertPathEquals(asked[0], join(CONFIG_DIR, "host.yaml"));
  assertEquals(text, "address: http://made\n");
  assertEquals(created, true);
  assertEquals(layout.hostFolder, null);
  assertPathEquals(layout.configFile, join(CONFIG_DIR, "host.yaml"));
  assertPathEquals(layout.stateDir, join(DATA_DIR, "host"));
});

Deno.test("locateHostYaml: a host.yaml another host created first is reported as not created by this one", async () => {
  const { read } = readerOf({});
  const { create } = creatorOf("address: http://theirs\n", false);
  const { text, created } = await locate(dirs, read, samePath, create);
  assertEquals(text, "address: http://theirs\n");
  assertEquals(created, false);
});

Deno.test("locateHostYaml: started from inside the config dir with no host.yaml, creates it there with no host folder", async () => {
  const { read } = readerOf({});
  const { create, asked } = creatorOf("address: http://made\n");
  const { layout } = await locate(
    { ...dirs, cwd: CONFIG_DIR },
    read,
    samePath,
    create,
  );
  assertEquals(asked.length, 1);
  assertPathEquals(asked[0], join(CONFIG_DIR, "host.yaml"));
  assertEquals(layout.hostFolder, null);
});

Deno.test("locateHostYaml: an invalid host.yaml found is returned as it is and nothing is created", async () => {
  const { read } = readerOf({
    [join(CONFIG_DIR, "host.yaml")]: "not: [valid\n",
  });
  const { text, created } = await locate(dirs, read);
  assertEquals(text, "not: [valid\n");
  assertEquals(created, false);
});

Deno.test("locateHostYaml: an unreadable host.yaml here stops the search rather than running the config dir's", async () => {
  const { read, asked } = readerOf({
    [join(CWD, "host.yaml")]: new Deno.errors.PermissionDenied("denied"),
    [join(CONFIG_DIR, "host.yaml")]: "address: http://other\n",
  });
  const error = await assertRejects(
    () => locate(dirs, read),
    UserError,
  );
  assertStringIncludes(error.message, `Cannot read ${join(CWD, "host.yaml")}`);
  assertStringIncludes(error.message, "denied");
  assertEquals(asked, [join(CWD, "host.yaml")]);
});

Deno.test("locateHostYaml: started from inside the config dir, its host.yaml runs with no host folder, never as a host folder", async () => {
  const { read, asked } = readerOf({
    [join(CONFIG_DIR, "host.yaml")]: "address: http://a\n",
  });
  const { layout } = await locate(
    { ...dirs, cwd: CONFIG_DIR },
    read,
    (path) => Promise.resolve(path),
  );
  assertEquals(layout.hostFolder, null);
  assertPathEquals(layout.stateDir, join(DATA_DIR, "host"));
  assertEquals(asked, [join(CONFIG_DIR, "host.yaml")]);
});

Deno.test("locateHostYaml: a current folder that is the config dir by another spelling is still not a host folder", async () => {
  const linked = resolve("linked-config");
  const { read } = readerOf({
    [join(linked, "host.yaml")]: "address: http://a\n",
    [join(CONFIG_DIR, "host.yaml")]: "address: http://a\n",
  });
  const { layout } = await locate(
    { ...dirs, cwd: linked },
    read,
    (path) => Promise.resolve(path === linked ? CONFIG_DIR : path),
  );
  assertEquals(layout.hostFolder, null);
  assertPathEquals(layout.stateDir, join(DATA_DIR, "host"));
});

Deno.test("locateHostYaml: --host-dir naming the config dir is taken as asked, a host folder", async () => {
  const { read } = readerOf({
    [join(CONFIG_DIR, "host.yaml")]: "address: http://a\n",
  });
  const { layout } = await locate(
    { ...dirs, cwd: CONFIG_DIR, hostDir: CONFIG_DIR },
    read,
    (path) => Promise.resolve(path),
  );
  assertPathEquals(layout.hostFolder!, CONFIG_DIR);
});
