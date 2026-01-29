import { z } from "zod";
import {
  CloudControlClient,
  CreateResourceCommand,
  DeleteResourceCommand,
  GetResourceCommand,
  GetResourceRequestStatusCommand,
} from "@aws-sdk/client-cloudcontrol";
import { ModelType } from "../../../model_type.ts";
import {
  createModelResourceId,
  ModelResource,
} from "../../../model_resource.ts";
import type {
  FollowUpAction,
  MethodContext,
  MethodResult,
  ModelDefinition,
} from "../../../model.ts";
import type { ModelInput } from "../../../model_input.ts";

/**
 * Schema for EC2 Instance block device mapping.
 */
export const BlockDeviceMappingSchema = z.object({
  DeviceName: z.string().optional(),
  Ebs: z.object({
    DeleteOnTermination: z.boolean().optional(),
    Encrypted: z.boolean().optional(),
    Iops: z.number().optional(),
    KmsKeyId: z.string().optional(),
    SnapshotId: z.string().optional(),
    Throughput: z.number().optional(),
    VolumeSize: z.number().optional(),
    VolumeType: z.enum(["standard", "io1", "io2", "gp2", "gp3", "sc1", "st1"])
      .optional(),
  }).optional(),
  NoDevice: z.string().optional(),
  VirtualName: z.string().optional(),
});

/**
 * Schema for EC2 Instance network interface specification.
 */
export const NetworkInterfaceSchema = z.object({
  AssociateCarrierIpAddress: z.boolean().optional(),
  AssociatePublicIpAddress: z.boolean().optional(),
  DeleteOnTermination: z.boolean().optional(),
  Description: z.string().optional(),
  DeviceIndex: z.number().optional(),
  GroupSet: z.array(z.string()).optional(),
  Ipv6AddressCount: z.number().optional(),
  Ipv6Addresses: z.array(z.object({
    Ipv6Address: z.string(),
  })).optional(),
  NetworkInterfaceId: z.string().optional(),
  PrivateIpAddress: z.string().optional(),
  PrivateIpAddresses: z.array(z.object({
    Primary: z.boolean().optional(),
    PrivateIpAddress: z.string(),
  })).optional(),
  SecondaryPrivateIpAddressCount: z.number().optional(),
  SubnetId: z.string().optional(),
});

/**
 * Schema for EC2 Instance CPU options.
 */
export const CpuOptionsSchema = z.object({
  CoreCount: z.number().optional(),
  ThreadsPerCore: z.number().optional(),
});

/**
 * Schema for EC2 Instance credit specification.
 */
export const CreditSpecificationSchema = z.object({
  CpuCredits: z.enum(["standard", "unlimited"]).optional(),
});

/**
 * Schema for EC2 Instance metadata options.
 */
export const MetadataOptionsSchema = z.object({
  HttpEndpoint: z.enum(["enabled", "disabled"]).optional(),
  HttpPutResponseHopLimit: z.number().optional(),
  HttpTokens: z.enum(["optional", "required"]).optional(),
  InstanceMetadataTags: z.enum(["enabled", "disabled"]).optional(),
});

/**
 * Schema for EC2 Instance launch template specification.
 */
export const LaunchTemplateSpecificationSchema = z.object({
  LaunchTemplateId: z.string().optional(),
  LaunchTemplateName: z.string().optional(),
  Version: z.string().optional(),
});

/**
 * Schema for EC2 Instance input attributes (1:1 mapping to CloudControl API).
 */
