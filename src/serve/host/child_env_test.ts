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
    SWAMP_OAUTH_CLIENT_SECRET_FILE: "/run/secrets/oauth",
    SWAMP_DISPATCH_ENV_ALLOW: "AWS_*",
    SWAMP_CA_CERT: "/etc/ssl/ca.pem",
    SWAMP_NO_TELEMETRY: "1",
  };
  assertEquals(hostChildEnv(hostEnv, PINNED), {
    ...hostEnv,
    SWAMP_HOME: "/data/swamp",
    SWAMP_CONFIG_DIR: "/config/swamp",
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
