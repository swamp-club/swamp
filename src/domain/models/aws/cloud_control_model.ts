import { z } from "zod";
import {
  CloudControlClient,
  CreateResourceCommand,
  DeleteResourceCommand,
  GetResourceCommand,
  GetResourceRequestStatusCommand,
} from "@aws-sdk/client-cloudcontrol";
import type { ModelType } from "../model_type.ts";
import {
  type DataHandle,
  defineModel,
  type FollowUpAction,
  type MethodContext,
  type MethodResult,
  type ModelDefinition,
} from "../model.ts";

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
   * Zod schema for validating arguments.
   */
  arguments: TInputAttrs;

  /**
   * Extracts the AWS resource identifier from existing data attributes.
   * Default implementation looks for common identifier fields.
   */
  extractResourceIdentifier?: (
    attributes: Record<string, unknown>,
  ) => string | undefined;

  /**
   * Maps the raw AWS properties to data attributes.
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
> {
  protected readonly config: CloudControlModelConfig<TInputAttrs>;

  constructor(config: CloudControlModelConfig<TInputAttrs>) {
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
  protected async createDeletedResult(
    _methodName: string,
    context: MethodContext,
  ): Promise<MethodResult> {
    const attributes = {
      OperationStatus: "SUCCESS",
      StatusMessage:
        `${this.typeName} has been deleted or does not exist in AWS`,
      DeletionCompleted: true,
    };

    const handle = await this.writeDataHandle(
      attributes,
      context,
    );

    return { dataHandles: [handle] };
  }

  /**
   * Writes attributes as a DataHandle via writeResource.
   */
  protected async writeDataHandle(
    attributes: Record<string, unknown>,
    context: MethodContext,
  ): Promise<DataHandle> {
    return await context.writeResource!("resource", "resource", attributes);
  }

  /**
   * Executes the "create" method using AWS CloudControl API.
   *
   * Provisions a new resource using AWS CloudControl API.
   */
  async executeCreate(
    args: z.infer<TInputAttrs>,
    context: MethodContext,
  ): Promise<MethodResult> {
    const client = this.createClient(context);

    const command = new CreateResourceCommand({
      TypeName: this.typeName,
      DesiredState: JSON.stringify(args),
    });

    const response = await client.send(command);

    if (!response.ProgressEvent?.RequestToken) {
      throw new Error(
        `${this.typeName} creation failed: no request token returned`,
      );
    }

    const requestToken = response.ProgressEvent.RequestToken;

    const attributes = {
      RequestToken: requestToken,
      OperationStatus: response.ProgressEvent.OperationStatus ||
        "IN_PROGRESS",
      StatusMessage: `${this.typeName} creation initiated via CloudControl API`,
      TypeName: this.typeName,
      EventTime: response.ProgressEvent.EventTime?.toISOString(),
      ResourceIdentifier: response.ProgressEvent.Identifier,
    };

    const handle = await this.writeDataHandle(
      attributes,
      context,
    );

    const followUpActions: FollowUpAction[] = [
      {
        methodName: "sync",
        delayMs: 5000,
        maxRetries: 3,
        continueCondition: (dataHandles: DataHandle[]) => {
          return dataHandles.length > 0;
        },
      },
    ];

    return { dataHandles: [handle], followUpActions };
  }

  /**
   * Executes the "delete" method using AWS CloudControl API.
   *
   * Terminates/deletes a resource using AWS CloudControl API.
   */
  async executeDelete(
    _args: z.infer<TInputAttrs>,
    context: MethodContext,
  ): Promise<MethodResult> {
    // Get existing data to find the AWS resource identifier
    const dataName = `${context.definition.name}-data`;
    const existingData = await context.dataRepository.findByName(
      context.modelType,
      context.modelId,
      dataName,
    );

    let awsResourceId: string | undefined;

    if (existingData) {
      const content = await context.dataRepository.getContent(
        context.modelType,
        context.modelId,
        dataName,
      );
      if (content) {
        try {
          const existingAttributes = JSON.parse(
            new TextDecoder().decode(content),
          );
          awsResourceId = this.extractResourceIdentifier(existingAttributes);
        } catch {
          // Ignore parse errors
        }
      }
    }

    if (!awsResourceId) {
      // No resource exists - nothing to delete
      return this.createDeletedResult("delete", context);
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

      const attributes = {
        RequestToken: requestToken,
        OperationStatus: response.ProgressEvent.OperationStatus ||
          "IN_PROGRESS",
        StatusMessage:
          `${this.typeName} deletion initiated via CloudControl API`,
        TypeName: this.typeName,
        ResourceIdentifier: awsResourceId,
        EventTime: response.ProgressEvent.EventTime?.toISOString(),
        DeletionInitiated: true,
      };

      const handle = await this.writeDataHandle(
        attributes,
        context,
      );

      const followUpActions: FollowUpAction[] = [
        {
          methodName: "sync",
          delayMs: 5000,
          maxRetries: 3,
          continueCondition: (dataHandles: DataHandle[]) => {
            return dataHandles.length > 0;
          },
        },
      ];

      return { dataHandles: [handle], followUpActions };
    } catch (error: unknown) {
      if (isResourceNotFoundError(error)) {
        return this.createDeletedResult("delete", context);
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
    args: Record<string, unknown>,
    context: MethodContext,
  ): Promise<MethodResult> {
    let requestToken = args.RequestToken as string | undefined;
    let resourceIdentifier = args.ResourceIdentifier as
      | string
      | undefined;
    let isDeletionContext = args.DeletionInitiated as
      | boolean
      | undefined;

    // Try to get existing data for this definition
    if (!requestToken) {
      const dataName = `${context.definition.name}-data`;
      const existingData = await context.dataRepository.findByName(
        context.modelType,
        context.modelId,
        dataName,
      );

      if (existingData) {
        const content = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          dataName,
        );
        if (content) {
          try {
            const existingAttributes = JSON.parse(
              new TextDecoder().decode(content),
            );
            requestToken = existingAttributes.RequestToken;
            resourceIdentifier = resourceIdentifier ||
              this.extractResourceIdentifier(existingAttributes);
            isDeletionContext = isDeletionContext ||
              existingAttributes.DeletionInitiated;
          } catch {
            // Ignore parse errors
          }
        }
      }
    }

    if (!requestToken) {
      const argKeys = Object.keys(args);
      const argSample = JSON.stringify(args).slice(0, 200);
      throw new Error(
        `${this.typeName} sync failed: no RequestToken found for definition '${context.definition.name}' (id: ${context.definition.id}). ` +
          `Arguments [${argKeys.join(", ") || "none"}]: ${argSample}`,
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
        return this.createDeletedResult("sync", context);
      }
      throw error;
    }

    const currentStatus = statusResponse.ProgressEvent?.OperationStatus;
    const statusMessage = statusResponse.ProgressEvent?.StatusMessage || "";

    if (currentStatus === "IN_PROGRESS") {
      const attributes = {
        RequestToken: requestToken,
        OperationStatus: currentStatus,
        StatusMessage: statusMessage,
        TypeName: this.typeName,
        ResourceIdentifier: statusResponse.ProgressEvent?.Identifier ||
          resourceIdentifier,
        EventTime: statusResponse.ProgressEvent?.EventTime?.toISOString(),
        DeletionInitiated: isDeletionContext || undefined,
      };

      const handle = await this.writeDataHandle(
        attributes,
        context,
      );

      const followUpActions: FollowUpAction[] = [
        {
          methodName: "sync",
          delayMs: 10000,
          maxRetries: 30,
          continueCondition: (dataHandles: DataHandle[]) => {
            return dataHandles.length > 0;
          },
        },
      ];

      return { dataHandles: [handle], followUpActions };
    }

    if (currentStatus === "FAILED") {
      if (
        statusMessage.includes("was not found") ||
        statusMessage.includes("does not exist")
      ) {
        return this.createDeletedResult("sync", context);
      }
      throw new Error(
        `CloudControl operation failed: ${statusMessage || "Unknown error"}`,
      );
    }

    if (isDeletionContext) {
      return this.createDeletedResult("sync", context);
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

      const attributes = {
        RequestToken: requestToken,
        OperationStatus: "SUCCESS",
        ...mappedProperties,
        RawProperties: rawProperties,
      };

      const handle = await this.writeDataHandle(
        attributes,
        context,
      );

      return { dataHandles: [handle] };
    } catch (error: unknown) {
      if (isResourceNotFoundError(error)) {
        return this.createDeletedResult("sync", context);
      }
      throw error;
    }
  }

  /**
   * Creates and registers a ModelDefinition for this CloudControl model.
   * This provides the standard create, delete, and sync methods.
   *
   * Call this at module level to self-register the model when imported.
   */
  defineAndRegister(): ModelDefinition {
    return defineModel(this.createModelDefinition());
  }

  /**
   * Creates a ModelDefinition for this CloudControl model.
   * This provides the standard create, delete, and sync methods.
   */
  createModelDefinition(): ModelDefinition {
    const syncArgumentsSchema = z.object({
      RequestToken: z.string().optional(),
      OperationStatus: z.string().optional(),
      StatusMessage: z.string().optional(),
      TypeName: z.string().optional(),
      EventTime: z.string().optional(),
      ResourceIdentifier: z.string().optional(),
      ErrorCode: z.string().optional(),
      DeletionInitiated: z.boolean().optional(),
    }).or(this.config.arguments);

    return {
      type: this.modelType,
      version: "2026.02.09.1",
      globalArguments: this.config.arguments,
      resources: {
        "resource": {
          description: `AWS ${this.typeName} resource data`,
          schema: z.record(z.string(), z.unknown()),
          lifetime: "infinite",
          garbageCollection: 10,
        },
      },
      methods: {
        create: {
          description:
            `Create a new ${this.typeName} using AWS CloudControl API`,
          arguments: this.config.arguments,
          execute: (args: z.infer<TInputAttrs>, context) =>
            this.executeCreate(args, context),
        },
        delete: {
          description: `Delete a ${this.typeName} using AWS CloudControl API`,
          arguments: this.config.arguments,
          execute: (args: z.infer<TInputAttrs>, context) =>
            this.executeDelete(args, context),
        },
        sync: {
          description:
            `Get full ${this.typeName} details after CloudControl operation completes`,
          arguments: syncArgumentsSchema,
          execute: (args: Record<string, unknown>, context) =>
            this.executeSync(args, context),
        },
      },
    };
  }
}
