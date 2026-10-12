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

import { basename, join } from "@std/path";
import { ensureDir } from "@std/fs";
import { z } from "zod";
import {
  StartSession,
  type StartSessionData,
} from "../../domain/start/start_session.ts";
import { StartTask } from "../../domain/start/start_task.ts";
import type {
  LegacyMigration,
  StartSessionRepository,
} from "../../domain/start/start_session_repository.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import {
  briefFileName,
  briefTaskText,
  isBriefFile,
  isSwampBrief,
  LEGACY_BRIEF_PATH,
  TASKS_DIR,
} from "../../domain/start/brief.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function removeIfPresent(
  path: string,
  options?: Deno.RemoveOptions,
): Promise<void> {
  try {
    await Deno.remove(path, options);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

/**
 * Refuses when any of `paths` is a symbolic link. An imported workspace is
 * someone else's folder: a link planted at `.swamp/start` or `tasks` would
 * otherwise make Swamp write or move files outside it.
 *
 * @throws {UserError} code `unsafe_path`
 */
export async function refuseSymlinks(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    if (info.isSymlink) {
      throw markErrorPaths(
        new UserError(
          `${path} is a symbolic link. Swamp won't write through it; remove it and try again.`,
          "unsafe_path",
        ),
        [path],
      );
    }
  }
}

/** The folders `swamp start` writes under, checked by {@link refuseSymlinks}. */
export function startWritePaths(workspacePath: string): string[] {
  return [
    join(workspacePath, ".swamp"),
    startDir(workspacePath),
    recordsDir(workspacePath),
    join(workspacePath, TASKS_DIR),
  ];
}

/** The folder under a workspace that holds every `swamp start` file. */
export function startDir(workspacePath: string): string {
  return join(workspacePath, ".swamp", "start");
}

/** The folder of task records, one `<id>.json` per task. */
function recordsDir(workspacePath: string): string {
  return join(startDir(workspacePath), "tasks");
}

/** A task brief's absolute path, from its workspace-relative one. */
export function briefPath(workspacePath: string, briefFile: string): string {
  if (!isBriefFile(briefFile)) {
    throw markErrorPaths(
      new Error(`Invalid task brief path ${JSON.stringify(briefFile)}`),
      [briefFile],
    );
  }
  return join(workspacePath, ...briefFile.split("/"));
}

const SCHEMA_VERSION = 1;

/**
 * What a task id may look like. It names a file under
 * `.swamp/start/tasks/`, so nothing read from disk that could leave that
 * folder (`..`, a separator) is accepted.
 */
const TASK_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

const TOOL_IDS = [
  "amp",
  "claude",
  "cursor",
  "opencode",
  "codex",
  "copilot",
  "kiro",
  "pi",
  "antigravity",
] as const;

const TaskDataSchema = z.object({
  id: z.string().regex(TASK_ID_PATTERN),
  workspacePath: z.string().min(1),
  // An ISO timestamp: its date becomes part of the brief's file name.
  createdAt: z.string().datetime(),
  step: z.enum(["task", "agent", "trust", "launched"]),
  task: z.string().optional(),
  harness: z.enum(TOOL_IDS).optional(),
  tools: z.array(z.enum(TOOL_IDS)).optional(),
  trustConfirmedAt: z.string().optional(),
  launch: z.object({
    method: z.enum([
      "macos_terminal",
      "windows_terminal",
      "linux_terminal",
      "copy_command",
    ]),
    at: z.string(),
    command: z.string(),
    opened: z.boolean(),
  }).optional(),
  briefFile: z.string().optional(),
});

const RecordFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  task: TaskDataSchema,
});

/** The one-session `state.json` (and `history/<id>/state.json`) of old. */
const LegacyStateSchema = z.object({
  schemaVersion: z.literal(1),
  session: TaskDataSchema.omit({ briefFile: true }),
});

/** The file beside a filed legacy session that named its brief. */
const LegacyBriefSchema = z.object({
  file: z.string(),
});

/**
 * Renames a file that can't be read to `<name>.unreadable-<time>`, so
 * nothing overwrites it. Returns the new path.
 */
async function setAside(path: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const aside = `${path}.unreadable-${stamp}`;
  await Deno.rename(path, aside);
  return aside;
}

/** An old `state.json`'s session, or null when missing or unreadable. */
async function readLegacyState(
  path: string,
): Promise<Omit<StartSessionData, "workspacePath"> | null> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
  try {
    const parsed = LegacyStateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const { workspacePath: _ignored, ...data } = parsed.data.session;
    // The same invariants a task read back must keep.
    StartSession.fromData({ ...data, workspacePath: "/" } as StartSessionData);
    return data as Omit<StartSessionData, "workspacePath">;
  } catch {
    return null;
  }
}

/** True when `path` is a regular file holding a brief swamp wrote. */
async function isOurFile(path: string): Promise<boolean> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
  if (!info.isFile) return false;
  return isSwampBrief(await Deno.readTextFile(path));
}

