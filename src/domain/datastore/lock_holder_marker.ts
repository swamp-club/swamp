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

import { hostname } from "node:os";

/**
 * The pid of the nearest swamp above a child that has taken a per-model lock:
 * a swamp sets it to its own pid once it takes one, and until then leaves the
 * value it inherited. A single pid, so a child running an older swamp, which
 * reads only this name, still skips the real lock holder's locks through a
 * swamp in between that takes none.
 */
export const SWAMP_LOCK_HOLDER_PID = "SWAMP_LOCK_HOLDER_PID";

/**
 * Every swamp process above a child, comma-separated, oldest first, ending
 * with the one that started it. A nested swamp skips per-model locks held by
 * any of them on this host, since the run that started it holds its lock
 * until the child exits (design/enablers/datastores.md, "Parent-Process Lock
 * Awareness", for what that also skips).
 */
export const SWAMP_LOCK_ANCESTOR_PIDS = "SWAMP_LOCK_ANCESTOR_PIDS";

/** The most ancestors kept in the chain; the newest are kept. */
export const MAX_LOCK_ANCESTORS = 64;

/** The slice of `Deno.env` that {@link LockHolderMarker} reads and writes. */
export type LockHolderEnvStore = Pick<typeof Deno.env, "get" | "set">;

/** The owner fields a per-model lock file records. */
export interface LockOwner {
  readonly pid?: number;
  readonly hostname?: string;
}

interface Inherited {
  readonly holder: string | undefined;
  readonly ancestors: string | undefined;
}

/**
 * Hands this process's identity down to any swamp it starts, so the nested
 * swamp's per-model lock drain skips the locks its ancestors hold instead of
 * waiting on them (design/enablers/datastores.md, "Parent-Process Lock
 * Awareness").
 *
 * Never cleared: the chain is published once at startup and the holder once
 * the process first takes a lock. A lock file carrying a pid exists only
 * while that process holds it, so keeping either for the rest of the
 * process's life is equivalent to keeping it while it holds locks, and
 * concurrent lock holders in one process (parallel workflow steps,
 * `swamp serve` runs) cannot clear it under each other.
 */
export class LockHolderMarker {
  #inherited: Inherited | undefined;
  #holding = false;

  constructor(
    private readonly env: LockHolderEnvStore = Deno.env,
    private readonly pid: number = Deno.pid,
    private readonly host: () => string = hostname,
  ) {}

  /**
   * Captures what this process inherited, then publishes the ancestor chain
   * (inherited chain plus its own pid) for its children. The holder keeps its
   * inherited value until {@link markHoldingLocks}. Later calls do nothing.
   *
   * Writes the env it was built with: tests use an instance with an injected
   * store, never {@link processLockHolderMarker}, which writes the real
   * process env shared by every test file.
   */
  publish(): void {
    if (this.#inherited) {
      return;
    }
    const inherited: Inherited = {
      holder: this.env.get(SWAMP_LOCK_HOLDER_PID),
      ancestors: this.env.get(SWAMP_LOCK_ANCESTOR_PIDS),
    };
    // Captured before writing, so this process's drain still skips the
    // locks its ancestors hold.
    this.#inherited = inherited;
    const chain = [...inheritedChain(inherited, this.pid), this.pid]
      .slice(-MAX_LOCK_ANCESTORS);
    this.env.set(SWAMP_LOCK_ANCESTOR_PIDS, chain.join(","));
  }

  /**
   * Records that this process holds per-model locks, so an older child (which
   * reads only the holder) skips them. Called each time locks are acquired;
   * only the first call writes, and nothing clears it.
   *
   * Does not capture what was inherited; only {@link publish} does, so a
   * process's own drain skips its parent's holder even after this runs.
   */
  markHoldingLocks(): void {
    if (this.#holding) {
      return;
    }
    this.#holding = true;
    this.env.set(SWAMP_LOCK_HOLDER_PID, String(this.pid));
  }

  /**
   * The pids whose per-model locks this process's drain skips: the swamp
   * processes above it, never itself. Before {@link publish} (an embedder or
   * a unit test) this reads the live env.
   */
  ancestorPids(): ReadonlySet<number> {
    const inherited = this.#inherited ?? {
      holder: this.env.get(SWAMP_LOCK_HOLDER_PID),
      ancestors: this.env.get(SWAMP_LOCK_ANCESTOR_PIDS),
    };
    return new Set(inheritedChain(inherited, this.pid));
  }

  /**
   * A test for whether a lock file is held by one of this process's
   * ancestors: its pid is an ancestor's and it was taken on this host. A
   * process on another host sharing the datastore (e.g. over NFS) can carry
   * the same pid. A lock with no recorded hostname matches on pid alone.
   *
   * The hostname is read when the filter is built, not when the module
   * loads. If the host is renamed between an ancestor taking its lock and
   * this call (macOS can rename on a network change), the ancestor's lock no
   * longer matches and is waited on like any other.
   */
  ancestorLockFilter(): (lock: LockOwner) => boolean {
    const pids = this.ancestorPids();
    const host = this.host();
    return (lock) =>
      lock.pid !== undefined && pids.has(lock.pid) &&
      (lock.hostname === undefined || lock.hostname === host);
  }
}

/**
 * The inherited chain, seeded from the single holder when the parent
 * published no chain (an older swamp), deduplicated, without `ownPid`, and
 * capped at the newest {@link MAX_LOCK_ANCESTORS} entries.
 */
function inheritedChain(inherited: Inherited, ownPid: number): number[] {
  const chain: number[] = [];
  const seen = new Set<number>([ownPid]);
  const raw = (inherited.ancestors ?? "").split(",")
    .slice(-MAX_LOCK_ANCESTORS);
  raw.push(inherited.holder ?? "");
  for (const entry of raw) {
    const pid = parsePid(entry);
    if (pid !== undefined && !seen.has(pid)) {
      seen.add(pid);
      chain.push(pid);
    }
  }
  return chain.slice(-MAX_LOCK_ANCESTORS);
}

function parsePid(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) {
    return undefined;
  }
  const pid = Number(trimmed);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

/** The process-wide instance, published once by the CLI at startup. */
export const processLockHolderMarker: LockHolderMarker = new LockHolderMarker();
