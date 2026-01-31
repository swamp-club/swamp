import { z } from "zod";
import { parse as parseYaml } from "@std/yaml";
import { ModelType } from "../../../src/domain/models/model_type.ts";
import {
  createModelResourceId,
  ModelResource,
} from "../../../src/domain/models/model_resource.ts";
import { ModelData } from "../../../src/domain/models/model_data.ts";
import {
  defineModel,
  type MethodContext,
  type MethodResult,
} from "../../../src/domain/models/model.ts";
import type { ModelInput } from "../../../src/domain/models/model_input.ts";

/**
 * Schema for DigitalOcean App model input attributes.
 */
const InputAttributesSchema = z.object({
  /** App name */
  name: z.string().min(1),
  /** Region (e.g., "nyc", "sfo", "ams") */
  region: z.string().min(1).optional(),
  /** App spec as YAML string */
  spec: z.string().min(1),
});

/**
 * Schema for update method input - only needs spec (appId comes from resource).
 */
const UpdateInputSchema = z.object({
  /** App spec as YAML string */
  spec: z.string().min(1),
});

/**
 * Schema for sync/delete methods - no attributes needed (appId comes from resource).
 */
const EmptyInputSchema = z.object({});

/**
 * Schema for listJobInvocations method input.
 */
const ListJobInvocationsInputSchema = z.object({
  /** Filter by job name */
  jobName: z.string().optional(),
  /** Filter by deployment ID */
  deploymentId: z.string().optional(),
});

/**
 * Schema for getJobInvocation method input.
 */
const GetJobInvocationInputSchema = z.object({
  /** The invocation ID to fetch */
  invocationId: z.string().min(1),
});

/**
 * Schema for getJobLogs method input.
 */
const GetJobLogsInputSchema = z.object({
  /** The invocation ID */
  invocationId: z.string().min(1),
  /** The component name (job name) */
  componentName: z.string().min(1),
  /** Log type: "build" or "run" (default: "run") */
  logType: z.enum(["build", "run"]).default("run"),
  /** Number of log lines to tail */
  tail: z.number().positive().optional(),
});

/**
 * Schema for DigitalOcean App model resource attributes.
 */
const ResourceAttributesSchema = z.object({
  /** App ID */
  id: z.string().uuid(),
  /** Default ingress URL */
  defaultIngress: z.string().nullable(),
  /** Active deployment ID */
  activeDeploymentId: z.string().nullable(),
  /** App creation timestamp */
  createdAt: z.string().datetime(),
  /** Last update timestamp */
  updatedAt: z.string().datetime(),
  /** App name */
  name: z.string(),
  /** Region */
  region: z.string().nullable(),
});

interface AppResponse {
  id: string;
  default_ingress?: string;
  active_deployment?: { id: string };
  created_at: string;
  updated_at: string;
  spec: {
    name: string;
    region?: string;
  };
}

/**
 * App spec structure from YAML.
 */
interface AppSpec {
  name: string;
  region?: string;
}

/**
 * Parses a YAML spec string into an AppSpec object.
 */
function parseYamlSpec(spec: string): AppSpec {
  return parseYaml(spec) as AppSpec;
}

/**
 * Gets the DigitalOcean app ID from the stored resource.
 */
async function getAppIdFromResource(
  input: ModelInput,
  context: MethodContext,
): Promise<string> {
  if (!context.resourceRepository) {
    throw new Error(
      "Cannot operate: resourceRepository not provided in context",
    );
  }

  const resource = await context.resourceRepository.findById(
    ModelType.create("digitalocean/app"),
    createModelResourceId(input.id),
  );

  if (!resource) {
    throw new Error(
      `Resource not found for input ID: ${input.id}. Run 'create' first.`,
    );
  }

  const appId = resource.attributes.id as string;
  if (!appId) {
    throw new Error("Resource missing 'id' attribute (DO app ID)");
  }

  return appId;
}

/**
 * Gets an app by name from the list of apps.
 */
