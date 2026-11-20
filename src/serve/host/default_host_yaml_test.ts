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
import { join } from "@std/path";
import { UserError } from "../../domain/errors.ts";
import {
  createDefaultHostYaml,
  DEFAULT_HOST_YAML,
} from "./default_host_yaml.ts";
import { HostConfig } from "./host_config.ts";
import { noHostFolderLayout } from "./host_layout.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

async function entries(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  return names.sort();
}

Deno.test("DEFAULT_HOST_YAML: parses to a loopback host on 8080 whose address is its own listener", () => {
  const config = HostConfig.parse(
    DEFAULT_HOST_YAML,
    noHostFolderLayout({ configDir: "config", dataDir: "data" }),
  );
  assertEquals(config.listen.host, "127.0.0.1");
  assertEquals(config.listen.port, 8080);
  assertEquals(config.listen.certFile, null);
  assertEquals(config.address, "http://127.0.0.1:8080");
  assertEquals(config.root, null);
  assertEquals(config.trustProxy, false);
  assertEquals(config.allowUnauthenticatedBehindProxy, false);
  assertEquals(config.oauthClient, null);
  assertEquals(config.offLoopback, false);
});

Deno.test("DEFAULT_HOST_YAML: names every key it leaves unset in a comment", () => {
  const commented = DEFAULT_HOST_YAML.split("\n")
    .filter((line) => line.trimStart().startsWith("#"))
    .join("\n");
  for (
    const key of [
      "cert-file:",
      "key-file:",
      "root:",
      "trust-proxy:",
      "allow-unauthenticated-behind-proxy:",
      "oauth-client:",
      "id:",
      "secret-file:",
    ]
  ) {
    assertStringIncludes(commented, key);
  }
});

Deno.test("createDefaultHostYaml: creates a missing folder and writes the defaults, leaving no temp file", async () => {
  await withTempDir(async (dir) => {
    const configDir = join(dir, "nested", "config");
    const path = join(configDir, "host.yaml");
    const result = await createDefaultHostYaml(path);
    assertEquals(result, { text: DEFAULT_HOST_YAML, created: true });
    assertEquals(await Deno.readTextFile(path), DEFAULT_HOST_YAML);
    assertEquals(await entries(configDir), ["host.yaml"]);
  });
});

Deno.test("createDefaultHostYaml: an existing host.yaml, even an invalid one, is read and never replaced", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "host.yaml");
    await Deno.writeTextFile(path, "not: [valid\n");
    const result = await createDefaultHostYaml(path);
    assertEquals(result, { text: "not: [valid\n", created: false });
    assertEquals(await Deno.readTextFile(path), "not: [valid\n");
    assertEquals(await entries(dir), ["host.yaml"]);
  });
});

Deno.test("createDefaultHostYaml: two hosts starting at once create the file once and read the same text", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "host.yaml");
    const results = await Promise.all([
      createDefaultHostYaml(path),
      createDefaultHostYaml(path),
    ]);
    assertEquals(results.filter((result) => result.created).length, 1);
    assertEquals(results.map((result) => result.text), [
      DEFAULT_HOST_YAML,
      DEFAULT_HOST_YAML,
    ]);
    assertEquals(await entries(dir), ["host.yaml"]);
  });
});

Deno.test("createDefaultHostYaml: a filesystem without hard links falls back to an exclusive create", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "host.yaml");
    const result = await createDefaultHostYaml(path, {
      link: () => Promise.reject(new Deno.errors.NotSupported("no links")),
    });
    assertEquals(result, { text: DEFAULT_HOST_YAML, created: true });
    assertEquals(await Deno.readTextFile(path), DEFAULT_HOST_YAML);
    assertEquals(await entries(dir), ["host.yaml"]);
  });
});

Deno.test("createDefaultHostYaml: a file that appears before the link is read, not replaced", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "host.yaml");
    const result = await createDefaultHostYaml(path, {
      link: async () => {
        await Deno.writeTextFile(path, "address: http://theirs\n");
        throw new Deno.errors.AlreadyExists("exists");
      },
    });
    assertEquals(result, { text: "address: http://theirs\n", created: false });
    assertEquals(await entries(dir), ["host.yaml"]);
  });
});

Deno.test("createDefaultHostYaml: something at the path that reads as missing is refused, naming the path", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "host.yaml");
    const error = await assertRejects(
      () =>
        createDefaultHostYaml(path, {
          link: () => Promise.reject(new Deno.errors.AlreadyExists("exists")),
          readTextFile: () => Promise.reject(new Deno.errors.NotFound("gone")),
        }),
      UserError,
    );
    assertStringIncludes(error.message, path);
    assertStringIncludes(error.message, "points nowhere");
    assertEquals(await entries(dir), []);
  });
});

Deno.test({
  name:
    "createDefaultHostYaml: a host.yaml link that points nowhere is refused and left as it is",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "host.yaml");
      await Deno.symlink(join(dir, "missing.yaml"), path, { type: "file" });
      const error = await assertRejects(
        () => createDefaultHostYaml(path),
        UserError,
      );
      assertStringIncludes(error.message, path);
      assertEquals(await entries(dir), ["host.yaml"]);
      assertEquals((await Deno.lstat(path)).isSymlink, true);
    });
  },
});

Deno.test({
  name:
    "createDefaultHostYaml: a folder it cannot write to is refused, naming the path",
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir, "config");
      await Deno.mkdir(configDir, { mode: 0o500 });
      try {
        const path = join(configDir, "host.yaml");
        const error = await assertRejects(
          () => createDefaultHostYaml(path),
          UserError,
        );
        assertStringIncludes(error.message, `Cannot create ${path}`);
      } finally {
        await Deno.chmod(configDir, 0o700);
      }
    });
  },
});
