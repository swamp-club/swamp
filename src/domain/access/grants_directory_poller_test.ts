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

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { waitFor } from "@swamp-club/swamp-testing";
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

const DENY_GRANT_YAML =
  `grants:\n  - subject: "user:alice"\n    effect: deny\n    actions: [run]\n    resource: "workflow:@acme/secret-*"`;

interface StoredGrant {
  grant: Grant;
  modelId: string;
  instanceName: string;
}

function storedGrant(
  modelId: string,
  source: string,
  overrides: Partial<Grant> = {},
): StoredGrant {
  return {
    modelId,
    instanceName: `inst-${modelId}`,
    grant: {
      id: crypto.randomUUID(),
      subject: { kind: "user", name: "adam" },
      effect: "allow",
      actions: ["run"],
      resource: { kind: "workflow", pattern: "*" },
      state: "active",
      source,
      createdBy: { kind: "user", id: "system" },
      createdAt: "2026-01-01T00:00:00Z",
      ...overrides,
    },
  };
}

const aliceDeny: Partial<Grant> = {
  subject: { kind: "user", name: "alice" },
  effect: "deny",
  resource: { kind: "workflow", pattern: "@acme/secret-*" },
};

/** A store that keeps its grants, so reconcile sees what it wrote. */
function createStatefulStore(seed: StoredGrant[]): FileGrantStore & {
  written: Map<string, Grant>;
} {
  const grants = new Map(seed.map((g) => [g.modelId, g]));
  const written = new Map<string, Grant>();
  return {
    written,
    queryFileGrants() {
      return Promise.resolve(new Map(grants));
    },
    ensureDefinition(_instanceName: string) {
      return Promise.resolve(crypto.randomUUID());
    },
    writeGrant(modelId: string, instanceName: string, grant: Grant) {
      written.set(modelId, grant);
      grants.set(modelId, { grant, modelId, instanceName });
      return Promise.resolve();
    },
  };
}

async function reconcileOnce(
  options: {
    grantsDir: string;
    externalGrantsFile?: string;
    externalGrantsDir?: string;
    store: FileGrantStore;
    commitReconcile?: (reconcile: () => Promise<void>) => Promise<void>;
  },
  change: () => Promise<void>,
  until?: () => boolean,
): Promise<void> {
  const mock = createMockLoader();
  const poller = new GrantsDirectoryPoller({
    grantsDir: options.grantsDir,
    externalGrantsFile: options.externalGrantsFile,
    externalGrantsDir: options.externalGrantsDir,
    fileGrantStore: options.store,
    policySnapshotLoader: mock.loader,
    pollIntervalMs: 20,
    commitReconcile: options.commitReconcile,
  });
  await poller.start();
  try {
    await change();
    await waitFor(until ?? (() => mock.loadCalls >= 1), "a reconcile");
  } finally {
    await poller.stop();
  }
}

Deno.test("GrantsDirectoryPoller: keeps the grants of a file with invalid YAML while other files reconcile", async () => {
  // A mis-indented deny file must not revoke its deny (swamp-club#2823).
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    await ensureDir(grantsDir);
    await Deno.writeTextFile(join(grantsDir, "deny.yaml"), DENY_GRANT_YAML);
    await Deno.writeTextFile(join(grantsDir, "team.yaml"), VALID_GRANT_YAML);
    const store = createStatefulStore([
      storedGrant("deny-1", "file:deny.yaml", aliceDeny),
      storedGrant("team-1", "file:team.yaml"),
    ]);

    await reconcileOnce({ grantsDir, store }, async () => {
      await Deno.writeTextFile(
        join(grantsDir, "deny.yaml"),
        `${DENY_GRANT_YAML}\n  - subject: "user:bob"\n   effect: deny`,
      );
      await Deno.writeTextFile(
        join(grantsDir, "team.yaml"),
        VALID_GRANT_YAML.replace("user:adam", "user:bob"),
      );
    }, () => store.written.get("team-1")?.state === "revoked");

    assertEquals(store.written.has("deny-1"), false);
    assertEquals(store.written.get("team-1")?.state, "revoked");
  });
});

