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

import { join, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import { FileLock } from "../persistence/file_lock.ts";
import {
  hubDir,
  type HubRecord,
  readHubRecord,
} from "../persistence/hub_record.ts";
import { refuseSymlinks } from "../persistence/start_session_file_repository.ts";
import { getSwampConfigDir, getSwampDataDir } from "../persistence/paths.ts";
import { HubAdminClient } from "../http/hub_admin_client.ts";
import type { HubBinaries } from "./hub_binary.ts";
import { type HubLiveness, hubRunsEngine, probeHub } from "./hub_probe.ts";
import { isProcessAlive } from "./process_kill.ts";

/** how long a hub this process launched waits for its last lease and engine */
export const HUB_EXIT_WHEN_IDLE = "60s";

const HUB_START_DEADLINE_MS = 60_000;
const HUB_STOP_DEADLINE_MS = 30_000;
const POLL_MS = 100;

export interface HubLauncherDeps {
  readonly dataDir: string;
  readonly binaries: HubBinaries;
  /** this swamp's build, compared with the running hub's engine */
  readonly gitSha: string;
  readRecord(): Promise<HubRecord | null>;
  probe(record: HubRecord): Promise<HubLiveness>;
  shutdown(record: HubRecord): Promise<boolean>;
  isAlive(pid: number): boolean;
  /** starts the hub detached and returns its pid */
  spawn(binary: string, args: string[]): number;
  withLock<T>(run: () => Promise<T>): Promise<T>;
  readonly startDeadlineMs?: number;
  readonly pollMs?: number;
}

export function hubLaunchArgs(
  dataDir: string,
  engine: string,
): string[] {
  return [
    "hub",
    "--engine",
    engine,
    "--bind",
    "127.0.0.1:0",
    "--record",
    join(hubDir(dataDir), "hub.json"),
    "--exit-when-idle",
    HUB_EXIT_WHEN_IDLE,
    "--log-file",
    join(hubDir(dataDir), "hub.log"),
    "--json",
  ];
}

async function waitUntil(
  check: () => Promise<boolean> | boolean,
  deadlineMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return await check();
}

/**
 * The user's running hub, or a new one this process launches. A hub running
 * another swamp build is replaced if swamp launched it and no page uses it.
 */
export async function findOrLaunchHub(
  deps: HubLauncherDeps,
): Promise<HubRecord> {
  return await deps.withLock(async () => {
    const pollMs = deps.pollMs ?? POLL_MS;
    const existing = await deps.readRecord();
    if (existing !== null && await deps.probe(existing) !== "dead") {
      if (
        hubRunsEngine(existing, deps.binaries.engine, deps.gitSha)
      ) {
        return existing;
      }
      if (!existing.autoExit) {
        throw new UserError(
          "Your swamp hub service runs another swamp build. Run `swamp hub daemon enable` to restart it on this one.",
          "hub_incompatible",
        );
      }
      if (!await deps.shutdown(existing)) {
        throw new UserError(
          "A swamp hub from another swamp build still has pages open. Close those `swamp start` or `swamp dashboard` sessions, then try again.",
          "hub_incompatible",
        );
      }
      const pid = existing.pid;
      if (
        !await waitUntil(
          () => !deps.isAlive(pid),
          HUB_STOP_DEADLINE_MS,
          pollMs,
        )
      ) {
        throw new UserError(
          `The swamp hub from another swamp build (pid ${pid}) did not stop. Stop it, then try again.`,
          "hub_incompatible",
        );
      }
    }
    const pid = deps.spawn(
      deps.binaries.hub,
      hubLaunchArgs(deps.dataDir, deps.binaries.engine),
    );
    const found: { record?: HubRecord } = {};
    await waitUntil(
      async () => {
        const record = await deps.readRecord();
        if (record === null || record.pid !== pid) return false;
        if (await deps.probe(record) !== "live") return false;
        found.record = record;
        return true;
      },
      deps.startDeadlineMs ?? HUB_START_DEADLINE_MS,
      pollMs,
    );
    if (found.record === undefined) {
      const log = join(hubDir(deps.dataDir), "hub.log");
      throw markErrorPaths(
        new UserError(
          `The swamp hub didn't start. See ${log} for why.`,
          "hub_unavailable",
        ),
        [log],
      );
    }
    return found.record;
  });
}

/** findOrLaunchHub on this machine's data dir */
export async function findOrLaunchLocalHub(
  binaries: HubBinaries,
  gitSha: string,
): Promise<HubRecord> {
  const dataDir = getSwampDataDir();
  await refuseSymlinks([dataDir, hubDir(dataDir)]);
  await ensureDir(hubDir(dataDir));
  const engine = await Deno.realPath(binaries.engine);
  return await findOrLaunchHub({
    dataDir,
    binaries: { hub: binaries.hub, engine },
    gitSha,
    readRecord: () => readHubRecord(dataDir),
    probe: (record) => probeHub(record),
    shutdown: (record) =>
      new HubAdminClient(record.port, record.adminToken).shutdown(),
    isAlive: isProcessAlive,
    spawn: (binary, args) => {
      // Its own process group and no pipes: the hub outlives this process
      // and serves every later swamp start or swamp dashboard.
      const child = new Deno.Command(binary, {
        args,
        stdin: "null",
        stdout: "null",
        stderr: "null",
        env: {
          ...Deno.env.toObject(),
          SWAMP_HOME: resolve(dataDir),
          SWAMP_CONFIG_DIR: resolve(getSwampConfigDir()),
        },
        clearEnv: true,
        detached: true,
      }).spawn();
      child.unref();
      return child.pid;
    },
    withLock: async (run) => {
      const lock = new FileLock(hubDir(dataDir), { lockKey: "launch.lock" });
      await lock.acquire();
      try {
        return await run();
      } finally {
        await lock.release();
      }
    },
  });
}
