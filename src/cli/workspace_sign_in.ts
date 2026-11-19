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

import { UserError } from "../domain/errors.ts";
import type { ServerCredential } from "../domain/auth/server_credential.ts";
import {
  loginHintFor,
  recordWorkspaceSignIn,
} from "../infrastructure/auth/workspace_sign_in_notes.ts";
import { splitWorkspaceAddress } from "../domain/workspace/workspace_address.ts";
import { sanitizeFieldText } from "../domain/vaults/vault_config_fields.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { processRuntimeSlot } from "../infrastructure/runtime/process_runtime.ts";
import {
  NOT_A_HOST_ROOT_CODE,
  SIGN_IN_NOT_OFFERED_CODE,
  SIGN_IN_REFUSED_FOR_CREDENTIAL_CODE,
  SIGN_IN_REFUSED_FOR_INTEGRATION_CODE,
  SIGN_IN_REFUSED_FOR_PRINCIPAL_CODE,
} from "../serve/protocol.ts";

const logger = getSwampLogger(["auth", "workspace-sign-in"]);

export const SIGN_IN_TIMEOUT_MS = 10_000;
/** an exchanged token this close to its expiry is replaced before it is sent */
export const RENEW_MARGIN_MS = 5 * 60 * 1000;
const MAX_CLOCK_CORRECTION_MS = 24 * 60 * 60 * 1000;
const MAX_REFUSAL_REASON_LENGTH = 300;
const AUTH_INFO_PATH = "/auth/info";
const AUTH_EXCHANGE_PATH = "/auth/exchange";

// the root's refusals of workspace.sign-in that asking again will not cure
const ROOT_REFUSAL_CODES = new Set([
  NOT_A_HOST_ROOT_CODE,
  SIGN_IN_NOT_OFFERED_CODE,
  SIGN_IN_REFUSED_FOR_INTEGRATION_CODE,
  SIGN_IN_REFUSED_FOR_PRINCIPAL_CODE,
  SIGN_IN_REFUSED_FOR_CREDENTIAL_CODE,
]);

export interface JsonReply {
  readonly status: number;
  readonly date: string | null;
  readonly body: unknown;
  readonly retryAfter?: string | null;
}

/** what the root's HTTP route says of the host token, which it checks first */
export type HostTokenCheck =
  | { readonly kind: "accepted" }
  | { readonly kind: "refused" }
  | { readonly kind: "limited"; readonly retryAfterSeconds?: number }
  | { readonly kind: "unknown" };

export interface WorkspaceSignInDeps {
  /** servers.json, never the SWAMP_SERVER_TOKEN pair */
  readonly credentials: {
    get(serverUrl: string): Promise<ServerCredential | null>;
    save(credential: ServerCredential): Promise<void>;
  };
  readonly envPairNames: (serverUrl: string) => boolean;
  readonly checkHostToken: (
    hostAddress: string,
    hostToken: string,
  ) => Promise<HostTokenCheck>;
  readonly requestSignInCode: (
    hostAddress: string,
    hostToken: string,
    name: string,
  ) => Promise<{ data: { code: string } }>;
  readonly fetchJson: (url: string, init: RequestInit) => Promise<JsonReply>;
  readonly headers: Record<string, string>;
  readonly now: () => number;
}

const inFlight = processRuntimeSlot(() =>
  new Map<string, Promise<string | undefined>>()
);

/**
 * undefined when the address cannot sign in through its host; throws only a
 * refusal the command should stop on
 */
export function signInToWorkspace(
  address: string,
  deps: WorkspaceSignInDeps,
): Promise<string | undefined> {
  const attempts = inFlight();
  let attempt = attempts.get(address);
  if (attempt === undefined) {
    attempt = attemptSignIn(address, deps);
    attempts.set(address, attempt);
  }
  return attempt;
}

/**
 * the token to send to address given what the lookup found; an exchanged token
 * is replaced before it expires, and one still valid is kept when that fails
 */
