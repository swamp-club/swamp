import { assertEquals, assertRejects } from "@std/assert";
import type { CloudControlClient } from "@aws-sdk/client-cloudcontrol";
import {
  EC2_VPC_MODEL_TYPE,
  EC2VpcInputAttributesSchema,
  ec2VpcModel,
  EC2VpcResourceAttributesSchema,
} from "./ec2_vpc_model.ts";
import { ModelInput } from "../../../model_input.ts";
import {
  createModelResourceId,
  ModelResource,
} from "../../../model_resource.ts";
import type { MethodContext } from "../../../model.ts";
import type { ResourceRepository } from "../../../repositories.ts";

Deno.test("EC2VpcModel - model type", () => {
  assertEquals(ec2VpcModel.type.raw, "AWS::EC2::VPC");
  assertEquals(ec2VpcModel.type.normalized, "aws/ec2/vpc");
  assertEquals(ec2VpcModel.type, EC2_VPC_MODEL_TYPE);
});

Deno.test("EC2VpcModel - version", () => {
  assertEquals(ec2VpcModel.version, 1);
});

Deno.test("EC2VpcModel - has required methods", () => {
  assertEquals(Object.keys(ec2VpcModel.methods).sort(), [
    "create",
    "delete",
    "sync",
  ]);
});

Deno.test("EC2VpcModel - input schema validation with CidrBlock", () => {
  const validInput = {
    CidrBlock: "10.0.0.0/16",
  };

  const result = EC2VpcInputAttributesSchema.safeParse(validInput);
  assertEquals(result.success, true);
});

Deno.test("EC2VpcModel - input schema validation with IPAM pool", () => {
  const validInput = {
    Ipv4IpamPoolId: "ipam-pool-12345678",
    Ipv4NetmaskLength: 16,
  };

  const result = EC2VpcInputAttributesSchema.safeParse(validInput);
  assertEquals(result.success, true);
});

Deno.test("EC2VpcModel - input schema with all properties", () => {
  const fullInput = {
    CidrBlock: "10.0.0.0/16",
    EnableDnsHostnames: true,
    EnableDnsSupport: true,
    InstanceTenancy: "default" as const,
    Tags: [
      { Key: "Name", Value: "test-vpc" },
      { Key: "Environment", Value: "test" },
    ],
  };

  const result = EC2VpcInputAttributesSchema.safeParse(fullInput);
  assertEquals(result.success, true);
});

Deno.test("EC2VpcModel - input schema with dedicated tenancy", () => {
  const dedicatedInput = {
    CidrBlock: "10.0.0.0/16",
    InstanceTenancy: "dedicated" as const,
  };

  const result = EC2VpcInputAttributesSchema.safeParse(dedicatedInput);
  assertEquals(result.success, true);
});

Deno.test("EC2VpcModel - resource schema validation", () => {
  const validResource = {
    VpcId: "vpc-12345678",
    CidrBlock: "10.0.0.0/16",
    DefaultNetworkAcl: "acl-12345678",
    DefaultSecurityGroup: "sg-12345678",
    EnableDnsHostnames: true,
    EnableDnsSupport: true,
  };

  const result = EC2VpcResourceAttributesSchema.safeParse(validResource);
  assertEquals(result.success, true);
});

Deno.test("EC2VpcModel - resource schema with IPv6", () => {
  const validResource = {
    VpcId: "vpc-12345678",
    CidrBlock: "10.0.0.0/16",
    Ipv6CidrBlocks: ["2001:db8:1234:1a00::/56"],
    CidrBlockAssociations: ["vpc-cidr-assoc-12345678"],
  };

  const result = EC2VpcResourceAttributesSchema.safeParse(validResource);
  assertEquals(result.success, true);
});

