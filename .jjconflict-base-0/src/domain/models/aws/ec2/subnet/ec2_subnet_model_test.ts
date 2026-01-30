import { assertEquals, assertRejects } from "@std/assert";
import type { CloudControlClient } from "@aws-sdk/client-cloudcontrol";
import {
  EC2_SUBNET_MODEL_TYPE,
  EC2SubnetInputAttributesSchema,
  ec2SubnetModel,
  EC2SubnetResourceAttributesSchema,
} from "./ec2_subnet_model.ts";
import { ModelInput } from "../../../model_input.ts";
import {
  createModelResourceId,
  ModelResource,
} from "../../../model_resource.ts";
import type { MethodContext } from "../../../model.ts";
import type { ResourceRepository } from "../../../repositories.ts";

Deno.test("EC2SubnetModel - model type", () => {
  assertEquals(ec2SubnetModel.type.raw, "AWS::EC2::Subnet");
  assertEquals(ec2SubnetModel.type.normalized, "aws/ec2/subnet");
  assertEquals(ec2SubnetModel.type, EC2_SUBNET_MODEL_TYPE);
});

Deno.test("EC2SubnetModel - version", () => {
  assertEquals(ec2SubnetModel.version, 1);
});

Deno.test("EC2SubnetModel - has required methods", () => {
  assertEquals(Object.keys(ec2SubnetModel.methods).sort(), [
    "create",
    "delete",
    "sync",
  ]);
});

Deno.test("EC2SubnetModel - input schema validation minimal", () => {
  const validInput = {
    VpcId: "vpc-12345678",
    CidrBlock: "10.0.1.0/24",
  };

  const result = EC2SubnetInputAttributesSchema.safeParse(validInput);
  assertEquals(result.success, true);
});

Deno.test("EC2SubnetModel - input schema requires VpcId", () => {
  const invalidInput = {
    CidrBlock: "10.0.1.0/24",
  };

  const result = EC2SubnetInputAttributesSchema.safeParse(invalidInput);
  assertEquals(result.success, false);
});

Deno.test("EC2SubnetModel - input schema with availability zone", () => {
  const validInput = {
    VpcId: "vpc-12345678",
    CidrBlock: "10.0.1.0/24",
    AvailabilityZone: "us-east-1a",
  };

  const result = EC2SubnetInputAttributesSchema.safeParse(validInput);
  assertEquals(result.success, true);
});

Deno.test("EC2SubnetModel - input schema with AZ ID", () => {
  const validInput = {
    VpcId: "vpc-12345678",
    CidrBlock: "10.0.1.0/24",
    AvailabilityZoneId: "use1-az1",
  };

  const result = EC2SubnetInputAttributesSchema.safeParse(validInput);
  assertEquals(result.success, true);
});

Deno.test("EC2SubnetModel - input schema with all properties", () => {
  const fullInput = {
    VpcId: "vpc-12345678",
    CidrBlock: "10.0.1.0/24",
    AvailabilityZone: "us-east-1a",
    AssignIpv6AddressOnCreation: false,
    MapPublicIpOnLaunch: true,
    EnableDns64: false,
    Ipv6Native: false,
    EnableLniAtDeviceIndex: 1,
    PrivateDnsNameOptionsOnLaunch: {
      EnableResourceNameDnsAAAARecord: false,
      EnableResourceNameDnsARecord: true,
      HostnameType: "ip-name" as const,
    },
    Tags: [
      { Key: "Name", Value: "test-subnet" },
      { Key: "Environment", Value: "test" },
    ],
  };

  const result = EC2SubnetInputAttributesSchema.safeParse(fullInput);
  assertEquals(result.success, true);
});

Deno.test("EC2SubnetModel - input schema with IPv6", () => {
  const ipv6Input = {
    VpcId: "vpc-12345678",
    Ipv6CidrBlock: "2001:db8:1234:1a00::/64",
    Ipv6Native: true,
    AssignIpv6AddressOnCreation: true,
  };

  const result = EC2SubnetInputAttributesSchema.safeParse(ipv6Input);
  assertEquals(result.success, true);
});

