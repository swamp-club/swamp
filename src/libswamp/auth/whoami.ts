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

import {
  type AuthCredentials,
  keyFingerprint,
} from "../../domain/auth/auth_credentials.ts";
import type {
  WhoamiCollectiveSourceHostingResponse,
  WhoamiResponse,
  WhoamiTrial,
} from "../../infrastructure/http/swamp_club_client.ts";
import {
  getCollectives,
  SwampClubClient,
} from "../../infrastructure/http/swamp_club_client.ts";
import type { ClientIdentity } from "../../infrastructure/http/client_identity.ts";
import {
  AuthRepository,
  type AuthRepositoryOptions,
} from "../../infrastructure/persistence/auth_repository.ts";
import { resolveApiKey } from "../../infrastructure/persistence/api_key_source.ts";
import { AuthVerificationRepository } from "../../infrastructure/persistence/auth_verification_repository.ts";
import type { LibSwampContext } from "../context.ts";
import {
  cancelled,
  invalidApiKey,
  noStoredLoginKey,
  notAuthenticated,
  type SwampError,
} from "../errors.ts";

/**
 * carried alongside, never instead of, collectives: that slug list is persisted
 * to auth.json and read elsewhere, and widening it would rewrite every
 * credentials file and make a cache a staler second source of truth
 */
export interface WhoamiCollectiveEntitlement {
  slug: string;
  plan?: string;
  planName?: string;
  subscriptionStatus?: string | null;
  trial?: WhoamiTrial | null;
  privateExtensions?: string;
}

export interface WhoamiIdentity {
  serverUrl: string;
  id: string;
  username: string;
  email: string;
  name: string;
  collectives?: string[];
  plan?: string;
  /**
   * Per-collective entitlement. Absent when the server sends none — an older
   * or self-hosted swamp-club — which is what keeps whoami working against
   * every server version.
   */
  collectiveEntitlements?: WhoamiCollectiveEntitlement[];
  collectiveToken?: boolean;
  collectiveSlug?: string;
  scopes?: string[];
  fingerprint?: string;
}

export type AuthWhoamiEvent =
  | { kind: "loading_credentials" }
  | { kind: "contacting_server"; serverUrl: string }
  | { kind: "completed"; identity: WhoamiIdentity }
  | { kind: "error"; error: SwampError };

export interface AuthDeps {
  loadCredentials: () => Promise<AuthCredentials | null>;
  saveCredentials: (credentials: AuthCredentials) => Promise<void>;
  fetchWhoami: (
    serverUrl: string,
    apiKey: string,
    signal: AbortSignal,
  ) => Promise<WhoamiResponse>;
  serverUrlOverride?: string;
}

export interface CreateAuthDepsOptions {
  serverUrlOverride?: string;
  repo?: AuthRepositoryOptions;
  identity?: ClientIdentity;
}

export function createAuthDeps(options: CreateAuthDepsOptions = {}): AuthDeps {
  const repo = new AuthRepository(options.repo);
  const getApiKey = options.repo?.getApiKey ?? resolveApiKey;
  return {
    loadCredentials: () => repo.load(),
    saveCredentials: async (credentials) => {
      const envKey = getApiKey();
      if (envKey) {
        return repo.saveIdentityCache(
          credentials.serverUrl,
          credentials.username,
          credentials.collectives ?? [],
          await keyFingerprint(envKey),
        );
      }
      return repo.save(credentials);
    },
    fetchWhoami: (serverUrl, apiKey, signal) => {
      const client = new SwampClubClient(serverUrl, options.identity);
      return client.whoami(apiKey, signal);
    },
    serverUrlOverride: options.serverUrlOverride,
  };
}

/**
 * reads collectiveEntitlements, never organizations (membership, which extension
 * push authorizes against). Returns undefined rather than an empty array so
 * renderers can tell no reported entitlement from everything being free.
 */