export async function workspaceTokenFor(
  address: string,
  found: ServerCredential | null,
  deps: WorkspaceSignInDeps,
): Promise<string | undefined> {
  if (found?.token && found.expiresAt === undefined) return found.token;
  const token = await exchangedTokenFor(address, found, deps);
  const workspace = splitWorkspaceAddress(address);
  if (token !== undefined && workspace !== null) {
    recordWorkspaceSignIn(address, workspace.hostAddress, "exchanged-token");
  }
  return token;
}

async function exchangedTokenFor(
  address: string,
  found: ServerCredential | null,
  deps: WorkspaceSignInDeps,
): Promise<string | undefined> {
  if (!found?.token || found.expiresAt === undefined) {
    return await signInToWorkspace(address, deps);
  }
  // an exchanged token acts as the host sign-in that issued it, so a host
  // sign-in made or removed since then must not lend it that identity
  if (!(await issuedByStoredHostSignIn(address, found, deps))) {
    return await signInToWorkspace(address, deps);
  }
  const expiresAt = Date.parse(found.expiresAt);
  const now = deps.now();
  if (Number.isNaN(expiresAt) || expiresAt <= now) {
    return await signInToWorkspace(address, deps);
  }
  // a token granted less than the margin was capped by the host token's own
  // expiry, and a new exchange would end no later
  const granted = expiresAt - Date.parse(found.obtainedAt);
  if (expiresAt - now > RENEW_MARGIN_MS || !(granted > RENEW_MARGIN_MS)) {
    return found.token;
  }
  try {
    return (await signInToWorkspace(address, deps)) ?? found.token;
  } catch (error) {
    logger
      .debug`Renewing the workspace token early failed; the stored one is still valid: ${error}`;
    return found.token;
  }
}

async function attemptSignIn(
  address: string,
  deps: WorkspaceSignInDeps,
): Promise<string | undefined> {
  const workspace = splitWorkspaceAddress(address);
  if (workspace === null) return undefined;
  const { hostAddress, name } = workspace;

  const info = await fetchQuietly(deps, `${address}${AUTH_INFO_PATH}`, {
    method: "GET",
    headers: deps.headers,
  });
  if (info === undefined || info.status !== 200) return undefined;
  if (!isRecord(info.body) || info.body.exchange !== true) return undefined;

  // the pair would make host commands run as another principal than the file's
  // host token, so an env host token is never exchanged
  if (deps.envPairNames(hostAddress)) {
    recordWorkspaceSignIn(address, hostAddress, "env-host-token");
    return undefined;
  }
  const host = await deps.credentials.get(hostAddress);
  if (!host?.token) {
    recordWorkspaceSignIn(address, hostAddress, "no-host-token");
    return undefined;
  }

  // asked before the socket, whose refusal a host's router hides, so a refused
  // token costs the root's lockout one failure and an accepted one clears it
  const check = await deps.checkHostToken(hostAddress, host.token);
  if (check.kind === "refused") {
    throw new UserError(
      `Could not sign in to the workspace ${name}: the host at ${hostAddress} refused your sign-in. ${
        loginHintFor(hostAddress)
      }`,
    );
  }
  if (check.kind === "limited") {
    const wait = check.retryAfterSeconds === undefined
      ? "for now"
      : `for ${check.retryAfterSeconds}s`;
    throw new UserError(
      `Could not sign in to the workspace ${name}: the host at ${hostAddress} is turning away sign-ins with your host token ${wait} after too many attempts or requests. Try again then; if it still refuses your sign-in, run: swamp auth server-login --server ${hostAddress}`,
      "rate_limited",
    );
  }

  let code: string;
  try {
    code = (await deps.requestSignInCode(hostAddress, host.token, name)).data
      .code;
  } catch (error) {
    const refusal = error instanceof UserError ? error.code : undefined;
    if (refusal !== undefined && ROOT_REFUSAL_CODES.has(refusal)) {
      throw new UserError(
        `The host at ${hostAddress} refused a sign-in code for the workspace ${name}: ${
          (error as { serverMessage?: string }).serverMessage ??
            (error as Error).message
        }`,
        refusal,
      );
    }
    logger.debug`Asking the host for a workspace sign-in code failed: ${error}`;
    return undefined;
  }

  const obtainedAt = deps.now();
  const exchanged = await fetchQuietly(
    deps,
    `${address}${AUTH_EXCHANGE_PATH}`,
    {
      method: "POST",
      headers: { ...deps.headers, "content-type": "application/json" },
      body: JSON.stringify({ code }),
    },
  );
  if (exchanged === undefined) return undefined;
  const body = isRecord(exchanged.body) ? exchanged.body : {};
  if (exchanged.status === 401 && body.error === "code_refused") {
    throw new UserError(
      `The workspace at ${address} refused the sign-in code the host at ${hostAddress} issued.`,
      "code_refused",
    );
  }
  if (exchanged.status === 403 && body.error === "not_admitted") {
    // the workspace's own text, so no escape sequence of its reaches the terminal
    const said = typeof body.reason === "string"
      ? sanitizeFieldText(body.reason, MAX_REFUSAL_REASON_LENGTH)
      : "";
    const reason = said === "" ? "" : `: ${said}`;
    throw new UserError(
      `The workspace at ${address} does not admit you${reason}. Signing in to the host again will not help; ask the workspace's administrator.`,
      "not_admitted",
    );
  }
  if (
    exchanged.status !== 200 || typeof body.token !== "string" ||
    body.token === "" || typeof body.expiresAt !== "string" ||
    Number.isNaN(Date.parse(body.expiresAt))
  ) {
    logger
      .debug`The workspace answered the sign-in exchange with status ${exchanged.status}`;
    return undefined;
  }

  const principal = isRecord(body.principal) ? body.principal : {};
  const email = stringOr(principal.email);
  const username = stringOr(principal.username);
  try {
    await deps.credentials.save({
      serverUrl: address,
      tokenName: email ?? username ?? "",
      token: body.token,
      principalId: stringOr(principal.id) ?? "",
      ...(username ?? email ? { displayName: username ?? email } : {}),
      obtainedAt: new Date(obtainedAt).toISOString(),
      expiresAt: new Date(
        localExpiry(obtainedAt, body.expiresAt, exchanged.date),
      ).toISOString(),
      hostSignInDigest: await hostSignInDigest(host),
    });
  } catch (error) {
    // the token still serves this command; only the next one signs in again
    logger
      .warn`Could not save the token for ${address}, so the next command signs in to it again: ${error}`;
  }
  return body.token;
}