Deno.test("GrantsDirectoryPoller: keeps all grants of a file with one schema-invalid entry", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    await ensureDir(grantsDir);
    await Deno.writeTextFile(join(grantsDir, "deny.yaml"), DENY_GRANT_YAML);
    const store = createStatefulStore([
      storedGrant("deny-1", "file:deny.yaml", aliceDeny),
    ]);

    await reconcileOnce({ grantsDir, store }, async () => {
      await Deno.writeTextFile(
        join(grantsDir, "deny.yaml"),
        `${DENY_GRANT_YAML}\n  - subject: "user:bob"\n    effect: deny\n    actions: [runn]\n    resource: "workflow:*"`,
      );
    });

    assertEquals(store.written.size, 0);
  });
});

Deno.test({
  name: "GrantsDirectoryPoller: keeps the grants of a file it cannot read",
  // chmod has no effect on Windows, and root can read a 000 file.
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    await withTempDir(async (dir) => {
      const grantsDir = join(dir, "grants");
      await ensureDir(grantsDir);
      const denyPath = join(grantsDir, "deny.yaml");
      await Deno.writeTextFile(denyPath, DENY_GRANT_YAML);
      const store = createStatefulStore([
        storedGrant("deny-1", "file:deny.yaml", aliceDeny),
      ]);

      try {
        await reconcileOnce({ grantsDir, store }, async () => {
          await Deno.chmod(denyPath, 0o000);
        });
      } finally {
        await Deno.chmod(denyPath, 0o644);
      }

      assertEquals(store.written.size, 0);
    });
  },
});

Deno.test("GrantsDirectoryPoller: still revokes the grants of a deleted file", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    await ensureDir(grantsDir);
    await Deno.writeTextFile(join(grantsDir, "deny.yaml"), DENY_GRANT_YAML);
    const store = createStatefulStore([
      storedGrant("deny-1", "file:deny.yaml", aliceDeny),
    ]);

    await reconcileOnce({ grantsDir, store }, async () => {
      await Deno.remove(join(grantsDir, "deny.yaml"));
    });

    assertEquals(store.written.get("deny-1")?.state, "revoked");
  });
});

Deno.test("GrantsDirectoryPoller: keeps the grants of a missing --grants-dir, as startup refuses it", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    const externalDir = join(dir, "external");
    await ensureDir(grantsDir);
    await ensureDir(externalDir);
    const externalFile = join(externalDir, "deny.yaml");
    await Deno.writeTextFile(externalFile, DENY_GRANT_YAML);
    const store = createStatefulStore([
      storedGrant("deny-1", `file:${externalFile}`, aliceDeny),
    ]);

    await reconcileOnce(
      { grantsDir, externalGrantsDir: externalDir, store },
      async () => {
        await Deno.rename(externalDir, join(dir, "unmounted"));
      },
    );

    assertEquals(store.written.size, 0);
  });
});

Deno.test("GrantsDirectoryPoller: revokes the grants of a --grants-dir that comes back empty after going missing", async () => {
  // Missing keeps the grants; the remount without the file must still revoke
  // them, so missing and empty cannot look the same to change detection.
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    const externalDir = join(dir, "external");
    await ensureDir(grantsDir);
    await ensureDir(externalDir);
    const externalFile = join(externalDir, "deny.yaml");
    await Deno.writeTextFile(externalFile, DENY_GRANT_YAML);
    const store = createStatefulStore([
      storedGrant("deny-1", `file:${externalFile}`, aliceDeny),
    ]);
    const mock = createMockLoader();
    const poller = new GrantsDirectoryPoller({
      grantsDir,
      externalGrantsDir: externalDir,
      fileGrantStore: store,
      policySnapshotLoader: mock.loader,
      pollIntervalMs: 20,
    });
    await poller.start();
    try {
      await Deno.remove(externalDir, { recursive: true });
      await waitFor(() => mock.loadCalls >= 1, "the unmount reconcile");
      assertEquals(store.written.size, 0);

      await ensureDir(externalDir);
      await waitFor(
        () => store.written.get("deny-1")?.state === "revoked",
        "the empty remount to revoke the deny",
      );
    } finally {
      await poller.stop();
    }
  });
});

