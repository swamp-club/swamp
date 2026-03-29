// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import type { S3ConnectionConfig } from "../../domain/datastore/datastore_config.ts";
import type {
  DatastoreHealthResult,
  DatastoreVerifier,
} from "../../domain/datastore/datastore_health.ts";
import { S3Client } from "./s3_client.ts";

/**
 * Verifies an S3 datastore is accessible.
 *
 * Issues a HeadBucket request to verify the bucket exists
 * and credentials are valid.
 */
export class S3DatastoreVerifier implements DatastoreVerifier {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(config: S3ConnectionConfig) {
    this.bucket = config.bucket;
    this.s3 = new S3Client(config);
  }

  async verify(): Promise<DatastoreHealthResult> {
    const start = performance.now();

    try {
      await this.s3.headBucket();

      return {
        healthy: true,
        message: `S3 bucket '${this.bucket}' is accessible`,
        latencyMs: performance.now() - start,
        datastoreType: "s3",
        details: { bucket: this.bucket },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let hint = "";

      if (message.includes("403") || message.includes("Forbidden")) {
        hint = " Check your AWS credentials and bucket permissions.";
      } else if (message.includes("404") || message.includes("NotFound")) {
        hint = ` The bucket '${this.bucket}' does not exist.`;
      } else if (message.includes("credentials")) {
        hint =
          " Configure AWS credentials (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or ~/.aws/credentials).";
      }

      return {
        healthy: false,
        message: `Cannot access S3 bucket '${this.bucket}': ${message}.${hint}`,
        latencyMs: performance.now() - start,
        datastoreType: "s3",
        details: { bucket: this.bucket },
      };
    }
  }
}
