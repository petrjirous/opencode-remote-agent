# opencode-remote-agent

An [OpenCode](https://opencode.ai) plugin that runs OpenCode agent tasks on ephemeral AWS ECS Fargate containers. Offload long-running coding tasks -- refactors, migrations, test suites, full feature builds -- to the cloud while you keep working locally.

Works on **macOS** and **Linux**.

## How it works

```
Local (OpenCode)                          AWS Cloud
+-----------------+                       +------------------+
| 1. Package      |  --- S3 upload --->   | 3. ECS Fargate   |
|    workspace    |                       |    container     |
| 2. Upload       |                       |    runs OpenCode |
|    prompt +     |                       |    CLI (headless)|
|    session      |                       |                  |
|    context      |  <-- S3 download ---  | 4. Git patch     |
| 5. Apply patch  |                       |    uploaded      |
+-----------------+                       +------------------+
```

1. Your local workspace is packaged (respecting `.gitignore`) and uploaded to S3
2. Current session context is extracted so the remote agent knows what you've discussed
3. An ECS Fargate container starts with OpenCode CLI and your codebase
4. When done, a `git diff` patch of all file changes is uploaded to S3
5. You download the patch and apply it locally with `git apply`

## Quickstart

### Prerequisites

- [OpenCode](https://opencode.ai) installed
- [AWS CLI](https://aws.amazon.com/cli/) configured (`aws configure`)
- [Docker](https://www.docker.com/) installed and running
- [Node.js](https://nodejs.org/) 22+
- An API key or OAuth login for your AI provider (Anthropic, OpenAI, etc.)

### 1. Install the plugin

```bash
# In your OpenCode config directory
cd ~/.config/opencode
npm install opencode-remote-agent
```

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-remote-agent"]
}
```

### 2. Deploy AWS infrastructure

From inside OpenCode, use the slash command:

```
/remote-setup
```

Or do it manually:

```bash
# Clone and build
git clone https://github.com/petrjirous/opencode-remote-agent.git
cd opencode-remote-agent
npm install
npm run build

# Bootstrap CDK (one-time, replace ACCOUNT and REGION)
npx cdk bootstrap aws://ACCOUNT_ID/REGION

# Deploy
npm run cdk:deploy
```

The CDK stack creates: VPC, ECS Fargate cluster, ECR repository, S3 bucket, CloudWatch log group, and IAM roles.

### 3. Build and push the Docker image

```bash
# Authenticate Docker with ECR
aws ecr get-login-password --region REGION | \
  docker login --username AWS --password-stdin ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com

# Build and push
docker build --platform linux/amd64 -t ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/remote-agent:latest .
docker push ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/remote-agent:latest
```

### 4. Configure (mostly automatic)

The plugin **auto-discovers** your infrastructure from the CloudFormation stack. You only need to set the region (if not `us-east-1`):

```bash
export REMOTE_AGENT_AWS_REGION="us-east-1"    # Your AWS region
export REMOTE_AGENT_AWS_PROFILE="default"      # AWS CLI profile (optional)
```

That's it. The plugin queries the `RemoteAgentStack` CloudFormation stack to find the S3 bucket, ECS cluster, subnets, security group, and ECR image automatically.

You can override any value with env vars if needed (see [Configuration](#configuration) below).

### 5. Use it

In OpenCode, ask the agent to run something remotely:

```
Use remote_run to refactor the auth module to use JWT tokens
```

Or use slash commands:

```
/remote-run Refactor the auth module to use JWT tokens
/remote-list
/remote-status TASK_ID
/remote-cancel TASK_ID
```

## Tools

| Tool | Description |
|------|-------------|
| `remote_run` | Launch a task on a remote Fargate container |
| `remote_status` | Check task status, view output, apply patch |
| `remote_list` | List all remote tasks |
| `remote_cancel` | Cancel a running task |
| `remote_setup` | Deploy/update/destroy AWS infrastructure |

## Slash commands

| Command | Description |
|---------|-------------|
| `/remote-run <prompt>` | Quick-launch a remote task |
| `/remote-status <id>` | Check task status |
| `/remote-list` | List all tasks |
| `/remote-cancel <id>` | Cancel a running task |
| `/remote-setup` | Deploy infrastructure |

## Configuration

After deploying with CDK, the plugin **auto-discovers infrastructure** from the CloudFormation stack outputs. No manual configuration is needed beyond region and profile.

Environment variable overrides (all optional if CDK stack is deployed):

| Variable | Default | Description |
|----------|---------|-------------|
| `REMOTE_AGENT_AWS_REGION` | `us-east-1` | AWS region |
| `REMOTE_AGENT_AWS_PROFILE` | `default` | AWS CLI profile name |
| `REMOTE_AGENT_S3_BUCKET` | *(auto)* | S3 bucket for results |
| `REMOTE_AGENT_ECS_CLUSTER` | *(auto)* | ECS cluster name |
| `REMOTE_AGENT_CONTAINER_IMAGE` | *(auto)* | ECR image URI |
| `REMOTE_AGENT_SUBNET_IDS` | *(auto)* | Comma-separated subnet IDs |
| `REMOTE_AGENT_SECURITY_GROUP_ID` | *(auto)* | Security group ID |
| `REMOTE_AGENT_PROVIDER` | `anthropic` | AI provider from OpenCode auth |
| `REMOTE_AGENT_MODEL` | `anthropic/claude-sonnet-4-5` | Model in `provider/model` format |

## Authentication

The plugin forwards your AI provider credentials to the remote container. It looks for credentials in this order:

1. `ANTHROPIC_API_KEY` environment variable
2. `OPENAI_API_KEY` environment variable
3. `REMOTE_AGENT_AUTH_TOKEN` environment variable (explicit override for any provider)
4. OpenCode auth file at `~/.local/share/opencode/auth.json` (automatic if you've run `opencode auth login`)

Set `REMOTE_AGENT_PROVIDER` to choose which provider to read from the auth file (default: `anthropic`).

### Supported providers

| Provider | Env var (direct key) | Auth file key |
|----------|---------------------|---------------|
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic` |
| OpenAI | `OPENAI_API_KEY` | `openai` |
| GitHub Copilot | `GITHUB_TOKEN` | `github-copilot` |
| Groq | `GROQ_API_KEY` | `groq` |
| Google Gemini | `GEMINI_API_KEY` | `gemini` |

## How the remote container works

- Runs `opencode run` with your prompt in headless mode
- OpenCode executes in full agentic mode (reads, writes, and edits files)
- All file changes are tracked via git and captured as a unified diff patch
- The patch, output, and metadata are uploaded to S3
- You can apply the patch locally with `git apply`

## Resource configuration

The `remote_run` tool accepts optional parameters:

- **`cpu`**: `256` (0.25 vCPU) to `4096` (4 vCPU). Default: `1024`
- **`memory`**: `512` MB to `30720` MB. Default: `4096`
- **`timeout_minutes`**: 1 to 720 (12 hours). Default: `120` (2 hours)
- **`include_workspace`**: Upload local files to container. Default: `true`
- **`include_session_context`**: Include conversation history. Default: `true`
- **`repo_url`**: Clone a git repo instead of uploading workspace

## Cost estimate

- **ECS Fargate** (1 vCPU, 4 GB): ~$0.04/hour
- **S3**: negligible for typical workspace sizes
- **CloudWatch Logs**: negligible
- **No NAT Gateway** -- the VPC uses public subnets only to avoid the ~$32/month NAT cost

A typical 10-minute task costs less than $0.01 in AWS charges (plus AI provider API usage).

## Cleanup

To remove all AWS resources:

```bash
cd opencode-remote-agent
npm run cdk:destroy
```

Or from OpenCode: `/remote-setup destroy`

## License

MIT