Deno.test("GrantsDirectoryPoller: keeps the grants of a deleted --grants-file, as startup refuses it", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    await ensureDir(grantsDir);
    const externalFile = join(dir, "grants-file.yaml");
    await Deno.writeTextFile(externalFile, DENY_GRANT_YAML);
    const store = createStatefulStore([
      storedGrant("deny-1", `file:${externalFile}`, aliceDeny),
    ]);

    await reconcileOnce(
      { grantsDir, externalGrantsFile: externalFile, store },
      async () => {
        await Deno.remove(externalFile);
      },
    );

    assertEquals(store.written.size, 0);
  });
});

Deno.test("GrantsDirectoryPoller: keeps the grants of a --grants-file with invalid YAML", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    await ensureDir(grantsDir);
    const externalFile = join(dir, "grants-file.yaml");
    await Deno.writeTextFile(externalFile, DENY_GRANT_YAML);
    const store = createStatefulStore([
      storedGrant("deny-1", `file:${externalFile}`, aliceDeny),
    ]);

    await reconcileOnce(
      { grantsDir, externalGrantsFile: externalFile, store },
      async () => {
        await Deno.writeTextFile(externalFile, "grants: [\n");
      },
    );

    assertEquals(store.written.size, 0);
  });
});

Deno.test("GrantsDirectoryPoller: revokes the grants of an emptied --grants-file, as before", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    await ensureDir(grantsDir);
    const externalFile = join(dir, "grants-file.yaml");
    await Deno.writeTextFile(externalFile, DENY_GRANT_YAML);
    const store = createStatefulStore([
      storedGrant("deny-1", `file:${externalFile}`, aliceDeny),
    ]);

    await reconcileOnce(
      { grantsDir, externalGrantsFile: externalFile, store },
      async () => {
        await Deno.writeTextFile(externalFile, "");
      },
    );

    assertEquals(store.written.get("deny-1")?.state, "revoked");
  });
});

Deno.test("GrantsDirectoryPoller: revokes the grants of an emptied --grants-dir file, as before", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    const externalDir = join(dir, "external");
    await ensureDir(grantsDir);
    await ensureDir(externalDir);
    const externalFile = join(externalDir, "deny.yaml");
    await Deno.writeTextFile(externalFile, DENY_GRANT_YAML);
    const store = createStatefulStore([
      storedGrant("deny-1", `file:${externalFile}`, aliceDeny),
    ]);

    await reconcileOnce(
      { grantsDir, externalGrantsDir: externalDir, store },
      async () => {
        await Deno.writeTextFile(externalFile, "  \n");
      },
    );

    assertEquals(store.written.get("deny-1")?.state, "revoked");
  });
});

Deno.test("GrantsDirectoryPoller: runs store writes and the snapshot reload inside commitReconcile", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    await ensureDir(grantsDir);
    const store = createStatefulStore([]);
    let insideUnit = false;
    let writesOutsideUnit = 0;
    let units = 0;
    const trackingStore: FileGrantStore = {
      ...store,
      writeGrant(modelId, instanceName, grant) {
        if (!insideUnit) writesOutsideUnit++;
        return store.writeGrant(modelId, instanceName, grant);
      },
    };

    await reconcileOnce(
      {
        grantsDir,
        store: trackingStore,
        commitReconcile: async (reconcile) => {
          units++;
          insideUnit = true;
          try {
            await reconcile();
          } finally {
            insideUnit = false;
          }
        },
      },
      async () => {
        await Deno.writeTextFile(
          join(grantsDir, "team.yaml"),
          VALID_GRANT_YAML,
        );
      },
    );

    assert(units >= 1);
    assertEquals(store.written.size, 1);
    assertEquals(writesOutsideUnit, 0);
  });
});
