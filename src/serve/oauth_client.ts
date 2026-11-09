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

import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "oauth-client"]);

export interface DeviceGrantResponse {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresIn: number;
  readonly interval: number;
}

export interface OAuthTokenResponse {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly expiresIn?: number;
  readonly refreshToken?: string;
  readonly scope?: string;
}

export interface OAuthUserInfo {
  readonly sub: string;
  readonly email: string;
  readonly name?: string;
  readonly username?: string;
  readonly collectives: string[];
  readonly groups: string[];
  /** the userinfo response had no groupsField claim at all */
  readonly collectivesFieldAbsent?: true;
}

export type DeviceGrantPollErrorCode =
  | "authorization_pending"
  | "slow_down"
  | "expired_token"
  | "access_denied"
  | "unknown";

export class DeviceGrantPollError extends Error {
  readonly code: DeviceGrantPollErrorCode;

  constructor(code: DeviceGrantPollErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "DeviceGrantPollError";
  }
}

const KNOWN_POLL_ERRORS = new Set<string>([
  "authorization_pending",
  "slow_down",
  "expired_token",
  "access_denied",
]);

export async function startDeviceGrant(
  providerUrl: string,
  clientId: string,
  signal: AbortSignal,
): Promise<DeviceGrantResponse> {
  const resp = await fetch(`${providerUrl}/api/auth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId }),
    signal,
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(
      `Device authorization request failed: ${resp.status} ${
        data.error ?? resp.statusText
      }${data.error_description ? ` — ${data.error_description}` : ""}`,
    );
  }
  const data = await resp.json();
  const result: DeviceGrantResponse = {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in,
    interval: data.interval ?? 5,
  };
  if (data.verification_uri_complete) {
    return {
      ...result,
      verificationUriComplete: data.verification_uri_complete,
    };
  }
  return result;
}

export async function pollForToken(
  providerUrl: string,
  clientId: string,
  clientSecret: string,
  deviceCode: string,
  signal: AbortSignal,
): Promise<OAuthTokenResponse> {
  const resp = await fetch(`${providerUrl}/api/auth/device/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
    signal,
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    const errorCode = data.error as string | undefined;
    if (errorCode && KNOWN_POLL_ERRORS.has(errorCode)) {
      throw new DeviceGrantPollError(
        errorCode as DeviceGrantPollErrorCode,
      );
    }
    throw new DeviceGrantPollError(
      "unknown",
      `Token request failed: ${resp.status} ${data.error ?? resp.statusText}`,
    );
  }
  const data = await resp.json();
  return {
    accessToken: data.access_token,
    tokenType: data.token_type ?? "bearer",
    expiresIn: data.expires_in,
    refreshToken: data.refresh_token,
    scope: data.scope,
  };
}

export async function getUserInfo(
  providerUrl: string,
  accessToken: string,
  groupsField: string,
  signal: AbortSignal,
): Promise<OAuthUserInfo> {
  const resp = await fetch(`${providerUrl}/api/auth/oauth2/userinfo`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal,
  });
  if (!resp.ok) {
    throw new Error(
      `Userinfo request failed: ${resp.status} ${resp.statusText}`,
    );
  }
  const data = await resp.json();
  if (typeof data.sub !== "string" || !data.sub) {
    throw new Error("Userinfo response missing required 'sub' field");
  }
  if (typeof data.email !== "string" || !data.email) {
    throw new Error("Userinfo response missing required 'email' field");
  }
  const rawCollectives = data[groupsField];
  const collectives = Array.isArray(rawCollectives)
    ? rawCollectives.filter((c): c is string => typeof c === "string")
    : [];
  if (rawCollectives !== undefined && !Array.isArray(rawCollectives)) {
    logger.warn(
      "Userinfo field {groupsField} is not a list, so no collectives were read from it",
      { groupsField },
    );
  } else if (
    Array.isArray(rawCollectives) &&
    collectives.length < rawCollectives.length
  ) {
    logger.warn(
      "Userinfo field {groupsField} held {dropped} entries that are not strings; they were ignored",
      { groupsField, dropped: rawCollectives.length - collectives.length },
    );
  }
  // IdP groups only: collectives admit, they never stand in for groups.
  const rawGroups = data.groups;
  const groups = Array.isArray(rawGroups)
    ? rawGroups.filter((g): g is string => typeof g === "string")
    : [];
  return {
    sub: data.sub,
    email: data.email,
    name: data.name,
    ...(typeof data.preferred_username === "string" &&
        data.preferred_username
      ? { username: data.preferred_username }
      : {}),
    collectives,
    groups,
    ...(rawCollectives === undefined
      ? { collectivesFieldAbsent: true as const }
      : {}),
  };
}

