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

import { assertEquals } from "@std/assert";
import {
  litestreamChildEnv,
  parseLitestreamReplicaType,
} from "./sidecar_env.ts";
import {
  parseSupervisorArgs,
  supervisorArgs,
} from "./replication_supervisor.ts";

const ENV: Record<string, string> = {
  HOME: "/home/u",
  PATH: "/usr/bin",
  AWS_ACCESS_KEY_ID: "akid",
  AWS_SECRET_ACCESS_KEY: "secret",
  AWS_PROFILE: "team",
  GOOGLE_APPLICATION_CREDENTIALS: "/home/u/key.json",
  CLOUDSDK_CONFIG: "/home/u/.gcloud",
  STORAGE_EMULATOR_HOST: "http://localhost:4443",
  HTTPS_PROXY: "http://proxy:3128",
  no_proxy: "localhost",
  SSL_CERT_FILE: "/etc/ca.pem",
  SWAMP_HOME: "/home/u/.swamp",
  SWAMP_LITESTREAM_PATH: "/opt/litestream",
  SWAMP_API_KEY: "club-key",
  DENO_DIR: "/home/u/.deno",
  GITHUB_TOKEN: "ghp",
};

Deno.test("litestreamChildEnv: an S3 replica keeps AWS credentials, HOME, PATH, proxies and CA bundles only", () => {
  assertEquals(litestreamChildEnv("s3", ENV, "linux"), {
    HOME: "/home/u",
    PATH: "/usr/bin",
    AWS_ACCESS_KEY_ID: "akid",
    AWS_SECRET_ACCESS_KEY: "secret",
    AWS_PROFILE: "team",
    HTTPS_PROXY: "http://proxy:3128",
    no_proxy: "localhost",
    SSL_CERT_FILE: "/etc/ca.pem",
  });
});

Deno.test("litestreamChildEnv: a GCS replica keeps Google credentials, the emulator host, HOME, PATH, proxies and CA bundles only", () => {
  assertEquals(litestreamChildEnv("gcs", ENV, "linux"), {
    HOME: "/home/u",
    PATH: "/usr/bin",
    GOOGLE_APPLICATION_CREDENTIALS: "/home/u/key.json",
    CLOUDSDK_CONFIG: "/home/u/.gcloud",
    STORAGE_EMULATOR_HOST: "http://localhost:4443",
    HTTPS_PROXY: "http://proxy:3128",
    no_proxy: "localhost",
    SSL_CERT_FILE: "/etc/ca.pem",
  });
});

Deno.test("litestreamChildEnv: a file replica keeps HOME and PATH only", () => {
  assertEquals(litestreamChildEnv("file", ENV, "linux"), {
    HOME: "/home/u",
    PATH: "/usr/bin",
  });
});

Deno.test("litestreamChildEnv: swamp's own and unrelated secrets never reach Litestream", () => {
  for (const type of ["file", "s3", "gcs"] as const) {
    const env = litestreamChildEnv(type, ENV, "linux");
    for (const name of ["SWAMP_API_KEY", "GITHUB_TOKEN", "SWAMP_HOME"]) {
      assertEquals(env[name], undefined, `${type} leaked ${name}`);
    }
  }
});

Deno.test("litestreamChildEnv: on Windows names match case-insensitively and a child keeps what it needs to start", () => {
  const env = litestreamChildEnv("s3", {
    Path: "C:\\Windows",
    SystemRoot: "C:\\Windows",
    aws_region: "eu-west-1",
    UNRELATED: "x",
  }, "windows");
  assertEquals(env, {
    Path: "C:\\Windows",
    SystemRoot: "C:\\Windows",
    aws_region: "eu-west-1",
  });
});

Deno.test("supervisorArgs: carry the replica type, which parses back; one without it narrows nothing", () => {
  const options = {
    commitsDb: "/c/commits.db",
    privateRoot: "/p",
    lineageFence: 3,
    replicaPath: "x/_litestream/000000000003",
    replicaType: "gcs" as const,
    idleMs: 1,
    stopWaitMs: 1,
    tickMs: 1,
  };
  assertEquals(parseSupervisorArgs(supervisorArgs(options)), options);
  const { replicaType: _, ...untyped } = options;
  assertEquals(parseSupervisorArgs(supervisorArgs(untyped)), untyped);
  assertEquals(parseLitestreamReplicaType("azure"), undefined);
});
