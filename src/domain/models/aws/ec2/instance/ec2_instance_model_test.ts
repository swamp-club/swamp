import { assertEquals, assertRejects } from "@std/assert";
import {
  EC2_INSTANCE_MODEL_TYPE,
  EC2InstanceInputAttributesSchema,
  ec2InstanceModel,
  EC2InstanceResourceAttributesSchema,
} from "./ec2_instance_model.ts";
import { ModelInput } from "../../../model_input.ts";
import type { MethodContext } from "../../../model.ts";

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

// Mock AWS SDK
const mockCloudControlClient = {
  send: () =>
    Promise.resolve({
      ProgressEvent: {
        Identifier: "i-1234567890abcdef0",
        RequestToken: "request-123",
      },
    }),
};

// Override the CloudControl client creation for testing
const originalCreateClient =
  (ec2InstanceModel as unknown as { createCloudControlClient: () => unknown })
    .createCloudControlClient;
(ec2InstanceModel as unknown as { createCloudControlClient: () => unknown })
  .createCloudControlClient = () => mockCloudControlClient;

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
    "reconcile",
    "update",
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

Deno.test("EC2InstanceModel - create method success", async () => {
  const input = ModelInput.create({
    name: "test-instance",
    attributes: {
      ImageId: "ami-12345678",
      InstanceType: "t2.micro",
      KeyName: "my-key",
    },
  });

  const context: MethodContext = {
    repoDir: "/tmp/test-repo",
  };

  // Mock successful creation
  mockCloudControlClient.send = () =>
    Promise.resolve({
      ProgressEvent: {
        Identifier: "i-1234567890abcdef0",
        RequestToken: "request-123",
      },
      ResourceDescription: {
        Properties: JSON.stringify({
          InstanceId: "i-1234567890abcdef0",
          State: { Name: "pending" },
          ImageId: "ami-12345678",
          InstanceType: "t2.micro",
        }),
      },
    });

  const result = await ec2InstanceModel.methods.create.execute(input, context);

  assertEquals(result.resource.attributes.InstanceId, "i-1234567890abcdef0");
});

Deno.test("EC2InstanceModel - update method with resource ID", async () => {
  const input = ModelInput.create({
    name: "test-instance",
    resourceId: "12345678-1234-1234-1234-123456789012", // Valid UUID
    attributes: {
      ImageId: "ami-12345678",
      InstanceType: "t2.small", // Changed from t2.micro
    },
  });

  const context: MethodContext = {
    repoDir: "/tmp/test-repo",
  };

  // Mock successful update
  mockCloudControlClient.send = () =>
    Promise.resolve({
      ProgressEvent: {
        Identifier: "i-1234567890abcdef0",
        RequestToken: "request-123",
      },
      ResourceDescription: {
        Properties: JSON.stringify({
          InstanceId: "i-1234567890abcdef0",
          InstanceType: "t2.small",
          State: { Name: "running" },
        }),
      },
    });

  const result = await ec2InstanceModel.methods.update.execute(input, context);

  assertEquals(result.resource.attributes.InstanceId, "i-1234567890abcdef0");
});

Deno.test("EC2InstanceModel - update method without resource ID fails", async () => {
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
    () => ec2InstanceModel.methods.update.execute(input, context),
    Error,
    "Cannot update: no resource ID found in input",
  );
});

Deno.test("EC2InstanceModel - delete method success", async () => {
  const input = ModelInput.create({
    name: "test-instance",
    resourceId: "12345678-1234-1234-1234-123456789012", // Valid UUID
    attributes: {
      ImageId: "ami-12345678",
      InstanceType: "t2.micro",
    },
  });

  const context: MethodContext = {
    repoDir: "/tmp/test-repo",
  };

  // Mock successful deletion
  mockCloudControlClient.send = () =>
    Promise.resolve({
      ProgressEvent: {
        Identifier: "i-1234567890abcdef0",
        RequestToken: "request-123",
      },
    });

  const result = await ec2InstanceModel.methods.delete.execute(input, context);

  assertEquals(result.resource.attributes.InstanceId, "i-1234567890abcdef0");
  assertEquals(
    (result.resource.attributes.State as { Name: string }).Name,
    "shutting-down",
  );
  assertEquals(result.resource.attributes.DeletionInitiated, true);
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

Deno.test("EC2InstanceModel - reconcile method with drift", async () => {
  const input = ModelInput.create({
    name: "test-instance",
    resourceId: "12345678-1234-1234-1234-123456789012", // Valid UUID
    attributes: {
      ImageId: "ami-12345678",
      InstanceType: "t2.small", // Desired state
      Monitoring: true,
    },
  });

  const context: MethodContext = {
    repoDir: "/tmp/test-repo",
  };

  let callCount = 0;
  // Mock GetResource (current state) and UpdateResource
  mockCloudControlClient.send = () => {
    callCount++;
    if (callCount === 1) {
      // GetResource call - return current state with drift
      return Promise.resolve({
        ProgressEvent: {
          Identifier: "i-1234567890abcdef0",
          RequestToken: "request-123",
        },
        ResourceDescription: {
          Properties: JSON.stringify({
            InstanceId: "i-1234567890abcdef0",
            InstanceType: "t2.micro", // Different from desired
            Monitoring: { State: "disabled" },
          }),
        },
      });
    } else {
      // UpdateResource call
      return Promise.resolve({
        ProgressEvent: {
          Identifier: "i-1234567890abcdef0",
          RequestToken: "request-123",
        },
        ResourceDescription: {
          Properties: JSON.stringify({
            InstanceId: "i-1234567890abcdef0",
            InstanceType: "t2.small", // Updated to desired state
            Monitoring: { State: "enabled" },
          }),
        },
      });
    }
  };

  const result = await ec2InstanceModel.methods.reconcile.execute(
    input,
    context,
  );

  assertEquals(result.resource.attributes.InstanceId, "i-1234567890abcdef0");
});

Deno.test("EC2InstanceModel - reconcile method without drift", async () => {
  const input = ModelInput.create({
    name: "test-instance",
    resourceId: "12345678-1234-1234-1234-123456789012", // Valid UUID
    attributes: {
      ImageId: "ami-12345678",
      InstanceType: "t2.micro",
    },
  });

  const context: MethodContext = {
    repoDir: "/tmp/test-repo",
  };

  // Mock GetResource returning state that matches desired state
  mockCloudControlClient.send = () =>
    Promise.resolve({
      ProgressEvent: {
        Identifier: "i-1234567890abcdef0",
        RequestToken: "request-123",
      },
      ResourceDescription: {
        Properties: JSON.stringify({
          InstanceId: "i-1234567890abcdef0",
          InstanceType: "t2.micro",
          ImageId: "ami-12345678",
          State: { Name: "running" },
        }),
      },
    });

  const result = await ec2InstanceModel.methods.reconcile.execute(
    input,
    context,
  );

  assertEquals(result.resource.attributes.InstanceId, "i-1234567890abcdef0");
  assertEquals(result.resource.attributes.ReconciliationStatus, "in-sync");
});

Deno.test("EC2InstanceModel - reconcile method without resource ID fails", async () => {
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
    () => ec2InstanceModel.methods.reconcile.execute(input, context),
    Error,
    "Cannot reconcile: no resource ID found in input",
  );
});

// Restore original client creation function
(ec2InstanceModel as unknown as { createCloudControlClient: () => unknown })
  .createCloudControlClient = originalCreateClient;