export interface RegisterInstanceRequest {
  readonly oauthClientId: string;
  readonly instanceId: string;
  readonly collectiveSlugs: string[];
  readonly hostname: string;
  readonly version: string;
  readonly deploymentMode: string;
  readonly tags?: Record<string, string>;
}

export interface RegisterInstanceResponse {
  readonly oauthClientId: string;
  readonly instanceId: string;
  readonly registeredAt: string;
  readonly startedAt: string;
}

export async function registerInstance(
  providerUrl: string,
  accessToken: string,
  request: RegisterInstanceRequest,
  signal: AbortSignal,
): Promise<RegisterInstanceResponse> {
  const resp = await fetch(`${providerUrl}/api/v1/serve/instances`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify(request),
    signal,
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(
      `Instance registration failed: ${resp.status} ${resp.statusText}${
        data.error ? ` — ${data.error}` : ""
      }`,
    );
  }
  return await resp.json() as RegisterInstanceResponse;
}

export interface HeartbeatResponse {
  readonly oauthClientId: string;
  readonly lastHeartbeatAt: string;
  readonly heartbeatCount: number;
}

export async function sendInstanceHeartbeat(
  providerUrl: string,
  accessToken: string,
  oauthClientId: string,
  signal: AbortSignal,
): Promise<HeartbeatResponse> {
  const resp = await fetch(
    `${providerUrl}/api/v1/serve/instances/${
      encodeURIComponent(oauthClientId)
    }/heartbeat`,
    {
      method: "PUT",
      headers: {
        "authorization": `Bearer ${accessToken}`,
      },
      signal,
    },
  );
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(
      `Instance heartbeat failed: ${resp.status} ${resp.statusText}${
        data.error ? ` — ${data.error}` : ""
      }`,
    );
  }
  return await resp.json() as HeartbeatResponse;
}

/**
 * 404 means the user does not exist; a 401 or 403 throws
 * UsernameLookupRefusedError; any other failure throws a plain Error so callers
 * can tell absent from unanswered
 */
export class UsernameNotFoundError extends Error {
  readonly username: string;
  readonly providerUrl: string;

  constructor(username: string, providerUrl: string) {
    super(`Username '${username}' not found on ${providerUrl}`);
    this.username = username;
    this.providerUrl = providerUrl;
    this.name = "UsernameNotFoundError";
  }
}

/**
 * the message names the scope a collective API token needs without claiming
 * which credential was used, since startup may use a login token from the
 * device grant
 */
export class UsernameLookupRefusedError extends Error {
  readonly username: string;
  readonly providerUrl: string;
  readonly status: number;

  constructor(
    username: string,
    providerUrl: string,
    status: number,
    statusText: string,
  ) {
    super(
      `Failed to resolve username '${username}': ${status} ${statusText}. ` +
        `${providerUrl} refused to look up users with this credential; if it is a collective API token, it needs the oauth:manage scope`,
    );
    this.username = username;
    this.providerUrl = providerUrl;
    this.status = status;
    this.name = "UsernameLookupRefusedError";
  }
}

export async function resolveUsername(
  providerUrl: string,
  username: string,
  accessToken: string,
  signal: AbortSignal,
): Promise<string> {
  const resp = await fetch(
    `${providerUrl}/api/auth/resolve-user?username=${
      encodeURIComponent(username)
    }`,
    {
      headers: { "authorization": `Bearer ${accessToken}` },
      signal,
    },
  );
  if (resp.status === 404) {
    throw new UsernameNotFoundError(username, providerUrl);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new UsernameLookupRefusedError(
      username,
      providerUrl,
      resp.status,
      resp.statusText,
    );
  }
  if (!resp.ok) {
    throw new Error(
      `Failed to resolve username '${username}': ${resp.status} ${resp.statusText}`,
    );
  }
  const data = await resp.json();
  if (typeof data.sub !== "string" || !data.sub) {
    throw new Error(
      `resolve-user response missing required 'sub' field for '${username}'`,
    );
  }
  return data.sub;
}
