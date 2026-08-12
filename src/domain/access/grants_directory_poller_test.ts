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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { GrantsDirectoryPoller } from "./grants_directory_poller.ts";
import type { FileGrantStore } from "./grant_file_reconciler.ts";
import type { PolicySnapshotLoader } from "./policy_snapshot_loader.ts";
import type { Grant } from "../models/access/grant_model.ts";

const VALID_GRANT_YAML =
  `grants:\n  - subject: "user:adam"\n    effect: allow\n    actions: [run]\n    resource: "workflow:*"`;

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-poller-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function createMockFileGrantStore(): FileGrantStore & { writeCalls: number } {
  const mock = {
    writeCalls: 0,
    queryFileGrants() {
      return Promise.resolve(
        new Map<
          string,
          { grant: Grant; modelId: string; instanceName: string }
        >(),
      );
    },
    ensureDefinition(_instanceName: string) {
      return Promise.resolve(crypto.randomUUID());
    },
    writeGrant(
      _modelId: string,
      _instanceName: string,
      _grant: Grant,
    ) {
      mock.writeCalls++;
      return Promise.resolve();
    },
  };
  return mock;
}

function createMockLoader(): {
  loader: PolicySnapshotLoader;
  loadCalls: number;
  reset: () => void;
} {
  const state = { loadCalls: 0 };
  const loader = {
    load() {
      state.loadCalls++;
      return Promise.resolve(
        undefined as unknown as ReturnType<PolicySnapshotLoader["load"]>,
      );
    },
  } as unknown as PolicySnapshotLoader;
  return {
    loader,
    get loadCalls() {
      return state.loadCalls;
    },
    reset() {
      state.loadCalls = 0;
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.test("GrantsDirectoryPoller: start and stop lifecycle", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    await ensureDir(grantsDir);

    const store = createMockFileGrantStore();
    const mock = createMockLoader();

    const poller = new GrantsDirectoryPoller({
      grantsDir,
      fileGrantStore: store,
      policySnapshotLoader: mock.loader,
      pollIntervalMs: 60_000,
    });

    await poller.start();
    await poller.stop();
  });
});

Deno.test("GrantsDirectoryPoller: detects new file and triggers reconcile + load", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    await ensureDir(grantsDir);

    const store = createMockFileGrantStore();
    const mock = createMockLoader();

    const poller = new GrantsDirectoryPoller({
      grantsDir,
      fileGrantStore: store,
      policySnapshotLoader: mock.loader,
      pollIntervalMs: 50,
    });

    await poller.start();

    await Deno.writeTextFile(join(grantsDir, "team.yaml"), VALID_GRANT_YAML);

    await delay(200);
    await poller.stop();

    assertEquals(mock.loadCalls > 0, true, "load() should have been called");
    assertEquals(store.writeCalls > 0, true, "grants should have been written");
  });
});

Deno.test("GrantsDirectoryPoller: detects modified file content", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    await ensureDir(grantsDir);
    await Deno.writeTextFile(join(grantsDir, "team.yaml"), VALID_GRANT_YAML);

    const store = createMockFileGrantStore();
    const mock = createMockLoader();

    const poller = new GrantsDirectoryPoller({
      grantsDir,
      fileGrantStore: store,
      policySnapshotLoader: mock.loader,
      pollIntervalMs: 50,
    });

    await poller.start();
    mock.reset();
    store.writeCalls = 0;

    const modifiedYaml =
      `grants:\n  - subject: "user:sarah"\n    effect: allow\n    actions: [read]\n    resource: "data:*"`;
    await Deno.writeTextFile(join(grantsDir, "team.yaml"), modifiedYaml);

    await delay(200);
    await poller.stop();

    assertEquals(mock.loadCalls > 0, true, "load() should have been called");
  });
});

Deno.test("GrantsDirectoryPoller: detects removed file", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    await ensureDir(grantsDir);
    await Deno.writeTextFile(join(grantsDir, "team.yaml"), VALID_GRANT_YAML);

    const store = createMockFileGrantStore();
    const mock = createMockLoader();

    const poller = new GrantsDirectoryPoller({
      grantsDir,
      fileGrantStore: store,
      policySnapshotLoader: mock.loader,
      pollIntervalMs: 50,
    });

    await poller.start();
    mock.reset();

    await Deno.remove(join(grantsDir, "team.yaml"));

    await delay(200);
    await poller.stop();

    assertEquals(mock.loadCalls > 0, true, "load() should have been called");
  });
});

Deno.test("GrantsDirectoryPoller: unchanged files produce no reconcile", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    await ensureDir(grantsDir);
    await Deno.writeTextFile(join(grantsDir, "team.yaml"), VALID_GRANT_YAML);

    const store = createMockFileGrantStore();
    const mock = createMockLoader();

    const poller = new GrantsDirectoryPoller({
      grantsDir,
      fileGrantStore: store,
      policySnapshotLoader: mock.loader,
      pollIntervalMs: 50,
    });

    await poller.start();
    mock.reset();
    store.writeCalls = 0;

    await delay(200);
    await poller.stop();

    assertEquals(mock.loadCalls, 0, "load() should not have been called");
    assertEquals(store.writeCalls, 0, "no grants should have been written");
  });
});

