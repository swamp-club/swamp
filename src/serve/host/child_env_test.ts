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
import { mergeServeOptions } from "../serve_config.ts";
import { hostChildEnv, withheldServeSettings } from "./child_env.ts";

const HOST_CWD = resolve("host-cwd");
const PINNED = {
  swampHome: "/data/swamp",
  configDir: "/config/swamp",
  cwd: HOST_CWD,
};

Deno.test("hostChildEnv: a child inherits what plain serve would see from its operator", () => {
  const hostEnv = {
    PATH: "/usr/bin",
    TZ: "Asia/Tokyo",
    KUBECONFIG: "/etc/kube",
    SSH_AUTH_SOCK: "/run/ssh.sock",
    AWS_ACCESS_KEY_ID: "akid",
    SWAMP_API_KEY: "swamp_org_key",
    SWAMP_SIGNIN_TOKEN: "signin",
    SWAMP_NESTED_GATE_PASS: "1234.proof.sig",
    SWAMP_CLUB_URL: "https://club.staging.example",
    SWAMP_DISPATCH_ENV_ALLOW: "AWS_*",
    SWAMP_CA_CERT: "/etc/ssl/ca.pem",
    SWAMP_NO_TELEMETRY: "1",
  };
  assertEquals(hostChildEnv(hostEnv, PINNED), {
    ...hostEnv,
    SWAMP_HOME: "/data/swamp",
    SWAMP_CONFIG_DIR: "/config/swamp",
    SWAMP_SERVE_CERT_FILE: "",
    SWAMP_SERVE_KEY_FILE: "",
  });
});

Deno.test("hostChildEnv: drops what would point every workspace at one repo, datastore or home, in any case", () => {
  const env = hostChildEnv({
    PATH: "/usr/bin",
    SWAMP_REPO_DIR: "/elsewhere",
    SWAMP_DATASTORE: "s3://one-for-all",
    swamp_datastore: "s3://one-for-all",
    SWAMP_HOME: "/wrong",
    SWAMP_CONFIG_DIR: "/wrong",
  }, PINNED);
  assertEquals(env, {
    PATH: "/usr/bin",
    SWAMP_HOME: "/data/swamp",
    SWAMP_CONFIG_DIR: "/config/swamp",
    SWAMP_SERVE_CERT_FILE: "",
    SWAMP_SERVE_KEY_FILE: "",
  });
});

Deno.test("hostChildEnv: a relative CA certificate, in any case, is resolved against the host's working directory", () => {
  assertEquals(
    hostChildEnv({ SWAMP_CA_CERT: "certs/ca.pem" }, PINNED).SWAMP_CA_CERT,
    resolve(HOST_CWD, "certs/ca.pem"),
  );
  assertEquals(
    hostChildEnv({ swamp_api_key_file: "secrets/key" }, PINNED)
      .swamp_api_key_file,
    resolve(HOST_CWD, "secrets/key"),
  );
});

Deno.test("hostChildEnv: a relative API key file is resolved against the host's working directory, since a child runs in its repo", () => {
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

Deno.test("hostChildEnv: a child serves plain http however the host or its serve.yaml asks for TLS", () => {
  const env = hostChildEnv({
    SWAMP_SERVE_CERT_FILE: "/etc/ssl/host.crt",
    swamp_serve_key_file: "/etc/ssl/host.key",
  }, PINNED);
  assertEquals(env.SWAMP_SERVE_CERT_FILE, "");
  assertEquals(env.SWAMP_SERVE_KEY_FILE, "");
  assertEquals("swamp_serve_key_file" in env, false);

  const merged = mergeServeOptions(
    { tls: { "cert-file": "certs/serve.crt", "key-file": "certs/serve.key" } },
    {},
    new Set<string>(),
    (name) => env[name],
  );
  assertEquals(merged.certFile, "");
  assertEquals(merged.keyFile, "");
});

Deno.test("hostChildEnv: holds back the settings that name one serve, so each workspace's serve.yaml decides them", () => {
  const perServe = {
    SWAMP_GRANTS_FILE: "/etc/swamp/grants.yaml",
    SWAMP_GRANTS_DIR: "/etc/swamp/grants.d",
    SWAMP_SERVE_ADVERTISE_ADDRESS: "https://node-1.internal",
    SWAMP_WEBHOOK_ROUTES_DIR: "/etc/swamp/hooks",
    SWAMP_OAUTH_CLIENT_ID: "client-1",
    SWAMP_OAUTH_CLIENT_NAME: "swamp",
    SWAMP_OAUTH_CLIENT_SECRET: "secret",
    swamp_oauth_client_secret_file: "/run/secrets/oauth",
  };
  const env = hostChildEnv({ PATH: "/usr/bin", ...perServe }, PINNED);
  for (const name of Object.keys(perServe)) {
    assertEquals(name in env, false, name);
  }
  assertEquals(env.PATH, "/usr/bin");
  assertEquals(
    withheldServeSettings({ PATH: "/usr/bin", ...perServe }),
    Object.keys(perServe).sort(),
  );
  assertEquals(withheldServeSettings({ PATH: "/usr/bin" }), []);
});