export const EC2InstanceInputAttributesSchema = z.object({
  AdditionalInfo: z.string().optional(),
  Affinity: z.enum(["default", "host"]).optional(),
  AvailabilityZone: z.string().optional(),
  BlockDeviceMappings: z.array(BlockDeviceMappingSchema).optional(),
  CpuOptions: CpuOptionsSchema.optional(),
  CreditSpecification: CreditSpecificationSchema.optional(),
  DisableApiTermination: z.boolean().optional(),
  EbsOptimized: z.boolean().optional(),
  EnclaveOptions: z.object({
    Enabled: z.boolean().optional(),
  }).optional(),
  HibernationOptions: z.object({
    Configured: z.boolean().optional(),
  }).optional(),
  HostId: z.string().optional(),
  HostResourceGroupArn: z.string().optional(),
  IamInstanceProfile: z.string().optional(),
  ImageId: z.string().optional(),
  InstanceInitiatedShutdownBehavior: z.enum(["stop", "terminate"]).optional(),
  InstanceType: z.string().optional(),
  Ipv6AddressCount: z.number().optional(),
  Ipv6Addresses: z.array(z.object({
    Ipv6Address: z.string(),
  })).optional(),
  KernelId: z.string().optional(),
  KeyName: z.string().optional(),
  LaunchTemplate: LaunchTemplateSpecificationSchema.optional(),
  MetadataOptions: MetadataOptionsSchema.optional(),
  Monitoring: z.boolean().optional(),
  NetworkInterfaces: z.array(NetworkInterfaceSchema).optional(),
  PlacementGroupName: z.string().optional(),
  PrivateIpAddress: z.string().optional(),
  PropagateTagsToVolumeOnCreation: z.boolean().optional(),
  RamdiskId: z.string().optional(),
  SecurityGroupIds: z.array(z.string()).optional(),
  SecurityGroups: z.array(z.string()).optional(),
  SourceDestCheck: z.boolean().optional(),
  SsrSpecification: z.object({
    Enabled: z.boolean().optional(),
  }).optional(),
  SubnetId: z.string().optional(),
  Tags: z.array(z.object({
    Key: z.string(),
    Value: z.string(),
  })).optional(),
  Tenancy: z.enum(["default", "dedicated", "host"]).optional(),
  UserData: z.string().optional(),
});

/**
 * Type for EC2 Instance input attributes.
 */
export type EC2InstanceInputAttributes = z.infer<
  typeof EC2InstanceInputAttributesSchema
>;

/**
 * Schema for EC2 Instance resource attributes (what gets returned from AWS).
 */
export const EC2InstanceResourceAttributesSchema = z.object({
  InstanceId: z.string(),
  AvailabilityZone: z.string().optional(),
  PrivateDnsName: z.string().optional(),
  PrivateIpAddress: z.string().optional(),
  PublicDnsName: z.string().optional(),
  PublicIpAddress: z.string().optional(),
  State: z.object({
    Code: z.number().optional(),
    Name: z.string().optional(),
  }).optional(),
  StateTransitionReason: z.string().optional(),
  VpcId: z.string().optional(),
  SecurityGroups: z.array(z.object({
    GroupId: z.string(),
    GroupName: z.string(),
  })).optional(),
  LaunchTime: z.string().optional(),
  ImageId: z.string().optional(),
  InstanceType: z.string().optional(),
  KeyName: z.string().optional(),
  Monitoring: z.object({
    State: z.string().optional(),
  }).optional(),
  Placement: z.object({
    AvailabilityZone: z.string().optional(),
    GroupName: z.string().optional(),
    HostId: z.string().optional(),
    Tenancy: z.string().optional(),
  }).optional(),
  Platform: z.string().optional(),
  SubnetId: z.string().optional(),
  Tags: z.array(z.object({
    Key: z.string(),
    Value: z.string(),
  })).optional(),
});

/**
 * Type for EC2 Instance resource attributes.
 */
export type EC2InstanceResourceAttributes = z.infer<
  typeof EC2InstanceResourceAttributesSchema
>;

/**
 * The EC2 Instance model type identifier.
 */
export const EC2_INSTANCE_MODEL_TYPE = ModelType.create("AWS::EC2::Instance");

/**
 * Creates an AWS CloudControl API client.
 */
export function createCloudControlClient(): CloudControlClient {
  return new CloudControlClient({
    region: Deno.env.get("AWS_REGION") || "us-east-1",
  });
}

/**
 * Executes the "create" method for the EC2 Instance model.
 *
 * Provisions a new EC2 instance using AWS CloudControl API.
 */
