import { z } from "zod";
import { ModelType } from "../../../src/domain/models/model_type.ts";
import {
  defineModel,
  type MethodContext,
  type MethodResult,
} from "../../../src/domain/models/model.ts";
import type { Definition } from "../../../src/domain/definitions/definition.ts";

/**
 * Schema for Docker image model input attributes.
 */
const InputAttributesSchema = z.object({
  /** Docker Hub repository (e.g., "keeb/discord-project-summarizer") */
  repository: z.string().min(1),
  /** Image tag (default: "latest") */
  tag: z.string().default("latest"),
  /** Path to Dockerfile (default: "Dockerfile") */
  dockerfile: z.string().default("Dockerfile"),
  /** Build context path (default: ".") */
  context: z.string().default("."),
});

type InputAttributes = z.infer<typeof InputAttributesSchema>;

/**
 * Runs a docker command.
 */
async function runDocker(args: string[]): Promise<void> {
  const command = new Deno.Command("docker", {
    args,
    stdout: "inherit",
    stderr: "inherit",
  });

  const output = await command.output();

  if (!output.success) {
    throw new Error(`docker command failed with exit code ${output.code}`);
  }
}

/**
 * Build a Docker image.
 */
async function buildImage(attrs: InputAttributes): Promise<void> {
  const imageRef = `${attrs.repository}:${attrs.tag}`;
  await runDocker([
    "build",
    "-t",
    imageRef,
    "-f",
    attrs.dockerfile,
    attrs.context,
  ]);
}

/**
 * Push a Docker image.
 */
async function pushImage(attrs: InputAttributes): Promise<void> {
  const imageRef = `${attrs.repository}:${attrs.tag}`;
  await runDocker(["push", imageRef]);
}

/**
 * Execute the build method.
 */
async function executeBuild(
  definition: Definition,
  _context: MethodContext,
): Promise<MethodResult> {
  const attrs = InputAttributesSchema.parse(definition.attributes);
  await buildImage(attrs);

  const dataAttributes = {
    imageRef: `${attrs.repository}:${attrs.tag}`,
    success: true,
    operation: "build",
    completedAt: new Date().toISOString(),
  };

  const definitionHash = await definition.computeHash();

  return {
    dataOutputs: [{
      name: `${definition.name}-data`,
      content: new TextEncoder().encode(JSON.stringify(dataAttributes)),
      metadata: {
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        streaming: false,
        tags: { type: "data" },
        ownerDefinition: {
          definitionHash,
          ownerType: "model-method",
          ownerRef: "build",
        },
      },
    }],
  };
}

/**
 * Execute the push method.
 */
async function executePush(
  definition: Definition,
  _context: MethodContext,
): Promise<MethodResult> {
  const attrs = InputAttributesSchema.parse(definition.attributes);
  await pushImage(attrs);

  const dataAttributes = {
    imageRef: `${attrs.repository}:${attrs.tag}`,
    success: true,
    operation: "push",
    completedAt: new Date().toISOString(),
  };

  const definitionHash = await definition.computeHash();

  return {
    dataOutputs: [{
      name: `${definition.name}-data`,
      content: new TextEncoder().encode(JSON.stringify(dataAttributes)),
      metadata: {
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        streaming: false,
        tags: { type: "data" },
        ownerDefinition: {
          definitionHash,
          ownerType: "model-method",
          ownerRef: "push",
        },
      },
    }],
  };
}

/**
 * Execute the build-push method.
 */
async function executeBuildPush(
  definition: Definition,
  _context: MethodContext,
): Promise<MethodResult> {
  const attrs = InputAttributesSchema.parse(definition.attributes);
  await buildImage(attrs);
  await pushImage(attrs);

  const dataAttributes = {
    imageRef: `${attrs.repository}:${attrs.tag}`,
    success: true,
    operation: "build-push",
    completedAt: new Date().toISOString(),
  };

  const definitionHash = await definition.computeHash();

  return {
    dataOutputs: [{
      name: `${definition.name}-data`,
      content: new TextEncoder().encode(JSON.stringify(dataAttributes)),
      metadata: {
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        streaming: false,
        tags: { type: "data" },
        ownerDefinition: {
          definitionHash,
          ownerType: "model-method",
          ownerRef: "build-push",
        },
      },
    }],
  };
}

/**
 * Docker Image model definition.
 *
 * Builds and pushes Docker images to Docker Hub.
 * Assumes docker CLI is pre-authenticated (docker login already done).
 * Uses Deno.Command to run docker build and push commands.
 */
export const dockerImageModel = defineModel({
  type: ModelType.create("docker/image"),
  version: 1,
  inputAttributesSchema: InputAttributesSchema,
  methods: {
    build: {
      description: "Build a Docker image locally",
      inputAttributesSchema: InputAttributesSchema,
      execute: executeBuild,
    },
    push: {
      description: "Push a Docker image to Docker Hub",
      inputAttributesSchema: InputAttributesSchema,
      execute: executePush,
    },
    "build-push": {
      description: "Build and push a Docker image in one step",
      inputAttributesSchema: InputAttributesSchema,
      execute: executeBuildPush,
    },
  },
});
