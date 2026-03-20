// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import {
  getCollectives,
  SwampClubClient,
} from "../../infrastructure/http/swamp_club_client.ts";
import { startCallbackServer } from "../../infrastructure/http/callback_server.ts";
import { openBrowser } from "../../infrastructure/process/browser.ts";
import { UserError } from "../../domain/errors.ts";
import { readSecretFromTty } from "../../infrastructure/io/stdin_reader.ts";
import { generateDeviceCode } from "../../domain/auth/device_code.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { validationFailed } from "../errors.ts";

/** Data returned on successful authentication. */
export interface AuthLoginData {
  username: string;
  email?: string;
  name?: string;
  serverUrl: string;
  apiKey: string;
}

/** Events emitted by the auth login generator. */
export type AuthLoginEvent =
  | { kind: "opening_browser" }
  | { kind: "browser_open_failed"; message: string }
  | { kind: "device_verification"; deviceCode: string }
  | { kind: "waiting_for_auth" }
  | { kind: "securing_session" }
  | { kind: "completed"; data: AuthLoginData }
  | { kind: "error"; error: SwampError };

/** Input parameters for the auth login generator. */
export interface AuthLoginInput {
  serverUrl: string;
  useBrowserFlow: boolean;
  username?: string;
  password?: string;
}

/** Handle returned by the callback server dependency. */
export interface CallbackServerHandle {
  port: number;
  token: Promise<string>;
  shutdown: () => Promise<void>;
}

/** Dependencies for the auth login operation, injected for testability. */
export interface AuthLoginDeps {
  /** Try to open a URL in the browser. Returns error message if it fails, null on success. */
  openBrowser: (url: string) => Promise<string | null>;
  /** Start callback server, returns port, token promise, and shutdown function. */
  startCallbackServer: (
    state: string,
    serverUrl: string,
  ) => CallbackServerHandle;
  /** Sign in with username/password, returns session token and username. */
  signIn: (
    serverUrl: string,
    username: string,
    password: string,
  ) => Promise<{ token: string; username: string }>;
  /** Read credentials from user (for interactive stdin flow). */
  readCredentials: () => Promise<{ username: string; password: string }>;
  /** Create API key for CLI use. */
  createApiKey: (
    serverUrl: string,
    sessionToken: string,
    keyName: string,
  ) => Promise<{ id: string; key: string }>;
  /** Get user identity. */
  whoami: (
    serverUrl: string,
    apiKey: string,
  ) => Promise<{
    username?: string;
    email?: string;
    name?: string;
    collectives?: string[];
  }>;
  /** Save credentials to persistent storage. */
  saveCredentials: (credentials: {
    serverUrl: string;
    apiKey: string;
    apiKeyId: string;
    username: string;
    collectives?: string[];
  }) => Promise<void>;
  /** Generate a device verification code. */
  generateDeviceCode: () => string;
  /** Get hostname for API key naming. */
  getHostname: () => string;
}

/** Read a line from stdin. */
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

/** Read a password from stdin without echoing. */
async function readPassword(prompt: string): Promise<string> {
  try {
    return await readSecretFromTty(prompt);
  } catch (err) {
    if (err instanceof Error && err.message === "Cancelled.") {
      throw new UserError("Cancelled.");
    }
    throw err;
  }
}

/** Wires real infrastructure into AuthLoginDeps. */
export function createAuthLoginDeps(): AuthLoginDeps {
  const repo = new AuthRepository();
  return {
    openBrowser: async (url: string): Promise<string | null> => {
      try {
        await openBrowser(url);
        return null;
      } catch (err) {
        if (err instanceof UserError) {
          return err.message;
        }
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to open browser: ${message}`;
      }
    },
    startCallbackServer: (state: string, serverUrl: string) =>
      startCallbackServer(state, serverUrl),
    signIn: async (serverUrl: string, username: string, password: string) => {
      const client = new SwampClubClient(serverUrl);
      const result = await client.signIn(username, password);
      return { token: result.token, username: result.user.username };
    },
    readCredentials: async () => {
      const username = await readLine("Username or email: ");
      const password = await readPassword("Password: ");
      return { username, password };
    },
    createApiKey: async (
      serverUrl: string,
      sessionToken: string,
      keyName: string,
    ) => {
      const client = new SwampClubClient(serverUrl);
      return await client.createApiKey(sessionToken, keyName);
    },
    whoami: async (serverUrl: string, apiKey: string) => {
      const client = new SwampClubClient(serverUrl);
      const result = await client.whoami(apiKey);
      return {
        username: result.username,
        email: result.email,
        name: result.name,
        collectives: getCollectives(result),
      };
    },
    saveCredentials: (credentials) => repo.save(credentials),
    generateDeviceCode,
    getHostname: () => Deno.hostname?.() ?? "unknown",
  };
}

/** Authenticates with a swamp-club server via browser or stdin flow. */
export async function* authLogin(
  ctx: LibSwampContext,
  deps: AuthLoginDeps,
  input: AuthLoginInput,
): AsyncIterable<AuthLoginEvent> {
  ctx.logger.debug`Executing auth login`;

  let sessionToken: string;
  let knownUsername: string | undefined;

  if (input.useBrowserFlow) {
    // Browser flow
    const state = crypto.randomUUID();
    const deviceCode = deps.generateDeviceCode();
    const server = deps.startCallbackServer(state, input.serverUrl);

    const callbackUrl = `http://localhost:${server.port}/callback`;
    const loginUrl = `${input.serverUrl}/login?cli_callback=${
      encodeURIComponent(callbackUrl)
    }&state=${encodeURIComponent(state)}&device_code=${
      encodeURIComponent(deviceCode)
    }`;

    yield { kind: "opening_browser" };
    const browserError = await deps.openBrowser(loginUrl);
    if (browserError) {
      yield { kind: "browser_open_failed", message: browserError };
    }

    yield { kind: "device_verification", deviceCode };
    yield { kind: "waiting_for_auth" };

    try {
      sessionToken = await server.token;
    } finally {
      await server.shutdown();
    }
  } else {
    // Stdin flow
    let username = input.username;
    let password = input.password;
    if (!username || !password) {
      const creds = await deps.readCredentials();
      username = username ?? creds.username;
      password = password ?? creds.password;
    }

    if (!username || !password) {
      yield {
        kind: "error",
        error: validationFailed("Username and password are required."),
      };
      return;
    }

    const result = await deps.signIn(input.serverUrl, username, password);
    sessionToken = result.token;
    knownUsername = result.username;
  }

  yield { kind: "securing_session" };

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
}
