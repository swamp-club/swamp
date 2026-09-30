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
 * Local record that a managed-config lockfile change failed to reach the
 * datastore (swamp-club#2752).
 *
 * The record holds the change itself, as a {@link LockfileDelta}, so the
 * next extension write can fetch the datastore's lockfile and replay the
 * change onto it instead of publishing a stale local copy over entries
 * other checkouts wrote meanwhile (swamp-club#2838). A record written by an
 * older swamp holds only a timestamp; it reads as `unknown`, a change whose
 * content was never recorded.
 *
 * It lives in the repo's own `.swamp/` directory, which is never synced, and
 * is cleared by the next successful lockfile publish or `datastore sync` push.
 */
const PENDING_FILE = "managed-config-lockfile-unpublished";
const PENDING_FORMAT_VERSION = 1;

/** A lockfile change that has not reached the datastore. */
export type LockfileEntryDelta = LockfileDelta<UpstreamExtensionEntry>;

/** What the pending record says about the local lockfile. */
export type PendingLockfilePublish =
  | { kind: "none" }
  | { kind: "delta"; delta: LockfileEntryDelta }
  | { kind: "unknown" };

function pendingPath(repoDir: string): string {
  return swampPath(repoDir, PENDING_FILE);
}

/**
 * Records `delta` as the lockfile change the datastore has not received.
 * It replaces any earlier record, so pass the whole outstanding change.
 * Without a delta, records a change of unknown content.
 */
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
 * Reads the pending record. A record that cannot be read or parsed counts
 * as `unknown`, so the caller errs towards keeping local entries.
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

/** Clears the record once the lockfile has reached the datastore. */
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
