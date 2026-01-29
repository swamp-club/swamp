import { Command } from "@cliffy/command";
import { dirname, fromFileUrl, join } from "@std/path";
import { createContext, type GlobalOptions } from "../context.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import {
  cors,
  createModelsHandlers,
  createResourcesHandlers,
  createServer,
  createStaticHandler,
  createWorkflowsHandlers,
  listTypes,
} from "../../infrastructure/http/mod.ts";
import { YamlInputRepository } from "../../infrastructure/persistence/yaml_input_repository.ts";
import { YamlResourceRepository } from "../../infrastructure/persistence/yaml_resource_repository.ts";
import { YamlWorkflowRepository } from "../../infrastructure/persistence/yaml_workflow_repository.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Resolves the webapp dist directory path.
 * When compiled, webapp/dist is embedded and accessible relative to the executable.
 * When running with deno run, resolve relative to this source file.
 */
function resolveWebappDir(): string {
  // import.meta.url gives us the URL of this module
  // When compiled, this will be something like file:///path/to/swamp
  // When running with deno run, it's file:///path/to/src/cli/commands/repo_webapp.ts
  const moduleUrl = import.meta.url;

  if (moduleUrl.startsWith("file://")) {
    const modulePath = fromFileUrl(moduleUrl);
    const moduleDir = dirname(modulePath);

    // Check if we're in the compiled binary (module path won't have /src/)
    if (!modulePath.includes("/src/")) {
      // Compiled binary - webapp/dist is alongside the binary
      return join(moduleDir, "webapp", "dist");
    }

    // Running from source - go up to project root
    return join(moduleDir, "..", "..", "..", "webapp", "dist");
  }

  // Fallback for other protocols
  return "webapp/dist";
}

export const repoWebappCommand = new Command()
  .description("Start the swamp webapp server")
  .arguments("[path:string]")
  .option("-p, --port <port:number>", "Port to serve on", { default: 8080 })
  .option("--host <host:string>", "Host to bind to", { default: "localhost" })
  .action(async function (options: AnyOptions, pathArg?: string) {
    const ctx = createContext(options as GlobalOptions, "repo-webapp");
    ctx.logger.debug`Starting webapp server for: ${pathArg ?? "."}`;

    const repoPath = RepoPath.create(pathArg ?? ".");
    const repoDir = repoPath.value;

    // Initialize repositories
    const inputRepository = new YamlInputRepository(repoDir);
    const resourceRepository = new YamlResourceRepository(repoDir);
    const workflowRepository = new YamlWorkflowRepository(repoDir);

    // Create handlers
    const modelsHandlers = createModelsHandlers(inputRepository);
    const resourcesHandlers = createResourcesHandlers(resourceRepository);
    const workflowsHandlers = createWorkflowsHandlers(workflowRepository);

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
    router.get("/api/v1/models/:type", modelsHandlers.listModelsByType);
    router.get("/api/v1/models/:type/:id", modelsHandlers.getModel);
    router.post("/api/v1/models/:type", modelsHandlers.createModel);
    router.put("/api/v1/models/:type/:id", modelsHandlers.updateModel);
    router.delete("/api/v1/models/:type/:id", modelsHandlers.deleteModel);

    // Resources endpoints
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
