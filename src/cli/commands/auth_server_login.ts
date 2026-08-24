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

import { Command } from "@cliffy/command";
import { createContext, type GlobalOptions } from "../context.ts";
import { UserError } from "../../domain/errors.ts";
import { getEnvCaCerts, resolveServeUrl } from "../remote_run.ts";
import { FileServerCredentialRepository } from "../../infrastructure/persistence/server_credential_repository.ts";
import { normalizeServerUrl } from "../../domain/auth/server_url.ts";
import { splitServerToken } from "../../serve/token_auth.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { bold, green, yellow } from "@std/fmt/colors";
import { createServerLoginDeps, serverLogin } from "../../libswamp/mod.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const authServerLoginCommand = new Command()
  .name("server-login")
  .description(
    "Authenticate with a swamp serve instance — uses OAuth device flow " +
      "when available, or store a static token with --token",
  )
  .example(
    "OAuth login",
    "swamp auth server-login --server wss://swamp.acme.internal:9090",
  )
  .example(
    "Save a static token",
    "swamp auth server-login --server wss://swamp.acme.internal:9090 --token adam-token.a1b2c3...",
  )
  .option(
    "--server <url:string>",
    "Server URL to authenticate with (env: SWAMP_SERVE_URL)",
  )
  .option(
    "--token <token:string>",
    "Server token in <name>.<secret> format (skips OAuth flow)",
  )
  .option(
    "--ca-cert <path:string>",
    "Path to PEM-encoded CA certificate to trust for TLS connections to the server (env: SWAMP_CA_CERT)",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "auth",
      "server-login",
    ]);

    const server = resolveServeUrl(options.server as string | undefined);
    if (!server) {
      throw new UserError(
        "--server is required (or set SWAMP_SERVE_URL)",
      );
    }

    const token = options.token as string | undefined;

    if (token) {
      await handleStaticToken(server, cliCtx, token);
    } else {
      await handleOAuthFlow(server, cliCtx);
    }

    cliCtx.logger.debug("Server login command completed");
  });

async function handleStaticToken(
  rawUrl: string,
  cliCtx: { outputMode: string },
  token: string,
): Promise<void> {
  const split = splitServerToken(token);
  if (split === null) {
    throw new UserError(
      `Invalid --token value: expected <name>.<secret> format`,
    );
  }

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "ws:") parsed.protocol = "http:";
    else if (parsed.protocol === "wss:") parsed.protocol = "https:";
    rawUrl = parsed.href;
  } catch {
    throw new UserError(
      `Invalid --server URL "${rawUrl}": expected ws://, wss://, http://, or https:// URL`,
    );
  }
  let serverUrl: string;
  try {
    serverUrl = normalizeServerUrl(rawUrl);
  } catch {
    throw new UserError(
      `Invalid --server URL "${rawUrl}": expected ws://, wss://, http://, or https:// URL`,
    );
  }

  const repo = new FileServerCredentialRepository();
  await repo.save({
    serverUrl,
    tokenName: split.name,
    token,
    principalId: "",
    obtainedAt: new Date().toISOString(),
  });

  if (cliCtx.outputMode === "json") {
    console.log(JSON.stringify({
      serverUrl,
      tokenName: split.name,
      stored: true,
    }));
  } else {
    writeOutput(
      `${green("✓")} Token ${bold(split.name)} stored for ${bold(serverUrl)}`,
    );
  }
}

async function handleOAuthFlow(
  rawUrl: string,
  cliCtx: { outputMode: string },
): Promise<void> {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "ws:") parsed.protocol = "http:";
    else if (parsed.protocol === "wss:") parsed.protocol = "https:";
    rawUrl = parsed.href;
  } catch {
    throw new UserError(
      `Invalid --server URL "${rawUrl}": expected ws://, wss://, http://, or https:// URL`,
    );
  }
  const normalizedUrl = normalizeServerUrl(rawUrl);
  const caCerts = getEnvCaCerts();
  const httpClient = caCerts?.length
    ? Deno.createHttpClient({ caCerts })
    : undefined;
  const deps = createServerLoginDeps({ httpClient });
  const input = { serverUrl: rawUrl, signal: AbortSignal.timeout(300_000) };

  for await (const event of serverLogin(deps, input)) {
    switch (event.kind) {
      case "discovering":
        if (cliCtx.outputMode !== "json") {
          writeOutput("Discovering server auth mode...");
        }
        break;
      case "device_verification":
        if (cliCtx.outputMode === "json") {
          console.log(JSON.stringify({
            status: "device_verification",
            userCode: event.userCode,
            verificationUri: event.verificationUri,
            verificationUriComplete: event.verificationUriComplete,
          }));
        } else {
          writeOutput(
            `\nYour verification code: ${bold(event.userCode)}\n`,
          );
          if (event.verificationUriComplete) {
            writeOutput(
              `Open: ${bold(event.verificationUriComplete)}`,
            );
          } else {
            writeOutput(
              `Visit ${bold(event.verificationUri)} and enter code ${
                bold(event.userCode)
              }`,
            );
          }
        }
        break;
      case "opening_browser":
        if (cliCtx.outputMode !== "json") {
          writeOutput("Opening browser...");
        }
        break;
      case "browser_open_failed":
        if (cliCtx.outputMode === "json") {
          console.log(JSON.stringify({
            status: "browser_open_failed",
            message: event.message,
          }));
        } else {
          writeOutput(yellow(event.message));
        }
        break;
      case "polling":
        break;
      case "completed":
        if (cliCtx.outputMode === "json") {
          console.log(JSON.stringify({
            status: "authenticated",
            serverUrl: normalizedUrl,
            principalId: event.data.principalId,
            principalEmail: event.data.principalEmail,
            displayName: event.data.displayName,
            collectives: event.data.collectives,
          }));
        } else {
          writeOutput(
            `\n${green("✓")} Authenticated as ${
              bold(event.data.displayName || event.data.principalEmail)
            }`,
          );
        }
        break;
      case "error":
        throw event.error;
    }
  }
}
