import { assertEquals, assertRejects } from "@std/assert";
import type { CloudControlClient } from "@aws-sdk/client-cloudcontrol";
import {
  EC2_INSTANCE_MODEL_TYPE,
  EC2InstanceInputAttributesSchema,
  ec2InstanceModel,
  EC2InstanceResourceAttributesSchema,
} from "./ec2_instance_model.ts";
import { ModelInput } from "../../../model_input.ts";
import {
  createModelResourceId,
  ModelResource,
} from "../../../model_resource.ts";
import type { MethodContext } from "../../../model.ts";
import type { ResourceRepository } from "../../../repositories.ts";

/*
Example instance attributes
id: 9ad6033a-e77b-4e3b-8347-c5e10dad073b
resourceId: 9ad6033a-e77b-4e3b-8347-c5e10dad073b
name: peach
version: 1
tags: {}
attributes:
  ImageId: ami-0c02fb55956c7d316
  InstanceType: t3.micro
  AvailabilityZone: us-east-1a
  Tags:
    - Key: Name
      Value: peach-instance
    - Key: Environment
      Value: development
*/

Deno.test("EC2InstanceModel - model type", () => {
  assertEquals(ec2InstanceModel.type.raw, "AWS::EC2::Instance");
  assertEquals(ec2InstanceModel.type.normalized, "aws/ec2/instance");
  assertEquals(ec2InstanceModel.type, EC2_INSTANCE_MODEL_TYPE);
});

Deno.test("EC2InstanceModel - version", () => {
  assertEquals(ec2InstanceModel.version, 1);
});

Deno.test("EC2InstanceModel - has required methods", () => {
  assertEquals(Object.keys(ec2InstanceModel.methods).sort(), [
    "create",
    "delete",
    "sync",
  ]);
});

Deno.test("EC2InstanceModel - input schema validation", () => {
  // Valid minimal input
  const validInput = {
    ImageId: "ami-12345678",
    InstanceType: "t2.micro",
  };

  const result = EC2InstanceInputAttributesSchema.safeParse(validInput);
  assertEquals(result.success, true);
});

Deno.test("EC2InstanceModel - input schema with all properties", () => {
  const fullInput = {
    AdditionalInfo: "test-info",
    Affinity: "default" as const,
    AvailabilityZone: "us-east-1a",
    BlockDeviceMappings: [{
      DeviceName: "/dev/sda1",
      Ebs: {
        VolumeSize: 20,
        VolumeType: "gp3" as const,
        DeleteOnTermination: true,
      },
    }],
    CpuOptions: {
      CoreCount: 1,
      ThreadsPerCore: 2,
    },
    CreditSpecification: {
      CpuCredits: "standard" as const,
    },
    DisableApiTermination: false,
    EbsOptimized: true,
    ImageId: "ami-12345678",
    InstanceType: "t2.micro",
    KeyName: "my-key",
    MetadataOptions: {
      HttpEndpoint: "enabled" as const,
      HttpTokens: "required" as const,
    },
    Monitoring: true,
    SecurityGroupIds: ["sg-12345678"],
    SubnetId: "subnet-12345678",
    Tags: [
      { Key: "Name", Value: "test-instance" },
      { Key: "Environment", Value: "test" },
    ],
    UserData: "IyEvYmluL2Jhc2gK", // base64 encoded
  };

  const result = EC2InstanceInputAttributesSchema.safeParse(fullInput);
  assertEquals(result.success, true);
});

Deno.test("EC2InstanceModel - resource schema validation", () => {
  const validResource = {
    InstanceId: "i-1234567890abcdef0",
    State: {
      Code: 16,
      Name: "running",
    },
    PrivateIpAddress: "10.0.1.100",
    PublicIpAddress: "54.123.45.67",
  };

  const result = EC2InstanceResourceAttributesSchema.safeParse(validResource);
  assertEquals(result.success, true);
});

Deno.test("EC2InstanceModel - sync method without RequestToken fails", async () => {
  const input = ModelInput.create({
    name: "test-instance",
    attributes: {
      ImageId: "ami-12345678",
      InstanceType: "t2.micro",
    },
  });

  // Mock resource repository that returns null (no existing resource)
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
    () => ec2InstanceModel.methods.sync.execute(input, context),
    Error,
    "EC2 instance sync failed: no RequestToken found to check operation status",
  );
});

