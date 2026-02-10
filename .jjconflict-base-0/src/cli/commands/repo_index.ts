import { Command } from "@cliffy/command";
import {
  renderRepoIndexPrune,
  renderRepoIndexRebuild,
  renderRepoIndexVerify,
  type RepoIndexPruneData,
  type RepoIndexRebuildData,
  type RepoIndexVerifyData,
} from "../../presentation/output/repo_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const repoIndexCommand = new Command()
  .description("Rebuild, verify, or prune repository index")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--verify", "Verify symlink integrity without rebuilding")
  .option("--prune", "Remove broken symlinks without rebuilding")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["repo", "index"]);

    // Validate repo initialization (with indexing disabled for manual operations)
    const { repoDir, repoContext } = await requireInitializedRepo(
      {
        repoDir: options.repoDir ?? ".",
        outputMode: ctx.outputMode,
      },
      { enableIndexing: false },
    );

    ctx.logger.debug`Managing repository index at: ${repoDir}`;

    const indexService = repoContext.indexService;

    if (options.verify) {
      ctx.logger.debug`Verifying index`;
      const result = await indexService.verify();

      const data: RepoIndexVerifyData = {
        path: repoDir,
        valid: result.valid,
        brokenLinks: result.brokenLinks,
        missingTargets: result.missingTargets,
      };

      renderRepoIndexVerify(data, ctx.outputMode);

      // Exit with error code if invalid
      if (!result.valid) {
        Deno.exit(1);
      }
    } else if (options.prune) {
      ctx.logger.debug`Pruning broken symlinks`;
      const result = await indexService.prune();

      const data: RepoIndexPruneData = {
        path: repoDir,
        removedLinks: result.removedLinks,
      };

      renderRepoIndexPrune(data, ctx.outputMode);
    } else {
      // Default: rebuild
      ctx.logger.debug`Rebuilding index`;
      const result = await indexService.rebuildAll();

      const data: RepoIndexRebuildData = {
        path: repoDir,
        modelsIndexed: result.modelsIndexed,
        workflowsIndexed: result.workflowsIndexed,
        workflowRunsIndexed: result.workflowRunsIndexed,
      };

      renderRepoIndexRebuild(data, ctx.outputMode);
    }

    ctx.logger.debug("Repo index command completed");
  });
