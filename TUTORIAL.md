# Setup Tutorial

Step-by-step guide to get `opencode-remote-agent` running from scratch.

## Prerequisites

| Tool | Install |
|------|---------|
| OpenCode | [opencode.ai](https://opencode.ai) |
| AWS CLI v2 | `brew install awscli` / `apt install awscli` / [aws.amazon.com/cli](https://aws.amazon.com/cli/) |
| Docker | [docker.com](https://www.docker.com/products/docker-desktop/) |
| Node.js 22+ | [nodejs.org](https://nodejs.org/) |
| AI provider credentials | API key or `opencode auth login` |

## Step 1: AWS credentials

If you don't have an AWS account, create one at [aws.amazon.com](https://aws.amazon.com).

Create an IAM user with programmatic access and these policies:
- `AmazonECS_FullAccess`
- `AmazonS3FullAccess`
- `AmazonEC2ContainerRegistryFullAccess`
- `CloudWatchLogsFullAccess`
- `AmazonVPCFullAccess`
- `AmazonSSMFullAccess`
- `IAMFullAccess` (needed for CDK to create roles)

Configure the AWS CLI:

```bash
aws configure
# Enter your Access Key ID, Secret Access Key, region (e.g., us-east-1), and output format (json)
```

## Step 2: Install the plugin in OpenCode

```bash
cd ~/.config/opencode
npm install opencode-remote-agent
```

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-remote-agent"]
}
```

## Step 3: Clone and build (for infrastructure deployment)

```bash
git clone https://github.com/petrjirous/opencode-remote-agent.git
cd opencode-remote-agent
npm install
npm run build
```

## Step 4: Bootstrap CDK

This is a one-time setup per AWS account/region:

```bash
npx cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/$(aws configure get region)
```

## Step 5: Deploy infrastructure

```bash
npm run cdk:deploy
```

This creates:
- VPC with 2 public subnets (no NAT gateway to save cost)
- ECS Fargate cluster
- ECR container registry
- S3 bucket for results (30-day lifecycle)
- CloudWatch log group
- IAM roles for ECS task execution

The deployment prints output values you'll need in Step 7.

## Step 6: Build and push the Docker image

```bash
# Get your account ID and region
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region)

# Login to ECR
aws ecr get-login-password --region $REGION | \
  docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$REGION.amazonaws.com

# Build for linux/amd64 (required for Fargate)
docker build --platform linux/amd64 \
  -t $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/remote-agent:latest .

# Push
docker push $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/remote-agent:latest
```

## Step 7: Set environment variables

Add to your `~/.zshrc` or `~/.bashrc` (values from CDK output in Step 5):

```bash
export REMOTE_AGENT_AWS_REGION="us-east-1"
export REMOTE_AGENT_AWS_PROFILE="default"
export REMOTE_AGENT_S3_BUCKET="remote-agent-results-ACCOUNT-REGION"
export REMOTE_AGENT_ECS_CLUSTER="remote-agent-cluster"
export REMOTE_AGENT_CONTAINER_IMAGE="ACCOUNT.dkr.ecr.REGION.amazonaws.com/remote-agent:latest"
export REMOTE_AGENT_SUBNET_IDS="subnet-xxx,subnet-yyy"
export REMOTE_AGENT_SECURITY_GROUP_ID="sg-xxx"

# Optional: choose AI provider and model
# export REMOTE_AGENT_PROVIDER="anthropic"
# export REMOTE_AGENT_MODEL="anthropic/claude-sonnet-4-5"
```

Reload your shell: `source ~/.zshrc` (or `source ~/.bashrc` on Linux)

## Step 8: Test it

Open OpenCode in a project directory and try:

```
/remote-list
```

You should see "No remote tasks found." -- which means the plugin loaded and can talk to S3.

Now launch a test task:

```
/remote-run Create a hello world Python script
```

Check status after ~1 minute:

```
/remote-list
```

## Authentication

The plugin reads credentials in this order:

1. `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` environment variable
2. `REMOTE_AGENT_AUTH_TOKEN` environment variable (explicit override)
3. OpenCode auth file at `~/.local/share/opencode/auth.json`

If you've already run `opencode auth login`, credentials are picked up automatically. Set `REMOTE_AGENT_PROVIDER` to choose the provider (default: `anthropic`).

## Troubleshooting

### "Remote agent infrastructure is not set up yet"
The `REMOTE_AGENT_CONTAINER_IMAGE` env var is not set. Make sure you completed Step 7 and reloaded your shell.

### "Failed to launch ECS task"
Check that your subnets have internet access (public subnets with an internet gateway) and that the security group allows outbound traffic.

### Container exits with code 1
Check CloudWatch logs at `/ecs/remote-agent` in your AWS Console. Common causes:
- Auth token expired -- run `opencode auth login` to refresh
- Image not pushed -- make sure Step 6 completed
- Wrong provider -- set `REMOTE_AGENT_PROVIDER` to match your available credentials

### "Refusing to package workspace"
Run OpenCode from a project directory, not `/` or your home directory.

## Cleanup

To remove all AWS resources and stop incurring charges:

```bash
cd opencode-remote-agent
npm run cdk:destroy
```

The S3 bucket will be emptied and deleted automatically.
