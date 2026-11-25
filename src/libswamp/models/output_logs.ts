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

import type { ModelOutput } from "../../domain/models/model_output.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import {
  isPartialId,
  matchByPartialId,
} from "../../domain/models/model_lookup.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import {
  createCatalogStore,
  namespaceFromResolver,
} from "../../infrastructure/persistence/repository_factory.ts";
import {
  type DatastorePathResolver,
  resolverEngine,
} from "../../domain/datastore/datastore_path_resolver.ts";
import type { UnreadableContentLookup } from "../../domain/datastore/datastore_sync_service.ts";
import type { LibSwampContext } from "../context.ts";
import { notFound, type SwampError, validationFailed } from "../errors.ts";
import {
  type OutputIdReference,
  type OutputIdReferenceDeps,
  resolveOutputIdReference,
} from "./output_reference.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import {
  countLines,
  KEPT_LINE_BYTES,
  type ResourceLoadGuard,
  resourceLoadGuardOf,
} from "../../domain/data/resource_load_guard.ts";
import {
  type OutputArtifactCheck,
  outputArtifactCheck,
} from "../data/run_artifact_check.ts";

export interface ModelOutputLogsData {
  outputId: string;
  methodName: string;
  logArtifacts: string[];
  lines: string[];
  totalLines: number;
  showingLines: number;
}

export type ModelOutputLogsEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: ModelOutputLogsData }
  | { kind: "error"; error: SwampError };

export interface ModelOutputLogsInput {
  outputIdArg: string;
  tail?: number;
  /**
   * The output id, already resolved with resolveOutputIdReference. The read
   * acts on exactly this and does not look the id up again.
   */
  reference?: OutputIdReference<ModelOutput>;
}

export interface ModelOutputLogsDeps
  extends OutputIdReferenceDeps<ModelOutput> {
  findDataByName: (
    type: ModelType,
    definitionId: string,
    name: string,
    version?: number,
  ) => Promise<{ readonly size?: number } | null>;
  getContent: (
    type: ModelType,
    definitionId: string,
    name: string,
    version?: number,
  ) => Promise<Uint8Array | null>;
  /**
   * on a v3 datastore, whether the version a log ref names is still the
   * content that output produced; absent on v2
   */
  checkArtifact?: OutputArtifactCheck;
  loadGuard?: ResourceLoadGuard;
}

export function createModelOutputLogsDeps(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
  injectedDataRepo?: FileSystemUnifiedDataRepository,
  /**
   * the repository context's lookup, so a read of a record the v3 read model
   * could not materialise fails loudly; used by the output repository built
   * here, and by the data repository when none is injected
   */
  unreadableContent?: UnreadableContentLookup,
): ModelOutputLogsDeps {
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const outputRepo = new YamlOutputRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.outputs),
    undefined,
    unreadableContent,
  );
  // reuse an injected shared data repo so each request does not open a new
  // file-based catalog store and leak its file descriptors
  const dataRepo = injectedDataRepo ?? new FileSystemUnifiedDataRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.data),
    createCatalogStore(repoDir, datastoreResolver),
    undefined,
    undefined,
    namespaceFromResolver(datastoreResolver),
    undefined,
    undefined,
    undefined,
    unreadableContent,
  );
  return {
    isPartialId,
    matchOutputByPartialId: async (idPrefix: string) => {
      const allOutputs = await outputRepo.findAllGlobal();
      const result = matchByPartialId(
        allOutputs.map((o) => ({ id: o.output.id, item: o })),
        idPrefix,
      );
      if (result.status === "found") {
        return {
          status: "found" as const,
          match: { output: result.match.output, type: result.match.type },
        };
      }
      if (result.status === "ambiguous") {
        return {
          status: "ambiguous" as const,
          matches: result.matches.map((m) => ({
            id: m.id,
            match: { output: m.match.output, type: m.match.type },
          })),
        };
      }
      return { status: "not_found" as const };
    },
    findDataByName: (type, definitionId, name, version) =>
      dataRepo.findByName(type, definitionId, name, version),
    getContent: (type, definitionId, name, version) =>
      dataRepo.getContent(type, definitionId, name, version),
    loadGuard: dataRepo.loadGuard,
    ...(resolverEngine(datastoreResolver) === "v3"
      ? { checkArtifact: outputArtifactCheck(dataRepo) }
      : {}),
  };
}

