import { z } from "zod";
import { ModelType } from "../../../src/domain/models/model_type.ts";
import { ModelData } from "../../../src/domain/models/model_data.ts";
import {
  defineModel,
  type MethodContext,
  type MethodResult,
} from "../../../src/domain/models/model.ts";
import type { ModelInput } from "../../../src/domain/models/model_input.ts";

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
 * Schema for Docker image model data attributes.
 */
const DataAttributesSchema = z.object({
  /** Full image reference (repository:tag) */
  imageRef: z.string(),
  /** Whether the operation succeeded */
  success: z.boolean(),
  /** Operation performed */
  operation: z.enum(["build", "push", "build-push"]),
  /** Timestamp when operation completed */
  completedAt: z.string().datetime(),
});

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
  input: ModelInput,
  _context: MethodContext,
): Promise<MethodResult> {
  const attrs = InputAttributesSchema.parse(input.attributes);
  await buildImage(attrs);

  const data = ModelData.create({
    id: input.id,
    attributes: {
      imageRef: `${attrs.repository}:${attrs.tag}`,
      success: true,
      operation: "build",
      completedAt: new Date().toISOString(),
    },
  });

  return { data };
}

/**
 * Execute the push method.
 */
async function executePush(
  input: ModelInput,
  _context: MethodContext,
): Promise<MethodResult> {
  const attrs = InputAttributesSchema.parse(input.attributes);
  await pushImage(attrs);

  const data = ModelData.create({
    id: input.id,
    attributes: {
      imageRef: `${attrs.repository}:${attrs.tag}`,
      success: true,
      operation: "push",
      completedAt: new Date().toISOString(),
    },
  });

  return { data };
}

/**
 * Execute the build-push method.
 */
async function executeBuildPush(
  input: ModelInput,
  _context: MethodContext,
): Promise<MethodResult> {
  const attrs = InputAttributesSchema.parse(input.attributes);
  await buildImage(attrs);
  await pushImage(attrs);

  const data = ModelData.create({
    id: input.id,
    attributes: {
      imageRef: `${attrs.repository}:${attrs.tag}`,
      success: true,
      operation: "build-push",
      completedAt: new Date().toISOString(),
    },
  });

  return { data };
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
  dataAttributesSchema: DataAttributesSchema,
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
