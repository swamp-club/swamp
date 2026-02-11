// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import { z } from "zod";
import { ModelType } from "../../../model_type.ts";
import type { ModelDefinition } from "../../../model.ts";
import { AWSCloudControlModel } from "../../cloud_control_model.ts";

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
 * EC2 Instance model implementation using AWS CloudControl base class.
 */
class EC2InstanceModel extends AWSCloudControlModel<
  typeof EC2InstanceInputAttributesSchema
> {
  constructor() {
    super({
      typeName: "AWS::EC2::Instance",
      modelType: EC2_INSTANCE_MODEL_TYPE,
      arguments: EC2InstanceInputAttributesSchema,
      extractResourceIdentifier: (attributes) => {
        return (attributes.InstanceId as string | undefined) ||
          (attributes.ResourceIdentifier as string | undefined);
      },
      mapResourceProperties: (rawProperties) => ({
        InstanceId: rawProperties.InstanceId,
        InstanceType: rawProperties.InstanceType,
        ImageId: rawProperties.ImageId,
        KeyName: rawProperties.KeyName,
        State: rawProperties.State,
        PublicIpAddress: rawProperties.PublicIpAddress,
        PrivateIpAddress: rawProperties.PrivateIpAddress,
        PublicDnsName: rawProperties.PublicDnsName,
        PrivateDnsName: rawProperties.PrivateDnsName,
        AvailabilityZone: (rawProperties.Placement as Record<string, unknown>)
          ?.AvailabilityZone,
        VpcId: rawProperties.VpcId,
        SubnetId: rawProperties.SubnetId,
        SecurityGroups: rawProperties.SecurityGroups,
        Tags: rawProperties.Tags,
        LaunchTime: rawProperties.LaunchTime,
      }),
    });
  }
}

/**
 * The EC2 Instance model instance.
 */
const ec2InstanceModelInstance = new EC2InstanceModel();

/**
 * The EC2 Instance model definition.
 *
 * Provides CRUD operations for AWS EC2 instances using CloudControl API.
 *
 * Self-registers with the global model registry when this module is imported.
 */
export const ec2InstanceModel: ModelDefinition = ec2InstanceModelInstance
  .defineAndRegister();

/**
 * Re-export createCloudControlClient for backward compatibility.
 */
export { createCloudControlClient } from "../../cloud_control_model.ts";