export function entitlementsOf(
  response: WhoamiResponse,
): WhoamiCollectiveEntitlement[] | undefined {
  const entitlements = response.collectiveEntitlements;
  if (!entitlements || entitlements.length === 0) return undefined;

  return entitlements.map((entitlement) => ({
    slug: entitlement.slug,
    ...(entitlement.plan !== undefined ? { plan: entitlement.plan } : {}),
    ...(entitlement.planName !== undefined
      ? { planName: entitlement.planName }
      : {}),
    ...(entitlement.subscriptionStatus !== undefined
      ? { subscriptionStatus: entitlement.subscriptionStatus }
      : {}),
    ...(entitlement.trial !== undefined ? { trial: entitlement.trial } : {}),
    ...(typeof entitlement.privateExtensions === "string"
      ? { privateExtensions: entitlement.privateExtensions }
      : {}),
  }));
}

export function rollUpPlanName(identity: WhoamiIdentity): string | undefined {
  if (!identity.plan || identity.plan === "free") return undefined;
  const match = identity.collectiveEntitlements?.find(
    (c) => c.plan === identity.plan && c.planName,
  );
  return match?.planName ?? identity.plan;
}

/**
 * reads collectiveSourceHosting, never organizations; an entry without boolean
 * flags counts as unreported, so a malformed answer falls back to the
 * repository URL
 */
export function sourceHostingOf(
  response: WhoamiResponse,
  slug: string,
): WhoamiCollectiveSourceHostingResponse | undefined {
  const entries: unknown = response.collectiveSourceHosting;
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries) {
    if (
      typeof entry === "object" && entry !== null &&
      entry.slug === slug &&
      typeof entry.privateSourceHosting === "boolean" &&
      typeof entry.privateNamespace === "boolean"
    ) {
      return {
        slug,
        privateSourceHosting: entry.privateSourceHosting,
        privateNamespace: entry.privateNamespace,
      };
    }
  }
  return undefined;
}

export async function* whoami(
  ctx: LibSwampContext,
  deps: AuthDeps,
): AsyncIterable<AuthWhoamiEvent> {
  yield { kind: "loading_credentials" };

  const credentials = await deps.loadCredentials();
  // An empty key is the identity cache older versions left in auth.json
  // after an env-key run: no credential, not a revoked one.
  if (!credentials?.apiKey) {
    yield {
      kind: "error",
      error: credentials ? noStoredLoginKey() : notAuthenticated(),
    };
    return;
  }

  const serverUrl = deps.serverUrlOverride ?? credentials.serverUrl;
  yield { kind: "contacting_server", serverUrl };

  try {
    const response = await deps.fetchWhoami(
      serverUrl,
      credentials.apiKey,
      ctx.signal,
    );

    if (!response.authenticated) {
      yield { kind: "error", error: invalidApiKey() };
      return;
    }

    if (
      response.verificationProof && response.verificationSignature &&
      response.publicKeys
    ) {
      const verificationRepo = new AuthVerificationRepository();
      await verificationRepo.save(
        response.verificationProof,
        response.verificationSignature,
        response.publicKeys,
      ).catch(() => {});
      // A verified answer ends any fail-open window an outage started.
      await verificationRepo.clearFailOpen().catch(() => {});
    }

    const collectives = getCollectives(response);
    const entitlements = entitlementsOf(response);
    const fingerprint = await keyFingerprint(credentials.apiKey);

    if (!response.collectiveToken) {
      // refresh cached username and collectives; the username also repairs a
      // login record overwritten with an env key's identity. Collective tokens
      // are env-var-based, so nothing is cached for them.
      await deps.saveCredentials({
        ...credentials,
        username: response.username ?? credentials.username,
        collectives: collectives ?? [],
      });
    }

    yield {
      kind: "completed",
      identity: {
        serverUrl,
        id: response.id ?? "",
        username: response.username ?? "",
        email: response.email ?? "",
        name: response.name ?? "",
        ...(collectives ? { collectives } : {}),
        ...(response.plan ? { plan: response.plan } : {}),
        ...(entitlements ? { collectiveEntitlements: entitlements } : {}),
        ...(response.collectiveToken
          ? {
            collectiveToken: true,
            collectiveSlug: response.collectiveSlug,
            scopes: response.scopes,
          }
          : {}),
        fingerprint,
      },
    };
  } catch (error: unknown) {
    if (
      error instanceof DOMException && error.name === "AbortError"
    ) {
      yield { kind: "error", error: cancelled(error) };
      return;
    }
    throw error;
  }
}
