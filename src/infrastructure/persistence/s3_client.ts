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

/**
 * Thin wrapper around AWS S3 SDK for datastore operations.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client as AwsS3Client,
} from "@aws-sdk/client-s3";
import type { S3ConnectionConfig } from "../../domain/datastore/datastore_config.ts";

export interface S3ListResult {
  keys: string[];
  truncated: boolean;
  continuationToken?: string;
}

/**
 * Thin S3 client wrapper for datastore operations.
 */
export class S3Client {
  private readonly client: AwsS3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(config: S3ConnectionConfig) {
    this.client = new AwsS3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      ...(config.forcePathStyle != null
        ? { forcePathStyle: config.forcePathStyle }
        : {}),
    });
    this.bucket = config.bucket;
    this.prefix = config.prefix ?? "";
  }

  private fullKey(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  /**
   * Checks if the bucket exists and is accessible.
   */
  async headBucket(): Promise<void> {
    await this.client.send(
      new HeadBucketCommand({ Bucket: this.bucket }),
    );
  }

  /**
   * Uploads an object to S3.
   */
  async putObject(key: string, body: Uint8Array): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
        Body: body,
      }),
    );
  }

  /**
   * Downloads an object from S3.
   */
  async getObject(key: string): Promise<Uint8Array> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
      }),
    );
    if (!response.Body) {
      throw new Error(`S3 GetObject returned empty body for key: ${key}`);
    }
    return new Uint8Array(await response.Body.transformToByteArray());
  }

  /**
   * Deletes an object from S3.
   */
  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
      }),
    );
  }

  /**
   * Checks if an object exists in S3.
   */
  async headObject(
    key: string,
  ): Promise<{ exists: boolean; size?: number; lastModified?: Date }> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.fullKey(key),
        }),
      );
      return {
        exists: true,
        size: response.ContentLength,
        lastModified: response.LastModified,
      };
    } catch (error) {
      if (
        error instanceof Error && "name" in error &&
        (error.name === "NotFound" || error.name === "NoSuchKey")
      ) {
        return { exists: false };
      }
      throw error;
    }
  }

  /**
   * Uploads an object only if it does not already exist (conditional write).
   * Uses S3 conditional writes (If-None-Match: *) to atomically check-and-create.
   * Returns true if the write succeeded, false if the object already exists.
   */
  async putObjectConditional(
    key: string,
    body: Uint8Array,
  ): Promise<boolean> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.fullKey(key),
          Body: body,
          IfNoneMatch: "*",
        }),
      );
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "PreconditionFailed" ||
          error.name === "ConditionalCheckFailed")
      ) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Lists objects in S3 with the configured prefix.
   */
  async listObjects(
    subPrefix?: string,
    continuationToken?: string,
  ): Promise<S3ListResult> {
    const prefix = subPrefix
      ? this.fullKey(subPrefix)
      : this.prefix
      ? this.prefix + "/"
      : undefined;

    const response = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    const prefixLen = this.prefix ? this.prefix.length + 1 : 0;
    const keys = (response.Contents ?? [])
      .map((obj) => obj.Key!)
      .map((key) => key.slice(prefixLen));

    return {
      keys,
      truncated: response.IsTruncated ?? false,
      continuationToken: response.NextContinuationToken,
    };
  }

  /**
   * Lists all objects (handling pagination).
   */
  async listAllObjects(subPrefix?: string): Promise<string[]> {
    const allKeys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const result = await this.listObjects(subPrefix, continuationToken);
      allKeys.push(...result.keys);
      continuationToken = result.truncated
        ? result.continuationToken
        : undefined;
    } while (continuationToken);

    return allKeys;
  }
}
