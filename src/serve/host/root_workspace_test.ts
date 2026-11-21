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
  WorkspaceRegistry,
  type WorkspaceRegistryRepository,
} from "../../domain/workspace/workspace_registry.ts";
import { assertPathEquals } from "../../infrastructure/persistence/path_test_helpers.ts";
import {
  resolveRootWorkspace,
  ROOT_WORKSPACE_NAME,
  ROOT_WORKSPACE_RECORD_FILE,
  type RootWorkspaceCreator,
  SERVE_CONFIG_PATH,
} from "./root_workspace.ts";
import { SERVE_CONFIG_PATH as SERVES_CONFIG_PATH } from "../serve_config.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(await Deno.realPath(tempDir));
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

class MemoryRegistry implements WorkspaceRegistryRepository {
  registry = WorkspaceRegistry.empty();
  unreadable: string | null = null;

  load(): Promise<WorkspaceRegistry | null> {
    if (this.unreadable !== null) {
      return Promise.reject(new Error(this.unreadable));
    }
    return Promise.resolve(this.registry);
  }

  update<T>(change: (registry: WorkspaceRegistry) => T): Promise<T> {
    return Promise.resolve(change(this.registry));
  }
}

interface Fixture {
  readonly stateDir: string;
  readonly location: string;
  readonly registry: MemoryRegistry;
  readonly creates: string[];
  readonly recordFile: string;
}

async function makeRepo(folder: string, repoId: string): Promise<void> {
  await Deno.mkdir(folder, { recursive: true });
  await Deno.writeTextFile(join(folder, ".swamp.yaml"), `repoId: ${repoId}\n`);
}

/** stands in for swamp workspace create: a repo at the location, registered as created */
function creatorFor(
  f: Fixture,
  repoId = "repo-1",
): RootWorkspaceCreator & { fail?: Error } {
  const creator: RootWorkspaceCreator & { fail?: Error } = {
    async create(name) {
      f.creates.push(name);
      if (creator.fail) throw creator.fail;
      await makeRepo(f.location, repoId);
      f.registry.registry.register({
        name,
        path: f.location,
        createdAt: "2026-11-20T00:00:00Z",
        origin: "created",
      });
      return f.location;
    },
  };
  return creator;
}

async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  await withTempDir(async (dir) => {
    const stateDir = join(dir, "data", "host");
    await Deno.mkdir(stateDir, { recursive: true });
    await Deno.mkdir(join(dir, "data", "workspaces"));
    await fn({
      stateDir,
      location: join(dir, "data", "workspaces", ROOT_WORKSPACE_NAME),
      registry: new MemoryRegistry(),
      creates: [],
      recordFile: join(stateDir, ROOT_WORKSPACE_RECORD_FILE),
    });
  });
}

function resolveWith(
  f: Fixture,
  creator: RootWorkspaceCreator = creatorFor(f),
) {
  return resolveRootWorkspace({
    stateDir: f.stateDir,
    store: { registry: f.registry },
    location: () => Promise.resolve(f.location),
    creator,
  });
}

async function refusal(
  f: Fixture,
  creator?: RootWorkspaceCreator,
): Promise<string> {
  const error = await assertRejects(() => resolveWith(f, creator), UserError);
  return error.message;
}

function register(f: Fixture, path: string, origin: "created" | "imported") {
  f.registry.registry.register({
    name: ROOT_WORKSPACE_NAME,
    path,
    createdAt: "2026-11-20T00:00:00Z",
    origin,
  });
}

async function writeRecord(
  f: Fixture,
  folder: string,
  repoId: string | null,
): Promise<void> {
  await Deno.writeTextFile(
    f.recordFile,
    `name: ${ROOT_WORKSPACE_NAME}\nfolder: ${JSON.stringify(folder)}\nrepoId: ${
      repoId ?? "null"
    }\n`,
  );
}

