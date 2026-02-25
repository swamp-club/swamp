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

import { Command } from "@cliffy/command";
import { createContext, type GlobalOptions, isStdinTty } from "../context.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { SwampClubClient } from "../../infrastructure/http/swamp_club_client.ts";
import { startCallbackServer } from "../../infrastructure/http/callback_server.ts";
import { openBrowser } from "../../infrastructure/process/browser.ts";
import { UserError } from "../../domain/errors.ts";

const DEFAULT_SERVER_URL = "https://swamp.club";

/** Resolve server URL: env var > default */
function resolveServerUrl(): string {
  return Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SERVER_URL;
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
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  await Deno.stdout.write(encoder.encode(prompt));

  // Attempt to disable echo for password input
  Deno.stdin.setRaw(true);
  try {
    const chars: number[] = [];
    const buf = new Uint8Array(1);
    while (true) {
      const n = await Deno.stdin.read(buf);
      if (n === null) break;
      // Enter key
      if (buf[0] === 13 || buf[0] === 10) break;
      // Backspace
      if (buf[0] === 127 || buf[0] === 8) {
        chars.pop();
        continue;
      }
      // Ctrl-C
      if (buf[0] === 3) {
        await Deno.stdout.write(encoder.encode("\n"));
        throw new UserError("Cancelled.");
      }
      chars.push(buf[0]);
    }
    await Deno.stdout.write(encoder.encode("\n"));
    return decoder.decode(new Uint8Array(chars));
  } finally {
    Deno.stdin.setRaw(false);
  }
}

/** Get a session token via the browser-based login flow. */
async function browserFlow(serverUrl: string): Promise<string> {
  const state = crypto.randomUUID();
  const server = startCallbackServer(state);

  const callbackUrl = `http://localhost:${server.port}/callback`;
  const loginUrl = `${serverUrl}/login?cli_callback=${
    encodeURIComponent(callbackUrl)
  }&state=${encodeURIComponent(state)}`;

  console.log("Opening browser to log in...");

  try {
    await openBrowser(loginUrl);
  } catch (err) {
    // openBrowser throws UserError with the URL — print it and continue waiting
    if (err instanceof UserError) {
      console.log(err.message);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      throw new UserError(`Failed to open browser: ${message}`);
    }
  }

  console.log("Waiting for authentication...");

  try {
    const token = await server.token;
    return token;
  } finally {
    await server.shutdown();
  }
}

/** Get a session token via the stdin username/password flow. */
async function stdinFlow(
  serverUrl: string,
  usernameOpt: string | undefined,
  passwordOpt: string | undefined,
): Promise<{ token: string; username: string }> {
  const username: string = usernameOpt ?? await readLine("Username or email: ");
  const password: string = passwordOpt ?? await readPassword("Password: ");

  if (!username || !password) {
    throw new UserError("Username and password are required.");
  }

  const client = new SwampClubClient(serverUrl);
  const signIn = await client.signIn(username, password);
  return { token: signIn.token, username: signIn.user.username };
}

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const authLoginCommand = new Command()
  .name("login")
  .description("Authenticate with a swamp-club server")
  .option(
    "--server <url:string>",
    "Server URL (env: SWAMP_CLUB_URL)",
  )
  .option("--username <username:string>", "Username or email")
  .option("--password <password:string>", "Password (omit to prompt)")
  .option("--no-browser", "Disable browser login, use username/password")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["auth", "login"]);
    ctx.logger.debug("Executing auth login command");

    const serverUrl: string = options.server ?? resolveServerUrl();
    const client = new SwampClubClient(serverUrl);

    // Decide which flow to use:
    // - stdin flow if --username/--password provided, --no-browser, or non-TTY
    // - browser flow otherwise
    const useStdinFlow = options.username || options.password ||
      options.browser === false || !isStdinTty();

    let sessionToken: string;
    let knownUsername: string | undefined;

    if (useStdinFlow) {
      ctx.logger.debug("Using stdin login flow");
      const result = await stdinFlow(
        serverUrl,
        options.username,
        options.password,
      );
      sessionToken = result.token;
      knownUsername = result.username;
    } else {
      ctx.logger.debug("Using browser login flow");
      sessionToken = await browserFlow(serverUrl);
    }

    // Verify identity using the session token (bearer plugin handles this)
    const whoami = await client.whoami(sessionToken);
    const username = whoami.username ?? knownUsername ?? "unknown";

    // Create an API key for CLI use
    // BetterAuth limits API key names to 32 characters
    const host = (Deno.hostname?.() ?? "unknown").slice(0, 14);
    const keyName = `cli-${host}-${Date.now()}`;
    ctx.logger.debug`Creating API key: ${keyName}`;
    const apiKey = await client.createApiKey(sessionToken, keyName);

    // Store credentials
    const repo = new AuthRepository();
    await repo.save({
      serverUrl,
      apiKey: apiKey.key,
      apiKeyId: apiKey.id,
      username,
    });

    if (ctx.outputMode === "json") {
      console.log(JSON.stringify(
        {
          authenticated: true,
          serverUrl,
          username,
        },
        null,
        2,
      ));
    } else {
      console.log(
        `Logged in as ${username} on ${serverUrl}`,
      );
    }

    ctx.logger.debug("Auth login command completed");
  });
