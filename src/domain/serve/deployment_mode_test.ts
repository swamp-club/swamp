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
  type DatastoreClassification,
  resolveDeploymentMode,
  type VaultClassification,
} from "./deployment_mode.ts";

const FILESYSTEM: DatastoreClassification = { kind: "filesystem" };
const REMOTE_NO_CP: DatastoreClassification = {
  kind: "remote",
  type: "@swamp/s3-datastore",
  hasControlPlane: false,
};
const REMOTE_CP: DatastoreClassification = {
  kind: "remote",
  type: "@swamp/s3-datastore",
  hasControlPlane: true,
};

const VAULT_NONE: VaultClassification = { kind: "none" };
const VAULT_LOCAL: VaultClassification = { kind: "local" };
const VAULT_REMOTE: VaultClassification = {
  kind: "remote",
  type: "@swamp/aws-sm-vault",
};

// Scenario 1: filesystem + none/local vault → local, no warnings
Deno.test("resolveDeploymentMode: filesystem datastore with no vault returns local", () => {
  const result = resolveDeploymentMode(FILESYSTEM, VAULT_NONE);
  assertEquals(result.mode, "local");
  assertEquals(result.warnings, []);
});

// Scenario 2: filesystem + remote vault → local, no warnings
Deno.test("resolveDeploymentMode: filesystem datastore with remote vault returns local", () => {
  const result = resolveDeploymentMode(FILESYSTEM, VAULT_REMOTE);
  assertEquals(result.mode, "local");
  assertEquals(result.warnings, []);
});

// Scenario 3: remote without control-plane → local, warns to update extension
Deno.test("resolveDeploymentMode: remote datastore without control-plane returns local with warning", () => {
  const result = resolveDeploymentMode(REMOTE_NO_CP, VAULT_REMOTE);
  assertEquals(result.mode, "local");
  assertEquals(result.warnings.length, 1);
  assertEquals(
    result.warnings[0],
    "Update @swamp/s3-datastore for cross-machine durability",
  );
});

// Scenario 4: remote with control-plane + no vault → durable, warns about missing vault
Deno.test("resolveDeploymentMode: remote datastore with control-plane and no vault returns durable with warning", () => {
  const result = resolveDeploymentMode(REMOTE_CP, VAULT_NONE);
  assertEquals(result.mode, "durable");
  assertEquals(result.warnings.length, 1);
  assertEquals(
    result.warnings[0],
    "No vault configured — workflows requiring secrets will fail after instance replacement",
  );
});

// Scenario 5: remote with control-plane + local vault → durable (limited), warns about file-based secrets
Deno.test("resolveDeploymentMode: remote datastore with control-plane and local vault returns durable limited", () => {
  const result = resolveDeploymentMode(REMOTE_CP, VAULT_LOCAL);
  assertEquals(result.mode, "durable (limited)");
  assertEquals(result.warnings.length, 1);
  assertEquals(
    result.warnings[0],
    "Vault is file-based — secrets will not be available after instance replacement",
  );
});

// Scenario 6: remote with control-plane + remote vault → durable, no warnings
Deno.test("resolveDeploymentMode: remote datastore with control-plane and remote vault returns durable", () => {
  const result = resolveDeploymentMode(REMOTE_CP, VAULT_REMOTE);
  assertEquals(result.mode, "durable");
  assertEquals(result.warnings, []);
});

// Edge: filesystem + local vault → still local, no warnings
Deno.test("resolveDeploymentMode: filesystem datastore with local vault returns local", () => {
  const result = resolveDeploymentMode(FILESYSTEM, VAULT_LOCAL);
  assertEquals(result.mode, "local");
  assertEquals(result.warnings, []);
});

// Edge: remote without control-plane + no vault → local with extension warning only
Deno.test("resolveDeploymentMode: remote datastore without control-plane and no vault returns local with warning", () => {
  const result = resolveDeploymentMode(REMOTE_NO_CP, VAULT_NONE);
  assertEquals(result.mode, "local");
  assertEquals(result.warnings.length, 1);
  assertEquals(
    result.warnings[0],
    "Update @swamp/s3-datastore for cross-machine durability",
  );
});
