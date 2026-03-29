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

import { assertExists } from "@std/assert";
import type { S3ConnectionConfig } from "../../domain/datastore/datastore_config.ts";
import type { S3DatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { S3Client } from "./s3_client.ts";

Deno.test("S3Client: accepts S3ConnectionConfig", () => {
  const config: S3ConnectionConfig = {
    bucket: "my-bucket",
    prefix: "my-prefix",
    region: "us-west-2",
    endpoint: "https://nyc3.digitaloceanspaces.com",
    forcePathStyle: true,
  };

  const client = new S3Client(config);
  assertExists(client);
});

Deno.test("S3Client: accepts S3DatastoreConfig via structural subtyping", () => {
  const config: S3DatastoreConfig = {
    type: "s3",
    bucket: "my-bucket",
    prefix: "my-prefix",
    region: "us-west-2",
    endpoint: "https://nyc3.digitaloceanspaces.com",
    forcePathStyle: true,
    cachePath: "/tmp/cache",
  };

  // S3DatastoreConfig extends S3ConnectionConfig, so this compiles
  const client = new S3Client(config);
  assertExists(client);
});

Deno.test("S3Client: accepts minimal config with only bucket", () => {
  const config: S3ConnectionConfig = {
    bucket: "my-bucket",
  };

  const client = new S3Client(config);
  assertExists(client);
});
