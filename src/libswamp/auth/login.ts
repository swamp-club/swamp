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

import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { AuthVerificationRepository } from "../../infrastructure/persistence/auth_verification_repository.ts";
import {
  getCollectives,
  SwampClubClient,
} from "../../infrastructure/http/swamp_club_client.ts";
import type { ClientIdentity } from "../../infrastructure/http/client_identity.ts";
import { openBrowser } from "../../infrastructure/process/browser.ts";
import { UserError } from "../../domain/errors.ts";
import { readSecretFromTty } from "../../infrastructure/io/stdin_reader.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { validationFailed } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import {
  createAccountNoticeDeps,
  refreshAccountNotices,
} from "../account_notices/notice.ts";

export const CLI_CLIENT_ID = "swamp-cli";

const DEFAULT_MIN_DEVICE_AUTH_EXPIRY_MS = 300_000;

const CREDENTIALS_REQUIRED = "Username and password are required.";

// Shown instead of prompting when stdin is not a terminal; keep it in step
// with the non-interactive guidance in the `auth login` help text.
const NO_TERMINAL_GUIDANCE =
  "There is no terminal to prompt on. For non-interactive use (CI, agents, " +
  "scripts), set the SWAMP_API_KEY environment variable (or " +
  "SWAMP_API_KEY_FILE, a path to a file holding the key), or pipe the " +
  "password with --username: " +
  "printf 'mypassword\\n' | swamp auth login --username alice --no-browser";

export interface AuthLoginData {
  username: string;
  email?: string;
  name?: string;
  serverUrl: string;
  apiKey: string;
}

export type AuthLoginEvent =
  | { kind: "opening_browser" }
  | { kind: "browser_open_failed"; message: string }
  | {
    kind: "device_verification";
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
  }
  | { kind: "polling" }
  | { kind: "securing_session" }
  | { kind: "completed"; data: AuthLoginData }
  | { kind: "error"; error: SwampError };

export interface AuthLoginInput {
  serverUrl: string;
  useBrowserFlow: boolean;
  username?: string;
  password?: string;
  minDeviceAuthExpiryMs?: number;
  stdinIsTerminal?: boolean;
}

export interface DeviceAuthResponse {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresIn: number;
  readonly interval: number;
}

export interface DeviceTokenResponse {
  readonly accessToken: string;
}

export class DeviceAuthPendingError extends Error {
  readonly slowDown: boolean;
  constructor(slowDown = false) {
    super(slowDown ? "slow_down" : "authorization_pending");
    this.name = "DeviceAuthPendingError";
    this.slowDown = slowDown;
  }
}

export interface AuthLoginDeps {
  openBrowser: (url: string) => Promise<boolean>;
  startDeviceAuth: (
    serverUrl: string,
    clientId: string,
    signal: AbortSignal,
  ) => Promise<DeviceAuthResponse>;
  pollDeviceToken: (
    serverUrl: string,
    deviceCode: string,
    clientId: string,
    signal: AbortSignal,
  ) => Promise<DeviceTokenResponse>;
  signIn: (
    serverUrl: string,
    username: string,
    password: string,
  ) => Promise<{ token: string; username: string }>;
  readCredentials: (prefilled?: {
    username?: string;
    password?: string;
  }) => Promise<{ username: string; password: string }>;
  createApiKey: (
    serverUrl: string,
    sessionToken: string,
    keyName: string,
  ) => Promise<{ id: string; key: string }>;
  whoami: (
    serverUrl: string,
    apiKey: string,
  ) => Promise<{
    username?: string;
    email?: string;
    name?: string;
    collectives?: string[];
  }>;
  saveCredentials: (credentials: {
    serverUrl: string;
    apiKey: string;
    apiKeyId: string;
    username: string;
    collectives?: string[];
  }) => Promise<void>;
  getHostname: () => string;
  // best effort and bounded; never throws
  refreshAccountNotices?: () => Promise<void>;
}

async function readLine(prompt: string): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  await Deno.stdout.write(encoder.encode(prompt));

  const buf = new Uint8Array(4096);
  const n = await Deno.stdin.read(buf);
  if (n === null) {
    return "";
  }
  return decoder.decode(buf.subarray(0, n)).trim();
}

async function readPassword(prompt: string): Promise<string> {
  if (!Deno.stdin.isTerminal()) {
    return await readLine(prompt);
  }
  try {
    return await readSecretFromTty(prompt);
  } catch (err) {
    if (err instanceof Error && err.message === "Cancelled.") {
      throw new UserError("Cancelled.");
    }
    throw err;
  }
}

