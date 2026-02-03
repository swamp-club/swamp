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
  type DataOutput,
  defineModel,
  type FollowUpAction,
  type MethodContext,
  type MethodResult,
  type ModelDefinition,
} from "../model.ts";
import type { Definition } from "../../definitions/definition.ts";

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
   * Zod schema for validating input attributes.
   */
  inputAttributesSchema: TInputAttrs;

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
    definition: Definition,
    methodName: string,
  ): Promise<MethodResult> {
    const attributes = {
      OperationStatus: "SUCCESS",
      StatusMessage:
        `${this.typeName} has been deleted or does not exist in AWS`,
      DeletionCompleted: true,
    };

    const definitionHash = await definition.computeHash();

    return {
      dataOutputs: [{
        name: `${definition.name}-data`,
        content: new TextEncoder().encode(JSON.stringify(attributes)),
        metadata: {
          contentType: "application/json",
          lifetime: "infinite",
          garbageCollection: 10,
          streaming: false,
          tags: { type: "resource" },
          ownerDefinition: {
            definitionHash,
            ownerType: "model-method",
            ownerRef: methodName,
          },
        },
      }],
    };
  }

  /**
   * Creates a DataOutput from attributes.
   */
  protected async createDataOutput(
    definition: Definition,
    methodName: string,
    attributes: Record<string, unknown>,
  ): Promise<DataOutput> {
    const definitionHash = await definition.computeHash();

    return {
      name: `${definition.name}-data`,
      content: new TextEncoder().encode(JSON.stringify(attributes)),
      metadata: {
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        streaming: false,
        tags: { type: "resource" },
        ownerDefinition: {
          definitionHash,
          ownerType: "model-method",
          ownerRef: methodName,
        },
      },
    };
  }

  /**
   * Executes the "create" method using AWS CloudControl API.
   *
   * Provisions a new resource using AWS CloudControl API.
   */
  async executeCreate(
    definition: Definition,
    context: MethodContext,
  ): Promise<MethodResult> {
    const attrs = this.config.inputAttributesSchema.parse(
      definition.attributes,
    );
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

    const attributes = {
      RequestToken: requestToken,
      OperationStatus: response.ProgressEvent.OperationStatus ||
        "IN_PROGRESS",
      StatusMessage: `${this.typeName} creation initiated via CloudControl API`,
      TypeName: this.typeName,
      EventTime: response.ProgressEvent.EventTime?.toISOString(),
      ResourceIdentifier: response.ProgressEvent.Identifier,
    };

    const dataOutput = await this.createDataOutput(
      definition,
      "create",
      attributes,
    );

    const followUpActions: FollowUpAction[] = [
      {
        methodName: "sync",
        delayMs: 5000,
        maxRetries: 3,
        continueCondition: (dataOutputs: DataOutput[]) => {
          // Continue if we have data outputs
          return dataOutputs.length > 0;
        },
      },
    ];

    return { dataOutputs: [dataOutput], followUpActions };
  }

  /**
   * Executes the "delete" method using AWS CloudControl API.
   *
   * Terminates/deletes a resource using AWS CloudControl API.
   */
  async executeDelete(
    definition: Definition,
    context: MethodContext,
  ): Promise<MethodResult> {
    // Get existing data to find the AWS resource identifier
    const dataName = `${definition.name}-data`;
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
      return this.createDeletedResult(definition, "delete");
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

      const dataOutput = await this.createDataOutput(
        definition,
        "delete",
        attributes,
      );

      const followUpActions: FollowUpAction[] = [
        {
          methodName: "sync",
          delayMs: 5000,
          maxRetries: 3,
          continueCondition: (dataOutputs: DataOutput[]) => {
            return dataOutputs.length > 0;
          },
        },
      ];

      return { dataOutputs: [dataOutput], followUpActions };
    } catch (error: unknown) {
      if (isResourceNotFoundError(error)) {
        return this.createDeletedResult(definition, "delete");
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
    definition: Definition,
    context: MethodContext,
  ): Promise<MethodResult> {
    let requestToken = definition.attributes.RequestToken as string | undefined;
    let resourceIdentifier = definition.attributes.ResourceIdentifier as
      | string
      | undefined;
    let isDeletionContext = definition.attributes.DeletionInitiated as
      | boolean
      | undefined;

    // Try to get existing data for this definition
    if (!requestToken) {
      const dataName = `${definition.name}-data`;
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
      const attrKeys = Object.keys(definition.attributes);
      const attrSample = JSON.stringify(definition.attributes).slice(0, 200);
      throw new Error(
        `${this.typeName} sync failed: no RequestToken found for definition '${definition.name}' (id: ${definition.id}). ` +
          `Definition attributes [${
            attrKeys.join(", ") || "none"
          }]: ${attrSample}`,
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
        return this.createDeletedResult(definition, "sync");
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

      const dataOutput = await this.createDataOutput(
        definition,
        "sync",
        attributes,
      );

      const followUpActions: FollowUpAction[] = [
        {
          methodName: "sync",
          delayMs: 10000,
          maxRetries: 30,
          continueCondition: (dataOutputs: DataOutput[]) => {
            return dataOutputs.length > 0;
          },
        },
      ];

      return { dataOutputs: [dataOutput], followUpActions };
    }

    if (currentStatus === "FAILED") {
      if (
        statusMessage.includes("was not found") ||
        statusMessage.includes("does not exist")
      ) {
        return this.createDeletedResult(definition, "sync");
      }
      throw new Error(
        `CloudControl operation failed: ${statusMessage || "Unknown error"}`,
      );
    }

    if (isDeletionContext) {
      return this.createDeletedResult(definition, "sync");
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

      const dataOutput = await this.createDataOutput(
        definition,
        "sync",
        attributes,
      );

      return { dataOutputs: [dataOutput] };
    } catch (error: unknown) {
      if (isResourceNotFoundError(error)) {
        return this.createDeletedResult(definition, "sync");
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
  defineAndRegister(): ModelDefinition<TInputAttrs> {
    return defineModel(this.createModelDefinition());
  }

  /**
   * Creates a ModelDefinition for this CloudControl model.
   * This provides the standard create, delete, and sync methods.
   */
  createModelDefinition(): ModelDefinition<TInputAttrs> {
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
      methods: {
        create: {
          description:
            `Create a new ${this.typeName} using AWS CloudControl API`,
          inputAttributesSchema: this.config.inputAttributesSchema,
          execute: (definition, context) =>
            this.executeCreate(definition, context),
        },
        delete: {
          description: `Delete a ${this.typeName} using AWS CloudControl API`,
          inputAttributesSchema: this.config.inputAttributesSchema,
          execute: (definition, context) =>
            this.executeDelete(definition, context),
        },
        sync: {
          description:
            `Get full ${this.typeName} details after CloudControl operation completes`,
          inputAttributesSchema: syncInputSchema,
          execute: (definition, context) =>
            this.executeSync(definition, context),
        },
      },
    };
  }
}
