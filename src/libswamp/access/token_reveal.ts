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

/**
 * Reveal the plaintext secret for a server token so the operator can
 * form the `<name>.<secret>` credential string for authentication.
 */

import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";
import type { DataQueryService } from "../../domain/data/data_query_service.ts";
import type { VaultService } from "../../domain/vaults/vault_service.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import {
  SERVER_TOKEN_MODEL_TYPE,
  ServerTokenSchema,
} from "../../domain/models/access/server_token_model.ts";

const TOKEN_DATA_NAME = "token-main";

function escapeCelString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export interface ServerTokenRevealData {
  name: string;
  token: string;
  expired: boolean;
  vaultRef: { vaultName: string; secretKey: string };
}

export type ServerTokenRevealEvent =
  | { kind: "resolving"; name: string }
  | { kind: "completed"; data: ServerTokenRevealData }
  | { kind: "error"; error: SwampError };

export interface ServerTokenRevealDeps {
  query: (predicate: string) => Promise<DataRecord[]>;
  readSecret: (vaultName: string, secretKey: string) => Promise<string>;
}

export function createServerTokenRevealDeps(
  dataQueryService: DataQueryService,
  vaultService: VaultService,
): ServerTokenRevealDeps {
  return {
    query: async (predicate) => {
      const results = await dataQueryService.query(predicate, {
        loadAttributes: true,
      });
      return results as DataRecord[];
    },
    readSecret: (vaultName, secretKey) =>
      vaultService.get(vaultName, secretKey, "access:server-token-reveal"),
  };
}

export async function* serverTokenReveal(
  _ctx: LibSwampContext,
  deps: ServerTokenRevealDeps,
  name: string,
): AsyncGenerator<ServerTokenRevealEvent> {
  yield* withGeneratorSpan(
    "swamp.access.token.reveal",
    { "token.name": name },
    (async function* () {
      yield { kind: "resolving" as const, name };

      let records: DataRecord[];
      try {
        records = await deps.query(
          `modelType == "${SERVER_TOKEN_MODEL_TYPE.normalized}" && ` +
            `name == "${TOKEN_DATA_NAME}" && ` +
            `modelName == "${escapeCelString(name)}"`,
        );
      } catch (error) {
        yield {
          kind: "error" as const,
          error: {
            code: "token_query_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        };
        return;
      }

      if (records.length === 0) {
        yield {
          kind: "error" as const,
          error: {
            code: "token_not_found",
            message: `Server token '${name}' not found`,
          },
        };
        return;
      }

      const parsed = ServerTokenSchema.safeParse(records[0].attributes);
      if (!parsed.success) {
        yield {
          kind: "error" as const,
          error: {
            code: "token_record_invalid",
            message:
              `Token record for '${name}' has invalid schema: ${parsed.error.message}`,
          },
        };
        return;
      }

      const token = parsed.data;
      if (token.state === "revoked") {
        yield {
          kind: "error" as const,
          error: {
            code: "token_revoked",
            message: `Server token '${name}' has been revoked`,
          },
        };
        return;
      }

      const expired = token.state === "expired" ||
        Date.parse(token.expiresAt) <= Date.now();
      const { vaultName, secretKey } = token;

      let plaintext: string;
      try {
        plaintext = await deps.readSecret(vaultName, secretKey);
      } catch (error) {
        yield {
          kind: "error" as const,
          error: {
            code: "vault_read_failed",
            message:
              `Failed to read secret for token '${name}' from vault '${vaultName}': ${
                error instanceof Error ? error.message : String(error)
              }`,
          },
        };
        return;
      }

      yield {
        kind: "completed" as const,
        data: {
          name,
          token: `${name}.${plaintext}`,
          expired,
          vaultRef: { vaultName, secretKey },
        },
      };
    })(),
  );
}
