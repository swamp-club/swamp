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
import { resolve } from "@std/path";
import { hostChildEnv } from "./child_env.ts";

const HOST_CWD = resolve("host-cwd");
const PINNED = {
  swampHome: "/data/swamp",
  configDir: "/config/swamp",
  cwd: HOST_CWD,
};

Deno.test("hostChildEnv: keeps what a child needs to run and reach the network", () => {
  const env = hostChildEnv({
    PATH: "/usr/bin",
    HOME: "/home/op",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    https_proxy: "http://proxy:3128",
    HTTPS_PROXY: "http://proxy:3128",
    no_proxy: "localhost",
    SSL_CERT_FILE: "/etc/ssl/ca.pem",
    SSL_CERT_DIR: "/etc/ssl/certs",
    DENO_CERT: "/etc/ssl/ca.pem",
    DENO_TLS_CA_STORE: "system",
    ALL_PROXY: "socks5://proxy:1080",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel:4318",
    Path: "C:\\Windows",
    SystemRoot: "C:\\Windows",
  }, PINNED);
  assertEquals(env, {
    PATH: "/usr/bin",
    HOME: "/home/op",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    https_proxy: "http://proxy:3128",
    HTTPS_PROXY: "http://proxy:3128",
    no_proxy: "localhost",
    SSL_CERT_FILE: "/etc/ssl/ca.pem",
    SSL_CERT_DIR: "/etc/ssl/certs",
    DENO_CERT: "/etc/ssl/ca.pem",
    DENO_TLS_CA_STORE: "system",
    ALL_PROXY: "socks5://proxy:1080",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel:4318",
    Path: "C:\\Windows",
    SystemRoot: "C:\\Windows",
    SWAMP_HOME: "/data/swamp",
    SWAMP_CONFIG_DIR: "/config/swamp",
  });
});

Deno.test("hostChildEnv: an operator's telemetry opt-out reaches every child", () => {
  assertEquals(
    hostChildEnv({ SWAMP_NO_TELEMETRY: "1", DO_NOT_TRACK: "1" }, PINNED),
    {
      SWAMP_NO_TELEMETRY: "1",
      DO_NOT_TRACK: "1",
      SWAMP_HOME: "/data/swamp",
      SWAMP_CONFIG_DIR: "/config/swamp",
    },
  );
});

Deno.test("hostChildEnv: a host signed in through the environment signs its children in the same way", () => {
  const env = hostChildEnv({
    SWAMP_API_KEY: "swamp_org_key",
    SWAMP_SIGNIN_TOKEN: "signin",
    SWAMP_NESTED_GATE_PASS: "1234.proof.sig",
    SWAMP_CLUB_URL: "https://club.staging.example",
  }, PINNED);
  assertEquals(env, {
    SWAMP_API_KEY: "swamp_org_key",
    SWAMP_SIGNIN_TOKEN: "signin",
    SWAMP_NESTED_GATE_PASS: "1234.proof.sig",
    SWAMP_CLUB_URL: "https://club.staging.example",
    SWAMP_HOME: "/data/swamp",
    SWAMP_CONFIG_DIR: "/config/swamp",
  });
});

Deno.test("hostChildEnv: a relative API key file is resolved against the host's folder, since a child runs in its repo", () => {
  assertEquals(
    hostChildEnv({ SWAMP_API_KEY_FILE: "secrets/key" }, PINNED)
      .SWAMP_API_KEY_FILE,
    resolve(HOST_CWD, "secrets/key"),
  );
  const absolute = resolve("/run/secrets/key");
  assertEquals(
    hostChildEnv({ SWAMP_API_KEY_FILE: absolute }, PINNED).SWAMP_API_KEY_FILE,
    absolute,
  );
});

Deno.test("hostChildEnv: no other SWAMP setting of the host reaches a child, and the swamp dirs are pinned", () => {
  const env = hostChildEnv({
    PATH: "/usr/bin",
    SWAMP_SERVE_AUTH_MODE: "none",
    SWAMP_SERVE_CERT_FILE: "/x.pem",
    SWAMP_REPO_DIR: "/elsewhere",
    SWAMP_TRUSTED_HOSTS: "evil.example",
    SWAMP_DATASTORE: "s3://one-for-all",
    SWAMP_SERVER_URL: "https://elsewhere",
    SWAMP_SERVER_TOKEN: "token",
    SWAMP_HOME: "/wrong",
    AWS_SECRET_ACCESS_KEY: "secret",
  }, PINNED);
  assertEquals(env, {
    PATH: "/usr/bin",
    SWAMP_HOME: "/data/swamp",
    SWAMP_CONFIG_DIR: "/config/swamp",
  });
});
