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
import { HttpAuthClient } from "../../infrastructure/auth/http_auth_client.ts";
import { CredentialRepository } from "../../infrastructure/auth/credential_repository.ts";
import {
  renderAuthError,
  renderAuthSuccess,
} from "../../presentation/output/auth_output.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Reads a line from stdin with echo disabled (for password input).
 */
async function readPassword(prompt: string): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  await Deno.stdout.write(encoder.encode(prompt));

  Deno.stdin.setRaw(true);
  try {
    const buf = new Uint8Array(1);
    const chars: string[] = [];
    while (true) {
      const n = await Deno.stdin.read(buf);
      if (n === null) break;
      const char = decoder.decode(buf.subarray(0, n));
      if (char === "\n" || char === "\r") {
        await Deno.stdout.write(encoder.encode("\n"));
        break;
      }
      if (char === "\x03") {
        // Ctrl+C
        await Deno.stdout.write(encoder.encode("\n"));
        Deno.exit(130);
      }
      if (char === "\x7f" || char === "\b") {
        // Backspace
        chars.pop();
        continue;
      }
      chars.push(char);
    }
    return chars.join("");
  } finally {
    Deno.stdin.setRaw(false);
  }
}

/**
 * Reads a line from stdin with echo enabled.
 */
async function readLine(prompt: string): Promise<string> {
  const encoder = new TextEncoder();
  await Deno.stdout.write(encoder.encode(prompt));

  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null) return "";
  const decoder = new TextDecoder();
  return decoder.decode(buf.subarray(0, n)).trim();
}

export const authLoginCommand = new Command()
  .name("login")
  .description("Log in to swamp.club")
  .option("--email <email:string>", "Email address")
  .option("--password <password:string>", "Password")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["auth", "login"]);
    const client = new HttpAuthClient();
    const store = new CredentialRepository();

    // Check for existing valid session
    const existing = await store.load();
    if (existing) {
      const session = await client.getSession(existing.sessionToken);
      if (session) {
        renderAuthSuccess(
          {
            action: "login",
            email: session.user.email,
            name: session.user.name,
            userId: session.user.id,
          },
          ctx.outputMode,
        );
        return;
      }
      // Stale credentials, clean up
      await store.remove();
    }

    let email = options.email as string | undefined;
    let password = options.password as string | undefined;

    // Interactive prompts
    if (!email || !password) {
      if (!isStdinTty() || ctx.outputMode === "json") {
        throw new UserError(
          "--email and --password are required in non-interactive mode",
        );
      }

      if (!email) {
        email = await readLine("Email: ");
        if (!email) throw new UserError("Email is required");
      }
      if (!password) {
        password = await readPassword("Password: ");
        if (!password) throw new UserError("Password is required");
      }
    }

    const result = await client.signIn(email, password);

    if (!result.ok) {
      renderAuthError({ error: result.error }, ctx.outputMode);
      Deno.exit(1);
    }

    await store.save({
      sessionToken: result.token,
      email: result.session.user.email,
      name: result.session.user.name,
      userId: result.session.user.id,
      storedAt: new Date().toISOString(),
    });

    renderAuthSuccess(
      {
        action: "login",
        email: result.session.user.email,
        name: result.session.user.name,
        userId: result.session.user.id,
      },
      ctx.outputMode,
    );
  });