async function getAppByName(name: string): Promise<AppResponse> {
  const output = await runDoctl(["apps", "list"]);
  const apps = JSON.parse(output) as AppResponse[];
  const app = apps.find((a) => a.spec?.name === name);
  if (!app) {
    throw new Error(`App '${name}' not found after creation`);
  }
  return app;
}

/**
 * Runs a doctl command and returns the JSON output.
 */
async function runDoctl(args: string[]): Promise<string> {
  const command = new Deno.Command("doctl", {
    args: [...args, "--output", "json"],
    stdout: "piped",
    stderr: "piped",
  });

  const output = await command.output();
  const stdout = new TextDecoder().decode(output.stdout);

  if (!output.success) {
    // doctl outputs JSON errors to stdout when using --output json
    const stderr = new TextDecoder().decode(output.stderr);
    const errorMsg = stdout || stderr || "unknown error";
    throw new Error(`doctl command failed: ${errorMsg}`);
  }

  return stdout;
}

/**
 * Runs a doctl command and returns raw text output (for commands that don't support JSON).
 */
async function runDoctlText(args: string[]): Promise<string> {
  const command = new Deno.Command("doctl", {
    args,
    stdout: "piped",
    stderr: "piped",
  });

  const output = await command.output();
  const stdout = new TextDecoder().decode(output.stdout);

  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    const errorMsg = stdout || stderr || "unknown error";
    throw new Error(`doctl command failed: ${errorMsg}`);
  }

  return stdout;
}

/**
 * Gets the DO API token from doctl config.
 */
async function getDoctlToken(): Promise<string> {
  const homeDir = Deno.env.get("HOME") || "~";
  const configPath = `${homeDir}/.config/doctl/config.yaml`;
  const configContent = await Deno.readTextFile(configPath);
  const match = configContent.match(/access-token:\s*(\S+)/);
  if (!match) {
    throw new Error("Could not find access-token in doctl config");
  }
  return match[1];
}

/**
 * Calls the DigitalOcean API directly (workaround for doctl bugs).
 */
