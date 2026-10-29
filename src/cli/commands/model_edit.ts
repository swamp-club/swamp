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
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { startConfigEdit } from "../../infrastructure/persistence/repo_unit_of_work.ts";
import {
  type CommandSyntax,
  definitionArgument,
  definitionNameType,
  recordDefiningModule,
  withPreferredExample,
} from "./command_syntax.ts";
import { surfaceNounCapitalized } from "../../presentation/command_surface.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import {
  createModelEditDeps,
  modelEdit,
  type ModelEditData,
  resolveModelEditFile,
} from "../../libswamp/models/edit.ts";
import {
  createEditorSessionDeps,
  editInEditor,
} from "../../libswamp/editor_session.ts";
import { saveEditedCopy, warnIfCopyKept } from "../editor_edit.ts";
import {
  modelSearch,
  type ModelSearchDeps,
} from "../../libswamp/models/search.ts";
import { createModelSearchRenderer } from "../../presentation/renderers/model_search.tsx";
import { createModelEditRenderer } from "../../presentation/renderers/model_edit.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  libSwampContextForRepo,
  requireInitializedRepoUnlocked,
} from "../repo_context.ts";
import { runManagedConfigMutation } from "../managed_config_sync.ts";
import { runAsUserConfigEdit } from "../../infrastructure/datastore_v3/config_edit_scope.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { UserError } from "../../domain/errors.ts";
import { readStdin } from "../../infrastructure/io/stdin_reader.ts";
import { requireRemoteEditContent } from "../remote_edit_content.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { ModelEditResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Returns the YAML piped to `model edit --server`, or refuses naming the
 * command as the user typed it on this surface.
 */
export function requireModelEditContent(
  content: string | null,
  syntax: CommandSyntax,
): string {
  return requireRemoteEditContent(content, syntax.invocation);
}

/** The preferred spelling: `swamp behavior edit`. */
export const BEHAVIOR_EDIT_SYNTAX: CommandSyntax = {
  invocation: "swamp behavior edit",
  surface: "behavior",
};

/** The legacy spelling: `swamp model edit`. */
export const MODEL_EDIT_SYNTAX: CommandSyntax = {
  invocation: "swamp model edit",
  surface: "model",
  preferred: `${BEHAVIOR_EDIT_SYNTAX.invocation} my-server`,
};

