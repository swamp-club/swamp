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
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import type {
  LockfileEntryDelta,
  PendingLockfilePublish,
} from "../../infrastructure/persistence/pending_lockfile_publish.ts";
import {
  readUpstreamExtensions,
  type UpstreamExtensionsMap,
} from "../../infrastructure/persistence/upstream_extensions.ts";
import {
  inManagedLockfileTransaction,
  ManagedLockfileTransaction,
  ManagedLockfileUnpublishedError,
  refreshManagedLockfile,
  withManagedLockfileTransaction,
} from "./managed_lockfile_transaction.ts";

const PULLED_AT = "2026-09-30T00:00:00.000Z";
const entry = (version: string) => ({ version, pulledAt: PULLED_AT });

interface Harness {
  lockfilePath: string;
  events: string[];
  remote: { entries: UpstreamExtensionsMap };
  pending: { value: PendingLockfilePublish };
  failPublish: { value: boolean };
  warnings: string[];
  transaction: (
    publishFailure?: "throw" | "defer",
  ) => ManagedLockfileTransaction;
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-lockfile-txn-" });
  try {
    const lockfilePath = join(dir, "config", "upstream_extensions.json");
    const events: string[] = [];
    const remote = { entries: {} as UpstreamExtensionsMap };
    const pending = { value: { kind: "none" } as PendingLockfilePublish };
    const failPublish = { value: false };
    const warnings: string[] = [];
    const transaction = (publishFailure?: "throw" | "defer") =>
      new ManagedLockfileTransaction({
        lockfilePath,
        publishFailure,
        onWarning: (message) => warnings.push(message),
        lock: {
          acquire: () => {
            events.push("acquire");
            return Promise.resolve();
          },
          release: () => {
            events.push("release");
            return Promise.resolve();
          },
        },
        sync: {
          hydrate: async () => {
            events.push("hydrate");
            await new LockfileRepository(lockfilePath).replaceAll(
              structuredClone(remote.entries),
            );
          },
          publish: async () => {
            events.push("publish");
            if (failPublish.value) throw new Error("datastore unreachable");
            remote.entries = await readUpstreamExtensions(lockfilePath);
          },
        },
        pending: {
          read: () => Promise.resolve(pending.value),
          write: (delta: LockfileEntryDelta) => {
            events.push("pending-write");
            pending.value = { kind: "delta", delta };
            return Promise.resolve();
          },
          clear: () => {
            pending.value = { kind: "none" };
            return Promise.resolve();
          },
        },
      });
    await fn({
      lockfilePath,
      events,
      remote,
      pending,
      failPublish,
      warnings,
      transaction,
    });
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("ManagedLockfileTransaction.run: fetches under the lock, keeps a peer's entry and publishes the change", async () => {
  await withHarness(async (h) => {
    h.remote.entries = { "@peer/p": entry("1") };
    // The local cache is stale: it has never seen the peer's entry.
    await new LockfileRepository(h.lockfilePath).replaceAll({});

    await h.transaction().run(async () => {
      h.events.push("change");
      const repo = await LockfileRepository.create(h.lockfilePath);
      await repo.writeEntry("@me/x", "1", []);
    });

    assertEquals(h.events, [
      "acquire",
      "hydrate",
      "change",
      "pending-write",
      "publish",
      "release",
    ]);
    assertEquals(Object.keys(h.remote.entries).sort(), ["@me/x", "@peer/p"]);
    assertEquals(h.pending.value, { kind: "none" });
  });
});

Deno.test("ManagedLockfileTransaction.run: a change that writes nothing publishes nothing", async () => {
  await withHarness(async (h) => {
    h.remote.entries = { "@peer/p": entry("1") };
    await h.transaction().refresh();
    assertEquals(h.events, ["acquire", "hydrate", "release"]);
    assertEquals(h.pending.value, { kind: "none" });
    assertEquals(await readUpstreamExtensions(h.lockfilePath), {
      "@peer/p": entry("1"),
    });
  });
});

Deno.test("ManagedLockfileTransaction.run: nested runs join the outer transaction and publish once", async () => {
  await withHarness(async (h) => {
    const transaction = h.transaction();
    await transaction.run(async () => {
      await transaction.run(async () => {
        await (await LockfileRepository.create(h.lockfilePath)).writeEntry(
          "@me/dep",
          "1",
          [],
        );
      });
      await (await LockfileRepository.create(h.lockfilePath)).writeEntry(
        "@me/x",
        "1",
        [],
      );
    });
    assertEquals(h.events.filter((e) => e === "acquire").length, 1);
    assertEquals(h.events.filter((e) => e === "publish").length, 1);
    assertEquals(Object.keys(h.remote.entries).sort(), ["@me/dep", "@me/x"]);
  });
});

Deno.test("ManagedLockfileTransaction.run: a failed publish is recorded and replayed after the next fetch", async () => {
  await withHarness(async (h) => {
    h.failPublish.value = true;
    await assertRejects(
      () =>
        h.transaction().run(async () => {
          await (await LockfileRepository.create(h.lockfilePath)).writeEntry(
            "@me/x",
            "1",
            [],
          );
        }),
      Error,
      "datastore unreachable",
    );
    assertEquals(h.pending.value.kind, "delta");
    assertEquals(h.events.at(-1), "release");

    // A peer publishes meanwhile; the next transaction must keep both.
    h.remote.entries = { "@peer/p": entry("1") };
    h.failPublish.value = false;
    await h.transaction().refresh();

    assertEquals(Object.keys(h.remote.entries).sort(), ["@me/x", "@peer/p"]);
    assertEquals(h.pending.value, { kind: "none" });
  });
});

Deno.test("ManagedLockfileTransaction.run: a replayed removal survives the fetch", async () => {
  await withHarness(async (h) => {
    h.remote.entries = { "@me/x": entry("1"), "@peer/p": entry("1") };
    h.pending.value = {
      kind: "delta",
      delta: { upserts: {}, removals: ["@me/x"] },
    };
    await h.transaction().refresh();
    assertEquals(Object.keys(h.remote.entries), ["@peer/p"]);
  });
});

Deno.test("ManagedLockfileTransaction.run: a legacy record merges local entries into the fetched lockfile", async () => {
  await withHarness(async (h) => {
    await new LockfileRepository(h.lockfilePath).replaceAll({
      "@me/x": entry("2"),
    });
    h.remote.entries = { "@me/x": entry("1"), "@peer/p": entry("1") };
    h.pending.value = { kind: "unknown" };

    await h.transaction().refresh();

    assertEquals(h.remote.entries, {
      "@me/x": entry("2"),
      "@peer/p": entry("1"),
    });
    assertEquals(h.warnings.length, 1);
    assertEquals(h.pending.value, { kind: "none" });
  });
});

Deno.test("ManagedLockfileTransaction.run: a change that throws after writing still publishes, and its error wins", async () => {
  await withHarness(async (h) => {
    await assertRejects(
      () =>
        h.transaction().run(async () => {
          await (await LockfileRepository.create(h.lockfilePath)).writeEntry(
            "@me/x",
            "1",
            [],
          );
          throw new Error("dependency failed");
        }),
      Error,
      "dependency failed",
    );
    assertEquals(Object.keys(h.remote.entries), ["@me/x"]);

    // With the publish failing too, the change's error is still the one
    // reported, and the change is left pending.
    h.failPublish.value = true;
    await assertRejects(
      () =>
        h.transaction().run(async () => {
          await (await LockfileRepository.create(h.lockfilePath)).writeEntry(
            "@me/y",
            "1",
            [],
          );
          throw new Error("dependency failed");
        }),
      Error,
      "dependency failed",
    );
    assertEquals(h.pending.value.kind, "delta");
  });
});

Deno.test("ManagedLockfileTransaction.run: a failed fetch changes nothing and releases the lock", async () => {
  await withHarness(async (h) => {
    const transaction = new ManagedLockfileTransaction({
      lockfilePath: h.lockfilePath,
      lock: {
        acquire: () => Promise.resolve(void h.events.push("acquire")),
        release: () => Promise.resolve(void h.events.push("release")),
      },
      sync: {
        hydrate: () => Promise.reject(new Error("fetch failed")),
        publish: () => Promise.resolve(void h.events.push("publish")),
      },
      pending: {
        read: () => Promise.resolve({ kind: "none" }),
        write: () => Promise.resolve(),
        clear: () => Promise.resolve(),
      },
    });
    let ran = false;
    await assertRejects(
      () =>
        transaction.run(() => {
          ran = true;
          return Promise.resolve();
        }),
      Error,
      "fetch failed",
    );
    assertEquals(ran, false);
    assertEquals(h.events, ["acquire", "release"]);
  });
});

Deno.test("ManagedLockfileTransaction.run: deferred publish failures warn and complete", async () => {
  await withHarness(async (h) => {
    h.failPublish.value = true;
    await h.transaction("defer").run(async () => {
      await (await LockfileRepository.create(h.lockfilePath)).writeEntry(
        "@me/x",
        "1",
        [],
      );
    });
    assertEquals(h.warnings.length, 1);
    assertEquals(h.pending.value.kind, "delta");
  });
});

Deno.test("inManagedLockfileTransaction: runs through the ambient transaction only for its lockfile", async () => {
  await withHarness(async (h) => {
    const transaction = h.transaction();
    await withManagedLockfileTransaction(transaction, async () => {
      await inManagedLockfileTransaction(
        join(h.lockfilePath, "..", "..", "other.json"),
        () => Promise.resolve(),
      );
      assertEquals(h.events, []);
      await inManagedLockfileTransaction(h.lockfilePath, () => {
        h.events.push("change");
        return Promise.resolve();
      });
    });
    assertEquals(h.events, [
      "acquire",
      "hydrate",
      "change",
      "release",
    ]);
  });
});

Deno.test("refreshManagedLockfile: refreshes the repository's snapshot from the fetched lockfile", async () => {
  await withHarness(async (h) => {
    const repo = await LockfileRepository.create(h.lockfilePath);
    h.remote.entries = { "@peer/p": entry("1") };

    await refreshManagedLockfile(repo);
    assertEquals(repo.getEntry("@peer/p"), null);

    await withManagedLockfileTransaction(h.transaction(), async () => {
      await refreshManagedLockfile(repo);
    });
    assertEquals(repo.getEntry("@peer/p")?.version, "1");
  });
});

Deno.test("ManagedLockfileTransaction.run: a pending change is published even when the fetch leaves it in place (no datastore lockfile yet)", async () => {
  await withHarness(async (h) => {
    const remote: { entries: UpstreamExtensionsMap | null } = {
      entries: null,
    };
    const pending = { value: { kind: "none" } as PendingLockfilePublish };
    let failPublish = true;
    const transaction = () =>
      new ManagedLockfileTransaction({
        lockfilePath: h.lockfilePath,
        lock: {
          acquire: () => Promise.resolve(),
          release: () => Promise.resolve(),
        },
        sync: {
          // A fetch with nothing to download leaves the local file alone.
          hydrate: async () => {
            if (remote.entries) {
              await new LockfileRepository(h.lockfilePath).replaceAll(
                remote.entries,
              );
            }
          },
          publish: async () => {
            if (failPublish) throw new Error("datastore unreachable");
            remote.entries = await readUpstreamExtensions(h.lockfilePath);
          },
        },
        pending: {
          read: () => Promise.resolve(pending.value),
          write: (delta) => {
            pending.value = { kind: "delta", delta };
            return Promise.resolve();
          },
          clear: () => {
            pending.value = { kind: "none" };
            return Promise.resolve();
          },
        },
      });

    await assertRejects(
      () =>
        transaction().run(async () => {
          await (await LockfileRepository.create(h.lockfilePath)).writeEntry(
            "@me/x",
            "1",
            [],
          );
        }),
      Error,
      "datastore unreachable",
    );
    assertEquals(remote.entries, null);

    // The retry sees the change already in the fetched copy; the diff is
    // empty, but the pending record still forces the publish.
    failPublish = false;
    await transaction().refresh();
    assertEquals(Object.keys(remote.entries ?? {}), ["@me/x"]);
    assertEquals(pending.value, { kind: "none" });
  });
});

Deno.test("ManagedLockfileTransaction.run: a second failed publish keeps the first change in the record (no datastore lockfile yet)", async () => {
  await withHarness(async (h) => {
    let remote: UpstreamExtensionsMap | null = null;
    const pending = { value: { kind: "none" } as PendingLockfilePublish };
    let failPublish = true;
    const transaction = () =>
      new ManagedLockfileTransaction({
        lockfilePath: h.lockfilePath,
        lock: {
          acquire: () => Promise.resolve(),
          release: () => Promise.resolve(),
        },
        sync: {
          hydrate: async () => {
            if (remote) {
              await new LockfileRepository(h.lockfilePath).replaceAll(remote);
            }
          },
          publish: async () => {
            if (failPublish) throw new Error("datastore unreachable");
            remote = await readUpstreamExtensions(h.lockfilePath);
          },
        },
        pending: {
          read: () => Promise.resolve(pending.value),
          write: (delta) => {
            pending.value = { kind: "delta", delta };
            return Promise.resolve();
          },
          clear: () => {
            pending.value = { kind: "none" };
            return Promise.resolve();
          },
        },
      });
    const install = (name: string) =>
      transaction().run(async () => {
        await (await LockfileRepository.create(h.lockfilePath)).writeEntry(
          name,
          "1",
          [],
        );
      });

    await assertRejects(() => install("@me/x"), Error, "unreachable");
    await assertRejects(() => install("@me/y"), Error, "unreachable");
    // A peer creates the datastore's first lockfile meanwhile.
    remote = { "@peer/z": entry("1") };
    failPublish = false;
    await transaction().refresh();

    assertEquals(Object.keys(remote ?? {}).sort(), [
      "@me/x",
      "@me/y",
      "@peer/z",
    ]);
    assertEquals(pending.value, { kind: "none" });
  });
});

Deno.test("ManagedLockfileTransaction.run: a failed publish surfaces as ManagedLockfileUnpublishedError", async () => {
  await withHarness(async (h) => {
    h.failPublish.value = true;
    await assertRejects(
      () =>
        h.transaction().run(async () => {
          await (await LockfileRepository.create(h.lockfilePath)).writeEntry(
            "@me/x",
            "1",
            [],
          );
        }),
      ManagedLockfileUnpublishedError,
      "datastore unreachable",
    );
  });
});

Deno.test("ManagedLockfileTransaction.run: a legacy record's local entries survive a fetch that overwrites the lockfile and then fails", async () => {
  await withHarness(async (h) => {
    // An older swamp's record: the change is not described.
    await new LockfileRepository(h.lockfilePath).replaceAll({
      "@me/new": entry("1"),
    });
    h.pending.value = { kind: "unknown" };
    h.remote.entries = { "@peer/p": entry("1") };

    // A fetch that downloads the lockfile, then fails on a later file.
    const failingFetch = new ManagedLockfileTransaction({
      lockfilePath: h.lockfilePath,
      lock: {
        acquire: () => Promise.resolve(),
        release: () => Promise.resolve(),
      },
      sync: {
        hydrate: async () => {
          await new LockfileRepository(h.lockfilePath).replaceAll(
            structuredClone(h.remote.entries),
          );
          throw new Error("timed out on a later file");
        },
        publish: () => Promise.resolve(),
      },
      pending: {
        read: () => Promise.resolve(h.pending.value),
        write: (delta) => {
          h.pending.value = { kind: "delta", delta };
          return Promise.resolve();
        },
        clear: () => {
          h.pending.value = { kind: "none" };
          return Promise.resolve();
        },
      },
    });
    await assertRejects(
      () => failingFetch.refresh(),
      Error,
      "timed out on a later file",
    );

    await h.transaction().refresh();
    assertEquals(Object.keys(h.remote.entries).sort(), ["@me/new", "@peer/p"]);
  });
});

Deno.test("ManagedLockfileTransaction.run: removing an extension an unpublished change added is recorded as a removal", async () => {
  await withHarness(async (h) => {
    h.failPublish.value = true;
    const change = (fn: (repo: LockfileRepository) => Promise<void>) =>
      h.transaction().run(async () =>
        fn(await LockfileRepository.create(h.lockfilePath))
      );
    await assertRejects(
      () => change((repo) => repo.writeEntry("@me/x", "1", [])),
      ManagedLockfileUnpublishedError,
    );
    await assertRejects(
      () => change((repo) => repo.removeEntry("@me/x")),
      ManagedLockfileUnpublishedError,
    );

    h.failPublish.value = false;
    await h.transaction().refresh();

    assertEquals(h.remote.entries, {});
    assertEquals(await readUpstreamExtensions(h.lockfilePath), {});
    assertEquals(h.pending.value, { kind: "none" });
  });
});