async function callDoApi(endpoint: string): Promise<string> {
  const token = await getDoctlToken();
  const command = new Deno.Command("curl", {
    args: [
      "-s",
      `https://api.digitalocean.com/v2${endpoint}`,
      "-H",
      `Authorization: Bearer ${token}`,
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const output = await command.output();
  const stdout = new TextDecoder().decode(output.stdout);

  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(`DO API call failed: ${stderr}`);
  }

  return stdout;
}

/**
 * Creates a temporary file with the spec content.
 */
async function withTempSpec<T>(
  spec: string,
  fn: (specPath: string) => Promise<T>,
): Promise<T> {
  const tempDir = await Deno.makeTempDir();
  const specPath = `${tempDir}/app-spec.yaml`;

  try {
    await Deno.writeTextFile(specPath, spec);
    return await fn(specPath);
  } finally {
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Parses doctl app JSON response into resource attributes.
 */
function parseAppResponse(app: AppResponse) {
  return {
    id: app.id,
    defaultIngress: app.default_ingress || null,
    activeDeploymentId: app.active_deployment?.id || null,
    createdAt: app.created_at,
    updatedAt: app.updated_at,
    name: app.spec.name,
    region: app.spec.region || null,
  };
}

/**
 * Job invocation response from DO API.
 */
interface JobInvocationApi {
  id: string;
  job_name: string;
  deployment_id: string;
  phase: string;
  trigger: {
    type: string;
  };
  created_at: string;
  started_at?: string;
  completed_at?: string;
  progress?: {
    steps: Array<{
      name: string;
      status: string;
      reason?: {
        code: string;
        message: string;
      };
    }>;
  };
}

/**
 * Job invocations API response wrapper.
 */
interface JobInvocationsResponse {
  job_invocations: JobInvocationApi[];
}

/**
 * Execute the listJobInvocations method.
 * Note: Uses direct API call due to doctl bug returning null.
 */
async function executeListJobInvocations(
  input: ModelInput,
  context: MethodContext,
): Promise<MethodResult> {
  const attrs = ListJobInvocationsInputSchema.parse(input.attributes);
  const appId = await getAppIdFromResource(input, context);

  // Build query params
  const params = new URLSearchParams();
  if (attrs.jobName) {
    params.append("job_names", attrs.jobName);
  }
  if (attrs.deploymentId) {
    params.append("deployment_ids", attrs.deploymentId);
  }

  const queryString = params.toString();
  const endpoint = `/apps/${appId}/job-invocations${
    queryString ? `?${queryString}` : ""
  }`;
  const output = await callDoApi(endpoint);
  const response = JSON.parse(output) as JobInvocationsResponse;
  const invocations = response.job_invocations ?? [];

  const data = ModelData.create({
    id: input.id,
    attributes: {
      invocations: invocations.map((inv) => ({
        id: inv.id,
        jobName: inv.job_name,
        deploymentId: inv.deployment_id,
        phase: inv.phase,
        triggerType: inv.trigger.type,
        createdAt: inv.created_at,
        startedAt: inv.started_at,
        completedAt: inv.completed_at,
        errorCode: inv.progress?.steps?.[0]?.reason?.code,
        errorMessage: inv.progress?.steps?.[0]?.reason?.message,
      })),
      fetchedAt: new Date().toISOString(),
    },
  });

  return { data };
}

/**
 * Execute the getJobInvocation method.
 * Note: Uses direct API call due to doctl bug.
 */
async function executeGetJobInvocation(
  input: ModelInput,
  context: MethodContext,
): Promise<MethodResult> {
  const attrs = GetJobInvocationInputSchema.parse(input.attributes);
  const appId = await getAppIdFromResource(input, context);

  const endpoint = `/apps/${appId}/job-invocations/${attrs.invocationId}`;
  const output = await callDoApi(endpoint);
  const response = JSON.parse(output) as { job_invocation: JobInvocationApi };
  const inv = response.job_invocation;

  const data = ModelData.create({
    id: input.id,
    attributes: {
      id: inv.id,
      jobName: inv.job_name,
      deploymentId: inv.deployment_id,
      phase: inv.phase,
      triggerType: inv.trigger.type,
      createdAt: inv.created_at,
      startedAt: inv.started_at,
      completedAt: inv.completed_at,
      errorCode: inv.progress?.steps?.[0]?.reason?.code,
      errorMessage: inv.progress?.steps?.[0]?.reason?.message,
      fetchedAt: new Date().toISOString(),
    },
  });

  return { data };
}

/**
 * Execute the getJobLogs method.
 */
async function executeGetJobLogs(
  input: ModelInput,
  context: MethodContext,
): Promise<MethodResult> {
  const attrs = GetJobLogsInputSchema.parse(input.attributes);
  const appId = await getAppIdFromResource(input, context);

  const args = [
    "apps",
    "logs",
    appId,
    attrs.componentName,
    "--job-invocation",
    attrs.invocationId,
    "--type",
    attrs.logType,
  ];

  if (attrs.tail) {
    args.push("--tail", attrs.tail.toString());
  }

  const logs = await runDoctlText(args);

  const data = ModelData.create({
    id: input.id,
    attributes: {
      logs,
      invocationId: attrs.invocationId,
      componentName: attrs.componentName,
      logType: attrs.logType,
      fetchedAt: new Date().toISOString(),
    },
  });

  return { data };
}

/**
 * Execute the create method.
 *
 * Note: `doctl apps create` returns a deployment object, not an app object.
 * We need to fetch the actual app by name after creation.
 */
async function executeCreate(
  input: ModelInput,
  _context: MethodContext,
): Promise<MethodResult> {
  const attrs = InputAttributesSchema.parse(input.attributes);

  // Create returns a deployment, not an app - we ignore the output
  await withTempSpec(attrs.spec, async (specPath: string) => {
    await runDoctl(["apps", "create", "--spec", specPath]);
  });

  // Get the actual app by name from the spec
  const specObj = parseYamlSpec(attrs.spec);
  const app = await getAppByName(specObj.name);

  const resource = ModelResource.create({
    id: input.id,
    attributes: parseAppResponse(app),
  });

  return { resource };
}

/**
 * Execute the update method.
 *
 * Note: `doctl apps update` returns inconsistent data structures.
 * We fetch fresh app state using `doctl apps get` after update.
 */
async function executeUpdate(
  input: ModelInput,
  context: MethodContext,
): Promise<MethodResult> {
  const attrs = UpdateInputSchema.parse(input.attributes);
  const appId = await getAppIdFromResource(input, context);

  // Update the app - ignore the inconsistent response
  await withTempSpec(attrs.spec, async (specPath: string) => {
    await runDoctl(["apps", "update", appId, "--spec", specPath]);
  });

  // Get fresh app state (doctl apps get returns an array)
  const output = await runDoctl(["apps", "get", appId]);
  const apps = JSON.parse(output) as AppResponse[];
  const app = apps[0];
  if (!app) {
    throw new Error(`App '${appId}' not found after update`);
  }

  return {
    resource: ModelResource.create({
      id: input.id,
      attributes: parseAppResponse(app),
    }),
  };
}

/**
 * Execute the delete method.
 */
async function executeDelete(
  input: ModelInput,
  context: MethodContext,
): Promise<MethodResult> {
  const appId = await getAppIdFromResource(input, context);
  await runDoctl(["apps", "delete", appId, "--force"]);
  return { deleteResource: true };
}

/**
 * Execute the sync method.
 */
async function executeSync(
  input: ModelInput,
  context: MethodContext,
): Promise<MethodResult> {
  const appId = await getAppIdFromResource(input, context);

  // doctl apps get returns an array
  const output = await runDoctl(["apps", "get", appId]);
  const apps = JSON.parse(output) as AppResponse[];
  const app = apps[0];
  if (!app) {
    throw new Error(`App '${appId}' not found`);
  }

  return {
    resource: ModelResource.create({
      id: input.id,
      attributes: parseAppResponse(app),
    }),
  };
}

/**
 * DigitalOcean App model definition.
 *
 * Wraps doctl apps commands to manage DigitalOcean App Platform applications.
 * Requires doctl to be installed and authenticated (doctl auth init).
 */
export const digitaloceanAppModel = defineModel({
  type: ModelType.create("digitalocean/app"),
  version: 1,
  inputAttributesSchema: InputAttributesSchema,
  resourceAttributesSchema: ResourceAttributesSchema,
  methods: {
    create: {
      description: "Create a new DigitalOcean App Platform application",
      inputAttributesSchema: InputAttributesSchema,
      execute: executeCreate,
    },
    update: {
      description: "Update an existing DigitalOcean App Platform application",
      inputAttributesSchema: UpdateInputSchema,
      execute: executeUpdate,
    },
    delete: {
      description: "Delete a DigitalOcean App Platform application",
      inputAttributesSchema: EmptyInputSchema,
      execute: executeDelete,
    },
    sync: {
      description:
        "Sync the current state of a DigitalOcean App Platform application",
      inputAttributesSchema: EmptyInputSchema,
      execute: executeSync,
    },
    listJobInvocations: {
      description: "List recent job invocations for the app",
      inputAttributesSchema: ListJobInvocationsInputSchema,
      execute: executeListJobInvocations,
    },
    getJobInvocation: {
      description: "Get details of a specific job invocation",
      inputAttributesSchema: GetJobInvocationInputSchema,
      execute: executeGetJobInvocation,
    },
    getJobLogs: {
      description: "Get logs for a job invocation",
      inputAttributesSchema: GetJobLogsInputSchema,
      execute: executeGetJobLogs,
    },
  },
});
