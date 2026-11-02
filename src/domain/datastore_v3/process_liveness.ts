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
 * a pid means something only on the kernel that assigned it: a record from
 * another host, pid namespace or boot is unjudgeable (unknown), so callers fall
 * back to TTL and fence, never to gone
 */

const MAX_IDENTITY_FIELD_LENGTH = 1024;

export interface ProcessIdentity {
  readonly host: string;
  readonly bootId?: string;
  readonly startTime?: string;
}

export interface ProcessProbe {
  readonly present: boolean;
  readonly zombie: boolean;
  readonly startTime?: string;
}

export type ProcessVerdict = "gone" | "alive" | "unknown";

export interface RecordedProcess {
  readonly pid: number;
  readonly process?: ProcessIdentity;
  /**
   * the caller knows the record is not this process's from a token only it
   * holds; a record with this process's pid that is not its own came from a
   * predecessor whose pid was reused
   */
  readonly notThisProcess?: boolean;
}

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
 * a DHCP renewal renames a machine under a running process, so files this
 * machine keeps for itself are judged by boot id and pid namespace, not
 * hostname; not for judging another writer gone
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
