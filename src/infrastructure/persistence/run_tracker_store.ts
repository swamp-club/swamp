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

import { DatabaseSync } from "node:sqlite";
import { dirname } from "@std/path";
import { ensureDirSync } from "@std/fs";
import { hostname } from "node:os";
import { getLogger } from "@logtape/logtape";
import {
  ActiveRun,
  type ActiveRunData,
  type ActiveRunStatus,
} from "../../domain/models/active_run.ts";
import type { RunTrackerRepository } from "../../domain/models/run_tracker_repository.ts";
import { isProcessDead } from "../runtime/process.ts";

import { join } from "@std/path";

const logger = getLogger(["swamp", "persistence", "run-tracker"]);

const RUN_TRACKER_DB_NAME = "run_tracker.db";

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
export { STALE_TTL_MS as DEFAULT_STALE_TTL_MS } from "../../domain/models/active_run.ts";
const RETENTION_DAYS = 7;
const SCHEMA_VERSION = 1;

interface ActiveRunRow {
  id: string;
  run_kind: string;
  model_type: string | null;
  method_name: string | null;
  workflow_name: string | null;
  pid: number;
  hostname: string;
  started_at: string;
  heartbeat_at: string;
  status: string;
  completed_at: string | null;
}

export class RunTrackerStore implements RunTrackerRepository {
  private db: DatabaseSync;
  private readonly dbPath: string;
  private closed = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    ensureDirSync(dirname(dbPath));
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA busy_timeout=5000");
    this.initializeWithRetry();
  }

  private initializeWithRetry(): void {
    const MAX_RETRIES = 5;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const modeRow = this.db.prepare("PRAGMA journal_mode").get() as
          | { journal_mode: string }
          | undefined;
        if (modeRow?.journal_mode !== "wal") {
          this.db.exec("PRAGMA journal_mode=WAL");
        }
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS run_tracker_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
        `);
        this.migrateIfNeeded();
        this.createSchema();
        this.purgeOldRuns();
        return;
      } catch (error: unknown) {
        const isLock = error instanceof Error &&
          /database is (locked|busy)/i.test(error.message);
        if (isLock && attempt < MAX_RETRIES) {
          const delay = 100 * Math.pow(2, attempt) +
            Math.floor(Math.random() * 50);
          Atomics.wait(
            new Int32Array(new SharedArrayBuffer(4)),
            0,
            0,
            delay,
          );
          continue;
        }
        throw error;
      }
    }
  }

  private migrateIfNeeded(): void {
    const row = this.db.prepare(
      "SELECT value FROM run_tracker_meta WHERE key = 'schema_version'",
    ).get() as { value: string } | undefined;
    const currentVersion = row ? Number(row.value) : 0;
    if (currentVersion >= SCHEMA_VERSION) return;

    if (currentVersion < 1) {
      // v0 → v1: add completed_at column if table already exists without it
      const tableExists = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='active_runs'",
      ).get();
      if (tableExists) {
        const columns = this.db.prepare(
          "PRAGMA table_info(active_runs)",
        ).all() as unknown as { name: string }[];
        const hasCompletedAt = columns.some((c) => c.name === "completed_at");
        if (!hasCompletedAt) {
          this.db.exec(
            "ALTER TABLE active_runs ADD COLUMN completed_at TEXT",
          );
        }
      }
    }

    this.db.prepare(
      "INSERT OR REPLACE INTO run_tracker_meta (key, value) VALUES ('schema_version', ?)",
    ).run(String(SCHEMA_VERSION));
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS active_runs (
        id            TEXT PRIMARY KEY,
        run_kind      TEXT NOT NULL,
        model_type    TEXT,
        method_name   TEXT,
        workflow_name TEXT,
        pid           INTEGER NOT NULL,
        hostname      TEXT NOT NULL,
        started_at    TEXT NOT NULL,
        heartbeat_at  TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'running',
        completed_at  TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_active_runs_status
        ON active_runs(status);
      CREATE INDEX IF NOT EXISTS idx_active_runs_heartbeat
        ON active_runs(heartbeat_at);
    `);
  }

  private purgeOldRuns(): void {
    const cutoff = new Date(
      Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const result = this.db.prepare(
      "DELETE FROM active_runs WHERE status != 'running' AND completed_at IS NOT NULL AND completed_at < ?",
    ).run(cutoff);
    if (result.changes > 0) {
      logger
        .debug`Purged ${result.changes} terminal run(s) older than ${RETENTION_DAYS} days`;
    }
  }

  register(run: ActiveRun): void {
    const data = run.toData();
    this.db.prepare(`
      INSERT INTO active_runs
        (id, run_kind, model_type, method_name, workflow_name,
         pid, hostname, started_at, heartbeat_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.id,
      data.runKind,
      data.modelType,
      data.methodName,
      data.workflowName,
      data.pid,
      data.hostname,
      data.startedAt,
      data.heartbeatAt,
      data.status,
    );
  }

  heartbeat(runId: string): void {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE active_runs SET heartbeat_at = ?
      WHERE id = ? AND status = 'running'
    `).run(now, runId);
    if (result.changes === 0) {
      logger
        .debug`Heartbeat skipped for run ${runId} — not found or not running`;
    }
  }

  complete(runId: string, status: ActiveRunStatus): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE active_runs SET status = ?, completed_at = ?
      WHERE id = ? AND status IN ('running', 'suspended')
    `).run(status, now, runId);
  }

  reactivate(runId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE active_runs SET status = 'running', heartbeat_at = ?, completed_at = NULL
      WHERE id = ? AND status = 'suspended'
    `).run(now, runId);
  }

  findById(runId: string): ActiveRun | null {
    const row = this.db.prepare(
      "SELECT * FROM active_runs WHERE id = ?",
    ).get(runId) as ActiveRunRow | undefined;
    if (!row) return null;
    return ActiveRun.fromData(this.rowToData(row));
  }

  findAllRunning(): ActiveRun[] {
    const rows = this.db.prepare(
      "SELECT * FROM active_runs WHERE status = 'running' ORDER BY started_at DESC",
    ).all() as unknown as ActiveRunRow[];
    return rows.map((r) => ActiveRun.fromData(this.rowToData(r)));
  }

  findStaleRuns(ttlMs: number): ActiveRun[] {
    const cutoff = new Date(Date.now() - ttlMs).toISOString();
    const rows = this.db.prepare(
      "SELECT * FROM active_runs WHERE status = 'running' AND heartbeat_at < ? ORDER BY started_at DESC",
    ).all(cutoff) as unknown as ActiveRunRow[];
    return rows.map((r) => ActiveRun.fromData(this.rowToData(r)));
  }

  findAll(): ActiveRun[] {
    const rows = this.db.prepare(
      "SELECT * FROM active_runs ORDER BY started_at DESC",
    ).all() as unknown as ActiveRunRow[];
    return rows.map((r) => ActiveRun.fromData(this.rowToData(r)));
  }

  findRecent(hours: number = 24): ActiveRun[] {
    const cutoff = new Date(
      Date.now() - hours * 60 * 60 * 1000,
    ).toISOString();
    const rows = this.db.prepare(
      "SELECT * FROM active_runs WHERE started_at > ? OR status = 'running' ORDER BY started_at DESC",
    ).all(cutoff) as unknown as ActiveRunRow[];
    return rows.map((r) => ActiveRun.fromData(this.rowToData(r)));
  }

  reapStaleRuns(ttlMs: number): ActiveRun[] {
    const currentHostname = hostname();
    const stale = this.findStaleRuns(ttlMs);
    const reaped: ActiveRun[] = [];

    for (const run of stale) {
      const shouldReap = run.hostname === currentHostname
        ? isProcessDead(run.pid)
        : true; // Cross-machine: rely on TTL alone

      if (shouldReap) {
        this.complete(run.id, "failed");
        reaped.push(run);
      }
    }

    return reaped;
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }

  static fromSwampDir(swampDir: string): RunTrackerStore {
    return new RunTrackerStore(join(swampDir, RUN_TRACKER_DB_NAME));
  }

  private rowToData(row: ActiveRunRow): ActiveRunData {
    return {
      id: row.id,
      runKind: row.run_kind as ActiveRunData["runKind"],
      modelType: row.model_type,
      methodName: row.method_name,
      workflowName: row.workflow_name,
      pid: row.pid,
      hostname: row.hostname,
      startedAt: row.started_at,
      heartbeatAt: row.heartbeat_at,
      status: row.status as ActiveRunStatus,
    };
  }
}
