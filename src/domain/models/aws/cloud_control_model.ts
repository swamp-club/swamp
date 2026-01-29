import { z } from "zod";
import {
  CloudControlClient,
  CreateResourceCommand,
  DeleteResourceCommand,
  GetResourceCommand,
  GetResourceRequestStatusCommand,
} from "@aws-sdk/client-cloudcontrol";
import type { ModelType } from "../model_type.ts";
import { createModelResourceId, ModelResource } from "../model_resource.ts";
import type {
  FollowUpAction,
  MethodContext,
  MethodResult,
  ModelDefinition,
} from "../model.ts";
import type { ModelInput } from "../model_input.ts";

/**
 * Creates an AWS CloudControl API client.
 */
export function createCloudControlClient(): CloudControlClient {
  return new CloudControlClient({
    region: Deno.env.get("AWS_REGION") || "us-east-1",
  });
}

/**
 * Checks if an error indicates the resource was not found.
 */
export function isResourceNotFoundError(error: unknown): boolean {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorName = error instanceof Error ? error.name : "";

  return (
    errorMessage.includes("was not found") ||
    errorMessage.includes("does not exist") ||
    errorName === "ResourceNotFoundException"
  );
}

/**
 * Configuration for an AWS CloudControl model.
 */
export interface CloudControlModelConfig<
  TInputAttrs extends z.ZodTypeAny,
  TResourceAttrs extends z.ZodTypeAny,
> {
  /**
   * The AWS CloudFormation type name (e.g., "AWS::EC2::Instance").
   */
  typeName: string;

  /**
   * The model type for this model.
   */
  modelType: ModelType;

  /**
   * Zod schema for validating input attributes.
   */
  inputAttributesSchema: TInputAttrs;

  /**
   * Zod schema for validating resource attributes.
   */
  resourceAttributesSchema: TResourceAttrs;

  /**
   * Extracts the AWS resource identifier from existing resource attributes.
   * Default implementation looks for common identifier fields.
   */
  extractResourceIdentifier?: (
    attributes: Record<string, unknown>,
  ) => string | undefined;

  /**
   * Maps the raw AWS properties to resource attributes.
   * Default implementation returns a standard set of properties.
   */
  mapResourceProperties?: (
    rawProperties: Record<string, unknown>,
  ) => Record<string, unknown>;
}

/**
 * Abstract base class for AWS CloudControl models.
 *
 * Provides common implementations for create, delete, and sync operations
 * using the AWS CloudControl API.
 */
export abstract class AWSCloudControlModel<
  TInputAttrs extends z.ZodTypeAny,
  TResourceAttrs extends z.ZodTypeAny,