Deno.test("EC2VpcModel - sync method without RequestToken fails", async () => {
  const input = ModelInput.create({
    name: "test-vpc",
    attributes: {
      CidrBlock: "10.0.0.0/16",
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
    () => ec2VpcModel.methods.sync.execute(input, context),
    Error,
    "AWS::EC2::VPC sync failed: no RequestToken found",
  );
});

Deno.test("EC2VpcModel - delete method without resource ID fails", async () => {
  const input = ModelInput.create({
    name: "test-vpc",
    attributes: {
      CidrBlock: "10.0.0.0/16",
    },
  });

  const context: MethodContext = {
    repoDir: "/tmp/test-repo",
  };

  await assertRejects(
    () => ec2VpcModel.methods.delete.execute(input, context),
    Error,
    "Cannot delete: no resource ID found in input",
  );
});

Deno.test("EC2VpcModel - create method uses injected CloudControl client", async () => {
  const input = ModelInput.create({
    name: "test-vpc",
    attributes: {
      CidrBlock: "10.0.0.0/16",
      EnableDnsHostnames: true,
      EnableDnsSupport: true,
    },
  });

  const mockClient = {
    send: () =>
      Promise.resolve({
        ProgressEvent: {
          Identifier: "vpc-12345678",
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

  const result = await ec2VpcModel.methods.create.execute(input, context);

  assertEquals(result.resource?.attributes.RequestToken, "request-123");
  assertEquals(result.resource?.attributes.OperationStatus, "IN_PROGRESS");
  assertEquals(result.followUpActions?.length, 1);
  assertEquals(result.followUpActions?.[0].methodName, "sync");
});

Deno.test("EC2VpcModel - delete method requires resourceRepository", async () => {
  const input = ModelInput.create({
    name: "test-vpc",
    resourceId: "00000000-0000-4000-8000-000000000001",
    attributes: {
      CidrBlock: "10.0.0.0/16",
    },
  });

  const context: MethodContext = {
    repoDir: "/tmp/test-repo",
  };

  await assertRejects(
    () => ec2VpcModel.methods.delete.execute(input, context),
    Error,
    "Cannot delete: resourceRepository not provided in context",
  );
});

Deno.test("EC2VpcModel - sync method treats 'not found' as deleted", async () => {
  const input = ModelInput.create({
    name: "test-vpc",
    attributes: {
      RequestToken: "request-123",
      ResourceIdentifier: "vpc-12345678",
    },
  });

  const mockClient = {
    send: () =>
      Promise.resolve({
        ProgressEvent: {
          OperationStatus: "FAILED",
          StatusMessage:
            "Resource of type 'AWS::EC2::VPC' with identifier 'vpc-12345678' was not found.",
        },
      }),
  };

  const context: MethodContext = {
    repoDir: "/tmp/test-repo",
    cloudControlClientFactory: () =>
      mockClient as unknown as CloudControlClient,
  };

  const result = await ec2VpcModel.methods.sync.execute(input, context);

  assertEquals(result.resource?.attributes.OperationStatus, "SUCCESS");
  assertEquals(result.resource?.attributes.DeletionCompleted, true);
  assertEquals(result.deleteResource, true);
  assertEquals(result.followUpActions, undefined);
});

Deno.test("EC2VpcModel - delete method treats 'not found' as success", async () => {
  const input = ModelInput.create({
    name: "test-vpc",
    resourceId: "00000000-0000-4000-8000-000000000001",
    attributes: {
      CidrBlock: "10.0.0.0/16",
    },
  });

  const existingResource = ModelResource.create({
    id: "00000000-0000-4000-8000-000000000001",
    attributes: {
      VpcId: "vpc-12345678",
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
        "Resource of type 'AWS::EC2::VPC' with identifier 'vpc-12345678' was not found.",
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

  const result = await ec2VpcModel.methods.delete.execute(input, context);

  assertEquals(result.resource?.attributes.OperationStatus, "SUCCESS");
  assertEquals(result.resource?.attributes.DeletionCompleted, true);
  assertEquals(result.deleteResource, true);
  assertEquals(result.followUpActions, undefined);
});
