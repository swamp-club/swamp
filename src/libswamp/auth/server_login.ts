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

import type { ServerCredential } from "../../domain/auth/server_credential.ts";
import { normalizeServerUrl } from "../../domain/auth/server_url.ts";
import { openBrowser } from "../../infrastructure/process/browser.ts";
import { FileServerCredentialRepository } from "../../infrastructure/persistence/server_credential_repository.ts";
import { UserError } from "../../domain/errors.ts";

/** Data returned on successful server login via OAuth device flow. */
export interface ServerLoginData {
  readonly token: string;
  readonly principalId: string;
  readonly principalEmail: string;
  readonly displayName: string;
  readonly collectives: string[];
}

/** Events emitted by the server login generator. */
export type ServerLoginEvent =
  | { kind: "discovering" }
  | {
    kind: "device_verification";
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
  }
  | { kind: "opening_browser" }
  | { kind: "browser_open_failed"; message: string }
  | { kind: "polling" }
  | { kind: "completed"; data: ServerLoginData }
  | { kind: "error"; error: Error };

/** Input parameters for the server login generator. */
export interface ServerLoginInput {
  readonly serverUrl: string;
  readonly signal?: AbortSignal;
}

/** Auth discovery response from a serve instance. */
export interface AuthDiscovery {
  readonly mode: string;
  readonly verificationBaseUri?: string;
}

/** Device authorization response from a serve instance. */
export interface DeviceAuthResponse {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresIn: number;
  readonly interval: number;
}

/** Token response from a device code poll. */
export interface DeviceTokenResponse {
  readonly token: string;
  readonly principal: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
    readonly collectives: string[];
  };
}

/** Error thrown when the device token poll receives a "pending" response. */
export class DeviceAuthPendingError extends Error {
  constructor() {
    super("authorization_pending");
    this.name = "DeviceAuthPendingError";
  }
}

/** Dependencies for the server login operation, injected for testability. */
export interface ServerLoginDeps {
  readonly discoverAuthMode: (
    serverUrl: string,
    signal: AbortSignal,
  ) => Promise<AuthDiscovery>;
  readonly startDeviceAuth: (
    serverUrl: string,
    signal: AbortSignal,
  ) => Promise<DeviceAuthResponse>;
  readonly pollDeviceToken: (
    serverUrl: string,
    deviceCode: string,
    signal: AbortSignal,
  ) => Promise<DeviceTokenResponse>;
  readonly openBrowser: (url: string) => Promise<boolean>;
  readonly saveCredential: (credential: ServerCredential) => Promise<void>;
  readonly normalizeServerUrl: (url: string) => string;
}

/**
 * Convert a WebSocket URL scheme to HTTP(S) for REST calls.
 * ws:// -> http://, wss:// -> https://. HTTP(S) URLs pass through unchanged.
 */
function wsToHttp(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "ws:") parsed.protocol = "http:";
  else if (parsed.protocol === "wss:") parsed.protocol = "https:";
  return parsed.href.replace(/\/+$/, "");
}

/**
 * Create production dependencies for server login.
 */
