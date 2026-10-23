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
 * Whether the process a v3 writer record names is still running
 * (swamp-club#3564): one rule for the writer lease, the writer marker, the
 * checkout sidecar and the commit outbox.
 *
 * A record names its writer by pid and {@link ProcessIdentity}: the host
 * and pid namespace, the kernel's boot id and the process's start time. A
 * pid means something only on the kernel that assigned it, so a record is
 * judged by its pid only when it was written on this kernel: the same host
 * and namespace, and the same boot. Otherwise it is **unjudgeable**, and the
 * verdict is `unknown`: the caller falls back to the lease's TTL and fence,
 * never to "gone". A boot id that differs is unjudgeable too, never proof
 * of a reboot: two machines can share a hostname and the root pid
 * namespace's id. So is a boot id missing on either side where the platform
 * has one (Linux, macOS: a read that failed, an image without `cat`), since
 * the same hostname in the root namespace then names nothing. Only where no
 * boot id exists (Windows) do the host and pid alone decide, as before.
 *
 * The hostname stays part of this rule: VMs restored from one memory
 * snapshot share a boot id, and only their hostnames tell them apart, so
 * ignoring it could judge another machine's live writer gone. Questions
 * about this machine's own files, which other checks also guard (a
 * Litestream sidecar's lock and command line), use {@link sameKernel},
 * which survives a hostname change (swamp-club#3801).
 *
 * On this kernel, a pid that is absent, a zombie, or started at another
 * time than the record says is `gone`; any other present pid is `alive`.
 * When either side has no start time (the **start time is unreadable**:
 * Windows, another user's process, a failed probe), presence alone decides,
 * as it did before identities were recorded. The two cases are kept apart:
 * an unreadable start time never makes a record unjudgeable, since mapping
 * a live writer to `unknown` would let outbox recovery land its entry.
 *
 * @module
 */

/** The longest string an identity field may hold. */
const MAX_IDENTITY_FIELD_LENGTH = 1024;

/** Which process a record's pid belongs to, as recorded where it ran. */
export interface ProcessIdentity {
  /**
   * The host and pid namespace (`processHostIdentity()`): the hostname, and
   * on Linux the pid namespace's id.
   */
  readonly host: string;
  /** The kernel's boot id, where the platform gives one. */
  readonly bootId?: string;
  /** The process's start time, an opaque per-platform stamp. */
  readonly startTime?: string;
}

/** What a probe of a pid on this kernel finds, without disturbing it. */
export interface ProcessProbe {
  /** Whether a process with the pid exists, zombies included. */
  readonly present: boolean;
  /** Whether it has exited and waits to be reaped. */
  readonly zombie: boolean;
  /** Its start time, undefined when it cannot be read. */
  readonly startTime?: string;
}

/** Gone, alive, or not judgeable from this kernel. */
export type ProcessVerdict = "gone" | "alive" | "unknown";

/** The writer a record names. */
export interface RecordedProcess {
  readonly pid: number;
  /** Undefined in a record from a swamp before identities were recorded. */
  readonly process?: ProcessIdentity;
  /**
   * Whether the caller knows the record is not this process's, from a
   * token only this process holds (a marker's or an outbox entry's
   * instance). A record with this process's pid that is not its own was
   * written by a predecessor whose pid this process reuses.
   */
  readonly notThisProcess?: boolean;
}

/** This process, and how it probes another pid. */
export interface LocalProcess {
  readonly pid: number;
  readonly identity: ProcessIdentity;
  readonly probe: (pid: number) => ProcessProbe;
  /**
   * Whether the platform has a boot id, so a record or this process lacking
   * one cannot be placed on this kernel: false only on Windows.
   */
  readonly bootIdRequired: boolean;
  /**
   * Whether the platform has pid namespaces (Linux), so a host identity
   * without one is a namespace that could not be read. Unset, it is assumed
   * to: the hostname then decides whenever a namespace is missing.
   */
  readonly pidNamespaces?: boolean;
  /**
   * This machine's hostname now, which a record without an identity is
   * judged by. It may change while the process runs.
   */
  readonly hostname?: () => string;
}

/** Decides whether the writer `recorded` names is still running. */
export function judgeRecordedProcess(
  recorded: RecordedProcess,
  local: LocalProcess,
): ProcessVerdict {
  if (unjudgeable(recorded.process, local)) return "unknown";
  const identity = recorded.process!;
  if (recorded.pid === local.pid) {
    // This pid on this kernel is this process's. The record is a
    // predecessor's when a token says so, or when its start time is not
    // this process's.
    return recorded.notThisProcess === true ||
        startTimesDiffer(identity.startTime, local.identity.startTime)
      ? "gone"
      : "alive";
  }
  const probe = local.probe(recorded.pid);
  if (!probe.present || probe.zombie) return "gone";
  return startTimesDiffer(identity.startTime, probe.startTime)
    ? "gone"
    : "alive";
}

/**
 * Whether a recorded identity cannot be judged from this kernel: missing,
 * or from another host, namespace or boot. One side having a boot id and
 * the other not is another boot as far as anyone can tell, and where the
 * platform has boot ids, neither side having one places nothing.
 */
function unjudgeable(
  recorded: ProcessIdentity | undefined,
  local: LocalProcess,
): boolean {
  if (recorded === undefined || recorded.host !== local.identity.host) {
    return true;
  }
  if (recorded.bootId !== local.identity.bootId) return true;
  return local.bootIdRequired && recorded.bootId === undefined;
}

/**
 * Whether `recorded` was written on this kernel and pid namespace, whatever
 * the hostname was then (swamp-club#3801): the same boot id and pid
 * namespace. A DHCP renewal renames a machine under a running process, so a
 * file this machine keeps for itself (a Litestream sidecar's presence) is
 * judged by this, never by the hostname. A container sharing the host's
 * boot id is another namespace. Only when neither side names a namespace on
 * a platform that has them (it could not be read) does the hostname decide
 * alongside the boot id. Not for judging another writer gone: see
 * {@link judgeRecordedProcess}.
 */
export function sameKernel(
  recorded: ProcessIdentity,
  local: LocalProcess,
): boolean {
  const here = local.identity;
  if (recorded.bootId !== undefined && here.bootId !== undefined) {
    if (recorded.bootId !== here.bootId) return false;
    const namespace = pidNamespaceOf(recorded.host);
    const ours = pidNamespaceOf(here.host);
    if (namespace !== undefined || ours !== undefined) {
      return namespace === ours;
    }
    // Neither names a namespace: none exist here, or they could not be read.
    return local.pidNamespaces === false || recorded.host === here.host;
  }
  if (recorded.host !== here.host) return false;
  if (recorded.bootId !== here.bootId) return false;
  return !local.bootIdRequired;
}

/** The pid namespace a host identity names (`<hostname>#<namespace>`). */
function pidNamespaceOf(host: string): string | undefined {
  const at = host.lastIndexOf("#");
  return at === -1 ? undefined : host.slice(at + 1);
}

/**
 * Whether two start times prove two processes. When either is unreadable,
 * nothing is proved and presence decides.
 */
function startTimesDiffer(
  recorded: string | undefined,
  probed: string | undefined,
): boolean {
  const startTimeUnreadable = recorded === undefined || probed === undefined;
  return !startTimeUnreadable && recorded !== probed;
}

/**
 * Reads a record's `process` field, or undefined when it is missing or
 * malformed: such a record is judged as one from an older swamp.
 */
export function parseProcessIdentity(
  value: unknown,
): ProcessIdentity | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const { host, bootId, startTime } = value as Record<string, unknown>;
  if (!isField(host)) return undefined;
  if (bootId !== undefined && !isField(bootId)) return undefined;
  if (startTime !== undefined && !isField(startTime)) return undefined;
  return {
    host,
    ...(bootId !== undefined ? { bootId } : {}),
    ...(startTime !== undefined ? { startTime } : {}),
  };
}

function isField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_IDENTITY_FIELD_LENGTH;
}
