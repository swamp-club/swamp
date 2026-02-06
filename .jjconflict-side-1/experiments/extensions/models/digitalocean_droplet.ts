import { z } from "zod";
import { ModelType } from "../../../src/domain/models/model_type.ts";
import {
  defineModel,
  type MethodContext,
  type MethodResult,
} from "../../../src/domain/models/model.ts";
import type { Definition } from "../../../src/domain/definitions/definition.ts";

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
 * Gets the DigitalOcean Droplet ID from the stored data.
 */
async function getDropletIdFromData(
  definition: Definition,
  context: MethodContext,
): Promise<number> {
  const dataName = `${definition.name}-data`;
  const existingData = await context.dataRepository.findByName(
    context.modelType,
    context.modelId,
    dataName,
  );

  if (!existingData) {
    throw new Error(
      `Data not found for definition: ${definition.name}. Run 'create' first.`,
    );
  }

  const content = await context.dataRepository.getContent(
    context.modelType,
    context.modelId,
    dataName,
  );

  if (!content) {
    throw new Error("Data content not found");
  }

  const attributes = JSON.parse(new TextDecoder().decode(content));
  const dropletId = attributes.id as number;
  if (!dropletId) {
    throw new Error("Data missing 'id' attribute (DO Droplet ID)");
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
  definition: Definition,
  _context: MethodContext,
): Promise<MethodResult> {
  const attrs = InputAttributesSchema.parse(definition.attributes);

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

  const definitionHash = await definition.computeHash();

  return {
    dataOutputs: [{
      name: `${definition.name}-data`,
      content: new TextEncoder().encode(
        JSON.stringify(parseDropletResponse(droplet)),
      ),
      metadata: {
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        streaming: false,
        tags: { type: "resource" },
        ownerDefinition: {
          definitionHash,
          ownerType: "model-method",
          ownerRef: "create",
        },
      },
    }],
  };
}

/**
 * Execute the delete method.
 */
async function executeDelete(
  definition: Definition,
  context: MethodContext,
): Promise<MethodResult> {
  const dropletId = await getDropletIdFromData(definition, context);
  await runDoctl([
    "compute",
    "droplet",
    "delete",
    dropletId.toString(),
    "--force",
  ]);

  const definitionHash = await definition.computeHash();

  return {
    dataOutputs: [{
      name: `${definition.name}-data`,
      content: new TextEncoder().encode(
        JSON.stringify({
          deleted: true,
          deletedAt: new Date().toISOString(),
          dropletId,
        }),
      ),
      metadata: {
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        streaming: false,
        tags: { type: "resource" },
        ownerDefinition: {
          definitionHash,
          ownerType: "model-method",
          ownerRef: "delete",
        },
      },
    }],
  };
}

/**
 * Execute the sync method.
 */
async function executeSync(
  definition: Definition,
  context: MethodContext,
): Promise<MethodResult> {
  const dropletId = await getDropletIdFromData(definition, context);

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

  const definitionHash = await definition.computeHash();

  return {
    dataOutputs: [{
      name: `${definition.name}-data`,
      content: new TextEncoder().encode(
        JSON.stringify(parseDropletResponse(droplet)),
      ),
      metadata: {
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        streaming: false,
        tags: { type: "resource" },
        ownerDefinition: {
          definitionHash,
          ownerType: "model-method",
          ownerRef: "sync",
        },
      },
    }],
  };
}

/**
 * Execute a droplet action (power-on, power-off, reboot).
 */
async function executeAction(
  action: "power-on" | "power-off" | "reboot",
  definition: Definition,
  context: MethodContext,
): Promise<MethodResult> {
  const dropletId = await getDropletIdFromData(definition, context);

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

  const definitionHash = await definition.computeHash();

  return {
    dataOutputs: [{
      name: `${definition.name}-data`,
      content: new TextEncoder().encode(
        JSON.stringify(parseDropletResponse(droplet)),
      ),
      metadata: {
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        streaming: false,
        tags: { type: "resource" },
        ownerDefinition: {
          definitionHash,
          ownerType: "model-method",
          ownerRef: action,
        },
      },
    }],
  };
}

/**
 * Execute the power-on method.
 */
function executePowerOn(
  definition: Definition,
  context: MethodContext,
): Promise<MethodResult> {
  return executeAction("power-on", definition, context);
}

/**
 * Execute the power-off method.
 */
function executePowerOff(
  definition: Definition,
  context: MethodContext,
): Promise<MethodResult> {
  return executeAction("power-off", definition, context);
}

/**
 * Execute the reboot method.
 */
function executeReboot(
  definition: Definition,
  context: MethodContext,
): Promise<MethodResult> {
  return executeAction("reboot", definition, context);
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
