# Data Chaining with aws/cli Model

The `aws/cli` model enables data chaining by running AWS CLI commands and
capturing output for use in other models. Use `parseJson: true` to parse JSON
output and access it via `resource.data.output.attributes.json`.

## aws/cli Data Attributes

| Attribute    | Description                                   |
| ------------ | --------------------------------------------- |
| `output`     | Raw stdout from the command                   |
| `json`       | Parsed JSON output (when `parseJson: true`)   |
| `exitCode`   | Command exit code                             |
| `executedAt` | ISO timestamp when command was executed       |
| `durationMs` | Duration of command execution in milliseconds |

## Example: Dynamic AMI Lookup

**Step 1: Create an aws/cli model to look up an AMI:**

```bash
# Create the model
swamp model create aws/cli latest-ami --json

# Configure the model with stdin
swamp model edit latest-ami --json <<EOF
name: latest-ami
version: 1
tags: {}
attributes:
  command: >-
    ec2 describe-images --owners amazon
    --filters "Name=name,Values=amzn2-ami-hvm-*-x86_64-gp2"
    --query "sort_by(Images,&CreationDate)[-1]"
  region: us-east-1
  parseJson: true
EOF
```

**Step 2: Create another model that references the CLI output:**

```bash
# Create the EC2 instance model
swamp model create @user/ec2-instance my-instance --json

# Configure with references to the aws/cli model's data output
swamp model edit my-instance --json <<EOF
name: my-instance
version: 1
tags: {}
attributes:
  # Reference parsed JSON fields from the aws/cli model's data output
  imageId: \${{ model.latest-ami.resource.data.output.attributes.json.ImageId }}
  instanceType: t3.micro
  tags:
    Name: \${{ self.name }}
    AmiName: \${{ model.latest-ami.resource.data.output.attributes.json.Name }}
EOF
```

## Example: Security Group Lookup

```bash
# Create and configure the security group lookup model
swamp model create aws/cli default-sg --json

swamp model edit default-sg --json <<EOF
name: default-sg
attributes:
  command: >-
    ec2 describe-security-groups
    --filters "Name=group-name,Values=default"
    --query "SecurityGroups[0]"
  parseJson: true
EOF
```

```bash
# Create an EC2 instance that references the security group
swamp model create @user/ec2 my-server --json

swamp model edit my-server --json <<EOF
name: my-server
attributes:
  securityGroupIds:
    - \${{ model.default-sg.resource.data.output.attributes.json.GroupId }}
EOF
```

## Example: Chaining Multiple Lookups

```bash
# Step 1: Create VPC lookup model
swamp model create aws/cli vpc-lookup --json

swamp model edit vpc-lookup --json <<EOF
name: vpc-lookup
attributes:
  command: ec2 describe-vpcs --filters "Name=isDefault,Values=true" --query "Vpcs[0]"
  parseJson: true
EOF
```

```bash
# Step 2: Create subnet lookup that references the VPC
swamp model create aws/cli subnet-lookup --json

swamp model edit subnet-lookup --json <<EOF
name: subnet-lookup
attributes:
  command: >-
    ec2 describe-subnets
    --filters "Name=vpc-id,Values=\${{ model.vpc-lookup.resource.data.output.attributes.json.VpcId }}"
    --query "Subnets[0]"
  parseJson: true
EOF
```

```bash
# Step 3: Create instance model that uses both lookups
swamp model create @user/ec2-instance my-instance --json

swamp model edit my-instance --json <<EOF
name: my-instance
attributes:
  subnetId: \${{ model.subnet-lookup.resource.data.output.attributes.json.SubnetId }}
  vpcId: \${{ model.vpc-lookup.resource.data.output.attributes.json.VpcId }}
EOF
```
