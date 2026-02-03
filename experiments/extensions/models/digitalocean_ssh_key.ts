import { z } from "zod";
import { ModelType } from "../../../src/domain/models/model_type.ts";
import {
  defineModel,
  type MethodContext,
  type MethodResult,
} from "../../../src/domain/models/model.ts";
import type { Definition } from "../../../src/domain/definitions/definition.ts";

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

interface SshKeyResponse {
  id: number;
  name: string;
  fingerprint: string;
  public_key: string;
}

/**
 * Gets the DigitalOcean SSH key ID from the stored data.
 */
async function getKeyIdFromData(
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
  const keyId = attributes.id as number;
  if (!keyId) {
    throw new Error("Data missing 'id' attribute (DO SSH key ID)");
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
  definition: Definition,
  _context: MethodContext,
): Promise<MethodResult> {
  const attrs = InputAttributesSchema.parse(definition.attributes);

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

  const definitionHash = await definition.computeHash();

  return {
    dataOutputs: [{
      name: `${definition.name}-data`,
      content: new TextEncoder().encode(
        JSON.stringify(parseSshKeyResponse(key)),
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
 * Execute the update method.
 */
async function executeUpdate(
  definition: Definition,
  context: MethodContext,
): Promise<MethodResult> {
  const attrs = UpdateInputSchema.parse(definition.attributes);
  const keyId = await getKeyIdFromData(definition, context);

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

  const definitionHash = await definition.computeHash();

  return {
    dataOutputs: [{
      name: `${definition.name}-data`,
      content: new TextEncoder().encode(
        JSON.stringify(parseSshKeyResponse(key)),
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
          ownerRef: "update",
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
  const keyId = await getKeyIdFromData(definition, context);
  await runDoctl(["compute", "ssh-key", "delete", keyId.toString(), "--force"]);

  const definitionHash = await definition.computeHash();

  return {
    dataOutputs: [{
      name: `${definition.name}-data`,
      content: new TextEncoder().encode(
        JSON.stringify({
          deleted: true,
          deletedAt: new Date().toISOString(),
          keyId,
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
  const keyId = await getKeyIdFromData(definition, context);

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

  const definitionHash = await definition.computeHash();

  return {
    dataOutputs: [{
      name: `${definition.name}-data`,
      content: new TextEncoder().encode(
        JSON.stringify(parseSshKeyResponse(key)),
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
 * DigitalOcean SSH Key model definition.
 *
 * Wraps doctl compute ssh-key commands to manage SSH keys on DigitalOcean.
 * Requires doctl to be installed and authenticated (doctl auth init).
 */
export const digitaloceanSshKeyModel = defineModel({
  type: ModelType.create("digitalocean/ssh-key"),
  version: 1,
  inputAttributesSchema: InputAttributesSchema,
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