Deno.test("resolveRootWorkspace: the first start creates the root workspace once and records it", async () => {
  await withFixture(async (f) => {
    const first = await resolveWith(f);
    assertEquals(f.creates, [ROOT_WORKSPACE_NAME]);
    assertEquals(first.created, true);
    assertEquals(first.name, ROOT_WORKSPACE_NAME);
    assertPathEquals(first.folder, f.location);
    assertEquals(first.leftFolder, null);
    const record = await Deno.readTextFile(f.recordFile);
    assertStringIncludes(record, "repoId: repo-1");
  });
});

Deno.test("resolveRootWorkspace: a later start finds the root workspace by its record and creates nothing", async () => {
  await withFixture(async (f) => {
    await resolveWith(f);
    const again = await resolveWith(f);
    assertEquals(f.creates, [ROOT_WORKSPACE_NAME]);
    assertEquals(again.created, false);
    assertPathEquals(again.folder, f.location);
  });
});

Deno.test("resolveRootWorkspace: an entry whose folder is gone is reported, never re-created", async () => {
  await withFixture(async (f) => {
    await resolveWith(f);
    await Deno.remove(f.location, { recursive: true });
    const message = await refusal(f);
    assertStringIncludes(message, "that folder is gone");
    assertStringIncludes(message, f.location);
    assertEquals(f.creates, [ROOT_WORKSPACE_NAME]);
  });
});

Deno.test("resolveRootWorkspace: a folder now holding another repo is refused", async () => {
  await withFixture(async (f) => {
    await resolveWith(f);
    await makeRepo(f.location, "someone-elses");
    assertStringIncludes(
      await refusal(f),
      "no longer holds the repo the host made there",
    );
  });
});

Deno.test("resolveRootWorkspace: a folder with no repo marker is refused", async () => {
  await withFixture(async (f) => {
    await resolveWith(f);
    await Deno.remove(join(f.location, ".swamp.yaml"));
    assertStringIncludes(
      await refusal(f),
      "no longer holds the repo the host made there",
    );
  });
});

Deno.test("resolveRootWorkspace: the name registered without a record is not adopted", async () => {
  await withFixture(async (f) => {
    const theirs = join(f.stateDir, "..", "theirs");
    await makeRepo(theirs, "repo-9");
    register(f, theirs, "imported");
    const message = await refusal(f);
    assertStringIncludes(message, "was not made by this host");
    assertStringIncludes(message, `set root: ${theirs}`);
    assertEquals(f.creates, []);
  });
});

Deno.test("resolveRootWorkspace: a record naming another folder than the entry's is not adopted", async () => {
  await withFixture(async (f) => {
    await makeRepo(f.location, "repo-1");
    register(f, f.location, "created");
    await writeRecord(f, join(f.stateDir, "..", "elsewhere"), "repo-1");
    assertStringIncludes(await refusal(f), "was not made by this host");
  });
});

Deno.test("resolveRootWorkspace: a pending record whose create registered is adopted and finished", async () => {
  await withFixture(async (f) => {
    await makeRepo(f.location, "repo-7");
    register(f, f.location, "created");
    await writeRecord(f, f.location, null);
    const root = await resolveWith(f);
    assertEquals(root.created, false);
    assertEquals(f.creates, []);
    assertStringIncludes(await Deno.readTextFile(f.recordFile), "repo-7");
  });
});

Deno.test("resolveRootWorkspace: a pending record never adopts an imported entry", async () => {
  await withFixture(async (f) => {
    await makeRepo(f.location, "repo-7");
    register(f, f.location, "imported");
    await writeRecord(f, f.location, null);
    assertStringIncludes(
      await refusal(f),
      "no longer holds the repo the host made there",
    );
  });
});

Deno.test("resolveRootWorkspace: a removed root whose folder is gone too is made anew", async () => {
  await withFixture(async (f) => {
    await writeRecord(f, f.location, "repo-old");
    const root = await resolveWith(f, creatorFor(f, "repo-new"));
    assertEquals(root.created, true);
    assertEquals(root.leftFolder, null);
    assertStringIncludes(await Deno.readTextFile(f.recordFile), "repo-new");
  });
});