> {
  protected readonly config: CloudControlModelConfig<
    TInputAttrs,
    TResourceAttrs
  >;

  constructor(config: CloudControlModelConfig<TInputAttrs, TResourceAttrs>) {
    this.config = config;
  }

  /**
   * Gets the AWS CloudFormation type name.
   */
  get typeName(): string {
    return this.config.typeName;
  }

  /**
   * Gets the model type.
   */
  get modelType(): ModelType {
    return this.config.modelType;
  }

  /**
   * Creates the CloudControl client.
   */
  protected createClient(context: MethodContext): CloudControlClient {
    return context.cloudControlClientFactory
      ? context.cloudControlClientFactory()
      : createCloudControlClient();
  }

  /**
   * Extracts the AWS resource identifier from attributes.
   * Override this method for model-specific identifier extraction.
   */
  protected extractResourceIdentifier(
    attributes: Record<string, unknown>,
  ): string | undefined {
    if (this.config.extractResourceIdentifier) {
      return this.config.extractResourceIdentifier(attributes);
    }
    // Default: look for common identifier patterns
    return (attributes.ResourceIdentifier as string | undefined) ||
      (attributes.Identifier as string | undefined);
  }

  /**
   * Maps raw AWS properties to resource attributes.
   * Override this method for model-specific property mapping.
   */
  protected mapResourceProperties(
    rawProperties: Record<string, unknown>,
  ): Record<string, unknown> {
    if (this.config.mapResourceProperties) {
      return this.config.mapResourceProperties(rawProperties);
    }
    // Default: return all raw properties
    return { ...rawProperties };
  }

  /**
   * Creates a "resource deleted" result.
   */
  protected createDeletedResult(inputId: string): MethodResult {
    const resource = ModelResource.create({
      id: inputId,
      attributes: {
        OperationStatus: "SUCCESS",
        StatusMessage:
          `${this.typeName} has been deleted or does not exist in AWS`,
        DeletionCompleted: true,
      },
    });
    return { resource, deleteResource: true };
  }

  /**
   * Executes the "create" method using AWS CloudControl API.
   *
   * Provisions a new resource using AWS CloudControl API.
   */
  async executeCreate(
    input: ModelInput,
    context: MethodContext,
  ): Promise<MethodResult> {
    const attrs = this.config.inputAttributesSchema.parse(input.attributes);
    const client = this.createClient(context);

    const command = new CreateResourceCommand({
      TypeName: this.typeName,
      DesiredState: JSON.stringify(attrs),
    });

    const response = await client.send(command);

    if (!response.ProgressEvent?.RequestToken) {
      throw new Error(
        `${this.typeName} creation failed: no request token returned`,
      );
    }

    const requestToken = response.ProgressEvent.RequestToken;

    const resource = ModelResource.create({
      id: input.id,
      attributes: {
        RequestToken: requestToken,
        OperationStatus: response.ProgressEvent.OperationStatus ||
          "IN_PROGRESS",
        StatusMessage:
          `${this.typeName} creation initiated via CloudControl API`,
        TypeName: this.typeName,
        EventTime: response.ProgressEvent.EventTime?.toISOString(),
        ResourceIdentifier: response.ProgressEvent.Identifier,
      },
    });

    const followUpActions: FollowUpAction[] = [
      {
        methodName: "sync",
        delayMs: 5000,
        maxRetries: 3,
      },
    ];

    return { resource, followUpActions };
  }

  /**
   * Executes the "delete" method using AWS CloudControl API.
   *
   * Terminates/deletes a resource using AWS CloudControl API.
   */
  async executeDelete(
    input: ModelInput,
    context: MethodContext,
  ): Promise<MethodResult> {
    if (!input.resourceId) {
      throw new Error("Cannot delete: no resource ID found in input");
    }

    if (!context.resourceRepository) {
      throw new Error(
        "Cannot delete: resourceRepository not provided in context",
      );
    }

    const existingResource = await context.resourceRepository.findById(
      this.modelType,
      createModelResourceId(input.id),
    );

    let awsResourceId = input.resourceId;
    if (existingResource) {
      const extractedId = this.extractResourceIdentifier(
        existingResource.attributes,
      );
      if (extractedId) {
        awsResourceId = extractedId;
      }
    }

    const client = this.createClient(context);

    const command = new DeleteResourceCommand({
      TypeName: this.typeName,
      Identifier: awsResourceId,
    });

    try {
      const response = await client.send(command);

      if (!response.ProgressEvent?.RequestToken) {
        throw new Error(
          `${this.typeName} deletion failed: no request token returned`,
        );
      }

      const requestToken = response.ProgressEvent.RequestToken;

      const resource = ModelResource.create({
        id: input.id,
        attributes: {
          RequestToken: requestToken,
          OperationStatus: response.ProgressEvent.OperationStatus ||
            "IN_PROGRESS",
          StatusMessage:
            `${this.typeName} deletion initiated via CloudControl API`,
          TypeName: this.typeName,
          ResourceIdentifier: awsResourceId,
          EventTime: response.ProgressEvent.EventTime?.toISOString(),
          DeletionInitiated: true,
        },
      });

      const followUpActions: FollowUpAction[] = [
        {
          methodName: "sync",
          delayMs: 5000,
          maxRetries: 3,
        },
      ];

      return { resource, followUpActions };
    } catch (error: unknown) {
      if (isResourceNotFoundError(error)) {
        const resource = ModelResource.create({
          id: input.id,
          attributes: {
            OperationStatus: "SUCCESS",
            StatusMessage:
              `${this.typeName} already deleted or does not exist in AWS`,
            DeletionCompleted: true,
          },
        });
        return { resource, deleteResource: true };
      }
      throw error;
    }
  }

  /**
   * Executes the "sync" method using AWS CloudControl API.
   *
   * Gets the full resource details after CloudControl operation completes.
   */
  async executeSync(
    input: ModelInput,
    context: MethodContext,
  ): Promise<MethodResult> {
    let requestToken = input.attributes.RequestToken as string | undefined;
    let resourceIdentifier = input.attributes.ResourceIdentifier as
      | string
      | undefined;

    if (!requestToken) {
      if (!context.resourceRepository) {
        const attrKeys = Object.keys(input.attributes);
        throw new Error(
          `${this.typeName} sync failed: no RequestToken in input attributes (found: ${
            attrKeys.join(", ") || "none"
          }) and no resourceRepository provided`,
        );
      }
      const existingResource = await context.resourceRepository.findById(
        this.modelType,
        createModelResourceId(input.id),
      );

      if (existingResource) {
        requestToken = existingResource.attributes.RequestToken as
          | string
          | undefined;
        resourceIdentifier = resourceIdentifier ||
          this.extractResourceIdentifier(existingResource.attributes);
      }
    }

    if (!requestToken) {
      const attrKeys = Object.keys(input.attributes);
      const attrSample = JSON.stringify(input.attributes).slice(0, 200);
      throw new Error(
        `${this.typeName} sync failed: no RequestToken found for input '${input.name}' (id: ${input.id}). ` +
          `Input attributes [${attrKeys.join(", ") || "none"}]: ${attrSample}`,
      );
    }

    const client = this.createClient(context);

    const statusCommand = new GetResourceRequestStatusCommand({
      RequestToken: requestToken,
    });

    let statusResponse;
    try {
      statusResponse = await client.send(statusCommand);
    } catch (error: unknown) {
      if (isResourceNotFoundError(error)) {
        return this.createDeletedResult(input.id);
      }
      throw error;
    }

    const currentStatus = statusResponse.ProgressEvent?.OperationStatus;
    const statusMessage = statusResponse.ProgressEvent?.StatusMessage || "";

    if (currentStatus === "IN_PROGRESS") {
      const resource = ModelResource.create({
        id: input.id,
        attributes: {
          RequestToken: requestToken,
          OperationStatus: currentStatus,
          StatusMessage: statusMessage,
          TypeName: this.typeName,
          ResourceIdentifier: statusResponse.ProgressEvent?.Identifier ||
            resourceIdentifier,
          EventTime: statusResponse.ProgressEvent?.EventTime?.toISOString(),
          DeletionInitiated: input.attributes.DeletionInitiated || undefined,
        },
      });

      const followUpActions: FollowUpAction[] = [
        {
          methodName: "sync",
          delayMs: 10000,
          maxRetries: 30,
        },
      ];

      return { resource, followUpActions };
    }

    if (currentStatus === "FAILED") {
      if (
        statusMessage.includes("was not found") ||
        statusMessage.includes("does not exist")
      ) {
        return this.createDeletedResult(input.id);
      }
      throw new Error(
        `CloudControl operation failed: ${statusMessage || "Unknown error"}`,
      );
    }

    const isDeletionContext = input.attributes.DeletionInitiated ||
      (input.attributes.StatusMessage as string)?.includes("deletion");

    if (isDeletionContext) {
      const resource = ModelResource.create({
        id: input.id,
        attributes: {
          OperationStatus: "SUCCESS",
          StatusMessage: `${this.typeName} successfully deleted`,
          DeletionCompleted: true,
        },
      });
      return { resource, deleteResource: true };
    }

    if (!resourceIdentifier) {
      resourceIdentifier = statusResponse.ProgressEvent?.Identifier || "";
    }

    if (!resourceIdentifier) {
      throw new Error(
        "Cannot get resource details: no ResourceIdentifier available",
      );
    }

    const getCommand = new GetResourceCommand({
      TypeName: this.typeName,
      Identifier: resourceIdentifier,
    });

    try {
      const response = await client.send(getCommand);

      if (!response.ResourceDescription?.Properties) {
        throw new Error(`Failed to get ${this.typeName} details`);
      }

      const rawProperties = JSON.parse(response.ResourceDescription.Properties);
      const mappedProperties = this.mapResourceProperties(rawProperties);

      const resource = ModelResource.create({
        id: input.id,
        attributes: {
          RequestToken: requestToken,
          OperationStatus: "SUCCESS",
          ...mappedProperties,
          RawProperties: rawProperties,
        },
      });

      return { resource };
    } catch (error: unknown) {
      if (isResourceNotFoundError(error)) {
        return this.createDeletedResult(input.id);
      }
      throw error;
    }
  }

  /**
   * Creates a ModelDefinition for this CloudControl model.
   * This provides the standard create, delete, and sync methods.
   */
  createModelDefinition(): ModelDefinition<TInputAttrs, TResourceAttrs> {
    const syncInputSchema = z.object({
      RequestToken: z.string().optional(),
      OperationStatus: z.string().optional(),
      StatusMessage: z.string().optional(),
      TypeName: z.string().optional(),
      EventTime: z.string().optional(),
      ResourceIdentifier: z.string().optional(),
      ErrorCode: z.string().optional(),
      DeletionInitiated: z.boolean().optional(),
    }).or(this.config.inputAttributesSchema);

    return {
      type: this.modelType,
      version: 1,
      inputAttributesSchema: this.config.inputAttributesSchema,
      resourceAttributesSchema: this.config.resourceAttributesSchema,
      methods: {
        create: {
          description:
            `Create a new ${this.typeName} using AWS CloudControl API`,
          inputAttributesSchema: this.config.inputAttributesSchema,
          execute: (input, context) => this.executeCreate(input, context),
        },
        delete: {
          description: `Delete a ${this.typeName} using AWS CloudControl API`,
          inputAttributesSchema: this.config.inputAttributesSchema,
          execute: (input, context) => this.executeDelete(input, context),
        },
        sync: {
          description:
            `Get full ${this.typeName} details after CloudControl operation completes`,
          inputAttributesSchema: syncInputSchema,
          execute: (input, context) => this.executeSync(input, context),
        },
      },
    };
  }
}
