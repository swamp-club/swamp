import { Command } from "@cliffy/command";
import {
  renderDataGC,
  renderDataGCCancelled,
  renderDataGCPreview,
} from "../../presentation/output/data_gc_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { DefaultDataLifecycleService } from "../../domain/data/data_lifecycle_service.ts";

/**
 * Prompts user for confirmation in interactive mode.
 * Uses basic stdin reading for confirmation prompt.
 */
async function promptConfirmation(message: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  await Deno.stdout.write(encoder.encode(`${message} [y/N] `));

  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null) {
    return false;
  }

  const response = decoder.decode(buf.subarray(0, n)).trim().toLowerCase();
  return response === "y" || response === "yes";
}

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const dataGcCommand = new Command()
  .name("gc")
  .description("Run garbage collection on data (lifecycle and versions)")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--dry-run", "Show what would be deleted without deleting")
  .option("-f, --force", "Skip confirmation prompt")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["data", "gc"]);
    const { repoDir, repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });

    const service = new DefaultDataLifecycleService(
      repoContext.unifiedDataRepo,
      repoContext.workflowRunRepo,
      repoDir,
    );

    // If interactive and no force, prompt for confirmation
    if (ctx.outputMode === "log" && !options.force && !options.dryRun) {
      const preview = await service.findExpiredData();
      if (preview.length === 0) {
        console.log("No expired data found. Nothing to clean up.");
        return;
      }

      renderDataGCPreview(preview, ctx.outputMode);
      const confirmed = await promptConfirmation(
        "Proceed with garbage collection?",
      );
      if (!confirmed) {
        renderDataGCCancelled(ctx.outputMode);
        return;
      }
    }

    // Execute GC
    const result = await service.deleteExpiredData({
      dryRun: options.dryRun,
    });
    renderDataGC(result, ctx.outputMode);
  });
