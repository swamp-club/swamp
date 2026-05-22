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

import { VaultAnnotation } from "../../domain/vaults/vault_annotation.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import { createVaultSecretAnnotated } from "../../domain/events/types.ts";
import type { EventBus } from "../../domain/events/event_bus.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound, validationFailed } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export interface VaultAnnotateConfigInfo {
  id: string;
  name: string;
  type: string;
}

export interface VaultAnnotateData {
  vaultName: string;
  secretKey: string;
  vaultType: string;
  fieldsUpdated: string[];
  cleared: boolean;
  timestamp: string;
}

export type VaultAnnotateEvent =
  | { kind: "annotating" }
  | { kind: "completed"; data: VaultAnnotateData }
  | { kind: "error"; error: SwampError };

export interface VaultAnnotateInput {
  vaultName: string;
  key: string;
  url?: string;
  notes?: string;
  labels?: Record<string, string>;
  clear: boolean;
}

export interface VaultAnnotateDeps {
  findVault: (name: string) => Promise<VaultAnnotateConfigInfo | null>;
  listVaultNames: () => Promise<string[]>;
  secretExists: (vaultName: string, key: string) => Promise<boolean>;
  supportsAnnotations: (vaultName: string) => Promise<boolean>;
  getAnnotation: (
    vaultName: string,
    key: string,
  ) => Promise<VaultAnnotation | null>;
  putAnnotation: (
    vaultName: string,
    key: string,
    annotation: VaultAnnotation,
  ) => Promise<void>;
  deleteAnnotation: (vaultName: string, key: string) => Promise<void>;
  publishSecretAnnotated: (
    vaultId: string,
    vaultType: string,
    vaultName: string,
    key: string,
    fields: string[],
  ) => Promise<void>;
}

export function createVaultAnnotateDeps(
  repoDir: string,
  eventBus: EventBus,
): VaultAnnotateDeps {
  const vaultConfigRepo = new YamlVaultConfigRepository(repoDir);
  let vaultServicePromise: Promise<VaultService> | null = null;

  const getVaultService = () => {
    if (!vaultServicePromise) {
      vaultServicePromise = VaultService.fromRepository(repoDir);
    }
    return vaultServicePromise;
  };

  return {
    findVault: (name) => vaultConfigRepo.findByName(name),
    listVaultNames: async () => {
      const all = await vaultConfigRepo.findAll();
      return all.map((v) => v.name);
    },
    secretExists: async (vaultName, key) => {
      const svc = await getVaultService();
      try {
        await svc.get(vaultName, key);
        return true;
      } catch {
        return false;
      }
    },
    supportsAnnotations: async (vaultName) => {
      const svc = await getVaultService();
      return svc.supportsAnnotations(vaultName);
    },
    getAnnotation: async (vaultName, key) => {
      const svc = await getVaultService();
      return await svc.getAnnotation(vaultName, key);
    },
    putAnnotation: async (vaultName, key, annotation) => {
      const svc = await getVaultService();
      await svc.putAnnotation(vaultName, key, annotation);
    },
    deleteAnnotation: async (vaultName, key) => {
      const svc = await getVaultService();
      await svc.deleteAnnotation(vaultName, key);
    },
    publishSecretAnnotated: async (
      vaultId,
      vaultType,
      vaultName,
      key,
      fields,
    ) => {
      const event = createVaultSecretAnnotated(
        vaultId,
        vaultType,
        vaultName,
        key,
        fields,
      );
      await eventBus.publish(event);
    },
  };
}

export async function* vaultAnnotate(
  ctx: LibSwampContext,
  deps: VaultAnnotateDeps,
  input: VaultAnnotateInput,
): AsyncIterable<VaultAnnotateEvent> {
  yield* withGeneratorSpan(
    "swamp.vault.annotate",
    {},
    (async function* () {
      yield { kind: "annotating" };

      const config = await deps.findVault(input.vaultName);
      if (!config) {
        const names = await deps.listVaultNames();
        if (names.length === 0) {
          yield {
            kind: "error",
            error: notFound(
              "Vault",
              `${input.vaultName}. No vaults are configured.`,
            ),
          };
        } else {
          yield {
            kind: "error",
            error: notFound(
              "Vault",
              `${input.vaultName}. Available vaults: ${names.join(", ")}`,
            ),
          };
        }
        return;
      }

      const exists = await deps.secretExists(input.vaultName, input.key);
      if (!exists) {
        yield {
          kind: "error",
          error: validationFailed(
            `Secret '${input.key}' does not exist in vault '${input.vaultName}'. Store a secret first with: swamp vault put ${input.vaultName} ${input.key}`,
          ),
        };
        return;
      }

      if (!await deps.supportsAnnotations(input.vaultName)) {
        yield {
          kind: "error",
          error: validationFailed(
            `Vault '${input.vaultName}' (type: ${config.type}) does not support annotations`,
          ),
        };
        return;
      }

      if (
        !input.clear && input.url === undefined &&
        input.notes === undefined && input.labels === undefined
      ) {
        yield {
          kind: "error",
          error: validationFailed(
            "No annotation fields specified. Use --url, --note, --label, or --clear.",
          ),
        };
        return;
      }

      if (input.clear) {
        await deps.deleteAnnotation(input.vaultName, input.key);
        ctx.logger.debug`Cleared annotation for ${input.key}`;

        await deps.publishSecretAnnotated(
          config.id,
          config.type,
          config.name,
          input.key,
          [],
        );

        yield {
          kind: "completed",
          data: {
            vaultName: input.vaultName,
            secretKey: input.key,
            vaultType: config.type,
            fieldsUpdated: [],
            cleared: true,
            timestamp: new Date().toISOString(),
          },
        };
        return;
      }

      const fieldsUpdated: string[] = [];
      if (input.url !== undefined) fieldsUpdated.push("url");
      if (input.notes !== undefined) fieldsUpdated.push("notes");
      if (input.labels !== undefined) fieldsUpdated.push("labels");

      const existing = await deps.getAnnotation(input.vaultName, input.key);
      const annotation = existing
        ? existing.merge({
          url: input.url,
          notes: input.notes,
          labels: input.labels,
        })
        : VaultAnnotation.create({
          url: input.url,
          notes: input.notes,
          labels: input.labels,
        });

      await deps.putAnnotation(input.vaultName, input.key, annotation);
      ctx.logger.debug`Annotation updated for ${input.key}`;

      await deps.publishSecretAnnotated(
        config.id,
        config.type,
        config.name,
        input.key,
        fieldsUpdated,
      );

      yield {
        kind: "completed",
        data: {
          vaultName: input.vaultName,
          secretKey: input.key,
          vaultType: config.type,
          fieldsUpdated,
          cleared: false,
          timestamp: new Date().toISOString(),
        },
      };
    })(),
  );
}
