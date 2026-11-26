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

import type { FingerprintRuntime } from "./fingerprint.ts";
import type { ServeMemberRecord } from "./serve_member.ts";

/** one instance's last check-in, as the hub's control-plane store holds it */
export interface MemberSighting {
  readonly instanceId: string;
  /** epoch ms */
  readonly at: number;
  /** null when the stored seen record has no runtime facts */
  readonly runtime: FingerprintRuntime | null;
}

// wire shapes, mirrored in packages/client; not readonly, so the parity test can match them exactly
export interface MemberLiveInstance {
  instanceId: string;
  lastSeenAt: string;
  runtime: FingerprintRuntime | null;
}

export interface MemberLiveView {
  /** the freshest instance's, or null when none has checked in */
  lastSeenAt: string | null;
  instances: MemberLiveInstance[];
}

/** a member's record with its last check-ins beside it, never inside it */
export interface ServeMemberLiveRecord extends ServeMemberRecord {
  live: MemberLiveView;
}

/** freshest first; ties keep a stable order by instance id */
export function memberLiveView(
  sightings: readonly MemberSighting[],
): MemberLiveView {
  const ordered = [...sightings].sort((a, b) =>
    b.at - a.at ||
    (a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0)
  );
  const instances = ordered.map((sighting) => ({
    instanceId: sighting.instanceId,
    lastSeenAt: new Date(sighting.at).toISOString(),
    runtime: sighting.runtime === null
      ? null
      : structuredClone(sighting.runtime),
  }));
  return {
    lastSeenAt: instances[0]?.lastSeenAt ?? null,
    instances,
  };
}