Deno.test("GrantsDirectoryPoller: external grants file changes detected", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    await ensureDir(grantsDir);
    const externalFile = join(dir, "external-grants.yaml");
    await Deno.writeTextFile(externalFile, VALID_GRANT_YAML);

    const store = createMockFileGrantStore();
    const mock = createMockLoader();

    const poller = new GrantsDirectoryPoller({
      grantsDir,
      externalGrantsFile: externalFile,
      fileGrantStore: store,
      policySnapshotLoader: mock.loader,
      pollIntervalMs: 50,
    });

    await poller.start();
    mock.reset();

    const modifiedYaml =
      `grants:\n  - subject: "user:sarah"\n    effect: deny\n    actions: [run]\n    resource: "workflow:*"`;
    await Deno.writeTextFile(externalFile, modifiedYaml);

    await delay(200);
    await poller.stop();

    assertEquals(mock.loadCalls > 0, true, "load() should have been called");
  });
});

Deno.test("GrantsDirectoryPoller: handles missing grants directory gracefully", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "nonexistent-grants");

    const store = createMockFileGrantStore();
    const mock = createMockLoader();

    const poller = new GrantsDirectoryPoller({
      grantsDir,
      fileGrantStore: store,
      policySnapshotLoader: mock.loader,
      pollIntervalMs: 50,
    });

    await poller.start();
    await delay(150);
    await poller.stop();
  });
});

Deno.test("GrantsDirectoryPoller: ignores non-YAML files", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    await ensureDir(grantsDir);
    await Deno.writeTextFile(join(grantsDir, "readme.txt"), "not a grant file");

    const store = createMockFileGrantStore();
    const mock = createMockLoader();

    const poller = new GrantsDirectoryPoller({
      grantsDir,
      fileGrantStore: store,
      policySnapshotLoader: mock.loader,
      pollIntervalMs: 50,
    });

    await poller.start();
    mock.reset();

    await Deno.writeTextFile(
      join(grantsDir, "readme.txt"),
      "modified non-yaml",
    );

    await delay(200);
    await poller.stop();

    assertEquals(mock.loadCalls, 0, "load() should not have been called");
  });
});

Deno.test("GrantsDirectoryPoller: ignores dot-prefixed files", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    await ensureDir(grantsDir);

    const store = createMockFileGrantStore();
    const mock = createMockLoader();

    const poller = new GrantsDirectoryPoller({
      grantsDir,
      fileGrantStore: store,
      policySnapshotLoader: mock.loader,
      pollIntervalMs: 50,
    });

    await poller.start();
    mock.reset();

    await Deno.writeTextFile(
      join(grantsDir, ".hidden.yaml"),
      VALID_GRANT_YAML,
    );

    await delay(200);
    await poller.stop();

    assertEquals(mock.loadCalls, 0, "load() should not have been called");
  });
});

Deno.test("GrantsDirectoryPoller: external grants dir changes detected", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    await ensureDir(grantsDir);
    const extDir = join(dir, "ext-grants");
    await ensureDir(extDir);
    await Deno.writeTextFile(join(extDir, "team.yaml"), VALID_GRANT_YAML);

    const store = createMockFileGrantStore();
    const mock = createMockLoader();

    const poller = new GrantsDirectoryPoller({
      grantsDir,
      externalGrantsDir: extDir,
      fileGrantStore: store,
      policySnapshotLoader: mock.loader,
      pollIntervalMs: 50,
    });

    await poller.start();
    mock.reset();

    const modifiedYaml =
      `grants:\n  - subject: "user:sarah"\n    effect: deny\n    actions: [run]\n    resource: "workflow:*"`;
    await Deno.writeTextFile(join(extDir, "team.yaml"), modifiedYaml);

    await delay(200);
    await poller.stop();

    assertEquals(mock.loadCalls > 0, true, "load() should have been called");
  });
});

Deno.test("GrantsDirectoryPoller: new file in external grants dir triggers reconcile", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    await ensureDir(grantsDir);
    const extDir = join(dir, "ext-grants");
    await ensureDir(extDir);

    const store = createMockFileGrantStore();
    const mock = createMockLoader();

    const poller = new GrantsDirectoryPoller({
      grantsDir,
      externalGrantsDir: extDir,
      fileGrantStore: store,
      policySnapshotLoader: mock.loader,
      pollIntervalMs: 50,
    });

    await poller.start();
    mock.reset();
    store.writeCalls = 0;

    await Deno.writeTextFile(join(extDir, "new-team.yaml"), VALID_GRANT_YAML);

    await delay(200);
    await poller.stop();

    assertEquals(mock.loadCalls > 0, true, "load() should have been called");
    assertEquals(store.writeCalls > 0, true, "grants should have been written");
  });
});

Deno.test("GrantsDirectoryPoller: unchanged external grants dir produces no reconcile", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    await ensureDir(grantsDir);
    const extDir = join(dir, "ext-grants");
    await ensureDir(extDir);
    await Deno.writeTextFile(join(extDir, "team.yaml"), VALID_GRANT_YAML);

    const store = createMockFileGrantStore();
    const mock = createMockLoader();

    const poller = new GrantsDirectoryPoller({
      grantsDir,
      externalGrantsDir: extDir,
      fileGrantStore: store,
      policySnapshotLoader: mock.loader,
      pollIntervalMs: 50,
    });

    await poller.start();
    mock.reset();
    store.writeCalls = 0;

    await delay(200);
    await poller.stop();

    assertEquals(mock.loadCalls, 0, "load() should not have been called");
    assertEquals(store.writeCalls, 0, "no grants should have been written");
  });
});