async function deviceRequest(
  serverUrl: string,
  endpoint: string,
  payload: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ status: number; ok: boolean; statusText: string; text: string }> {
  try {
    const resp = await fetch(`${serverUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    const text = await resp.text();
    return {
      status: resp.status,
      ok: resp.ok,
      statusText: resp.statusText,
      text,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new UserError(
        `Request to ${serverUrl}${endpoint} timed out.`,
        "timeout",
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new UserError(`Could not connect to ${serverUrl}: ${message}`);
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * identity is optional and bearerToken is normally undefined, since login runs
 * before the user has a personal API key; distinctId lets the handshake traffic
 * attribute to a device
 */
export function createAuthLoginDeps(
  identity?: ClientIdentity,
): AuthLoginDeps {
  const repo = new AuthRepository();
  return {
    openBrowser: async (url: string): Promise<boolean> => {
      try {
        await openBrowser(url);
        return true;
      } catch {
        return false;
      }
    },
    startDeviceAuth: async (
      serverUrl: string,
      clientId: string,
      signal: AbortSignal,
    ): Promise<DeviceAuthResponse> => {
      const resp = await deviceRequest(
        serverUrl,
        "/api/auth/device/code",
        { client_id: clientId },
        signal,
      );
      const body = resp.text;
      if (!resp.ok) {
        throw new UserError(
          `Failed to start device authorization: ${resp.status} ${body}`,
        );
      }
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(body);
      } catch {
        throw new UserError(
          `Failed to start device authorization: server returned invalid JSON`,
        );
      }
      return {
        deviceCode: data.device_code as string,
        userCode: data.user_code as string,
        verificationUri: data.verification_uri as string,
        verificationUriComplete: data.verification_uri_complete as
          | string
          | undefined,
        expiresIn: data.expires_in as number,
        interval: data.interval as number,
      };
    },
    pollDeviceToken: async (
      serverUrl: string,
      deviceCode: string,
      clientId: string,
      signal: AbortSignal,
    ): Promise<DeviceTokenResponse> => {
      const resp = await deviceRequest(
        serverUrl,
        "/api/auth/device/token",
        {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          client_id: clientId,
        },
        signal,
      );
      const body = resp.text;
      if (resp.status === 403 || resp.status === 410) {
        throw new UserError(
          `Device authorization failed: ${body || resp.statusText}`,
        );
      }
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(body);
      } catch {
        throw new UserError(
          `Failed to poll device token: ${resp.status} ${body}`,
        );
      }
      if (data.error === "authorization_pending") {
        throw new DeviceAuthPendingError(false);
      }
      if (data.error === "slow_down") {
        throw new DeviceAuthPendingError(true);
      }
      if (!resp.ok) {
        throw new UserError(
          `Failed to poll device token: ${resp.status} ${body}`,
        );
      }
      if (typeof data.access_token !== "string" || !data.access_token) {
        throw new UserError(
          `Server returned 200 but no access_token in response`,
        );
      }
      return { accessToken: data.access_token };
    },
    signIn: async (serverUrl: string, username: string, password: string) => {
      const client = new SwampClubClient(serverUrl, identity);
      const result = await client.signIn(username, password);
      return { token: result.token, username: result.user.username };
    },
    readCredentials: async (prefilled) => {
      const username = prefilled?.username ??
        await readLine("Username or email: ");
      const password = prefilled?.password ??
        await readPassword("Password: ");
      return { username, password };
    },
    createApiKey: async (
      serverUrl: string,
      sessionToken: string,
      keyName: string,
    ) => {
      const client = new SwampClubClient(serverUrl, identity);
      return await client.createApiKey(sessionToken, keyName);
    },
    whoami: async (serverUrl: string, apiKey: string) => {
      const client = new SwampClubClient(serverUrl, identity);
      const result = await client.whoami(apiKey);
      if (
        result.verificationProof && result.verificationSignature &&
        result.publicKeys
      ) {
        const verificationRepo = new AuthVerificationRepository();
        await verificationRepo.save(
          result.verificationProof,
          result.verificationSignature,
          result.publicKeys,
        ).catch(() => {});
        // A verified answer ends any fail-open window an outage started.
        await verificationRepo.clearFailOpen().catch(() => {});
      }
      return {
        username: result.username,
        email: result.email,
        name: result.name,
        collectives: getCollectives(result),
      };
    },
    saveCredentials: (credentials) => repo.save(credentials),
    getHostname: () => Deno.hostname?.() ?? "unknown",
    refreshAccountNotices: async () => {
      await refreshAccountNotices(createAccountNoticeDeps({ identity }));
    },
  };
}

export async function* authLogin(
  ctx: LibSwampContext,
  deps: AuthLoginDeps,
  input: AuthLoginInput,
): AsyncIterable<AuthLoginEvent> {
  yield* withGeneratorSpan(
    "swamp.auth.login",
    {},
    (async function* () {
      ctx.logger.debug`Executing auth login`;

      let sessionToken: string;
      let knownUsername: string | undefined;

      if (input.useBrowserFlow) {
        const deviceAuth = await deps.startDeviceAuth(
          input.serverUrl,
          CLI_CLIENT_ID,
          AbortSignal.timeout(10_000),
        );

        const minExpiryMs = input.minDeviceAuthExpiryMs ??
          DEFAULT_MIN_DEVICE_AUTH_EXPIRY_MS;
        const expiryMs = Math.max(deviceAuth.expiresIn * 1000, minExpiryMs);
        const signal = AbortSignal.timeout(expiryMs);

        yield {
          kind: "device_verification",
          userCode: deviceAuth.userCode,
          verificationUri: deviceAuth.verificationUri,
          verificationUriComplete: deviceAuth.verificationUriComplete,
        };

        const urlToOpen = deviceAuth.verificationUriComplete ??
          deviceAuth.verificationUri;
        yield { kind: "opening_browser" };
        const opened = await deps.openBrowser(urlToOpen);
        if (!opened) {
          yield {
            kind: "browser_open_failed",
            message:
              `Could not open browser automatically. Please visit the URL above.`,
          };
        }

        let intervalMs = (deviceAuth.interval > 0 ? deviceAuth.interval : 5) *
          1000;
        const deadline = Date.now() + expiryMs;

        let token: string | undefined;
        while (Date.now() < deadline) {
          yield { kind: "polling" };
          try {
            const result = await deps.pollDeviceToken(
              input.serverUrl,
              deviceAuth.deviceCode,
              CLI_CLIENT_ID,
              signal,
            );
            token = result.accessToken;
            break;
          } catch (err) {
            if (signal.aborted) {
              break;
            }
            if (err instanceof DeviceAuthPendingError) {
              if (err.slowDown) {
                intervalMs += 5000;
              }
              try {
                await delay(intervalMs, signal);
              } catch {
                break;
              }
              continue;
            }
            yield {
              kind: "error",
              error: err instanceof UserError
                ? { code: "user_error", message: err.message }
                : {
                  code: "unknown",
                  message: err instanceof Error ? err.message : String(err),
                },
            };
            return;
          }
        }

        if (!token) {
          yield {
            kind: "error",
            error: {
              code: "user_error",
              message: "Device authorization timed out",
            },
          };
          return;
        }

        sessionToken = token;
      } else {
        let username = input.username;
        let password = input.password;
        if (!username && input.stdinIsTerminal === false) {
          yield {
            kind: "error",
            error: validationFailed(
              `${CREDENTIALS_REQUIRED} ${NO_TERMINAL_GUIDANCE}`,
            ),
          };
          return;
        }
        if (!username || !password) {
          const creds = await deps.readCredentials({ username, password });
          username = creds.username;
          password = creds.password;
        }

        if (!username || !password) {
          yield {
            kind: "error",
            error: validationFailed(CREDENTIALS_REQUIRED),
          };
          return;
        }

        const result = await deps.signIn(input.serverUrl, username, password);
        sessionToken = result.token;
        knownUsername = result.username;
      }

      yield { kind: "securing_session" };

      // swamp-club expires login keys by matching this name shape
      // (LOGIN_KEY_NAME in lib/auth-body-hook.ts); keep the two in step.
      const host = deps.getHostname().slice(0, 14);
      const keyName = `cli-${host}-${Date.now()}`;
      ctx.logger.debug`Creating API key: ${keyName}`;
      const apiKey = await deps.createApiKey(
        input.serverUrl,
        sessionToken,
        keyName,
      );
      const identity = await deps.whoami(input.serverUrl, apiKey.key);
      const username = identity.username ?? knownUsername ?? "unknown";

      await deps.saveCredentials({
        serverUrl: input.serverUrl,
        apiKey: apiKey.key,
        apiKeyId: apiKey.id,
        username,
        ...(identity.collectives ? { collectives: identity.collectives } : {}),
      });

      yield {
        kind: "completed",
        data: {
          username,
          email: identity.email,
          name: identity.name,
          serverUrl: input.serverUrl,
          apiKey: apiKey.key,
        },
      };
      // after success is reported, so a slow fetch never delays it
      await deps.refreshAccountNotices?.();
    })(),
  );
}
