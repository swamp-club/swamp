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

import { configure, type LogRecord, reset } from "@logtape/logtape";
import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { LockTimeoutError } from "../../domain/datastore/distributed_lock.ts";
import type { WorkspaceRegistry } from "../../domain/workspace/workspace_registry.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { WorkspaceRegistryFileRepository } from "../../infrastructure/persistence/workspace_registry_file_repository.ts";
import type { HostedRegistryDeps } from "../../libswamp/workspace/hosted_registration.ts";
import { createWorkspaceRegistrar } from "./workspace_registration.ts";

interface Fixture {
  readonly dir: string;
  readonly workspacesDir: string;
  readonly repository: WorkspaceRegistryFileRepository;
  readonly store: HostedRegistryDeps;
  /** replaces update; call `real` to go through to the file */
  interceptUpdate(
    fn: (
      real: <T>(change: (r: WorkspaceRegistry) => T) => Promise<T>,
    ) => Promise<void>,
  ): void;
  makeRepo(name: string): Promise<void>;
  names(): Promise<string[] | undefined>;
}

async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  const workspacesDir = join(dir, "workspaces");
  await Deno.mkdir(workspacesDir);
  const repository = new WorkspaceRegistryFileRepository(join(dir, "config"));
  let intercept:
    | ((real: typeof repository.update) => Promise<void>)
    | null = null;
  const store: HostedRegistryDeps = {
    dataDir: join(dir, "data"),
    now: () => new Date("2026-11-19T00:00:00.000Z"),
    repo: {
      isRepo: async (path) => {
        try {
          return (await Deno.stat(join(path, ".swamp.yaml"))).isFile;
        } catch {
          return false;
        }
      },
    },
    registry: {
      load: () => repository.load(),
      update: async (change) => {
        if (intercept !== null) {
          const hook = intercept;
          intercept = null;
          await hook((c) => repository.update(c));
        }
        return await repository.update(change);
      },
    },
  };
  try {
    await fn({
      dir,
      workspacesDir,
      repository,
      store,
      interceptUpdate: (hook) => intercept = hook,
      makeRepo: async (name) => {
        await Deno.mkdir(join(workspacesDir, name));
        await Deno.writeTextFile(join(workspacesDir, name, ".swamp.yaml"), "");
      },
      names: async () =>
        (await repository.load())?.list().map((e) => e.name).sort(),
    });
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function captured(fn: () => Promise<void>): Promise<LogRecord[]> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      {
        category: ["serve", "host", "workspaces"],
        lowestLevel: "info",
        sinks: ["capture"],
      },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
    reset: true,
  });
  try {
    await fn();
  } finally {
    await reset();
    await initializeLogging({});
  }
  return records;
}

const text = (record: LogRecord) => record.message.map(String).join("");

Deno.test("createWorkspaceRegistrar: registers what is served when the run starts, and drain waits for it", async () => {
  await withFixture(async (f) => {
    await f.makeRepo("alpha");
    await f.makeRepo("beta");
    const registrar = createWorkspaceRegistrar(f);
    let served = ["alpha"];
    registrar.sync(() => served);
    served = ["alpha", "beta"];
    await registrar.drain();
    assertEquals(await f.names(), ["alpha", "beta"]);
  });
});

Deno.test("createWorkspaceRegistrar: a clash is logged once across rescans and the registry is left as it is", async () => {
  await withFixture(async (f) => {
    await f.makeRepo("alpha");
    await f.repository.update((r) =>
      r.register({ name: "alpha", path: join(f.dir, "mine"), createdAt: "t" })
    );
    const file = join(f.dir, "config", "workspaces.json");
    const before = await Deno.readTextFile(file);
    const records = await captured(async () => {
      const registrar = createWorkspaceRegistrar(f);
      for (let i = 0; i < 3; i++) {
        registrar.sync(() => ["alpha"]);
        await registrar.drain();
      }
    });
    const errors = records.filter((r) => r.level === "error");
    assertEquals(errors.length, 1);
    const message = text(errors[0]);
    for (
      const part of [
        join(f.workspacesDir, "alpha"),
        join(f.dir, "mine"),
        "A later release stops serving this folder",
        "swamp workspace remove",
      ]
    ) {
      assertEquals(message.includes(part), true, `${part} in ${message}`);
    }
    assertEquals(await Deno.readTextFile(file), before);
  });
});

Deno.test("createWorkspaceRegistrar: a failed write is logged once and tried again at the next sync", async () => {
  await withFixture(async (f) => {
    await f.makeRepo("alpha");
    let failing = true;
    const store: HostedRegistryDeps = {
      ...f.store,
      registry: {
        load: () => f.repository.load(),
        update: (change) =>
          failing
            ? Promise.reject(new Error("lock timed out"))
            : f.repository.update(change),
      },
    };
    const records = await captured(async () => {
      const registrar = createWorkspaceRegistrar({
        workspacesDir: f.workspacesDir,
        store,
      });
      registrar.sync(() => ["alpha"]);
      await registrar.drain();
      registrar.sync(() => ["alpha"]);
      await registrar.drain();
      assertEquals(await f.names(), undefined);
      failing = false;
      registrar.sync(() => ["alpha"]);
      await registrar.drain();
    });
    assertEquals(
      records.filter((r) => text(r).includes("tried again at every rescan"))
        .length,
      1,
    );
    assertEquals(await f.names(), ["alpha"]);
  });
});

