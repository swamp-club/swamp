import { z } from "zod";
import {
  CloudControlClient,
  CreateResourceCommand,
  DeleteResourceCommand,
  GetResourceCommand,
  UpdateResourceCommand,
} from "@aws-sdk/client-cloudcontrol";
import { ModelType } from "../../../model_type.ts";
import { ModelResource } from "../../../model_resource.ts";
import type {
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
  _context: MethodContext,
): Promise<MethodResult> {
  const attrs = EC2InstanceInputAttributesSchema.parse(input.attributes);
  const client = createCloudControlClient();

  const command = new CreateResourceCommand({
    TypeName: "AWS::EC2::Instance",
    DesiredState: JSON.stringify(attrs),
  });

  const response = await client.send(command);

  if (!response.ProgressEvent?.Identifier) {
    throw new Error("Failed to create EC2 instance: no identifier returned");
  }

  // Get the created resource to get full details
  const getCommand = new GetResourceCommand({
    TypeName: "AWS::EC2::Instance",
    Identifier: response.ProgressEvent.Identifier,
  });

  const getResponse = await client.send(getCommand);
  const resourceProperties = getResponse.ResourceDescription?.Properties
    ? JSON.parse(getResponse.ResourceDescription.Properties)
    : {};

  const resource = ModelResource.create({
    inputId: input.id,
    attributes: {
      InstanceId: response.ProgressEvent.Identifier,
      ...resourceProperties,
    },
  });

  return { resource };
}

/**
 * Executes the "update" method for the EC2 Instance model.
 *
 * Updates mutable properties of an existing EC2 instance.
 */
async function executeUpdate(
  input: ModelInput,
  _context: MethodContext,
): Promise<MethodResult> {
  const attrs = EC2InstanceInputAttributesSchema.parse(input.attributes);

  if (!input.resourceId) {
    throw new Error("Cannot update: no resource ID found in input");
  }

  const client = createCloudControlClient();

  const command = new UpdateResourceCommand({
    TypeName: "AWS::EC2::Instance",
    Identifier: input.resourceId,
    PatchDocument: JSON.stringify([
      {
        op: "replace",
        path: "/",
        value: attrs,
      },
    ]),
  });

  const response = await client.send(command);

  if (!response.ProgressEvent?.Identifier) {
    throw new Error("Failed to update EC2 instance");
  }

  // Get the updated resource
  const getCommand = new GetResourceCommand({
    TypeName: "AWS::EC2::Instance",
    Identifier: response.ProgressEvent.Identifier,
  });

  const getResponse = await client.send(getCommand);
  const resourceProperties = getResponse.ResourceDescription?.Properties
    ? JSON.parse(getResponse.ResourceDescription.Properties)
    : {};

  const resource = ModelResource.create({
    inputId: input.id,
    attributes: {
      InstanceId: response.ProgressEvent.Identifier,
      ...resourceProperties,
    },
  });

  return { resource };
}

/**
 * Executes the "delete" method for the EC2 Instance model.
 *
 * Terminates an EC2 instance using AWS CloudControl API.
 */
async function executeDelete(
  input: ModelInput,
  _context: MethodContext,
): Promise<MethodResult> {
  if (!input.resourceId) {
    throw new Error("Cannot delete: no resource ID found in input");
  }

  const client = createCloudControlClient();

  const command = new DeleteResourceCommand({
    TypeName: "AWS::EC2::Instance",
    Identifier: input.resourceId,
  });

  const response = await client.send(command);

  const resource = ModelResource.create({
    inputId: input.id,
    attributes: {
      InstanceId: input.resourceId,
      State: {
        Name: "shutting-down",
      },
      DeletionInitiated: true,
      ProgressEventId: response.ProgressEvent?.RequestToken,
    },
  });

  return { resource };
}

/**
 * Executes the "reconcile" method for the EC2 Instance model.
 *
 * Compares actual AWS state with desired state and corrects any drift.
 */
async function executeReconcile(
  input: ModelInput,
  context: MethodContext,
): Promise<MethodResult> {
  if (!input.resourceId) {
    throw new Error("Cannot reconcile: no resource ID found in input");
  }

  const client = createCloudControlClient();

  // Get current state from AWS
  const getCommand = new GetResourceCommand({
    TypeName: "AWS::EC2::Instance",
    Identifier: input.resourceId,
  });

  const getResponse = await client.send(getCommand);
  const currentState = getResponse.ResourceDescription?.Properties
    ? JSON.parse(getResponse.ResourceDescription.Properties)
    : {};

  // Compare with desired state
  const desiredAttrs = EC2InstanceInputAttributesSchema.parse(input.attributes);

  // Check if update is needed (simplified drift detection)
  const needsUpdate = Object.keys(desiredAttrs).some((key) => {
    const desired = desiredAttrs[key as keyof EC2InstanceInputAttributes];
    const current = currentState[key];
    return desired !== undefined &&
      JSON.stringify(desired) !== JSON.stringify(current);
  });

  if (needsUpdate) {
    // Perform update to correct drift
    return executeUpdate(input, context);
  }

  // No drift detected, return current state
  const resource = ModelResource.create({
    inputId: input.id,
    attributes: {
      InstanceId: input.resourceId,
      ...currentState,
      ReconciliationStatus: "in-sync",
    },
  });

  return { resource };
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
    update: {
      description: "Update an existing EC2 instance's mutable properties",
      inputAttributesSchema: EC2InstanceInputAttributesSchema,
      execute: executeUpdate,
    },
    delete: {
      description: "Terminate an EC2 instance using AWS CloudControl API",
      inputAttributesSchema: EC2InstanceInputAttributesSchema,
      execute: executeDelete,
    },
    reconcile: {
      description:
        "Compare actual vs desired state and correct any configuration drift",
      inputAttributesSchema: EC2InstanceInputAttributesSchema,
      execute: executeReconcile,
    },
  },
};
