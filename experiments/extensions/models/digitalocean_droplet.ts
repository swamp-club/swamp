import { z } from "zod";
import { ModelType } from "../../../src/domain/models/model_type.ts";
import {
  createModelResourceId,
  ModelResource,
} from "../../../src/domain/models/model_resource.ts";
import {
  defineModel,
  type MethodContext,
  type MethodResult,
} from "../../../src/domain/models/model.ts";
import type { ModelInput } from "../../../src/domain/models/model_input.ts";

/**
 * Schema for DigitalOcean Droplet model input attributes.
 */
const InputAttributesSchema = z.object({
  /** Droplet name */
  name: z.string().min(1),
  /** Region (e.g., "sfo3", "nyc3") */
  region: z.string().min(1),
  /** Size slug (e.g., "s-1vcpu-1gb") */
  size: z.string().min(1),
  /** Image slug (defaults to Docker on Ubuntu 20.04) */
  image: z.string().default("docker-20-04"),
  /** SSH key IDs or fingerprints */
  sshKeys: z.array(z.string()).optional(),
  /** Enable monitoring */
  enableMonitoring: z.boolean().default(true),
  /** Enable backups */
  enableBackups: z.boolean().default(false),
  /** Cloud-init user data script */
  userData: z.string().optional(),
  /** Tags to apply to the Droplet */
  tags: z.array(z.string()).optional(),
});

/**
 * Schema for sync/delete/action methods - no attributes needed (dropletId comes from resource).
 */
const EmptyInputSchema = z.object({});

/**
 * Schema for DigitalOcean Droplet model resource attributes.
 */
const ResourceAttributesSchema = z.object({
  /** Droplet ID */
  id: z.number(),
  /** Droplet name */
  name: z.string(),
  /** Status (e.g., "new", "active", "off") */
  status: z.string(),
  /** Memory in MB */
  memory: z.number(),
  /** Number of vCPUs */
  vcpus: z.number(),
  /** Disk size in GB */
  disk: z.number(),
  /** Region slug */
  region: z.string(),
  /** Image slug or name */
  image: z.string(),
  /** Size slug */
  sizeSlug: z.string(),
  /** Public IPv4 address */
  publicIpv4: z.string().nullable(),
  /** Private IPv4 address */
  privateIpv4: z.string().nullable(),
  /** Creation timestamp */
  createdAt: z.string(),
  /** VPC UUID */
  vpcUuid: z.string().nullable(),
});

interface NetworkInfo {
  ip_address: string;
  type: "public" | "private";
}

interface DropletResponse {
  id: number;
  name: string;
  status: string;
  memory: number;
  vcpus: number;
  disk: number;
  region: { slug: string };
  image: { slug?: string; name: string };
  size_slug: string;
  networks: {
    v4: NetworkInfo[];
  };
  created_at: string;
  vpc_uuid?: string;
}

/**
 * Gets the DigitalOcean Droplet ID from the stored resource.
 */
async function getDropletIdFromResource(
  input: ModelInput,
  context: MethodContext,
): Promise<number> {
  if (!context.resourceRepository) {
    throw new Error(
      "Cannot operate: resourceRepository not provided in context",
    );
  }

  const resource = await context.resourceRepository.findById(
    ModelType.create("digitalocean/droplet"),
    createModelResourceId(input.id),
  );

  if (!resource) {
    throw new Error(
      `Resource not found for input ID: ${input.id}. Run 'create' first.`,
    );
  }

  const dropletId = resource.attributes.id as number;
  if (!dropletId) {
    throw new Error("Resource missing 'id' attribute (DO Droplet ID)");
  }

  return dropletId;
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
    const stderr = new TextDecoder().decode(output.stderr);
    const errorMsg = stdout || stderr || "unknown error";
    throw new Error(`doctl command failed: ${errorMsg}`);
  }

  return stdout;
}

/**
 * Parses doctl Droplet JSON response into resource attributes.
 */
function parseDropletResponse(droplet: DropletResponse) {
  return {
    id: droplet.id,
    name: droplet.name,
    status: droplet.status,
    memory: droplet.memory,
    vcpus: droplet.vcpus,
    disk: droplet.disk,
    region: droplet.region.slug,
    image: droplet.image.slug || droplet.image.name,
    sizeSlug: droplet.size_slug,
    publicIpv4:
      droplet.networks.v4.find((n) => n.type === "public")?.ip_address || null,
    privateIpv4:
      droplet.networks.v4.find((n) => n.type === "private")?.ip_address || null,
    createdAt: droplet.created_at,
    vpcUuid: droplet.vpc_uuid || null,
  };
}

/**
 * Execute the create method.
 */
