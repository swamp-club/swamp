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

import { z } from "zod";
import { UserError } from "../domain/errors.ts";
import { RepoPath } from "../domain/repo/repo_path.ts";
import { RepoService } from "../domain/repo/repo_service.ts";
import { ControlPlaneVaultProvider } from "../domain/vaults/control_plane_vault_provider.ts";
import { FileSystemControlPlaneStore } from "../infrastructure/persistence/fs_control_plane_store.ts";
import { swampPath } from "../infrastructure/persistence/paths.ts";
import { VERSION } from "../infrastructure/runtime/build_info.ts";
import type { HostedWorkspaceProvisionSpec } from "../libswamp/hosted_workspace/deps.ts";
import {
  notPlainUsernameReason,
  resolvedCacheKey,
  unresolvedCacheKey,
  usernameOf,
} from "../serve/oauth_access_list_resolution.ts";
import { OAUTH_RESOLVED_ADMINS_KEY } from "../serve/oauth_registration.ts";
import {
  type ServeConfigFile,
  writeServeConfigFile,
} from "../serve/serve_config.ts";

// the parent writes one spec; anything larger is not one
export const MAX_PROVISION_SPEC_BYTES = 1024 * 1024;

const ProvisionSpecSchema = z.object({
  access: z.object({
    mode: z.enum(["none", "token", "oauth"]),
    oauthProvider: z.string().min(1).nullable(),
    allowedUsers: z.array(z.string()),
    allowedCollectives: z.array(z.string()),
    nameCache: z.record(z.string(), z.string()),
  }).strict(),
  admin: z.string().nullable(),
  adminSubject: z.string().nullable(),
}).strict();

export function parseProvisionSpec(text: string): HostedWorkspaceProvisionSpec {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UserError("The provision spec on stdin is not JSON.");
  }
  const parsed = ProvisionSpecSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.length > 0 ? issue.path.join(".") : "the spec";
    throw new UserError(
      `The provision spec is invalid at ${where}: ${issue.message}`,
    );
  }
  return parsed.data;
}

export async function readProvisionSpec(
  stdin: ReadableStream<Uint8Array>,
): Promise<HostedWorkspaceProvisionSpec> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    size += chunk.length;
    if (size > MAX_PROVISION_SPEC_BYTES) {
      throw new UserError(
        `The provision spec on stdin is larger than ${MAX_PROVISION_SPEC_BYTES} bytes.`,
      );
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return parseProvisionSpec(new TextDecoder().decode(bytes));
}

/** what the provisioner child runs in the new folder; tests run it in-process */
export async function provisionHostedWorkspace(
  dir: string,
  spec: HostedWorkspaceProvisionSpec,
): Promise<void> {
  const seed = nameCacheSeed(spec);
  await new RepoService(VERSION).init(RepoPath.create(dir), { tools: [] });
  await writeServeConfigFile(dir, workspaceServeConfig(spec));
  if (seed !== null) await storeNameCacheSeed(dir, seed);
}

export function workspaceServeConfig(
  spec: HostedWorkspaceProvisionSpec,
): ServeConfigFile {
  const { access, admin } = spec;
  return {
    auth: {
      mode: access.mode,
      ...(admin !== null ? { admins: [admin] } : {}),
      ...(access.oauthProvider !== null
        ? { "oauth-provider": access.oauthProvider }
        : {}),
      ...(access.allowedUsers.length > 0
        ? { "allowed-users": [...access.allowedUsers] }
        : {}),
      ...(access.allowedCollectives.length > 0
        ? { "allowed-collectives": [...access.allowedCollectives] }
        : {}),
    },
  };
}

/**
 * the admins entry and its seed key are one string, so the first start finds
 * the creator cached; copied allowed-users carry the root's pinned or skipped
 * record, so a name skipped on the root stays skipped here
 */
export function nameCacheSeed(
  spec: HostedWorkspaceProvisionSpec,
): Record<string, string> | null {
  const { access, admin, adminSubject } = spec;
  if (access.mode !== "oauth") return null;
  if (admin === null || adminSubject === null || adminSubject === "") {
    throw new UserError(
      "An oauth workspace needs its creator's username and subject.",
    );
  }
  const reason = notPlainUsernameReason(admin);
  if (reason !== undefined || admin === "") {
    throw new UserError(
      `The creator's name cannot be an oauth admin: ${
        reason ?? "it is empty"
      }.`,
    );
  }
  const seed: Record<string, string> = Object.create(null);
  seed[resolvedCacheKey("admin", admin)] = adminSubject;
  for (const entry of access.allowedUsers) {
    const username = usernameOf(entry);
    for (
      const key of [
        resolvedCacheKey("allowed-user", username),
        unresolvedCacheKey("allowed-user", username),
      ]
    ) {
      if (Object.hasOwn(access.nameCache, key)) {
        seed[key] = access.nameCache[key];
      }
    }
  }
  return seed;
}

/**
 * the provider is used directly: registering it with VaultService is
 * process-wide and would replace the calling process's own _token-secrets
 */
async function storeNameCacheSeed(
  dir: string,
  seed: Record<string, string>,
): Promise<void> {
  const provider = new ControlPlaneVaultProvider(
    new FileSystemControlPlaneStore(swampPath(dir)),
    { migrate: false },
  );
  await provider.initialize();
  await provider.put(OAUTH_RESOLVED_ADMINS_KEY, JSON.stringify(seed));
}
