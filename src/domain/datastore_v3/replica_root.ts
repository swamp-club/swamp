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
 * Which replica a v3 replication lineage replicates under (swamp-club#3801).
 *
 * A lineage records its replica root as a string, `s3:<endpoint>:<bucket>:
 * <path>`, `gcs:<bucket>:<path>` or `file:<path>`, and a checkout trusts only
 * lineages started under its own replica. The S3 endpoint is how a checkout
 * reaches the bucket, not which replica it is, just as path-style addressing
 * is not: two checkouts that spell one endpoint differently (a trailing
 * slash, the default endpoint explicit in one and implicit in the other, a
 * proxy in front of the service) replicate one datastore. So an S3 root
 * matches any recorded S3 root that names the same bucket and path. The
 * lineage records live in that bucket, so a truly different S3 service never
 * sees them; the endpoint adds no protection.
 *
 * The root is still written in full, so a swamp from before this rule that
 * spells the endpoint the same way still matches a lineage this one starts.
 *
 * Pure rules, no I/O.
 *
 * @module
 */

/** A checkout's own replica root, and which recorded roots name it. */
export class ReplicaRoot {
  private constructor(
    /** The root as a lineage records it. */
    readonly value: string,
    private readonly s3Suffix?: string,
  ) {}

  /** A root that matches only itself: GCS and file replicas. */
  static of(value: string): ReplicaRoot {
    return new ReplicaRoot(value);
  }

  /** An S3 root, which matches any endpoint spelling of its bucket and path. */
  static s3(
    endpoint: string | undefined,
    bucket: string,
    path: string,
  ): ReplicaRoot {
    return new ReplicaRoot(
      `s3:${endpoint ?? ""}:${bucket}:${path}`,
      `:${bucket}:${path}`,
    );
  }

  /** Whether the recorded root `recorded` names this replica. */
  matches(recorded: string): boolean {
    if (recorded === this.value) return true;
    const suffix = this.s3Suffix;
    if (
      suffix === undefined || !recorded.startsWith("s3:") ||
      !recorded.endsWith(suffix) ||
      recorded.length < "s3:".length + suffix.length
    ) {
      return false;
    }
    // The endpoint may hold colons (a scheme, a port), so the recorded root
    // is never split on them. A root with no endpoint whose path merely ends
    // in this bucket and path (`s3::other:x:<bucket>:<path>`) does not
    // match. A path holding colons can still make the format ambiguous; such
    // a root would have to be recorded in this datastore's own control plane.
    const endpoint = recorded.slice(
      "s3:".length,
      recorded.length - suffix.length,
    );
    return !endpoint.startsWith(":");
  }
}