Deno.test("resolveRootWorkspace: a new root made elsewhere names the old folder it left", async () => {
  await withFixture(async (f) => {
    const old = join(f.stateDir, "..", "old-location", ROOT_WORKSPACE_NAME);
    await makeRepo(old, "repo-old");
    await writeRecord(f, old, "repo-old");
    const root = await resolveWith(f);
    assertEquals(root.created, true);
    assertPathEquals(root.leftFolder ?? "", old);
  });
});

Deno.test("resolveRootWorkspace: the root's own folder left at the location is refused with how to bring it back", async () => {
  await withFixture(async (f) => {
    await makeRepo(f.location, "repo-1");
    await writeRecord(f, f.location, "repo-1");
    const message = await refusal(f);
    assertStringIncludes(message, "is no longer registered");
    assertStringIncludes(
      message,
      `swamp workspace import "${f.location}" --name ${ROOT_WORKSPACE_NAME}`,
    );
    assertEquals(f.creates, []);
  });
});

Deno.test("resolveRootWorkspace: a folder at the location the host cannot vouch for is refused without offering an import", async () => {
  const records: Array<[string, string | null] | null> = [
    null,
    ["location", null],
    ["location", "another-repo"],
    ["elsewhere", "repo-1"],
  ];
  for (const record of records) {
    await withFixture(async (f) => {
      await makeRepo(f.location, "repo-1");
      if (record !== null) {
        const [where, repoId] = record;
        await writeRecord(
          f,
          where === "location" ? f.location : join(f.stateDir, "..", where),
          repoId,
        );
      }
      const message = await refusal(f);
      assertStringIncludes(message, "a folder this host did not make");
      assertStringIncludes(message, `set root: ${f.location}`);
      assertEquals(message.includes("swamp workspace import"), false);
      assertEquals(f.creates, []);
    });
  }
});

Deno.test("resolveRootWorkspace: an unreadable registry fails the start and creates nothing", async () => {
  await withFixture(async (f) => {
    f.registry.unreadable = "workspaces.json is not JSON";
    assertStringIncludes(await refusal(f), "workspaces.json is not JSON");
    assertEquals(f.creates, []);
  });
});

Deno.test("resolveRootWorkspace: a failed create says why and leaves no record", async () => {
  await withFixture(async (f) => {
    const creator = creatorFor(f);
    creator.fail = new Error("The workspaces folder /nope doesn't exist.");
    const message = await refusal(f, creator);
    assertStringIncludes(message, "could not create its root workspace");
    assertStringIncludes(message, "/nope doesn't exist. To use a repo");
    await assertRejects(() => Deno.stat(f.recordFile), Deno.errors.NotFound);
  });
});

Deno.test("resolveRootWorkspace: a create that registered before it failed keeps its pending record", async () => {
  await withFixture(async (f) => {
    const creator: RootWorkspaceCreator = {
      async create(name) {
        await makeRepo(f.location, "repo-3");
        register(f, f.location, "created");
        throw new Error(`killed after registering ${name}`);
      },
    };
    await refusal(f, creator);
    const adopted = await resolveWith(f);
    assertEquals(adopted.created, false);
    assertStringIncludes(await Deno.readTextFile(f.recordFile), "repo-3");
  });
});

Deno.test("resolveRootWorkspace: a record that is not one the host writes is reported, never acted on", async () => {
  const bad = [
    ["name: other\nfolder: /x\nrepoId: r\n", "name"],
    [`name: ${ROOT_WORKSPACE_NAME}\nfolder: relative/x\nrepoId: r\n`, "folder"],
    [`name: ${ROOT_WORKSPACE_NAME}\nfolder: /x\nrepoId: r\nextra: 1\n`, ""],
    ["{ not yaml", "not valid YAML"],
    [`repoId: ${"x".repeat(70_000)}\n`, "larger than"],
  ];
  for (const [text, says] of bad) {
    await withFixture(async (f) => {
      await Deno.writeTextFile(f.recordFile, text);
      const message = await refusal(f);
      assertStringIncludes(message, "root workspace record");
      assertStringIncludes(message, says);
      assertEquals(f.creates, []);
    });
  }
});

Deno.test("SERVE_CONFIG_PATH: is serve's own default config path", () => {
  assertEquals(SERVE_CONFIG_PATH, SERVES_CONFIG_PATH);
});
