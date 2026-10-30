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

/**
 * Explicit model leases (swamp-club#4121): a fenced lease a serve-mode
 * checkout takes with `swamp model lease acquire <behavior> --for
 * <duration>` and holds across commands. Serve holds it for its hold
 * between renewals; the checkout records it next to its copy, every swamp
 * command in the checkout renews it while it lives, and a command that
 * takes the behavior's lock uses it instead of asking for another.
 *
 * The record is this checkout's note of what it holds, never authority:
 * serve decides every renewal and every commit, so a hand-edited record
 * can at worst name a lease serve refuses.
 *
 * @module
 */

import { join } from "@std/path";
import type { DataNameMarks } from "../../domain/datastore_v3/commit_store.ts";
import { dataNameMarksFromJSON } from "../../domain/datastore_v3/observed_base.ts";
import { getSwampLogger } from "../logging/logger.ts";
import { atomicWriteTextFile } from "../persistence/atomic_write.ts";
import { FileLock } from "../persistence/file_lock.ts";
import type {
  LockLease,
  ServeDatastoreClient,
} from "./serve_datastore_client.ts";
import { type LandedVersion, raisedFloor } from "./serve_lease_registry.ts";
import { ServeUnreachableError } from "./serve_upstream_errors.ts";

const logger = getSwampLogger(["datastore", "v3", "lease"]);

/** The file, in a checkout's local root, that records its explicit leases. */
export const EXPLICIT_LEASES_FILE = "model_leases.json";

/** An explicit lease this checkout holds at serve. */
export interface ExplicitLease {
  readonly leaseId: string;
  /** Serve's canonical lock key, with no namespace. */
  readonly lockKey: string;
  readonly fence: number;
  /** Each renewal extends the lease by this long. */
  readonly holdMs: number;
  /** When the lease ends unless renewed, by serve's clock. */
  readonly expiresAt: string;
  /** The data-version floor serve gave when the lease was taken. */
  readonly floor: readonly DataNameMarks[];
}

/** What the explicit-lease operations need of serve's datastore API. */
export type ExplicitLeaseClient = Pick<
  ServeDatastoreClient,
  "acquireLock" | "renewLock" | "releaseLock"
>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The explicit leases recorded for the checkout root `root`. A missing file
 * is none; an entry that is not a well-formed lease is left out, with a
 * warning, rather than sent to serve.
 */
export async function readExplicitLeases(
  root: string,
): Promise<ExplicitLease[]> {
  let text: string;
  try {
    text = await Deno.readTextFile(join(root, EXPLICIT_LEASES_FILE));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    logger
      .warn`The record of this checkout's model leases is unreadable; ignoring it`;
    return [];
  }
  const entries = typeof parsed === "object" && parsed !== null &&
      Array.isArray((parsed as Record<string, unknown>).leases)
    ? (parsed as { leases: unknown[] }).leases
    : [];
  const leases: ExplicitLease[] = [];
  for (const entry of entries) {
    const lease = explicitLeaseOf(entry);
    if (lease === undefined) {
      logger.warn`Ignoring a malformed entry in this checkout's model leases`;
      continue;
    }
    leases.push(lease);
  }
  return leases;
}

function explicitLeaseOf(raw: unknown): ExplicitLease | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const fields = raw as Record<string, unknown>;
  if (
    typeof fields.leaseId !== "string" || !UUID.test(fields.leaseId) ||
    typeof fields.lockKey !== "string" || fields.lockKey.length > 512 ||
    !Number.isSafeInteger(fields.fence) || (fields.fence as number) < 0 ||
    !Number.isSafeInteger(fields.holdMs) || (fields.holdMs as number) <= 0 ||
    typeof fields.expiresAt !== "string" ||
    Number.isNaN(Date.parse(fields.expiresAt)) ||
    !Array.isArray(fields.floor)
  ) {
    return undefined;
  }
  let floor: DataNameMarks[];
  try {
    floor = fields.floor.map(dataNameMarksFromJSON);
  } catch {
    return undefined;
  }
  return {
    leaseId: fields.leaseId,
    lockKey: fields.lockKey,
    fence: fields.fence as number,
    holdMs: fields.holdMs as number,
    expiresAt: fields.expiresAt,
    floor,
  };
}

async function writeExplicitLeases(
  root: string,
  leases: readonly ExplicitLease[],
): Promise<void> {
  const path = join(root, EXPLICIT_LEASES_FILE);
  if (leases.length === 0) {
    await Deno.remove(path).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
    return;
  }
  await atomicWriteTextFile(path, JSON.stringify({ leases }, null, 2) + "\n");
}

/**
 * Runs `fn`, a read-modify-write of `root`'s record, under a lock local to
 * the checkout: each command in the checkout renews the record, so two of
 * them must never write back what the other changed.
 */
async function withRecordLock<T>(
  root: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = new FileLock(root, {
    lockKey: "explicit-leases/.record.lock",
    maxWaitMs: 30_000,
    retryIntervalMs: 25,
    maxBackoffMs: 250,
  });
  return await lock.withLock(fn);
}