Deno.test("createWorkspaceRegistrar: an unreadable registry is logged once and never written", async () => {
  await withFixture(async (f) => {
    await f.makeRepo("alpha");
    const file = join(f.dir, "config", "workspaces.json");
    await Deno.mkdir(join(f.dir, "config"));
    await Deno.writeTextFile(file, "{nope");
    const records = await captured(async () => {
      const registrar = createWorkspaceRegistrar(f);
      registrar.sync(() => ["alpha"]);
      await registrar.drain();
      registrar.sync(() => ["alpha"]);
      await registrar.drain();
      await registrar.unregister("alpha");
    });
    assertEquals(
      records.filter((r) => text(r).includes("cannot be read")).length,
      1,
    );
    assertEquals(await Deno.readTextFile(file), "{nope");
  });
});

Deno.test("createWorkspaceRegistrar: an unregister waits for a sync in flight, so no entry is left after a removal", async () => {
  await withFixture(async (f) => {
    await f.makeRepo("alpha");
    const registrar = createWorkspaceRegistrar(f);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.interceptUpdate(async () => {
      entered.resolve();
      await release.promise;
    });
    let served = ["alpha"];
    registrar.sync(() => served);
    await entered.promise;
    served = [];
    const unregistered = registrar.unregister("alpha");
    release.resolve();
    await unregistered;
    await registrar.drain();
    assertEquals(await f.names(), []);
  });
});

Deno.test("createWorkspaceRegistrar: unregister rejects when the write fails", async () => {
  await withFixture(async (f) => {
    await f.repository.update((r) =>
      r.register({
        name: "alpha",
        path: join(f.workspacesDir, "alpha"),
        createdAt: "t",
      })
    );
    const registrar = createWorkspaceRegistrar({
      workspacesDir: f.workspacesDir,
      store: {
        ...f.store,
        registry: {
          load: () => f.repository.load(),
          update: () => Promise.reject(new Error("lock timed out")),
        },
      },
    });
    await assertRejects(
      () => registrar.unregister("alpha"),
      Error,
      "lock timed out",
    );
  });
});

Deno.test("createWorkspaceRegistrar: a forgotten name loses its entry, is retried after a failure, and is kept when served again", async () => {
  await withFixture(async (f) => {
    await f.makeRepo("alpha");
    await f.makeRepo("beta");
    const registrar = createWorkspaceRegistrar(f);
    registrar.sync(() => ["alpha", "beta"]);
    await registrar.drain();

    f.interceptUpdate(() => Promise.reject(new Error("lock timed out")));
    await captured(async () => {
      registrar.sync(() => ["beta"]);
      registrar.forget("alpha");
      await registrar.drain();
    });
    assertEquals(await f.names(), ["alpha", "beta"]);
    registrar.sync(() => ["beta"]);
    await registrar.drain();
    assertEquals(await f.names(), ["beta"]);

    registrar.forget("beta");
    registrar.sync(() => ["beta"]);
    await registrar.drain();
    assertEquals(await f.names(), ["beta"]);
  });
});

Deno.test("createWorkspaceRegistrar: a held lock ends the run at its first write, and is logged once without a stack, however many names wait", async () => {
  await withFixture(async (f) => {
    for (const name of ["a", "b", "c", "d"]) await f.makeRepo(name);
    const registrar = createWorkspaceRegistrar(f);
    registrar.sync(() => ["a", "b", "c", "d"]);
    await registrar.drain();

    let writes = 0;
    const timeout = () =>
      new LockTimeoutError(
        join(f.dir, "config", "workspaces.json.lock"),
        null,
        2000,
      );
    const held = createWorkspaceRegistrar({
      workspacesDir: f.workspacesDir,
      store: {
        ...f.store,
        registry: {
          load: () => f.repository.load(),
          update: () => {
            writes++;
            return Promise.reject(timeout());
          },
        },
      },
    });
    const records = await captured(async () => {
      for (const name of ["a", "b", "c"]) held.forget(name);
      held.sync(() => ["d"]);
      await held.drain();
      held.sync(() => ["d"]);
      await held.drain();
    });
    assertEquals(writes, 2, "one write attempt per run");
    const warnings = records.filter((r) => r.level === "warning");
    assertEquals(warnings.length, 1);
    assertEquals(
      warnings[0].properties.reason,
      "another process held its lock for longer than 2 s",
    );
  });
});

Deno.test("createWorkspaceRegistrar: after close no sync starts, a queued one is skipped, and a removal may still unregister", async () => {
  await withFixture(async (f) => {
    await f.makeRepo("alpha");
    await f.repository.update((r) =>
      r.register({
        name: "gone",
        path: join(f.workspacesDir, "gone"),
        createdAt: "t",
      })
    );
    const registrar = createWorkspaceRegistrar(f);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.interceptUpdate(async () => {
      entered.resolve();
      await release.promise;
    });
    // a forget whose run is held at its write, then one queued behind it
    registrar.sync(() => []);
    registrar.forget("gone");
    await entered.promise;
    registrar.sync(() => ["alpha"]);
    registrar.close();
    registrar.sync(() => ["alpha"]);
    const unregistered = registrar.unregister("gone");
    release.resolve();
    await unregistered;
    await registrar.drain();
    assertEquals(await f.names(), []);
  });
});