export function createServerLoginDeps(): ServerLoginDeps {
  const repo = new FileServerCredentialRepository();
  return {
    discoverAuthMode: async (
      serverUrl: string,
      signal: AbortSignal,
    ): Promise<AuthDiscovery> => {
      const httpUrl = wsToHttp(serverUrl);
      const resp = await fetch(`${httpUrl}/auth/info`, { signal });
      if (!resp.ok) {
        throw new UserError(
          `Failed to discover auth mode: ${resp.status} ${resp.statusText}`,
        );
      }
      return await resp.json() as AuthDiscovery;
    },

    startDeviceAuth: async (
      serverUrl: string,
      signal: AbortSignal,
    ): Promise<DeviceAuthResponse> => {
      const httpUrl = wsToHttp(serverUrl);
      const resp = await fetch(`${httpUrl}/auth/device`, {
        method: "POST",
        signal,
      });
      if (!resp.ok) {
        throw new UserError(
          `Failed to start device authorization: ${resp.status} ${resp.statusText}`,
        );
      }
      return await resp.json() as DeviceAuthResponse;
    },

    pollDeviceToken: async (
      serverUrl: string,
      deviceCode: string,
      signal: AbortSignal,
    ): Promise<DeviceTokenResponse> => {
      const httpUrl = wsToHttp(serverUrl);
      const resp = await fetch(`${httpUrl}/auth/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode }),
        signal,
      });
      if (resp.status === 202) {
        throw new DeviceAuthPendingError();
      }
      if (resp.status === 403 || resp.status === 410) {
        const body = await resp.text();
        throw new UserError(
          `Device authorization failed: ${body || resp.statusText}`,
        );
      }
      if (!resp.ok) {
        throw new UserError(
          `Failed to poll device token: ${resp.status} ${resp.statusText}`,
        );
      }
      return await resp.json() as DeviceTokenResponse;
    },

    openBrowser: async (url: string): Promise<boolean> => {
      try {
        await openBrowser(url);
        return true;
      } catch {
        return false;
      }
    },

    saveCredential: (credential: ServerCredential) => repo.save(credential),
    normalizeServerUrl,
  };
}

/** Delay helper that respects AbortSignal. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Authenticate with a swamp serve instance via the OAuth device code flow.
 *
 * Yields events as the flow progresses so the CLI can render status updates.
 */
export async function* serverLogin(
  deps: ServerLoginDeps,
  input: ServerLoginInput,
): AsyncGenerator<ServerLoginEvent> {
  const signal = input.signal ?? AbortSignal.timeout(300_000);
  const serverUrl = deps.normalizeServerUrl(
    wsToHttp(input.serverUrl),
  );

  // Step 1: Discover auth mode
  yield { kind: "discovering" };
  const discovery = await deps.discoverAuthMode(serverUrl, signal);

  if (discovery.mode !== "oauth") {
    throw new UserError(
      `Server does not support OAuth login (mode: ${discovery.mode}). ` +
        `Use 'swamp auth server-login --server <url> --token <token>' for token-based auth.`,
    );
  }

  // Step 2: Start device authorization
  const deviceAuth = await deps.startDeviceAuth(serverUrl, signal);

  yield {
    kind: "device_verification",
    userCode: deviceAuth.userCode,
    verificationUri: deviceAuth.verificationUri,
    verificationUriComplete: deviceAuth.verificationUriComplete,
  };

  // Step 3: Try to open browser
  const urlToOpen = deviceAuth.verificationUriComplete ??
    deviceAuth.verificationUri;
  yield { kind: "opening_browser" };
  const opened = await deps.openBrowser(urlToOpen);
  if (!opened) {
    yield {
      kind: "browser_open_failed",
      message:
        `Could not open browser automatically. Please visit: ${urlToOpen}`,
    };
  }

  // Step 4: Poll for token
  const intervalMs = (deviceAuth.interval > 0 ? deviceAuth.interval : 5) * 1000;
  const deadline = Date.now() + deviceAuth.expiresIn * 1000;

  while (Date.now() < deadline) {
    yield { kind: "polling" };
    try {
      const tokenResult = await deps.pollDeviceToken(
        serverUrl,
        deviceAuth.deviceCode,
        signal,
      );

      // Save credential
      await deps.saveCredential({
        serverUrl,
        tokenName: tokenResult.principal.email,
        token: tokenResult.token,
        principalId: tokenResult.principal.id,
        displayName: tokenResult.principal.name,
        obtainedAt: new Date().toISOString(),
      });

      yield {
        kind: "completed",
        data: {
          token: tokenResult.token,
          principalId: tokenResult.principal.id,
          principalEmail: tokenResult.principal.email,
          displayName: tokenResult.principal.name,
          collectives: tokenResult.principal.collectives,
        },
      };
      return;
    } catch (err) {
      if (err instanceof DeviceAuthPendingError) {
        await delay(intervalMs, signal);
        continue;
      }
      yield {
        kind: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      };
      return;
    }
  }

  yield {
    kind: "error",
    error: new UserError("Device authorization timed out"),
  };
}
