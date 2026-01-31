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
 * Schema for DigitalOcean SSH Key model input attributes.
 */
const InputAttributesSchema = z.object({
  /** SSH key name */
  name: z.string().min(1),
  /** SSH public key content */
  publicKey: z.string().min(1),
});

/**
 * Schema for update method input - only name can be changed.
 */
const UpdateInputSchema = z.object({
  /** New SSH key name */
  name: z.string().min(1),
});

/**
 * Schema for sync/delete methods - no attributes needed (keyId comes from resource).
 */
const EmptyInputSchema = z.object({});

/**
 * Schema for DigitalOcean SSH Key model resource attributes.
 */
const ResourceAttributesSchema = z.object({
  /** SSH key ID */
  id: z.number(),
  /** SSH key name */
  name: z.string(),
  /** SSH key fingerprint */
  fingerprint: z.string(),
  /** SSH public key content */
  publicKey: z.string(),
});

interface SshKeyResponse {
  id: number;
  name: string;
  fingerprint: string;
  public_key: string;
}

/**
 * Gets the DigitalOcean SSH key ID from the stored resource.
 */
async function getKeyIdFromResource(
  input: ModelInput,
  context: MethodContext,
): Promise<number> {
  if (!context.resourceRepository) {
    throw new Error(
      "Cannot operate: resourceRepository not provided in context",
    );
  }

  const resource = await context.resourceRepository.findById(
    ModelType.create("digitalocean/ssh-key"),
    createModelResourceId(input.id),
  );

  if (!resource) {
    throw new Error(
      `Resource not found for input ID: ${input.id}. Run 'create' first.`,
    );
  }

  const keyId = resource.attributes.id as number;
  if (!keyId) {
    throw new Error("Resource missing 'id' attribute (DO SSH key ID)");
  }

  return keyId;
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
 * Parses doctl SSH key JSON response into resource attributes.
 */
function parseSshKeyResponse(key: SshKeyResponse) {
  return {
    id: key.id,
    name: key.name,
    fingerprint: key.fingerprint,
    publicKey: key.public_key,
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

  const output = await runDoctl([
    "compute",
    "ssh-key",
    "create",
    attrs.name,
    "--public-key",
    attrs.publicKey,
  ]);

  const keys = JSON.parse(output) as SshKeyResponse[];
  const key = keys[0];
  if (!key) {
    throw new Error("SSH key not found in create response");
  }

  const resource = ModelResource.create({
    id: input.id,
    attributes: parseSshKeyResponse(key),
  });

  return { resource };
}

/**
 * Execute the update method.
 */
async function executeUpdate(
  input: ModelInput,
  context: MethodContext,
): Promise<MethodResult> {
  const attrs = UpdateInputSchema.parse(input.attributes);
  const keyId = await getKeyIdFromResource(input, context);

  const output = await runDoctl([
    "compute",
    "ssh-key",
    "update",
    keyId.toString(),
    "--key-name",
    attrs.name,
  ]);

  const keys = JSON.parse(output) as SshKeyResponse[];
  const key = keys[0];
  if (!key) {
    throw new Error(`SSH key '${keyId}' not found after update`);
  }

  return {
    resource: ModelResource.create({
      id: input.id,
      attributes: parseSshKeyResponse(key),
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
  const keyId = await getKeyIdFromResource(input, context);
  await runDoctl(["compute", "ssh-key", "delete", keyId.toString(), "--force"]);
  return { deleteResource: true };
}

/**
 * Execute the sync method.
 */
async function executeSync(
  input: ModelInput,
  context: MethodContext,
): Promise<MethodResult> {
  const keyId = await getKeyIdFromResource(input, context);

  const output = await runDoctl([
    "compute",
    "ssh-key",
    "get",
    keyId.toString(),
  ]);
  const keys = JSON.parse(output) as SshKeyResponse[];
  const key = keys[0];
  if (!key) {
    throw new Error(`SSH key '${keyId}' not found`);
  }

  return {
    resource: ModelResource.create({
      id: input.id,
      attributes: parseSshKeyResponse(key),
    }),
  };
}

/**
 * DigitalOcean SSH Key model definition.
 *
 * Wraps doctl compute ssh-key commands to manage SSH keys on DigitalOcean.
 * Requires doctl to be installed and authenticated (doctl auth init).
 */
export const digitaloceanSshKeyModel = defineModel({
  type: ModelType.create("digitalocean/ssh-key"),
  version: 1,
  inputAttributesSchema: InputAttributesSchema,
  resourceAttributesSchema: ResourceAttributesSchema,
  methods: {
    create: {
      description: "Create a new SSH key on DigitalOcean",
      inputAttributesSchema: InputAttributesSchema,
      execute: executeCreate,
    },
    update: {
      description: "Rename an existing SSH key",
      inputAttributesSchema: UpdateInputSchema,
      execute: executeUpdate,
    },
    delete: {
      description: "Delete an SSH key from DigitalOcean",
      inputAttributesSchema: EmptyInputSchema,
      execute: executeDelete,
    },
    sync: {
      description: "Sync the current state of an SSH key",
      inputAttributesSchema: EmptyInputSchema,
      execute: executeSync,
    },
  },
});