export function createModelEditCommand(syntax: CommandSyntax) {
  const command = withRemoteOptions(withPreferredExample(
    new Command()
      .name("edit")
      .description(`Edit a ${syntax.surface} definition file`)
      .example(`Edit a ${syntax.surface}`, `${syntax.invocation} my-server`)
      .example("Interactive search", syntax.invocation)
      .example(
        "Update from stdin (required with --server)",
        `cat my-server.yaml | ${syntax.invocation} my-server`,
      )
      .arguments(
        `[${definitionArgument(syntax.surface)}:${
          definitionNameType(syntax.surface)
        }]`,
      )
      .example(
        "Rename from stdin",
        `cat renamed.yaml | ${syntax.invocation} my-server --allow-rename`,
      )
      .option(
        "--repo-dir <dir:string>",
        "Repository directory (env: SWAMP_REPO_DIR)",
      )
      .option(
        "--allow-rename",
        `Allow a stdin update to change the ${syntax.surface}'s name; refused otherwise`,
      ),
    syntax,
  )).action(
    // @ts-expect-error - Cliffy custom type returns unknown instead of string
    async function (options: AnyOptions, modelIdOrName?: string) {
      const cliCtx = createContext(options as GlobalOptions, ["model", "edit"]);
      cliCtx.logger.debug`Editing model: ${modelIdOrName ?? "(interactive)"}`;

      const server = resolveServeUrl(options.server as string | undefined);
      if (server) {
        const token = await resolveServerTokenFromOptions(
          server,
          options,
        );
        const content = requireModelEditContent(await readStdin(), syntax);
        const response = await requestServerResponse<ModelEditResponse>(
          { server, token },
          {
            type: "model.edit",
            payload: {
              modelIdOrName,
              content,
              allowRename: options.allowRename === true,
            },
          },
        );
        const renderer = createModelEditRenderer(cliCtx.outputMode);
        renderer.handlers().completed({
          kind: "completed",
          data: response.data as unknown as ModelEditData,
        });
        return;
      }

      const { repoContext, repoDir, syncService, datastoreConfig } =
        await requireInitializedRepoUnlocked({
          repoDir: resolveRepoDir(options.repoDir),
          outputMode: cliCtx.outputMode,
        });

      const markerRepo = new RepoMarkerRepository();
      const marker = await markerRepo.read(RepoPath.create(repoDir));

      const libCtx = libSwampContextForRepo(repoContext, {
        logger: cliCtx.logger,
      });

      // Interactive search mode when no argument provided
      if (!modelIdOrName) {
        if (cliCtx.outputMode === "json") {
          throw new UserError(
            `${
              surfaceNounCapitalized(syntax.surface)
            } ID or name is required in non-interactive mode`,
          );
        }

        const searchDeps: ModelSearchDeps = {
          findAllGlobal: () => repoContext.definitionRepo.findAllGlobal(),
        };

        const searchRenderer = createModelSearchRenderer(
          cliCtx.outputMode,
          undefined,
          syntax.surface,
        );
        await consumeStream(
          modelSearch(libCtx, searchDeps, { query: undefined }),
          searchRenderer.handlers(),
        );

        const selected = searchRenderer.selectedItem();
        if (!selected) {
          cliCtx.logger.debug`Search cancelled`;
          return;
        }

        cliCtx.logger.debug`Selected model: ${selected.name} (${selected.id})`;
        modelIdOrName = selected.id;
      }

      const stdinContent = await readStdin();
      const deps = createModelEditDeps(repoDir);
      const renderer = createModelEditRenderer(cliCtx.outputMode);
      const runEdit = (
        content: string | null,
        editor?: string,
      ) =>
        runAsUserConfigEdit(() =>
          runManagedConfigMutation(
            repoContext,
            syncService,
            datastoreConfig,
            marker,
            "model edit",
            () =>
              consumeStream(
                modelEdit(libCtx, deps, {
                  modelIdOrName: modelIdOrName!,
                  stdinContent: content,
                  ...(editor !== undefined
                    ? { source: "editor" as const, editor, allowRename: true }
                    : { allowRename: options.allowRename === true }),
                }),
                renderer.handlers(),
              ),
          )
        );

      // A stored definition is edited on a copy and saved like a piped
      // edit, so the edit is committed (swamp-club#4107). Opening the editor
      // loads the definition (swamp-club#4097); a change another member lands
      // while it is open refuses the save.
      const file = stdinContent === null
        ? await resolveModelEditFile(libCtx, deps, { modelIdOrName })
        : null;
      if (file?.kind === "definition") {
        const name = file.definition.name;
        await startConfigEdit(repoContext, "model", name, true);
        const edit = await editInEditor(createEditorSessionDeps(), {
          content: await Deno.readTextFile(file.path),
          fileName: name,
          onLaunching: (data) =>
            renderer.handlers().launching({ kind: "launching", data }),
        });
        if (edit.status === "unchanged") {
          renderer.handlers().completed({
            kind: "completed",
            data: {
              path: file.path,
              editor: edit.editor,
              status: "unchanged",
              name,
              type: file.type.normalized,
              editType: "definition",
            },
          });
          warnIfCopyKept(
            edit,
            `${syntax.invocation} ${name} --allow-rename`,
            cliCtx.logger,
          );
          return;
        }
        await saveEditedCopy(
          edit,
          {
            retry: `${syntax.invocation} ${name} --allow-rename`,
            reload: `swamp ${syntax.surface} get ${name}`,
          },
          async () => {
            await startConfigEdit(repoContext, "model", name, false);
            await runEdit(edit.content, edit.editor);
          },
        );
        return;
      }

      // A stale stdin edit, a rename's included, is refused before it
      // writes; opening the editor loads the definition (swamp-club#4097).
      const target = await findDefinitionByIdOrName(
        repoContext.definitionRepo,
        modelIdOrName,
      ).catch(() => null);
      if (target) {
        await startConfigEdit(
          repoContext,
          "model",
          target.definition.name,
          stdinContent === null,
        );
      }

      await runEdit(stdinContent);

      cliCtx.logger.debug("Model edit command completed");
    },
  );
  return recordDefiningModule(command, import.meta.url);
}

export const modelEditCommand = createModelEditCommand(MODEL_EDIT_SYNTAX);