async function executeCreate(
  input: ModelInput,
  context: MethodContext,
): Promise<MethodResult> {
  const attrs = EC2InstanceInputAttributesSchema.parse(input.attributes);
  const client = context.cloudControlClientFactory
    ? context.cloudControlClientFactory()
    : createCloudControlClient();

  const command = new CreateResourceCommand({
    TypeName: "AWS::EC2::Instance",
    DesiredState: JSON.stringify(attrs),
  });

  const response = await client.send(command);

  if (!response.ProgressEvent?.RequestToken) {
    throw new Error("EC2 instance creation failed: no request token returned");
  }

  // CloudControl API is asynchronous, so we get a RequestToken to track progress
  const requestToken = response.ProgressEvent.RequestToken;

  // Create initial resource with request token
  const resource = ModelResource.create({
    id: input.id,
    attributes: {
      RequestToken: requestToken,
      OperationStatus: response.ProgressEvent.OperationStatus || "IN_PROGRESS",
      StatusMessage: "EC2 instance creation initiated via CloudControl API",
      TypeName: "AWS::EC2::Instance",
      EventTime: response.ProgressEvent.EventTime?.toISOString(),
      ResourceIdentifier: response.ProgressEvent.Identifier, // Add the ResourceIdentifier from create response
    },
  });

  // Set up follow-up actions to immediately call sync, which will handle all polling
  const followUpActions: FollowUpAction[] = [
    {
      methodName: "sync",
      delayMs: 5000, // Wait 5 seconds before first sync call
      maxRetries: 3, // Allow a few retries for the initial sync call
      // Always call sync after create - sync will handle checking status and polling
    },
  ];

  return { resource, followUpActions };
}

/**
 * Checks if an error indicates the resource was not found.
 */
function isResourceNotFoundError(error: unknown): boolean {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorName = error instanceof Error ? error.name : "";

  return (
    errorMessage.includes("was not found") ||
    errorMessage.includes("does not exist") ||
    errorName === "ResourceNotFoundException"
  );
}

/**
 * Executes the "delete" method for the EC2 Instance model.
 *
 * Terminates an EC2 instance using AWS CloudControl API.
 */
async function executeDelete(
  input: ModelInput,
  context: MethodContext,
): Promise<MethodResult> {
  if (!input.resourceId) {
    throw new Error("Cannot delete: no resource ID found in input");
  }

  // Load existing resource to get the actual AWS instance ID
  if (!context.resourceRepository) {
    throw new Error(
      "Cannot delete: resourceRepository not provided in context",
    );
  }
  const existingResource = await context.resourceRepository.findById(
    EC2_INSTANCE_MODEL_TYPE,
    createModelResourceId(input.id),
  );

  let awsInstanceId = input.resourceId; // fallback
  if (existingResource && existingResource.attributes.InstanceId) {
    awsInstanceId = existingResource.attributes.InstanceId as string;
  }

  const client = context.cloudControlClientFactory
    ? context.cloudControlClientFactory()
    : createCloudControlClient();

  const command = new DeleteResourceCommand({
    TypeName: "AWS::EC2::Instance",
    Identifier: awsInstanceId,
  });

  try {
    const response = await client.send(command);

    if (!response.ProgressEvent?.RequestToken) {
      throw new Error(
        "EC2 instance deletion failed: no request token returned",
      );
    }

    // CloudControl API is asynchronous, so we get a RequestToken to track progress
    const requestToken = response.ProgressEvent.RequestToken;

    // Create initial resource with request token
    const resource = ModelResource.create({
      id: input.id,
      attributes: {
        RequestToken: requestToken,
        OperationStatus: response.ProgressEvent.OperationStatus ||
          "IN_PROGRESS",
        StatusMessage: "EC2 instance deletion initiated via CloudControl API",
        TypeName: "AWS::EC2::Instance",
        ResourceIdentifier: awsInstanceId, // The AWS instance being deleted
        EventTime: response.ProgressEvent.EventTime?.toISOString(),
        DeletionInitiated: true,
      },
    });

    // Set up follow-up actions to poll deletion status until complete
    const followUpActions: FollowUpAction[] = [
      {
        methodName: "sync",
        delayMs: 5000, // Wait 5 seconds before first sync call
        maxRetries: 3, // Allow a few retries for the initial sync call
        // Always call sync after delete - sync will handle checking status and polling
      },
    ];

    return { resource, followUpActions };
  } catch (error: unknown) {
    // If the resource is already gone, treat as successful deletion
    if (isResourceNotFoundError(error)) {
      const resource = ModelResource.create({
        id: input.id,
        attributes: {
          OperationStatus: "SUCCESS",
          StatusMessage:
            "EC2 instance already deleted or does not exist in AWS",
          DeletionCompleted: true,
        },
      });
      return { resource, deleteResource: true };
    }
    throw error;
  }
}