/**
 * the serve's expiry on this machine's clock: the lifetime it granted, measured
 * by its own Date header, counted from when the token arrived here
 */
export function localExpiry(
  obtainedAt: number,
  serveExpiresAt: string,
  serveDate: string | null,
): number {
  const expiresAt = Date.parse(serveExpiresAt);
  const serveNow = serveDate === null ? NaN : Date.parse(serveDate);
  if (Number.isNaN(serveNow)) return expiresAt;
  const granted = Math.max(0, expiresAt - serveNow);
  const asGiven = Math.max(0, expiresAt - obtainedAt);
  return obtainedAt + Math.min(granted, asGiven + MAX_CLOCK_CORRECTION_MS);
}

async function issuedByStoredHostSignIn(
  address: string,
  found: ServerCredential,
  deps: WorkspaceSignInDeps,
): Promise<boolean> {
  const workspace = splitWorkspaceAddress(address);
  if (workspace === null) return true;
  const host = await deps.credentials.get(workspace.hostAddress);
  if (!host?.token || found.hostSignInDigest === undefined) return false;
  return found.hostSignInDigest === await hostSignInDigest(host);
}

/** obtainedAt is in it so that signing in to the host again, even with the same token, starts afresh */
export async function hostSignInDigest(
  host: Pick<ServerCredential, "token" | "obtainedAt">,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${host.obtainedAt}\n${host.token}`),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function fetchQuietly(
  deps: WorkspaceSignInDeps,
  url: string,
  init: RequestInit,
): Promise<JsonReply | undefined> {
  try {
    return await deps.fetchJson(url, {
      ...init,
      // a redirect would carry the sign-in code elsewhere
      redirect: "manual",
      signal: AbortSignal.timeout(SIGN_IN_TIMEOUT_MS),
    });
  } catch (error) {
    logger.debug`A workspace sign-in request to ${url} failed: ${error}`;
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
