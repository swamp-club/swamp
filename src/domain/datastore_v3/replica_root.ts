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
 * an S3 root matches any recorded S3 root with the same bucket and path: the
 * endpoint is only how a checkout reaches the bucket, and the lineage records
 * live there anyway, so it adds no protection
 */

export class ReplicaRoot {
  private constructor(
    readonly value: string,
    private readonly s3Suffix?: string,
  ) {}

  static of(value: string): ReplicaRoot {
    return new ReplicaRoot(value);
  }

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
    // the recorded root is never split on colons because the endpoint may hold
    // them; a root with no endpoint whose path merely ends in this bucket and
    // path does not match
    const endpoint = recorded.slice(
      "s3:".length,
      recorded.length - suffix.length,
    );
    return !endpoint.startsWith(":");
  }
}
