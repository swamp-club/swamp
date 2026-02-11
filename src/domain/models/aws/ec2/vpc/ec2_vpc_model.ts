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
 * Schema for EC2 VPC input attributes (1:1 mapping to CloudControl API).
 *
 * Based on AWS CloudFormation AWS::EC2::VPC resource type.
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-ec2-vpc.html
 */
export const EC2VpcInputAttributesSchema = z.object({
  /**
   * The IPv4 network range for the VPC, in CIDR notation.
   * For example, 10.0.0.0/16. Must specify either CidrBlock or Ipv4IpamPoolId.
   */
  CidrBlock: z.string().optional(),

  /**
   * Indicates whether the instances launched in the VPC get DNS hostnames.
   * If enabled, instances in the VPC get DNS hostnames; otherwise, they do not.
   * Disabled by default for nondefault VPCs.
   */
  EnableDnsHostnames: z.boolean().optional(),

  /**
   * Indicates whether the DNS resolution is supported for the VPC.
   * If enabled, queries to the Amazon provided DNS server at the
   * 169.254.169.253 IP address, or the reserved IP address at the base
   * of the VPC network range "plus two" succeed.
   * If disabled, the Amazon provided DNS service in the VPC that resolves
   * public DNS hostnames to IP addresses is not enabled.
   * Enabled by default.
   */
  EnableDnsSupport: z.boolean().optional(),

  /**
   * The allowed tenancy of instances launched into the VPC.
   * - "default": An instance launched into the VPC runs on shared hardware
   *   by default, unless you explicitly specify a different tenancy during
   *   instance launch.
   * - "dedicated": An instance launched into the VPC runs on dedicated
   *   hardware by default, unless you explicitly specify a tenancy of host
   *   during instance launch.
   * - "host": An instance launched into the VPC runs on a dedicated host
   *   by default.
   */
  InstanceTenancy: z.enum(["default", "dedicated", "host"]).optional(),

  /**
   * The ID of an IPv4 IPAM pool you want to use for allocating this VPC's CIDR.
   * Must specify either CidrBlock or Ipv4IpamPoolId.
   */
  Ipv4IpamPoolId: z.string().optional(),

  /**
   * The netmask length of the IPv4 CIDR you want to allocate to this VPC
   * from an Amazon VPC IP Address Manager (IPAM) pool.
   */
  Ipv4NetmaskLength: z.number().optional(),

  /**
   * The tags for the VPC.
   */
  Tags: z.array(z.object({
    Key: z.string(),
    Value: z.string(),
  })).optional(),
});

/**
 * Type for EC2 VPC input attributes.
 */
export type EC2VpcInputAttributes = z.infer<typeof EC2VpcInputAttributesSchema>;

/**
 * Schema for EC2 VPC resource attributes (what gets returned from AWS).
 */
export const EC2VpcResourceAttributesSchema = z.object({
  /**
   * The ID of the VPC.
   */
  VpcId: z.string(),

  /**
   * The primary IPv4 CIDR block for the VPC.
   */
  CidrBlock: z.string().optional(),

  /**
   * The association IDs of the IPv4 CIDR blocks for the VPC.
   */
  CidrBlockAssociations: z.array(z.string()).optional(),

  /**
   * The ID of the default network ACL for the VPC.
   */
  DefaultNetworkAcl: z.string().optional(),

  /**
   * The ID of the default security group for the VPC.
   */
  DefaultSecurityGroup: z.string().optional(),

  /**
   * The IPv6 CIDR blocks for the VPC.
   */
  Ipv6CidrBlocks: z.array(z.string()).optional(),

  /**
   * Whether DNS hostnames are enabled.
   */
  EnableDnsHostnames: z.boolean().optional(),

  /**
   * Whether DNS support is enabled.
   */
  EnableDnsSupport: z.boolean().optional(),

  /**
   * The instance tenancy setting for the VPC.
   */
  InstanceTenancy: z.string().optional(),

  /**
   * The tags for the VPC.
   */
  Tags: z.array(z.object({
    Key: z.string(),
    Value: z.string(),
  })).optional(),
});

/**
 * Type for EC2 VPC resource attributes.
 */
export type EC2VpcResourceAttributes = z.infer<
  typeof EC2VpcResourceAttributesSchema
>;

/**
 * The EC2 VPC model type identifier.
 */
export const EC2_VPC_MODEL_TYPE = ModelType.create("AWS::EC2::VPC");

/**
 * EC2 VPC model implementation using AWS CloudControl base class.
 */
class EC2VpcModel extends AWSCloudControlModel<
  typeof EC2VpcInputAttributesSchema
> {
  constructor() {
    super({
      typeName: "AWS::EC2::VPC",
      modelType: EC2_VPC_MODEL_TYPE,
      arguments: EC2VpcInputAttributesSchema,
      extractResourceIdentifier: (attributes) => {
        return (attributes.VpcId as string | undefined) ||
          (attributes.ResourceIdentifier as string | undefined);
      },
      mapResourceProperties: (rawProperties) => ({
        VpcId: rawProperties.VpcId,
        CidrBlock: rawProperties.CidrBlock,
        CidrBlockAssociations: rawProperties.CidrBlockAssociations,
        DefaultNetworkAcl: rawProperties.DefaultNetworkAcl,
        DefaultSecurityGroup: rawProperties.DefaultSecurityGroup,
        Ipv6CidrBlocks: rawProperties.Ipv6CidrBlocks,
        EnableDnsHostnames: rawProperties.EnableDnsHostnames,
        EnableDnsSupport: rawProperties.EnableDnsSupport,
        InstanceTenancy: rawProperties.InstanceTenancy,
        Tags: rawProperties.Tags,
      }),
    });
  }
}

/**
 * The EC2 VPC model instance.
 */
const ec2VpcModelInstance = new EC2VpcModel();

/**
 * The EC2 VPC model definition.
 *
 * Provides CRUD operations for AWS EC2 VPCs using CloudControl API.
 *
 * Self-registers with the global model registry when this module is imported.
 */
export const ec2VpcModel: ModelDefinition = ec2VpcModelInstance
  .defineAndRegister();
