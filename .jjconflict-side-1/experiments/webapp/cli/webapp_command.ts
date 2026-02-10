import { Command } from "@cliffy/command";
import { dirname, fromFileUrl, join } from "@std/path";
import { createContext, type GlobalOptions } from "../../../src/cli/context.ts";
import { RepoPath } from "../../../src/domain/repo/repo_path.ts";
import {
  cors,
  createModelsHandlers,
  createOutputsHandlers,
  createResourcesHandlers,
  createServer,
  createStaticHandler,
  createWorkflowRunsHandlers,
  createWorkflowsHandlers,
  listTypes,
} from "../backend/mod.ts";
import { YamlDefinitionRepository } from "../../../src/infrastructure/persistence/yaml_definition_repository.ts";
import { YamlWorkflowRepository } from "../../../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../../../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { YamlOutputRepository } from "../../../src/infrastructure/persistence/yaml_output_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../../src/infrastructure/persistence/unified_data_repository.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Resolves the webapp dist directory path.
 * When compiled, the frontend dist is embedded and accessible relative to the executable.
 * When running with deno run, resolve relative to this source file.
 */
function resolveWebappDir(): string {
  // import.meta.url gives us the URL of this module
  // When compiled, this will be something like file:///path/to/swamp
  // When running with deno run, it's file:///path/to/experiments/webapp/cli/webapp_command.ts
  const moduleUrl = import.meta.url;

  if (moduleUrl.startsWith("file://")) {
    const modulePath = fromFileUrl(moduleUrl);
    const moduleDir = dirname(modulePath);

    // Check if we're in the compiled binary (module path won't have /experiments/)
    if (!modulePath.includes("/experiments/")) {
      // Compiled binary - experiments/webapp/frontend/dist is alongside the binary
      return join(moduleDir, "experiments", "webapp", "frontend", "dist");
    }

    // Running from source - go up to frontend/dist
    return join(moduleDir, "..", "frontend", "dist");
  }

  // Fallback for other protocols
  return "experiments/webapp/frontend/dist";
}

export const repoWebappCommand = new Command()
  .description("Start the swamp webapp server")
  .arguments("[path:string]")
  .option("-p, --port <port:number>", "Port to serve on", { default: 8080 })
  .option("--host <host:string>", "Host to bind to", { default: "localhost" })
  .action(async function (options: AnyOptions, pathArg?: string) {
    const ctx = createContext(options as GlobalOptions, ["repo", "webapp"]);
    ctx.logger.debug`Starting webapp server for: ${pathArg ?? "."}`;

    const repoPath = RepoPath.create(pathArg ?? ".");
    const repoDir = repoPath.value;

    // Initialize repositories
    const definitionRepository = new YamlDefinitionRepository(repoDir);
    const workflowRepository = new YamlWorkflowRepository(repoDir);
    const workflowRunRepository = new YamlWorkflowRunRepository(repoDir);
    const outputRepository = new YamlOutputRepository(repoDir);
    const dataRepository = new FileSystemUnifiedDataRepository(repoDir);

    // Create handlers
    const modelsHandlers = createModelsHandlers(definitionRepository);
    const resourcesHandlers = createResourcesHandlers(dataRepository);
    const workflowsHandlers = createWorkflowsHandlers(workflowRepository);
    const workflowRunsHandlers = createWorkflowRunsHandlers(
      workflowRunRepository,
      workflowRepository,
      outputRepository,
    );
    const outputsHandlers = createOutputsHandlers(
      outputRepository,
      definitionRepository,
      dataRepository,
    );

    // Resolve webapp directory
    const webappDir = resolveWebappDir();
    ctx.logger.debug`Webapp directory: ${webappDir}`;

    const staticHandler = createStaticHandler(webappDir);

    // Create server
    const server = createServer({
      port: options.port,
      host: options.host,
      logger: ctx.logger,
    });

    // Add CORS middleware
    server.use(cors());

    // Register API routes
    const router = server.getRouter();

    // Types endpoints
    router.get("/api/v1/types", listTypes);

    // Models endpoints
    router.get("/api/v1/models", modelsHandlers.listAllModels);
    router.get("/api/v1/models/lookup/:id", modelsHandlers.lookupModelById);
    router.get("/api/v1/models/:type", modelsHandlers.listModelsByType);
    router.get("/api/v1/models/:type/:id", modelsHandlers.getModel);
    router.post("/api/v1/models/:type", modelsHandlers.createModel);
    router.put("/api/v1/models/:type/:id", modelsHandlers.updateModel);
    router.delete("/api/v1/models/:type/:id", modelsHandlers.deleteModel);

    // Resources endpoints (deprecated, use data API)
    router.get(
      "/api/v1/resources/:type",
      resourcesHandlers.listResourcesByType,
    );
    router.get("/api/v1/resources/:type/:id", resourcesHandlers.getResource);
    router.delete(
      "/api/v1/resources/:type/:id",
      resourcesHandlers.deleteResource,
    );

    // Workflows endpoints
    router.get("/api/v1/workflows", workflowsHandlers.listWorkflows);
    router.get("/api/v1/workflows/:id", workflowsHandlers.getWorkflow);
    router.post("/api/v1/workflows", workflowsHandlers.createWorkflow);
    router.put("/api/v1/workflows/:id", workflowsHandlers.updateWorkflow);
    router.delete("/api/v1/workflows/:id", workflowsHandlers.deleteWorkflow);

    // Workflow runs endpoints
    router.get("/api/v1/workflow-runs", workflowRunsHandlers.listWorkflowRuns);
    router.get(
      "/api/v1/workflow-runs/:id",
      workflowRunsHandlers.getWorkflowRun,
    );
    router.get(
      "/api/v1/workflows/:workflowId/runs",
      workflowRunsHandlers.listWorkflowRunsByWorkflow,
    );

    // Outputs endpoints
    router.get("/api/v1/outputs", outputsHandlers.listOutputs);
    router.get("/api/v1/outputs/:id", outputsHandlers.getOutput);
    router.get("/api/v1/outputs/:id/data", outputsHandlers.getOutputData);
    router.get("/api/v1/outputs/:id/logs", outputsHandlers.getOutputLogs);

    // Static file serving (catch-all for SPA)
    router.get("/*", staticHandler.serveStatic);

    // Output startup info
    if (ctx.outputMode === "json") {
      console.log(
        JSON.stringify({
          status: "started",
          url: `http://${options.host}:${options.port}`,
          repoDir,
        }),
      );
    } else {
      console.log(
        `\nSwamp webapp server starting at http://${options.host}:${options.port}`,
      );
      console.log(`Repository: ${repoDir}`);
      console.log("Press Ctrl+C to stop\n");
    }

    // Start server
    await server.start();
  });