/**
 * Executes the "sync" method for the EC2 Instance model.
 *
 * Gets the full EC2 instance details after CloudControl operation completes.
 */
async function executeSync(
  input: ModelInput,
  context: MethodContext,
): Promise<MethodResult> {
  // Get RequestToken from input attributes to check status first
  let requestToken = input.attributes.RequestToken as string;
  let resourceIdentifier = input.attributes.ResourceIdentifier as string;

  // If not found, load from the existing resource (for standalone sync calls)
  if (!requestToken || !resourceIdentifier) {
    if (!context.resourceRepository) {
      throw new Error(
        "EC2 instance sync failed: resourceRepository not provided in context",
      );
    }
    const existingResource = await context.resourceRepository.findById(
      EC2_INSTANCE_MODEL_TYPE,
      createModelResourceId(input.id),
    );

    if (existingResource) {
      requestToken = existingResource.attributes.RequestToken as string;
      resourceIdentifier = existingResource.attributes
        .ResourceIdentifier as string;
    }
  }

  if (!requestToken) {
    throw new Error(
      "EC2 instance sync failed: no RequestToken found to check operation status",
    );
  }

  const client = context.cloudControlClientFactory
    ? context.cloudControlClientFactory()
    : createCloudControlClient();

  // Helper to create a "resource deleted" result
  const createDeletedResult = (): MethodResult => {
    const resource = ModelResource.create({
      id: input.id,
      attributes: {
        OperationStatus: "SUCCESS",
        StatusMessage: "EC2 instance has been deleted or does not exist in AWS",
        DeletionCompleted: true,
      },
    });
    return { resource, deleteResource: true };
  };

  // Always check the CloudControl operation status first
  const statusCommand = new GetResourceRequestStatusCommand({
    RequestToken: requestToken,
  });

  let statusResponse;
  try {
    statusResponse = await client.send(statusCommand);
  } catch (error: unknown) {
    // If status check fails with "not found", the resource is deleted
    if (isResourceNotFoundError(error)) {
      return createDeletedResult();
    }
    throw error;
  }

  const currentStatus = statusResponse.ProgressEvent?.OperationStatus;
  const statusMessage = statusResponse.ProgressEvent?.StatusMessage || "";

  // If still in progress, return current state with follow-up action to retry sync
  if (currentStatus === "IN_PROGRESS") {
    const resource = ModelResource.create({
      id: input.id,
      attributes: {
        RequestToken: requestToken,
        OperationStatus: currentStatus,
        StatusMessage: statusMessage,
        TypeName: "AWS::EC2::Instance",
        ResourceIdentifier: statusResponse.ProgressEvent?.Identifier ||
          resourceIdentifier,
        EventTime: statusResponse.ProgressEvent?.EventTime?.toISOString(),
        // Preserve deletion context if it exists
        DeletionInitiated: input.attributes.DeletionInitiated || undefined,
      },
    });

    // Recursively call sync again after a delay
    const followUpActions: FollowUpAction[] = [
      {
        methodName: "sync",
        delayMs: 10000, // Wait 10 seconds before retrying
        maxRetries: 30, // Allow up to 30 retries (5 minutes total)
      },
    ];

    return { resource, followUpActions };
  }

  // If operation failed, check if it's a "not found" error (resource deleted)
  if (currentStatus === "FAILED") {
    if (
      statusMessage.includes("was not found") ||
      statusMessage.includes("does not exist")
    ) {
      return createDeletedResult();
    }
    throw new Error(
      `CloudControl operation failed: ${statusMessage || "Unknown error"}`,
    );
  }

  // Operation is SUCCESS - check if this is a deletion operation first
  const isDeletionContext = input.attributes.DeletionInitiated ||
    (input.attributes.StatusMessage as string)?.includes("deletion");

  if (isDeletionContext) {
    // For deletion operations, we should delete the resource file regardless of GetResource response
    const resource = ModelResource.create({
      id: input.id,
      attributes: {
        OperationStatus: "SUCCESS",
        StatusMessage: "EC2 instance successfully deleted",
        DeletionCompleted: true,
      },
    });
    return { resource, deleteResource: true };
  }

  // For non-deletion operations, get the full resource details
  if (!resourceIdentifier) {
    resourceIdentifier = statusResponse.ProgressEvent?.Identifier || "";
  }

  if (!resourceIdentifier) {
    throw new Error(
      "Cannot get instance details: no ResourceIdentifier available",
    );
  }

  const getCommand = new GetResourceCommand({
    TypeName: "AWS::EC2::Instance",
    Identifier: resourceIdentifier,
  });

  try {
    const response = await client.send(getCommand);

    if (!response.ResourceDescription?.Properties) {
      throw new Error("Failed to get EC2 instance details");
    }

    const instanceProperties = JSON.parse(
      response.ResourceDescription.Properties,
    );

    const resource = ModelResource.create({
      id: input.id,
      attributes: {
        // Keep the original tracking info
        RequestToken: requestToken,
        OperationStatus: "SUCCESS",

        // Add the full EC2 instance details
        InstanceId: instanceProperties.InstanceId,
        InstanceType: instanceProperties.InstanceType,
        ImageId: instanceProperties.ImageId,
        KeyName: instanceProperties.KeyName,
        State: instanceProperties.State,
        PublicIpAddress: instanceProperties.PublicIpAddress,
        PrivateIpAddress: instanceProperties.PrivateIpAddress,
        PublicDnsName: instanceProperties.PublicDnsName,
        PrivateDnsName: instanceProperties.PrivateDnsName,
        AvailabilityZone: instanceProperties.Placement?.AvailabilityZone,
        VpcId: instanceProperties.VpcId,
        SubnetId: instanceProperties.SubnetId,
        SecurityGroups: instanceProperties.SecurityGroups,
        Tags: instanceProperties.Tags,
        LaunchTime: instanceProperties.LaunchTime,

        // Store the raw properties for reference
        RawProperties: instanceProperties,
      },
    });

    return { resource };
  } catch (error: unknown) {
    // If resource not found, treat as deleted
    if (isResourceNotFoundError(error)) {
      return createDeletedResult();
    }
    throw error;
  }
}