/** The recorded lease on `lockKey` for `root`, if any. */
export async function explicitLeaseOn(
  root: string,
  lockKey: string,
): Promise<ExplicitLease | undefined> {
  return (await readExplicitLeases(root)).find((lease) =>
    lease.lockKey === lockKey
  );
}

/** Records `lease` for `root`, replacing any recorded on its key. */
export async function recordExplicitLease(
  root: string,
  lease: ExplicitLease,
): Promise<void> {
  await withRecordLock(root, async () => {
    const leases = (await readExplicitLeases(root)).filter((held) =>
      held.lockKey !== lease.lockKey
    );
    await writeExplicitLeases(root, [...leases, lease]);
  });
}

/**
 * Raises the floor recorded for explicit lease `leaseId` by versions a
 * commit under it recorded (swamp-club#4121), so the next command's floor
 * includes them; nothing when the record no longer names that lease.
 */
export async function raiseExplicitLeaseFloor(
  root: string,
  leaseId: string,
  landed: readonly LandedVersion[],
): Promise<void> {
  if (landed.length === 0) return;
  await withRecordLock(root, async () => {
    const leases = await readExplicitLeases(root);
    if (!leases.some((lease) => lease.leaseId === leaseId)) return;
    await writeExplicitLeases(
      root,
      leases.map((lease) =>
        lease.leaseId === leaseId
          ? { ...lease, floor: raisedFloor(lease.floor, landed) }
          : lease
      ),
    );
  });
}

/** Forgets the recorded lease `leaseId` for `root`. */
export async function forgetExplicitLease(
  root: string,
  leaseId: string,
): Promise<void> {
  await withRecordLock(root, async () => {
    const leases = await readExplicitLeases(root);
    const kept = leases.filter((held) => held.leaseId !== leaseId);
    if (kept.length !== leases.length) await writeExplicitLeases(root, kept);
  });
}

/**
 * The explicit lease `reply` grants, or undefined for a lease serve did
 * not fence (an older serve), which cannot be held across commands.
 */
export function explicitLeaseFrom(
  lease: LockLease,
  holdMs: number,
): ExplicitLease | undefined {
  if (lease.fence === undefined) return undefined;
  return {
    leaseId: lease.leaseId,
    lockKey: lease.lockKey,
    fence: lease.fence,
    holdMs: lease.holdMs ?? holdMs,
    expiresAt: lease.expiresAt,
    floor: lease.floor ?? [],
  };
}

/** What renewing a checkout's explicit leases found. */
export interface ExplicitLeaseRenewal {
  readonly renewed: readonly ExplicitLease[];
  /** Leases serve no longer holds: their records are forgotten. */
  readonly ended: readonly ExplicitLease[];
}

/**
 * Renews every explicit lease recorded for `root` at serve, as each swamp
 * command in the checkout does while the lease lives. A lease serve no
 * longer holds is forgotten; one that could not be renewed (serve away)
 * keeps its record, and lapses at serve once its hold passes.
 */
export async function renewExplicitLeases(
  root: string,
  client: Pick<ExplicitLeaseClient, "renewLock">,
  signal: AbortSignal,
): Promise<ExplicitLeaseRenewal> {
  const leases = await readExplicitLeases(root);
  if (leases.length === 0) return { renewed: [], ended: [] };
  const renewed: ExplicitLease[] = [];
  const ended: ExplicitLease[] = [];
  for (const lease of leases) {
    try {
      const reply = await client.renewLock(
        lease.leaseId,
        lease.holdMs,
        signal,
        { holdMs: lease.holdMs },
      );
      if (reply === undefined) {
        ended.push(lease);
        continue;
      }
      renewed.push({ ...lease, expiresAt: reply.expiresAt });
    } catch (error) {
      // Serve away: no other lease renews either, and each keeps its
      // record, judged by its recorded end offline (swamp-club#4195). Said
      // once, without the failure's stack.
      if (error instanceof ServeUnreachableError) {
        logger
          .info`Serve is unreachable, so this checkout's model leases were not renewed; each holds until its recorded end`;
        break;
      }
      logger
        .warn`Could not renew the model lease on ${lease.lockKey} at serve: ${error}`;
    }
  }
  // Merged into the record as it stands now, not as it was read: another
  // command may have taken or released a lease meanwhile.
  if (renewed.length > 0 || ended.length > 0) {
    const endedIds = new Set(ended.map((lease) => lease.leaseId));
    const expiries = new Map(
      renewed.map((lease) => [lease.leaseId, lease.expiresAt]),
    );
    await withRecordLock(root, async () => {
      const current = await readExplicitLeases(root);
      await writeExplicitLeases(
        root,
        current
          .filter((lease) => !endedIds.has(lease.leaseId))
          .map((lease) => {
            const expiresAt = expiries.get(lease.leaseId);
            return expiresAt === undefined ? lease : { ...lease, expiresAt };
          }),
      );
    });
  }
  for (const lease of ended) {
    logger
      .warn`The model lease on ${lease.lockKey} has ended at serve; forgetting it`;
  }
  return { renewed, ended };
}

