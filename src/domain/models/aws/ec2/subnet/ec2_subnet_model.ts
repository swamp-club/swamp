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
 * Schema for EC2 Subnet private DNS name options on launch.
 */
export const PrivateDnsNameOptionsOnLaunchSchema = z.object({
  /**
   * Indicates whether to respond to DNS queries for instance hostnames
   * with DNS AAAA records.
   */
  EnableResourceNameDnsAAAARecord: z.boolean().optional(),

  /**
   * Indicates whether to respond to DNS queries for instance hostnames
   * with DNS A records.
   */
  EnableResourceNameDnsARecord: z.boolean().optional(),

  /**
   * The type of hostname for EC2 instances.
   * - "ip-name": Use IP-based naming
   * - "resource-name": Use resource-based naming
   */
  HostnameType: z.enum(["ip-name", "resource-name"]).optional(),
});

/**
 * Schema for EC2 Subnet input attributes (1:1 mapping to CloudControl API).
 *
 * Based on AWS CloudFormation AWS::EC2::Subnet resource type.
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-subnet.html
 */
export const EC2SubnetInputAttributesSchema = z.object({
  /**
   * The ID of the VPC the subnet is in. Required.
   */
  VpcId: z.string(),

  /**
   * The IPv4 CIDR block assigned to the subnet.
   * If you update this property, you must also update the AvailabilityZone property.
   */
  CidrBlock: z.string().optional(),

  /**
   * The Availability Zone of the subnet.
   * If you update this property, you must also update the CidrBlock property.
   */
  AvailabilityZone: z.string().optional(),

  /**
   * The AZ ID of the subnet.
   */
  AvailabilityZoneId: z.string().optional(),

  /**
   * Indicates whether a network interface created in this subnet
   * (including a network interface created by RunInstances) receives
   * an IPv6 address. The default value is false.
   */
  AssignIpv6AddressOnCreation: z.boolean().optional(),

  /**
   * Indicates whether instances launched in this subnet receive
   * a public IPv4 address. The default value is false.
   */
  MapPublicIpOnLaunch: z.boolean().optional(),

  /**
   * Indicates whether DNS queries made to the Amazon-provided DNS Resolver
   * in this subnet should return synthetic IPv6 addresses for IPv4-only destinations.
   */
  EnableDns64: z.boolean().optional(),

  /**
   * Indicates whether this is an IPv6 only subnet.
   * For more information, see Subnet basics in the Amazon VPC User Guide.
   */
  Ipv6Native: z.boolean().optional(),

  /**
   * Indicates the device position for local network interfaces in this subnet.
   * For example, 1 indicates local network interfaces in this subnet are the
   * secondary network interface (eth1).
   */
  EnableLniAtDeviceIndex: z.number().optional(),

  /**
   * The Amazon Resource Name (ARN) of the Outpost.
   */
  OutpostArn: z.string().optional(),

  /**
   * An IPv4 IPAM pool ID for the subnet.
   */
  Ipv4IpamPoolId: z.string().optional(),

  /**
   * An IPv4 netmask length for the subnet.
   */
  Ipv4NetmaskLength: z.number().optional(),

  /**
   * The IPv6 CIDR block.
   * If you specify AssignIpv6AddressOnCreation, you must also specify Ipv6CidrBlock.
   */
  Ipv6CidrBlock: z.string().optional(),

  /**
   * An IPv6 IPAM pool ID for the subnet.
   */
  Ipv6IpamPoolId: z.string().optional(),

  /**
   * An IPv6 netmask length for the subnet.
   */
  Ipv6NetmaskLength: z.number().optional(),

  /**
   * The hostname type for EC2 instances launched into this subnet and
   * how DNS A and AAAA record queries to the instances should be handled.
   */
  PrivateDnsNameOptionsOnLaunch: PrivateDnsNameOptionsOnLaunchSchema.optional(),

  /**
   * Any tags assigned to the subnet.
   */
  Tags: z.array(z.object({
    Key: z.string(),
    Value: z.string(),
  })).optional(),
});

/**
 * Type for EC2 Subnet input attributes.
 */
export type EC2SubnetInputAttributes = z.infer<
  typeof EC2SubnetInputAttributesSchema