/** True when the file at `path` is a swamp brief written for `task`. */
async function isBriefFor(path: string, task: string): Promise<boolean> {
  if (!await isOurFile(path)) return false;
  return briefTaskText(await Deno.readTextFile(path))?.trim() === task.trim();
}

/**
 * The brief under `tasks/` written for `task` that no other task has
 * claimed, as a workspace-relative path, or undefined.
 */
async function findBriefFor(
  workspacePath: string,
  task: string,
  claimed: ReadonlySet<string>,
): Promise<string | undefined> {
  try {
    for await (const entry of Deno.readDir(join(workspacePath, TASKS_DIR))) {
      const file = `${TASKS_DIR}/${entry.name}`;
      if (!entry.isFile || !isBriefFile(file) || claimed.has(file)) continue;
      if (await isBriefFor(join(workspacePath, file), task)) return file;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return undefined;
}

/** A task text's title, for a brief's file name. */
function titleOf(task: string): string {
  return StartTask.create(task).title();
}

/**
 * The brief an old filed session recorded in its `brief.json`, when that is
 * a well-formed brief path still holding a brief swamp wrote.
 */
async function legacyFiledBrief(
  workspacePath: string,
  dir: string,
): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(join(dir, "brief.json"));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  try {
    const parsed = LegacyBriefSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || !isBriefFile(parsed.data.file)) return undefined;
    return await isOurFile(briefPath(workspacePath, parsed.data.file))
      ? parsed.data.file
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stores each task in `<workspace>/.swamp/start/tasks/<id>.json`, mode 0600;
 * its brief is `<workspace>/<briefFile>`, written at launch.
 */
export class StartSessionFileRepository implements StartSessionRepository {
  async list(workspacePath: string): Promise<StartSession[]> {
    const tasks = new Map<string, StartSession>();
    try {
      for await (const entry of Deno.readDir(recordsDir(workspacePath))) {
        const id = entry.name.replace(/\.json$/, "");
        if (
          !entry.isFile || !entry.name.endsWith(".json") ||
          !TASK_ID_PATTERN.test(id)
        ) {
          continue;
        }
        const task = await this.readRecord(workspacePath, id);
        if (task) tasks.set(task.id, task);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    // A workspace not opened since tasks got their own records still lists
    // its tasks, read from the old files without changing them.
    for (const legacy of await this.readLegacy(workspacePath)) {
      if (!tasks.has(legacy.session.id)) {
        tasks.set(legacy.session.id, legacy.session);
      }
    }
    return [...tasks.values()];
  }

  async load(workspacePath: string, id: string): Promise<StartSession | null> {
    if (!TASK_ID_PATTERN.test(id)) return null;
    return await this.readRecord(workspacePath, id);
  }

  async save(session: StartSession): Promise<void> {
    const data = session.toData();
    if (!TASK_ID_PATTERN.test(data.id)) {
      throw new Error(`Invalid task id ${JSON.stringify(data.id)}`);
    }
    await refuseSymlinks(startWritePaths(data.workspacePath));
    await ensureDir(recordsDir(data.workspacePath));
    const path = this.recordPath(data.workspacePath, data.id);
    // A record that exists but can't be read is kept, never overwritten.
    if (
      await exists(path) &&
      await this.readRecord(data.workspacePath, data.id) === null
    ) {
      await setAside(path);
    }
    await atomicWriteTextFile(
      path,
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, task: data }, null, 2) +
        "\n",
      { mode: 0o600 },
    );
  }

  async reserveBriefFile(
    workspacePath: string,
    createdAt: string,
    title: string,
  ): Promise<string> {
    const taken = new Set<string>();
    try {
      for await (const entry of Deno.readDir(join(workspacePath, TASKS_DIR))) {
        taken.add(entry.name);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    for (const task of await this.list(workspacePath)) {
      if (task.briefFile) taken.add(basename(task.briefFile));
    }
    const name = briefFileName(createdAt, title);
    let fileName = name;
    for (let n = 2; taken.has(fileName); n++) {
      fileName = name.replace(/\.md$/, `-${n}.md`);
    }
    return `${TASKS_DIR}/${fileName}`;
  }

  async migrateLegacy(workspacePath: string): Promise<LegacyMigration> {
    const kept: string[] = [];
    let migrated = 0;
    // Brief files already given to a task, so no two tasks share one.
    const claimed = new Set<string>();
    const start = startDir(workspacePath);
    const current = join(start, "state.json");
    const history = join(start, "history");
    if (!await exists(current) && !await exists(history)) {
      return { migrated, kept };
    }
    await refuseSymlinks([...startWritePaths(workspacePath), history]);

    // The old current task: its brief was TASK.md at the workspace root.
    if (await exists(current)) {
      const data = await readLegacyState(current);
      if (data === null) {
        kept.push(await setAside(current));
      } else {
        if (
          data.task !== undefined &&
          !await this.hasRecord(workspacePath, data.id)
        ) {
          let briefFile: string | undefined;
          const legacyBrief = join(workspacePath, LEGACY_BRIEF_PATH);
          // TASK.md is this task's brief only when it was written for this
          // task: reopening an older task used to leave another task's
          // TASK.md in place. A TASK.md that matches no task stays put.
          if (await isBriefFor(legacyBrief, data.task)) {
            briefFile = await this.reserveBriefFile(
              workspacePath,
              data.createdAt,
              titleOf(data.task),
            );
            await ensureDir(join(workspacePath, TASKS_DIR));
            try {
              await Deno.rename(
                legacyBrief,
                briefPath(workspacePath, briefFile),
              );
            } catch (error) {
              // Another `swamp start` moved it first.
              if (!(error instanceof Deno.errors.NotFound)) throw error;
              briefFile = undefined;
            }
          } else {
            briefFile = await findBriefFor(workspacePath, data.task, claimed);
          }
          if (briefFile !== undefined) claimed.add(briefFile);
          await this.saveMigrated(workspacePath, data, briefFile);
          migrated++;
        }
        await removeIfPresent(current);
      }
    }

    // Tasks filed by "Start a new task", their briefs already in tasks/.
    try {
      for await (const entry of Deno.readDir(history)) {
        if (!entry.isDirectory || !TASK_ID_PATTERN.test(entry.name)) continue;
        const dir = join(history, entry.name);
        await refuseSymlinks([dir]);
        const state = join(dir, "state.json");
        const data = await readLegacyState(state);
        if (data === null || data.id !== entry.name) {
          if (await exists(state)) kept.push(state);
          continue;
        }
        if (
          data.task !== undefined &&
          !await this.hasRecord(workspacePath, data.id)
        ) {
          let briefFile = await legacyFiledBrief(workspacePath, dir);
          if (
            briefFile === undefined || claimed.has(briefFile) ||
            !await isBriefFor(briefPath(workspacePath, briefFile), data.task)
          ) {
            briefFile = await findBriefFor(workspacePath, data.task, claimed);
          }
          if (briefFile !== undefined) claimed.add(briefFile);
          await this.saveMigrated(workspacePath, data, briefFile);
          migrated++;
        }
        await removeIfPresent(dir, { recursive: true });
      }
      // Only an empty history folder goes; one holding kept files stays.
      await Deno.remove(history).catch(() => {});
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return { migrated, kept };
  }

  private async hasRecord(
    workspacePath: string,
    id: string,
  ): Promise<boolean> {
    return await exists(this.recordPath(workspacePath, id));
  }

  private async saveMigrated(
    workspacePath: string,
    data: Omit<StartSessionData, "workspacePath">,
    briefFile: string | undefined,
  ): Promise<void> {
    const path = this.recordPath(workspacePath, data.id);
    // Another `swamp start` migrated it already.
    if (await exists(path)) return;
    await this.save(
      StartSession.fromData({
        ...data,
        workspacePath,
        ...(briefFile !== undefined ? { briefFile } : {}),
      } as StartSessionData),
    );
  }

  /** The old files' tasks, read only, for a workspace not yet migrated. */
  private async readLegacy(
    workspacePath: string,
  ): Promise<{ session: StartSession }[]> {
    const found: { session: StartSession }[] = [];
    const start = startDir(workspacePath);
    const add = (
      data: Omit<StartSessionData, "workspacePath"> | null,
      briefFile?: string,
    ) => {
      if (data === null || data.task === undefined) return;
      try {
        found.push({
          session: StartSession.fromData({
            ...data,
            workspacePath,
            ...(briefFile !== undefined ? { briefFile } : {}),
          } as StartSessionData),
        });
      } catch {
        // An inconsistent old file is left out, like any unreadable one.
      }
    };
    add(await readLegacyState(join(start, "state.json")));
    try {
      for await (const entry of Deno.readDir(join(start, "history"))) {
        if (!entry.isDirectory || !TASK_ID_PATTERN.test(entry.name)) continue;
        const dir = join(start, "history", entry.name);
        const data = await readLegacyState(join(dir, "state.json"));
        if (data === null || data.id !== entry.name) continue;
        add(data, await legacyFiledBrief(workspacePath, dir));
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return found;
  }

  /**
   * Reads one task record. A missing, damaged or other-version record, or
   * one naming another id, reads as none; the task's workspace path is the
   * folder it was read from, whatever the file says.
   */
  private async readRecord(
    workspacePath: string,
    id: string,
  ): Promise<StartSession | null> {
    let raw: string;
    try {
      raw = await Deno.readTextFile(this.recordPath(workspacePath, id));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
    try {
      const parsed = RecordFileSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || parsed.data.task.id !== id) return null;
      return StartSession.fromData({
        ...parsed.data.task,
        workspacePath,
      } as StartSessionData);
    } catch {
      return null;
    }
  }

  private recordPath(workspacePath: string, id: string): string {
    if (!TASK_ID_PATTERN.test(id)) {
      throw new Error(`Invalid task id ${JSON.stringify(id)}`);
    }
    return join(recordsDir(workspacePath), `${id}.json`);
  }
}