/** Serve granted the lock to someone else for the whole wait. */
export class ExplicitLeaseHeldError extends Error {
  constructor(
    readonly lockKey: string,
    readonly heldBy: string,
    readonly waitedMs: number,
  ) {
    const holder = heldBy === "caller"
      ? "another command of yours"
      : heldBy === "serve"
      ? "serve's own work"
      : "another caller";
    super(
      `The lock ${lockKey} is held at serve by ${holder}; gave up after ` +
        `${waitedMs}ms. See who holds it with 'swamp datastore lock status'`,
    );
    this.name = "ExplicitLeaseHeldError";
  }
}

/** Serve granted a lease it does not fence: it is too old to hold one. */
export class ExplicitLeaseUnsupportedError extends Error {
  constructor() {
    super(
      "This serve does not fence model leases, so a lease cannot be held " +
        "across commands: upgrade serve",
    );
    this.name = "ExplicitLeaseUnsupportedError";
  }
}

/** The short TTL an explicit lease is first taken for, before it is recorded. */
const ACQUIRE_TTL_MS = 30_000;
/** The longest one acquire request asks serve to wait. */
const ACQUIRE_REQUEST_WAIT_MS = 10_000;

/**
 * Takes an explicit lease on `lockKey` for `root`, held for `holdMs`
 * between renewals, waiting up to `maxWaitMs` while another holds the
 * lock, and records it. A lease this checkout already records on the key
 * is renewed for `holdMs` and returned instead (`existing: true`).
 *
 * The lease is taken for a command's short TTL, recorded, and only then
 * extended to `holdMs`: a reply lost on the way strands it for that short
 * TTL, never for its whole hold.
 *
 * @throws ExplicitLeaseHeldError when the lock is still held after the wait
 * @throws ExplicitLeaseUnsupportedError when serve does not fence leases
 */
export async function acquireExplicitLease(
  root: string,
  client: ExplicitLeaseClient & { readonly timeoutMs: number },
  lockKey: string,
  holdMs: number,
  maxWaitMs: number,
  signal: AbortSignal,
): Promise<{ lease: ExplicitLease; existing: boolean }> {
  const recorded = await explicitLeaseOn(root, lockKey);
  if (recorded !== undefined) {
    const renewed = await client.renewLock(
      recorded.leaseId,
      holdMs,
      signal,
      { holdMs },
    );
    if (renewed !== undefined) {
      const lease = { ...recorded, holdMs, expiresAt: renewed.expiresAt };
      await recordExplicitLease(root, lease);
      return { lease, existing: true };
    }
    await forgetExplicitLease(root, recorded.leaseId);
  }
  const started = performance.now();
  let heldBy = "other";
  while (true) {
    const remaining = maxWaitMs - (performance.now() - started);
    const waitMs = Math.max(
      0,
      Math.floor(
        Math.min(
          remaining,
          ACQUIRE_REQUEST_WAIT_MS,
          client.timeoutMs / 2,
        ),
      ),
    );
    const reply = await client.acquireLock(
      lockKey,
      ACQUIRE_TTL_MS,
      waitMs,
      signal,
    );
    if (reply.acquired) {
      const taken = explicitLeaseFrom(reply.lease, holdMs);
      if (taken === undefined) {
        // Bounded by the client's own per-request timeout.
        await client.releaseLock(reply.lease.leaseId, signal).catch(() =>
          false
        );
        throw new ExplicitLeaseUnsupportedError();
      }
      await recordExplicitLease(root, taken);
      const extended = await client.renewLock(
        taken.leaseId,
        holdMs,
        signal,
        { holdMs },
      );
      if (extended === undefined) {
        await forgetExplicitLease(root, taken.leaseId);
        throw new ExplicitLeaseHeldError(
          lockKey,
          "serve",
          Math.round(performance.now() - started),
        );
      }
      const lease = { ...taken, expiresAt: extended.expiresAt };
      await recordExplicitLease(root, lease);
      return { lease, existing: false };
    }
    heldBy = reply.heldBy;
    if (performance.now() - started >= maxWaitMs) {
      throw new ExplicitLeaseHeldError(
        lockKey,
        heldBy,
        Math.round(performance.now() - started),
      );
    }
    if (waitMs === 0) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/**
 * Ends the explicit lease this checkout records on `lockKey` at serve and
 * forgets it. False when none is recorded. A lease serve already ended is
 * forgotten all the same.
 */
export async function releaseExplicitLease(
  root: string,
  client: Pick<ExplicitLeaseClient, "releaseLock">,
  lockKey: string,
  signal: AbortSignal,
): Promise<boolean> {
  const recorded = await explicitLeaseOn(root, lockKey);
  if (recorded === undefined) return false;
  await client.releaseLock(recorded.leaseId, signal);
  await forgetExplicitLease(root, recorded.leaseId);
  return true;
}