/**
 * The EC2 Instance model definition.
 *
 * Provides CRUD operations for AWS EC2 instances using CloudControl API.
 */
export const ec2InstanceModel: ModelDefinition<
  typeof EC2InstanceInputAttributesSchema,
  typeof EC2InstanceResourceAttributesSchema
> = {
  type: EC2_INSTANCE_MODEL_TYPE,
  version: 1,
  inputAttributesSchema: EC2InstanceInputAttributesSchema,
  resourceAttributesSchema: EC2InstanceResourceAttributesSchema,
  methods: {
    create: {
      description: "Create a new EC2 instance using AWS CloudControl API",
      inputAttributesSchema: EC2InstanceInputAttributesSchema,
      execute: executeCreate,
    },
    delete: {
      description: "Terminate an EC2 instance using AWS CloudControl API",
      inputAttributesSchema: EC2InstanceInputAttributesSchema,
      execute: executeDelete,
    },
    sync: {
      description:
        "Get full EC2 instance details after CloudControl operation completes",
      inputAttributesSchema: z.object({
        RequestToken: z.string().optional(),
        OperationStatus: z.string().optional(),
        StatusMessage: z.string().optional(),
        TypeName: z.string().optional(),
        EventTime: z.string().optional(),
        ResourceIdentifier: z.string().optional(),
        ErrorCode: z.string().optional(),
      }).or(EC2InstanceInputAttributesSchema),
      execute: executeSync,
    },
  },
};