>;

/**
 * Schema for EC2 Subnet resource attributes (what gets returned from AWS).
 */
export const EC2SubnetResourceAttributesSchema = z.object({
  /**
   * The ID of the subnet.
   */
  SubnetId: z.string(),

  /**
   * The ID of the VPC the subnet is in.
   */
  VpcId: z.string().optional(),

  /**
   * The Availability Zone of the subnet.
   */
  AvailabilityZone: z.string().optional(),

  /**
   * The AZ ID of the subnet.
   */
  AvailabilityZoneId: z.string().optional(),

  /**
   * The IPv4 CIDR block assigned to the subnet.
   */
  CidrBlock: z.string().optional(),

  /**
   * The IPv6 CIDR blocks associated with the subnet.
   */
  Ipv6CidrBlocks: z.array(z.string()).optional(),

  /**
   * The ID of the network ACL associated with the subnet's VPC.
   */
  NetworkAclAssociationId: z.string().optional(),

  /**
   * The Amazon Resource Name (ARN) of the Outpost.
   */
  OutpostArn: z.string().optional(),

  /**
   * Indicates whether instances launched in this subnet receive
   * a public IPv4 address.
   */
  MapPublicIpOnLaunch: z.boolean().optional(),

  /**
   * Indicates whether a network interface created in this subnet
   * receives an IPv6 address.
   */
  AssignIpv6AddressOnCreation: z.boolean().optional(),

  /**
   * Indicates whether this is an IPv6 only subnet.
   */
  Ipv6Native: z.boolean().optional(),

  /**
   * Indicates whether DNS queries return synthetic IPv6 addresses
   * for IPv4-only destinations.
   */
  EnableDns64: z.boolean().optional(),

  /**
   * The tags for the subnet.
   */
  Tags: z.array(z.object({
    Key: z.string(),
    Value: z.string(),
  })).optional(),
});

/**
 * Type for EC2 Subnet resource attributes.
 */
export type EC2SubnetResourceAttributes = z.infer<
  typeof EC2SubnetResourceAttributesSchema
>;

/**
 * The EC2 Subnet model type identifier.
 */
export const EC2_SUBNET_MODEL_TYPE = ModelType.create("AWS::EC2::Subnet");

/**
 * EC2 Subnet model implementation using AWS CloudControl base class.
 */
class EC2SubnetModel extends AWSCloudControlModel<
  typeof EC2SubnetInputAttributesSchema
> {
  constructor() {
    super({
      typeName: "AWS::EC2::Subnet",
      modelType: EC2_SUBNET_MODEL_TYPE,
      arguments: EC2SubnetInputAttributesSchema,
      extractResourceIdentifier: (attributes) => {
        return (attributes.SubnetId as string | undefined) ||
          (attributes.ResourceIdentifier as string | undefined);
      },
      mapResourceProperties: (rawProperties) => ({
        SubnetId: rawProperties.SubnetId,
        VpcId: rawProperties.VpcId,
        AvailabilityZone: rawProperties.AvailabilityZone,
        AvailabilityZoneId: rawProperties.AvailabilityZoneId,
        CidrBlock: rawProperties.CidrBlock,
        Ipv6CidrBlocks: rawProperties.Ipv6CidrBlocks,
        NetworkAclAssociationId: rawProperties.NetworkAclAssociationId,
        OutpostArn: rawProperties.OutpostArn,
        MapPublicIpOnLaunch: rawProperties.MapPublicIpOnLaunch,
        AssignIpv6AddressOnCreation: rawProperties.AssignIpv6AddressOnCreation,
        Ipv6Native: rawProperties.Ipv6Native,
        EnableDns64: rawProperties.EnableDns64,
        Tags: rawProperties.Tags,
      }),
    });
  }
}

/**
 * The EC2 Subnet model instance.
 */
const ec2SubnetModelInstance = new EC2SubnetModel();

/**
 * The EC2 Subnet model definition.
 *
 * Provides CRUD operations for AWS EC2 Subnets using CloudControl API.
 *
 * Self-registers with the global model registry when this module is imported.
 */
export const ec2SubnetModel: ModelDefinition = ec2SubnetModelInstance
  .defineAndRegister();