Deno.test("EC2SubnetModel - input schema with IPAM", () => {
  const ipamInput = {
    VpcId: "vpc-12345678",
    Ipv4IpamPoolId: "ipam-pool-12345678",
    Ipv4NetmaskLength: 24,
  };

  const result = EC2SubnetInputAttributesSchema.safeParse(ipamInput);
  assertEquals(result.success, true);
});

Deno.test("EC2SubnetModel - input schema with Outpost", () => {
  const outpostInput = {
    VpcId: "vpc-12345678",
    CidrBlock: "10.0.1.0/24",
    OutpostArn: "arn:aws:outposts:us-east-1:123456789012:outpost/op-12345678",
  };

  const result = EC2SubnetInputAttributesSchema.safeParse(outpostInput);
  assertEquals(result.success, true);
});

Deno.test("EC2SubnetModel - resource schema validation", () => {
  const validResource = {
    SubnetId: "subnet-12345678",
    VpcId: "vpc-12345678",
    AvailabilityZone: "us-east-1a",
    CidrBlock: "10.0.1.0/24",
    MapPublicIpOnLaunch: true,
  };

  const result = EC2SubnetResourceAttributesSchema.safeParse(validResource);
  assertEquals(result.success, true);
});

Deno.test("EC2SubnetModel - resource schema with all attributes", () => {
  const fullResource = {
    SubnetId: "subnet-12345678",
    VpcId: "vpc-12345678",
    AvailabilityZone: "us-east-1a",
    AvailabilityZoneId: "use1-az1",
    CidrBlock: "10.0.1.0/24",
    Ipv6CidrBlocks: ["2001:db8:1234:1a00::/64"],
    NetworkAclAssociationId: "aclassoc-12345678",
    MapPublicIpOnLaunch: true,
    AssignIpv6AddressOnCreation: false,
    Ipv6Native: false,
    EnableDns64: false,
    Tags: [
      { Key: "Name", Value: "test-subnet" },
    ],
  };

  const result = EC2SubnetResourceAttributesSchema.safeParse(fullResource);
  assertEquals(result.success, true);
});

Deno.test("EC2SubnetModel - sync method without RequestToken fails", async () => {
  const input = ModelInput.create({
    name: "test-subnet",
    attributes: {
      VpcId: "vpc-12345678",
      CidrBlock: "10.0.1.0/24",
    },
  });

  const mockResourceRepository: ResourceRepository = {
    findById: () => Promise.resolve(null),
    findAll: () => Promise.resolve([]),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    nextId: () => createModelResourceId("mock-id"),
    getPath: () => "/mock/path",
  };

  const context: MethodContext = {
    repoDir: "/tmp/test-repo",
    resourceRepository: mockResourceRepository,
  };

  await assertRejects(
    () => ec2SubnetModel.methods.sync.execute(input, context),
    Error,
    "AWS::EC2::Subnet sync failed: no RequestToken found",
  );
});

Deno.test("EC2SubnetModel - delete method without resource ID fails", async () => {
  const input = ModelInput.create({
    name: "test-subnet",
    attributes: {
      VpcId: "vpc-12345678",
      CidrBlock: "10.0.1.0/24",
    },
  });

  const context: MethodContext = {
    repoDir: "/tmp/test-repo",
  };

  await assertRejects(
    () => ec2SubnetModel.methods.delete.execute(input, context),
    Error,
    "Cannot delete: no resource ID found in input",
  );
});

