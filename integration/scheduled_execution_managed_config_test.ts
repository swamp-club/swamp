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

// Pins the schedule watcher to the directory the workflow loader reads
// (swamp-club#2946): under managed config the loader reads the config base's
// workflows directory, so that is where swamp serve must watch for schedule
// changes — not the repo-local workflows directory.
//
// Deno.watchFs is replaced with a fake for these tests: they check which
// directory the service watches and that a change event there reloads the
// schedule. Delivery by the OS is not what they pin, and relying on it made
// them fail whenever macOS fseventsd fell behind under load.

import { assertEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  registerManagedConfig,
  resetManagedConfigRegistry,
} from "../src/infrastructure/persistence/paths.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { ScheduledExecutionService } from "../src/libswamp/workflows/scheduled_execution.ts";

function workflowYaml(id: string, name: string, schedule?: string): string {
  const trigger = schedule ? `trigger:\n  schedule: "${schedule}"\n` : "";
  return `id: "${id}"
name: ${name}
jobs:
  - name: job
    steps:
      - name: step
        task:
          type: model_method
          modelIdOrName: my-model
          methodName: validate
${trigger}`;
}

async function writeFile(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await Deno.writeTextFile(path, content);
}

/** A Deno.FsWatcher whose events the test sends. */
class FakeWatcher implements AsyncIterable<Deno.FsEvent> {
  private readonly queue: Deno.FsEvent[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  constructor(readonly paths: string[]) {}

  send(kind: Deno.FsEvent["kind"], path: string): void {
    this.queue.push({ kind, paths: [path] });
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Deno.FsEvent> {
    while (true) {
      const event = this.queue.shift();
      if (event) {
        yield event;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => this.wake = resolve);
      this.wake = null;
    }
  }
}

/**
 * Runs `fn` with Deno.watchFs replaced by a factory that records each
 * FakeWatcher it creates, restoring the real one afterwards.
 */
async function withFakeWatchFs(
  fn: (watchers: FakeWatcher[]) => Promise<void>,
): Promise<void> {
  const watchers: FakeWatcher[] = [];
  const deno = Deno as unknown as { watchFs: unknown };
  const original = deno.watchFs;
  deno.watchFs = (paths: string | string[]) => {
    const watcher = new FakeWatcher(Array.isArray(paths) ? paths : [paths]);
    watchers.push(watcher);
    return watcher;
  };
  try {
    await fn(watchers);
  } finally {
    deno.watchFs = original;
  }
}

/** The one watcher the service started, once it has started it. */
async function startedWatcher(watchers: FakeWatcher[]): Promise<FakeWatcher> {
  await waitFor(() => watchers.length > 0, "the schedule watcher to start");
  assertEquals(watchers.length, 1);
  return watchers[0];
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp_schedule_watch_" });
  try {
    await fn(dir);
  } finally {
    resetManagedConfigRegistry();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function scheduleOf(
  service: ScheduledExecutionService,
  workflowId: string,
): string | undefined {
  return service.listSchedules().find((s) => s.workflowId === workflowId)
    ?.cronExpression;
}

Deno.test("scheduled execution: reloads schedules from the managed config workflows dir", async () => {
  await withFakeWatchFs(async (watchers) => {
    await withTempDir(async (dir) => {
      const repoDir = join(dir, "repo");
      const configBase = join(dir, "datastore", "config");
      const managedDir = join(configBase, "workflows");
      const repoLocalDir = join(repoDir, "workflows");
      await ensureDir(managedDir);
      await ensureDir(repoLocalDir);
      registerManagedConfig(repoDir, true, configBase);

      const existingId = crypto.randomUUID();
      const addedId = crypto.randomUUID();
      await writeFile(
        join(managedDir, "workflow-existing.yaml"),
        workflowYaml(existingId, "existing", "0 0 1 1 *"),
      );

      const service = new ScheduledExecutionService({
        workflowRepo: new YamlWorkflowRepository(
          repoDir,
          undefined,
          managedDir,
        ),
        repoDir,
        executeWorkflow: () => Promise.resolve(),
      });
      await service.start();
      try {
        assertEquals(scheduleOf(service, existingId), "0 0 1 1 *");

        // The service watches the managed dir the loader reads, not the
        // repo-local workflows dir.
        const watcher = await startedWatcher(watchers);
        assertEquals(watcher.paths, [managedDir]);

        // Adding a scheduled workflow to the managed dir registers it.
        const added = join(managedDir, "workflow-added.yaml");
        await writeFile(added, workflowYaml(addedId, "added", "30 3 1 1 *"));
        watcher.send("create", added);
        await waitFor(
          () => scheduleOf(service, addedId) === "30 3 1 1 *",
          "schedule registered for a workflow added to the managed dir",
        );
        assertEquals(scheduleOf(service, existingId), "0 0 1 1 *");

        // Changing a schedule in the managed dir re-registers it.
        const existing = join(managedDir, "workflow-existing.yaml");
        await writeFile(
          existing,
          workflowYaml(existingId, "existing", "15 4 1 1 *"),
        );
        watcher.send("modify", existing);
        await waitFor(
          () => scheduleOf(service, existingId) === "15 4 1 1 *",
          "schedule updated for a workflow changed in the managed dir",
        );
      } finally {
        await service.stop();
      }
    });
  });
});

Deno.test("scheduled execution: reloads schedules from the repo workflows dir without managed config", async () => {
  await withFakeWatchFs(async (watchers) => {
    await withTempDir(async (dir) => {
      const repoDir = join(dir, "repo");
      const workflowsDir = join(repoDir, "workflows");
      await ensureDir(workflowsDir);

      const service = new ScheduledExecutionService({
        workflowRepo: new YamlWorkflowRepository(repoDir),
        repoDir,
        executeWorkflow: () => Promise.resolve(),
      });
      await service.start();
      try {
        const watcher = await startedWatcher(watchers);
        assertEquals(watcher.paths, [workflowsDir]);

        const id = crypto.randomUUID();
        const added = join(workflowsDir, "workflow-added.yaml");
        await writeFile(added, workflowYaml(id, "added", "0 0 1 1 *"));
        watcher.send("create", added);
        await waitFor(
          () => scheduleOf(service, id) === "0 0 1 1 *",
          "schedule registered for a workflow added to the repo workflows dir",
        );
      } finally {
        await service.stop();
      }
    });
  });
});