Deno.test("EC2InstanceModel - delete method without resource ID fails", async () => {
  const input = ModelInput.create({
    name: "test-instance",
    attributes: {
      ImageId: "ami-12345678",
      InstanceType: "t2.micro",
    },
  });

  const context: MethodContext = {
    repoDir: "/tmp/test-repo",
  };

  await assertRejects(
    () => ec2InstanceModel.methods.delete.execute(input, context),
    Error,
    "Cannot delete: no resource ID found in input",
  );
});

Deno.test("EC2InstanceModel - create method uses injected CloudControl client", async () => {
  const input = ModelInput.create({
    name: "test-instance",
    attributes: {
      ImageId: "ami-12345678",
      InstanceType: "t2.micro",
    },
  });

  // Mock CloudControl client that returns success
  const mockClient = {
    send: () =>
      Promise.resolve({
        ProgressEvent: {
          Identifier: "i-1234567890abcdef0",
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

  const result = await ec2InstanceModel.methods.create.execute(input, context);

  assertEquals(result.resource.attributes.RequestToken, "request-123");
  assertEquals(result.resource.attributes.OperationStatus, "IN_PROGRESS");
  assertEquals(result.followUpActions?.length, 1);
  assertEquals(result.followUpActions?.[0].methodName, "sync");
});

Deno.test("EC2InstanceModel - delete method requires resourceRepository", async () => {
  const input = ModelInput.create({
    name: "test-instance",
    resourceId: "00000000-0000-4000-8000-000000000001", // Valid UUID
    attributes: {
      ImageId: "ami-12345678",
      InstanceType: "t2.micro",
    },
  });

  // Context without resourceRepository
  const context: MethodContext = {
    repoDir: "/tmp/test-repo",
  };

  await assertRejects(
    () => ec2InstanceModel.methods.delete.execute(input, context),
    Error,
    "Cannot delete: resourceRepository not provided in context",
  );
});

Deno.test("EC2InstanceModel - sync method treats 'not found' as deleted", async () => {
  const input = ModelInput.create({
    name: "test-instance",
    attributes: {
      RequestToken: "request-123",
      ResourceIdentifier: "i-1234567890abcdef0",
    },
  });

  // Mock CloudControl client where status check returns FAILED with "not found"
  const mockClient = {
    send: () =>
      Promise.resolve({
        ProgressEvent: {
          OperationStatus: "FAILED",
          StatusMessage:
            "Resource of type 'AWS::EC2::Instance' with identifier 'i-1234567890abcdef0' was not found.",
        },
      }),
  };

  const context: MethodContext = {
    repoDir: "/tmp/test-repo",
    cloudControlClientFactory: () =>
      mockClient as unknown as CloudControlClient,
  };

  const result = await ec2InstanceModel.methods.sync.execute(input, context);

  // Should return success with deleteResource flag
  assertEquals(result.resource.attributes.OperationStatus, "SUCCESS");
  assertEquals(result.resource.attributes.DeletionCompleted, true);
  assertEquals(result.deleteResource, true);
  assertEquals(result.followUpActions, undefined);
});

Deno.test("EC2InstanceModel - delete method treats 'not found' as success", async () => {
  const input = ModelInput.create({
    name: "test-instance",
    resourceId: "00000000-0000-4000-8000-000000000001",
    attributes: {
      ImageId: "ami-12345678",
      InstanceType: "t2.micro",
    },
  });

  // Mock resource repository that returns an existing resource with InstanceId
  const existingResource = ModelResource.create({
    id: "00000000-0000-4000-8000-000000000001",
    attributes: {
      InstanceId: "i-1234567890abcdef0",
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

  // Mock CloudControl client that returns "not found" error
  const mockClient = {
    send: () => {
      const error = new Error(
        "Resource of type 'AWS::EC2::Instance' with identifier 'i-1234567890abcdef0' was not found.",
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

  const result = await ec2InstanceModel.methods.delete.execute(input, context);

  // Should return success with deleteResource flag
  assertEquals(result.resource.attributes.OperationStatus, "SUCCESS");
  assertEquals(result.resource.attributes.DeletionCompleted, true);
  assertEquals(result.deleteResource, true);
  assertEquals(result.followUpActions, undefined);
});