Deno.test("EC2SubnetModel - create method uses injected CloudControl client", async () => {
  const input = ModelInput.create({
    name: "test-subnet",
    attributes: {
      VpcId: "vpc-12345678",
      CidrBlock: "10.0.1.0/24",
      AvailabilityZone: "us-east-1a",
    },
  });

  const mockClient = {
    send: () =>
      Promise.resolve({
        ProgressEvent: {
          Identifier: "subnet-12345678",
          RequestToken: "request-123",
          OperationStatus: "IN_PROGRESS",
        },
      }),
  };

  const context: MethodContext = {
    repoDir: "/tmp/test-repo",
    cloudControlClientFactory: () =>
      mockClient as unknown as CloudControlClient,
  };

  const result = await ec2SubnetModel.methods.create.execute(input, context);

  assertEquals(result.resource?.attributes.RequestToken, "request-123");
  assertEquals(result.resource?.attributes.OperationStatus, "IN_PROGRESS");
  assertEquals(result.followUpActions?.length, 1);
  assertEquals(result.followUpActions?.[0].methodName, "sync");
});

Deno.test("EC2SubnetModel - delete method requires resourceRepository", async () => {
  const input = ModelInput.create({
    name: "test-subnet",
    resourceId: "00000000-0000-4000-8000-000000000001",
    attributes: {
      VpcId: "vpc-12345678",
      CidrBlock: "10.0.1.0/24",
    },
  });

  const context: MethodContext = {
    repoDir: "/tmp/test-repo",
  };

  await assertRejects(
    () => ec2SubnetModel.methods.delete.execute(input, context),
    Error,
    "Cannot delete: resourceRepository not provided in context",
  );
});

Deno.test("EC2SubnetModel - sync method treats 'not found' as deleted", async () => {
  const input = ModelInput.create({
    name: "test-subnet",
    attributes: {
      RequestToken: "request-123",
      ResourceIdentifier: "subnet-12345678",
    },
  });

  const mockClient = {
    send: () =>
      Promise.resolve({
        ProgressEvent: {
          OperationStatus: "FAILED",
          StatusMessage:
            "Resource of type 'AWS::EC2::Subnet' with identifier 'subnet-12345678' was not found.",
        },
      }),
  };

  const context: MethodContext = {
    repoDir: "/tmp/test-repo",
    cloudControlClientFactory: () =>
      mockClient as unknown as CloudControlClient,
  };

  const result = await ec2SubnetModel.methods.sync.execute(input, context);

  assertEquals(result.resource?.attributes.OperationStatus, "SUCCESS");
  assertEquals(result.resource?.attributes.DeletionCompleted, true);
  assertEquals(result.deleteResource, true);
  assertEquals(result.followUpActions, undefined);
});

Deno.test("EC2SubnetModel - delete method treats 'not found' as success", async () => {
  const input = ModelInput.create({
    name: "test-subnet",
    resourceId: "00000000-0000-4000-8000-000000000001",
    attributes: {
      VpcId: "vpc-12345678",
      CidrBlock: "10.0.1.0/24",
    },
  });

  const existingResource = ModelResource.create({
    id: "00000000-0000-4000-8000-000000000001",
    attributes: {
      SubnetId: "subnet-12345678",
    },
  });
  const mockResourceRepository: ResourceRepository = {
    findById: () => Promise.resolve(existingResource),
    findAll: () => Promise.resolve([]),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    nextId: () => createModelResourceId("mock-id"),
    getPath: () => "/mock/path",
  };

  const mockClient = {
    send: () => {
      const error = new Error(
        "Resource of type 'AWS::EC2::Subnet' with identifier 'subnet-12345678' was not found.",
      );
      error.name = "ResourceNotFoundException";
      return Promise.reject(error);
    },
  };

  const context: MethodContext = {
    repoDir: "/tmp/test-repo",
    resourceRepository: mockResourceRepository,
    cloudControlClientFactory: () =>
      mockClient as unknown as CloudControlClient,
  };

  const result = await ec2SubnetModel.methods.delete.execute(input, context);

  assertEquals(result.resource?.attributes.OperationStatus, "SUCCESS");
  assertEquals(result.resource?.attributes.DeletionCompleted, true);
  assertEquals(result.deleteResource, true);
  assertEquals(result.followUpActions, undefined);
});