async function executeCreate(
  input: ModelInput,
  _context: MethodContext,
): Promise<MethodResult> {
  const attrs = InputAttributesSchema.parse(input.attributes);

  const args = [
    "compute",
    "droplet",
    "create",
    attrs.name,
    "--size",
    attrs.size,
    "--image",
    attrs.image,
    "--region",
    attrs.region,
    "--wait",
  ];

  if (attrs.sshKeys && attrs.sshKeys.length > 0) {
    args.push("--ssh-keys", attrs.sshKeys.join(","));
  }

  if (attrs.enableMonitoring) {
    args.push("--enable-monitoring");
  }

  if (attrs.enableBackups) {
    args.push("--enable-backups");
  }

  if (attrs.userData) {
    args.push("--user-data", attrs.userData);
  }

  if (attrs.tags && attrs.tags.length > 0) {
    args.push("--tag-names", attrs.tags.join(","));
  }

  const output = await runDoctl(args);

  const droplets = JSON.parse(output) as DropletResponse[];
  const droplet = droplets[0];
  if (!droplet) {
    throw new Error("Droplet not found in create response");
  }

  const resource = ModelResource.create({
    id: input.id,
    attributes: parseDropletResponse(droplet),
  });

  return { resource };
}

/**
 * Execute the delete method.
 */
async function executeDelete(
  input: ModelInput,
  context: MethodContext,
): Promise<MethodResult> {
  const dropletId = await getDropletIdFromResource(input, context);
  await runDoctl([
    "compute",
    "droplet",
    "delete",
    dropletId.toString(),
    "--force",
  ]);
  return { deleteResource: true };
}

/**
 * Execute the sync method.
 */
async function executeSync(
  input: ModelInput,
  context: MethodContext,
): Promise<MethodResult> {
  const dropletId = await getDropletIdFromResource(input, context);

  const output = await runDoctl([
    "compute",
    "droplet",
    "get",
    dropletId.toString(),
  ]);
  const droplets = JSON.parse(output) as DropletResponse[];
  const droplet = droplets[0];
  if (!droplet) {
    throw new Error(`Droplet '${dropletId}' not found`);
  }

  return {
    resource: ModelResource.create({
      id: input.id,
      attributes: parseDropletResponse(droplet),
    }),
  };
}

/**
 * Execute a droplet action (power-on, power-off, reboot).
 */
async function executeAction(
  action: "power-on" | "power-off" | "reboot",
  input: ModelInput,
  context: MethodContext,
): Promise<MethodResult> {
  const dropletId = await getDropletIdFromResource(input, context);

  await runDoctl([
    "compute",
    "droplet-action",
    action,
    dropletId.toString(),
  ]);

  // Fetch updated state after action
  const output = await runDoctl([
    "compute",
    "droplet",
    "get",
    dropletId.toString(),
  ]);
  const droplets = JSON.parse(output) as DropletResponse[];
  const droplet = droplets[0];
  if (!droplet) {
    throw new Error(`Droplet '${dropletId}' not found after ${action}`);
  }

  return {
    resource: ModelResource.create({
      id: input.id,
      attributes: parseDropletResponse(droplet),
    }),
  };
}

/**
 * Execute the power-on method.
 */
function executePowerOn(
  input: ModelInput,
  context: MethodContext,
): Promise<MethodResult> {
  return executeAction("power-on", input, context);
}

/**
 * Execute the power-off method.
 */
function executePowerOff(
  input: ModelInput,
  context: MethodContext,
): Promise<MethodResult> {
  return executeAction("power-off", input, context);
}

/**
 * Execute the reboot method.
 */
function executeReboot(
  input: ModelInput,
  context: MethodContext,
): Promise<MethodResult> {
  return executeAction("reboot", input, context);
}

/**
 * DigitalOcean Droplet model definition.
 *
 * Wraps doctl compute droplet commands to manage Droplets on DigitalOcean.
 * Requires doctl to be installed and authenticated (doctl auth init).
 */
export const digitaloceanDropletModel = defineModel({
  type: ModelType.create("digitalocean/droplet"),
  version: 1,
  inputAttributesSchema: InputAttributesSchema,
  resourceAttributesSchema: ResourceAttributesSchema,
  methods: {
    create: {
      description: "Create a new DigitalOcean Droplet",
      inputAttributesSchema: InputAttributesSchema,
      execute: executeCreate,
    },
    delete: {
      description: "Destroy a DigitalOcean Droplet",
      inputAttributesSchema: EmptyInputSchema,
      execute: executeDelete,
    },
    sync: {
      description: "Sync the current state of a Droplet",
      inputAttributesSchema: EmptyInputSchema,
      execute: executeSync,
    },
    "power-on": {
      description: "Power on a Droplet",
      inputAttributesSchema: EmptyInputSchema,
      execute: executePowerOn,
    },
    "power-off": {
      description: "Power off a Droplet",
      inputAttributesSchema: EmptyInputSchema,
      execute: executePowerOff,
    },
    reboot: {
      description: "Reboot a Droplet",
      inputAttributesSchema: EmptyInputSchema,
      execute: executeReboot,
    },
  },
});
