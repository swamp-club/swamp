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
import { startConfigEdit } from "../../infrastructure/persistence/repo_unit_of_work.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import {
  createWorkflowEditDeps,
  resolveWorkflowEditFile,
  workflowEdit,
  type WorkflowEditData,
} from "../../libswamp/workflows/edit.ts";
import {
  createEditorSessionDeps,
  editInEditor,
} from "../../libswamp/editor_session.ts";
import { saveEditedCopy, warnIfCopyKept } from "../editor_edit.ts";
import {
  workflowSearch,
  type WorkflowSearchDeps,
} from "../../libswamp/workflows/search.ts";
import { createWorkflowSearchRenderer } from "../../presentation/renderers/workflow_search.tsx";
import { createWorkflowEditRenderer } from "../../presentation/renderers/workflow_edit.ts";
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
import type { WorkflowEditResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowEditCommand = withRemoteOptions(
  new Command()
    .name("edit")
    .description("Edit a workflow file")
    .example("Edit a workflow", "swamp workflow edit deploy-pipeline")
    .example("Interactive search", "swamp workflow edit")
    .example(
      "Update from stdin (required with --server)",
      "cat deploy.yaml | swamp workflow edit deploy",
    )
    .arguments("[workflow_id_or_name:workflow_name]")
    .example(
      "Rename from stdin",
      "cat renamed.yaml | swamp workflow edit deploy --allow-rename",
    )
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option(
      "--allow-rename",
      "Allow a stdin update to change the workflow's name; refused otherwise",
    ),
).action(
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  async function (options: AnyOptions, workflowIdOrName?: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "workflow",
      "edit",
    ]);
    cliCtx.logger
      .debug`Editing workflow: ${workflowIdOrName ?? "(interactive)"}`;

    const server = resolveServeUrl(options.server as string | undefined);
    if (server) {
      const token = await resolveServerTokenFromOptions(
        server,
        options,
      );
      const content = requireRemoteEditContent(
        await readStdin(),
        "swamp workflow edit",
      );
      const response = await requestServerResponse<WorkflowEditResponse>(
        { server, token },
        {
          type: "workflow.edit",
          payload: {
            workflowIdOrName,
            content,
            allowRename: options.allowRename === true,
          },
        },
      );
      const renderer = createWorkflowEditRenderer(cliCtx.outputMode);
      renderer.handlers().completed({
        kind: "completed",
        data: response.data as unknown as WorkflowEditData,
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
    if (!workflowIdOrName) {
      if (cliCtx.outputMode === "json") {
        throw new UserError(
          "Workflow ID or name is required in non-interactive mode",
        );
      }

      const searchDeps: WorkflowSearchDeps = {
        findAllWorkflows: () => repoContext.workflowRepo.findAll(),
      };

      const searchRenderer = createWorkflowSearchRenderer(cliCtx.outputMode);
      await consumeStream(
        workflowSearch(libCtx, searchDeps, { query: undefined }),
        searchRenderer.handlers(),
      );

      const selected = searchRenderer.selectedItem();
      if (!selected) {
        cliCtx.logger.debug`Search cancelled`;
        return;
      }

      cliCtx.logger
        .debug`Selected workflow: ${selected.name} (${selected.id})`;
      workflowIdOrName = selected.id;
    }

    const stdinContent = await readStdin();
    const deps = createWorkflowEditDeps(repoDir, repoContext.workflowRepo);
    const renderer = createWorkflowEditRenderer(cliCtx.outputMode);
    const editIdOrName = workflowIdOrName;
    const runEdit = (content: string | null, editor?: string) =>
      runAsUserConfigEdit(() =>
        runManagedConfigMutation(
          repoContext,
          syncService,
          datastoreConfig,
          marker,
          "workflow edit",
          () =>
            consumeStream(
              workflowEdit(libCtx, deps, {
                workflowIdOrName: editIdOrName,
                stdinContent: content,
                ...(editor !== undefined
                  ? { source: "editor" as const, editor, allowRename: true }
                  : { allowRename: options.allowRename === true }),
              }),
              renderer.handlers(),
            ),
        )
      );

    // A stored workflow is edited on a copy and saved like a piped edit, so
    // the edit is committed (swamp-club#4107). Opening the editor loads the
    // workflow (swamp-club#4097); a change another member lands while it is
    // open refuses the save.
    const file = stdinContent === null
      ? await resolveWorkflowEditFile(libCtx, deps, { workflowIdOrName })
      : null;
    if (file && file.kind !== "file") {
      const name = file.kind === "workflow" ? file.workflow.name : file.name;
      // A broken file whose id could not be read is named as it was asked
      // for.
      const id = (file.kind === "workflow" ? file.workflow.id : file.id) ??
        editIdOrName;
      if (name !== null) {
        await startConfigEdit(repoContext, "workflow", name, true);
      }
      const edit = await editInEditor(createEditorSessionDeps(), {
        content: await Deno.readTextFile(file.path),
        fileName: name ?? id,
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
            name: name ?? id,
            id,
            ...(edit.keptPath ? { keptPath: edit.keptPath } : {}),
          },
        });
        // A piped edit cannot replace a broken file.
        warnIfCopyKept(
          edit,
          file.kind === "workflow"
            ? { retry: `swamp workflow edit ${name} --allow-rename` }
            : {
              manual: `Run 'swamp workflow edit ${
                name ?? id
              }' again and paste the kept copy into the editor.`,
            },
          cliCtx.logger,
        );
        return;
      }
      await saveEditedCopy(
        edit,
        // A piped edit cannot replace a broken file, so a refused repair is
        // retried in the editor.
        file.kind === "workflow"
          ? {
            retry: `swamp workflow edit ${name} --allow-rename`,
            reload: `swamp workflow get ${name}`,
          }
          : {
            manual: `Run 'swamp workflow edit ${
              name ?? id
            }' again and paste the kept copy into the editor.`,
          },
        async () => {
          if (name !== null) {
            await startConfigEdit(repoContext, "workflow", name, false);
          }
          await runEdit(edit.content, edit.editor);
        },
      );
      return;
    }

    // A stale stdin edit, a rename's included, is refused before it
    // writes; opening the editor loads the workflow (swamp-club#4097).
    const target = await repoContext.workflowRepo.findByName(workflowIdOrName)
      .catch(() => null) ??
      await repoContext.workflowRepo.findById(
        workflowIdOrName as Parameters<
          typeof repoContext.workflowRepo.findById
        >[0],
      ).catch(() => null);
    if (target) {
      await startConfigEdit(
        repoContext,
        "workflow",
        target.name,
        stdinContent === null,
      );
    }

    await runEdit(stdinContent);

    cliCtx.logger.debug("Workflow edit command completed");
  },
);
