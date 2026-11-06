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

export const CLIENT_KINDS = ["direct", "integration"] as const;

export type ClientKind = typeof CLIENT_KINDS[number];

export const DIRECT_CLIENT_IDS = ["cli", "dashboard", "token"] as const;

export type DirectClientId = typeof DIRECT_CLIENT_IDS[number];

export const DIRECT_CLI_CLIENT = "direct:cli";
export const DIRECT_DASHBOARD_CLIENT = "direct:dashboard";
export const DIRECT_TOKEN_CLIENT = "direct:token";

/**
 * How a token was issued, not what presents it: a copied `direct:cli` token
 * still reads `direct:cli`, so a direct id is never a security boundary.
 */
export interface Client {
  readonly kind: ClientKind;
  readonly id: string;
}

const INTEGRATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function parseClient(value: string): Client {
  const colonIndex = value.indexOf(":");
  if (colonIndex === -1) {
    throw new Error(`Invalid client "${value}": expected <kind>:<id>`);
  }
  const kind = value.slice(0, colonIndex);
  const id = value.slice(colonIndex + 1);
  if (kind === "direct") {
    if (!(DIRECT_CLIENT_IDS as readonly string[]).includes(id)) {
      throw new Error(
        `Invalid client "${value}": expected a direct id of ${
          DIRECT_CLIENT_IDS.join(", ")
        }`,
      );
    }
    return { kind, id };
  }
  if (kind === "integration") {
    if (!INTEGRATION_ID_PATTERN.test(id)) {
      throw new Error(
        `Invalid client "${value}": an integration id is lowercase letters, digits and hyphens`,
      );
    }
    return { kind, id };
  }
  throw new Error(
    `Invalid client kind "${kind}": expected ${CLIENT_KINDS.join(" or ")}`,
  );
}

export function clientToString(client: Client): string {
  return `${client.kind}:${client.id}`;
}

/** a token with no client is direct with no id; never stored or parsed */
export const ABSENT_CLIENT_CONDITION_VALUE = "direct:";

export function clientConditionValue(client: string | undefined): string {
  return client ?? ABSENT_CLIENT_CONDITION_VALUE;
}

export type ClientLiteralFinding =
  | { readonly kind: "never-matches"; readonly message: string }
  | { readonly kind: "not-a-boundary"; readonly message: string };

/** judges a literal a condition compares `client` with, in full */
export function clientLiteralFinding(
  literal: string,
): ClientLiteralFinding | undefined {
  if (literal === ABSENT_CLIENT_CONDITION_VALUE) return undefined;
  let parsed: Client;
  try {
    parsed = parseClient(literal);
  } catch (error) {
    return {
      kind: "never-matches",
      message: `client is compared with ${
        JSON.stringify(literal)
      }, which no token can hold: ${(error as Error).message}`,
    };
  }
  return parsed.kind === "direct"
    ? {
      kind: "not-a-boundary",
      message:
        `client is compared with ${literal}: a client labels how a token was issued, not what presents it, so a copied token still reads the same; a direct id is not a security boundary`,
    }
    : undefined;
}