export async function* modelOutputLogs(
  _ctx: LibSwampContext,
  deps: ModelOutputLogsDeps,
  input: ModelOutputLogsInput,
): AsyncIterable<ModelOutputLogsEvent> {
  yield* withGeneratorSpan(
    "swamp.model.output.logs",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const reference = input.reference ??
        await resolveOutputIdReference(deps, input.outputIdArg);

      if (reference.kind === "invalid") {
        yield {
          kind: "error",
          error: validationFailed(
            `Invalid output ID format: ${input.outputIdArg}. ` +
              `Expected a UUID or partial ID (3+ hex characters).`,
          ),
        };
        return;
      }

      if (reference.kind === "not_found") {
        yield {
          kind: "error",
          error: notFound("Output", input.outputIdArg),
        };
        return;
      }

      if (reference.kind === "ambiguous") {
        yield {
          kind: "error",
          error: validationFailed(
            `Ambiguous ID prefix "${input.outputIdArg}" matches:\n` +
              reference.ids.map((id) => `  ${id}`).join("\n"),
          ),
        };
        return;
      }

      const { output, type } = reference.match;

      const logArtifacts = output.artifacts.dataArtifacts.filter(
        (a) => a.tags.type === "log",
      );
      if (logArtifacts.length === 0) {
        yield {
          kind: "error",
          error: notFound(
            "Log artifacts",
            `Output ${output.id} has no log artifacts. ` +
              `Status: ${output.status}, Method: ${output.methodName}`,
          ),
        };
        return;
      }

      const loadGuard = resourceLoadGuardOf(deps);
      const tail = input.tail !== undefined && input.tail >= 1
        ? Math.floor(input.tail)
        : undefined;
      const remedy = tail === undefined ? LOGS_REMEDY : TAIL_REMEDY;
      const allEntries: string[] = [];
      let totalLines = 0;
      let heldBytes = 0;
      // a kept line is a slice that pins its whole decoded log
      const pinned: { bytes: number; lines: number }[] = [];

      for (const artifact of logArtifacts) {
        if (deps.checkArtifact !== undefined) {
          const resolution = await deps.checkArtifact(
            type,
            output.definitionId,
            artifact,
            {
              ...(output.provenance.workflowRunId !== undefined
                ? { workflowRunId: output.provenance.workflowRunId }
                : {}),
              startedAt: output.startedAt,
              ...(output.completedAt !== undefined
                ? { completedAt: output.completedAt }
                : {}),
            },
          );
          if (resolution.kind === "unavailable") {
            yield { kind: "error", error: notFound("Log", resolution.reason) };
            return;
          }
        }

        const dataResult = await deps.findDataByName(
          type,
          output.definitionId,
          artifact.name,
          artifact.version,
        );
        const item = {
          modelType: type.normalized,
          dataName: artifact.name,
          version: artifact.version,
        };
        if (dataResult !== null) {
          const sizeRefusal = loadGuard.refusalFor(
            item,
            dataResult.size ?? 0,
            heldBytes,
            remedy,
          );
          if (sizeRefusal) throw sizeRefusal;
        }
        const content = dataResult === null ? null : await deps.getContent(
          type,
          output.definitionId,
          artifact.name,
          artifact.version,
        );
        if (content === null) {
          yield {
            kind: "error",
            error: notFound("Log", `${artifact.name}@${artifact.version}`),
          };
          return;
        }
        if (tail === undefined) {
          const lines = countLines(content);
          const refusal = loadGuard.splitRefusalFor(
            item,
            content,
            heldBytes,
            remedy,
            lines,
          );
          if (refusal) throw refusal;
          const text = new TextDecoder().decode(content);
          for (const line of text.split("\n")) {
            if (line.length > 0) allEntries.push(line);
          }
          heldBytes += content.length + lines * KEPT_LINE_BYTES;
        } else {
          // a tail splits nothing and keeps at most its own count of lines
          const nonEmpty = countNonEmptyLines(content);
          const refusal = loadGuard.splitRefusalFor(
            item,
            content,
            heldBytes,
            remedy,
            Math.min(nonEmpty, tail),
          );
          if (refusal) throw refusal;
          totalLines += nonEmpty;
          const last = lastNonEmptyLines(
            new TextDecoder().decode(content),
            tail,
          );
          for (const line of last) allEntries.push(line);
          if (last.length > 0) {
            pinned.push({ bytes: content.length, lines: last.length });
            heldBytes += content.length + last.length * KEPT_LINE_BYTES;
          }
          let excess = allEntries.length - tail;
          if (excess > 0) allEntries.splice(0, excess);
          while (excess > 0 && pinned.length > 0) {
            const oldest = pinned[0];
            const dropped = Math.min(excess, oldest.lines);
            oldest.lines -= dropped;
            excess -= dropped;
            heldBytes -= dropped * KEPT_LINE_BYTES;
            if (oldest.lines === 0) {
              heldBytes -= oldest.bytes;
              pinned.shift();
            }
          }
        }
      }

      if (tail === undefined) totalLines = allEntries.length;
      const entriesToShow = allEntries;

      yield {
        kind: "completed",
        data: {
          outputId: output.id,
          methodName: output.methodName,
          logArtifacts: logArtifacts.map((a) => a.name),
          lines: entriesToShow,
          totalLines,
          showingLines: entriesToShow.length,
        },
      };
    })(),
  );
}

const NEWLINE = 0x0a;
// a tail holds one log at a time, so it reads logs too large to read together
const LOGS_REMEDY =
  "pass --tail to read only the last lines, one log at a time";
const TAIL_REMEDY = "pass a smaller --tail";

function hasByteOrderMark(content: Uint8Array): boolean {
  return content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf;
}

// TextDecoder drops a leading byte-order mark, so the count skips it too
function countNonEmptyLines(content: Uint8Array): number {
  let count = 0;
  let start = hasByteOrderMark(content) ? 3 : 0;
  while (start <= content.length) {
    const at = content.indexOf(NEWLINE, start);
    const end = at === -1 ? content.length : at;
    if (end > start) count++;
    if (at === -1) break;
    start = at + 1;
  }
  return count;
}

function lastNonEmptyLines(text: string, count: number): string[] {
  const lines: string[] = [];
  let end = text.length;
  while (lines.length < count && end > 0) {
    const at = text.lastIndexOf("\n", end - 1);
    if (end > at + 1) lines.push(text.slice(at + 1, end));
    end = at === -1 ? 0 : at;
  }
  return lines.reverse();
}
