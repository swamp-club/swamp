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

import type { LockfileDelta } from "../../domain/extensions/lockfile_delta.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { swampPath } from "./paths.ts";
import type { UpstreamExtensionEntry } from "./upstream_extensions.ts";

/**
 * a lockfile change that missed the datastore, kept as a delta so the next
 * extension write replays it onto the datastore copy; lives in the unsynced
 * .swamp dir, cleared by the next successful publish
 */
const PENDING_FILE = "managed-config-lockfile-unpublished";
const PENDING_FORMAT_VERSION = 1;

export type LockfileEntryDelta = LockfileDelta<UpstreamExtensionEntry>;

export type PendingLockfilePublish =
  | { kind: "none" }
  | { kind: "delta"; delta: LockfileEntryDelta }
  | { kind: "unknown" };

function pendingPath(repoDir: string): string {
  return swampPath(repoDir, PENDING_FILE);
}

export async function markLockfilePublishPending(
  repoDir: string,
  delta?: LockfileEntryDelta,
): Promise<void> {
  const content = delta
    ? JSON.stringify({
      version: PENDING_FORMAT_VERSION,
      upserts: delta.upserts,
      removals: delta.removals,
    })
    : new Date().toISOString();
  await atomicWriteTextFile(pendingPath(repoDir), content);
}

/**
 * a record that cannot be read or parsed counts as unknown, so the caller errs
 * towards keeping local entries
 */
export async function readLockfilePublishPending(
  repoDir: string,
): Promise<PendingLockfilePublish> {
  let content: string;
  try {
    content = await Deno.readTextFile(pendingPath(repoDir));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { kind: "none" };
    return { kind: "unknown" };
  }
  const delta = parseDelta(content);
  return delta ? { kind: "delta", delta } : { kind: "unknown" };
}

export async function clearLockfilePublishPending(
  repoDir: string,
): Promise<void> {
  try {
    await Deno.remove(pendingPath(repoDir));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

function parseDelta(content: string): LockfileEntryDelta | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.version !== PENDING_FORMAT_VERSION) {
    return undefined;
  }
  const { upserts, removals } = parsed;
  if (!isRecord(upserts) || !Array.isArray(removals)) return undefined;
  if (!removals.every((name) => typeof name === "string")) return undefined;
  for (const entry of Object.values(upserts)) {
    if (!isRecord(entry) || typeof entry.version !== "string") {
      return undefined;
    }
  }
  return {
    upserts: upserts as Record<string, UpstreamExtensionEntry>,
    removals: removals as string[],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * a recorded delta is kept: it is the only copy of the change, and replaying it
 * is harmless if the push already delivered it, while the push may have been
 * overwritten
 */
export async function clearUnrecordedLockfilePublishPending(
  repoDir: string,
): Promise<void> {
  const pending = await readLockfilePublishPending(repoDir);
  if (pending.kind !== "unknown") return;
  await clearLockfilePublishPending(repoDir);
}
