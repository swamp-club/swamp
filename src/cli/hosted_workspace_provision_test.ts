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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { UserError } from "../domain/errors.ts";
import { ControlPlaneVaultProvider } from "../domain/vaults/control_plane_vault_provider.ts";
import { FileSystemControlPlaneStore } from "../infrastructure/persistence/fs_control_plane_store.ts";
import { swampPath } from "../infrastructure/persistence/paths.ts";
import type { HostedWorkspaceProvisionSpec } from "../libswamp/hosted_workspace/deps.ts";
import { chooseResolutionMode } from "../serve/oauth_access_list_resolution.ts";
import { OAUTH_RESOLVED_ADMINS_KEY } from "../serve/oauth_registration.ts";
import { loadServeConfig } from "../serve/serve_config.ts";
import { provisionSpecBytes } from "../serve/workspace_provision_process.ts";
import {
  MAX_PROVISION_SPEC_BYTES,
  nameCacheSeed,
  provisionHostedWorkspace,
  readProvisionSpec,
} from "./hosted_workspace_provision.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

function oauthSpec(
  overrides: Partial<HostedWorkspaceProvisionSpec> = {},
): HostedWorkspaceProvisionSpec {
  return {
    access: {
      mode: "oauth",
      oauthProvider: "https://club.example",
      allowedUsers: ["bob", "user:carol", "dave"],
      allowedCollectives: ["swamp-team"],
      nameCache: {
        "root-admin": "sub-root",
        "allowed:bob": "sub-bob",
        "unresolved:allowed:carol": "2026-11-01T00:00:00.000Z",
      },
    },
    admin: "alice",
    adminSubject: "sub-alice",
    ...overrides,
  };
}

Deno.test("provisionHostedWorkspace: sets a repo up with the root's access and the creator as its admin", async () => {
  await withTempDir(async (dir) => {
    await provisionHostedWorkspace(dir, oauthSpec());
    assertEquals((await Deno.stat(join(dir, ".swamp.yaml"))).isFile, true);
    assertEquals(loadServeConfig(undefined, dir)?.auth, {
      mode: "oauth",
      admins: ["alice"],
      "oauth-provider": "https://club.example",
      "allowed-users": ["bob", "user:carol", "dave"],
      "allowed-collectives": ["swamp-team"],
    });
  });
});

Deno.test("provisionHostedWorkspace: seeds the name cache so the first start looks up only names the root never resolved", async () => {
  await withTempDir(async (dir) => {
    await provisionHostedWorkspace(dir, oauthSpec());
    const provider = new ControlPlaneVaultProvider(
      new FileSystemControlPlaneStore(swampPath(dir)),
    );
    await provider.initialize();
    const seed = JSON.parse(await provider.get(OAUTH_RESOLVED_ADMINS_KEY));
    assertEquals(seed, {
      alice: "sub-alice",
      "allowed:bob": "sub-bob",
      "unresolved:allowed:carol": "2026-11-01T00:00:00.000Z",
    });
    const auth = loadServeConfig(undefined, dir)!.auth!;
    // dave was never resolved on the root, so only dave forces a lookup
    assertEquals(
      chooseResolutionMode(auth.admins!, auth["allowed-users"]!, seed),
      "full",
    );
    assertEquals(
      chooseResolutionMode(
        auth.admins!,
        auth["allowed-users"]!.filter((u) => u !== "dave"),
        seed,
      ),
      "cached",
    );
  });
});

Deno.test("provisionHostedWorkspace: a token-mode workspace names the caller's principal and stores no seed", async () => {
  await withTempDir(async (dir) => {
    await provisionHostedWorkspace(dir, {
      access: {
        mode: "token",
        oauthProvider: null,
        allowedUsers: [],
        allowedCollectives: [],
        nameCache: {},
      },
      admin: "user:alice",
      adminSubject: null,
    });
    assertEquals(loadServeConfig(undefined, dir)?.auth, {
      mode: "token",
      admins: ["user:alice"],
    });
    await assertRejects(() =>
      Deno.stat(swampPath(dir, "_control", "token-secrets"))
    );
  });
});

Deno.test("nameCacheSeed: refuses an oauth creator without a plain username or a subject", () => {
  for (
    const overrides of [
      { admin: null },
      { admin: "" },
      { admin: "group:ops" },
      { admin: "a:b" },
      { adminSubject: null },
      { adminSubject: "" },
    ]
  ) {
    assertThrows(
      () => nameCacheSeed(oauthSpec(overrides)),
      UserError,
      undefined,
      JSON.stringify(overrides),
    );
  }
});

Deno.test("nameCacheSeed: copies nothing for a name the root's cache holds only on Object.prototype", () => {
  const seed = nameCacheSeed(oauthSpec({
    access: { ...oauthSpec().access, allowedUsers: ["constructor"] },
  }));
  assertEquals({ ...seed }, { alice: "sub-alice" });
});

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

Deno.test("readProvisionSpec: the child reads back the spec the adapter writes to its stdin", async () => {
  const spec = oauthSpec();
  assertEquals(
    await readProvisionSpec(streamOf(provisionSpecBytes(spec))),
    spec,
  );
});

Deno.test("readProvisionSpec: refuses a spec that is not JSON, has unknown fields or is too large", async () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  for (
    const [bytes, expected] of [
      [encode("{"), "not JSON"],
      [encode(JSON.stringify({ ...oauthSpec(), extra: 1 })), "invalid"],
      [encode(JSON.stringify({ ...oauthSpec(), admin: 7 })), "admin"],
      [new Uint8Array(MAX_PROVISION_SPEC_BYTES + 1), "larger than"],
    ] as const
  ) {
    await assertRejects(
      () => readProvisionSpec(streamOf(bytes)),
      UserError,
      expected,
    );
  }
});
