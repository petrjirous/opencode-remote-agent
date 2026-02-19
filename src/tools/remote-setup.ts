import { tool } from "@opencode-ai/plugin";
import { loadConfig, resetConfigCache } from "../config.js";
import { verifyAwsCredentials } from "../aws/client.js";
import { execSync } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

export const remoteSetupTool = tool({
  description:
    "Deploy or update the AWS infrastructure needed for running remote agent tasks. " +
    "This uses AWS CDK to create an ECS Fargate cluster, S3 bucket, ECR repository, " +
    "VPC, IAM roles, and CloudWatch log group. Run this once to set up, or again to update. " +
    "Requires AWS CLI credentials to be configured.",
  args: {
    region: tool.schema
      .string()
      .optional()
      .describe("AWS region to deploy to (default: us-east-1)"),
    profile: tool.schema
      .string()
      .optional()
      .describe("AWS CLI profile to use (default: default)"),
    action: tool.schema
      .enum(["deploy", "status", "destroy"])
      .optional()
      .describe(
        "Action to perform: deploy (create/update infra), status (check current state), " +
          "destroy (tear down all resources). Default: deploy",
      ),
  },
  async execute(args, context) {
    const action = args.action ?? "deploy";
    context.metadata({ title: `Remote agent infra: ${action}...` });

    const config = loadConfig({
      awsRegion: args.region,
      awsProfile: args.profile,
    });

    // Verify AWS credentials
    try {
      const identity = await verifyAwsCredentials(config);
      context.metadata({
        title: `AWS account: ${identity.account} — ${action}ing...`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return (
        `Error: Could not verify AWS credentials. ${message}\n\n` +
        `Make sure you have:\n` +
        `1. AWS CLI installed and configured\n` +
        `2. A valid profile in ~/.aws/credentials\n` +
        `3. Permissions to create ECS, S3, ECR, VPC, IAM resources`
      );
    }

    // Find the project root (three levels up from dist/src/tools/)
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const projectRoot = resolve(__dirname, "..", "..", "..");
    const cdkApp = resolve(projectRoot, "dist", "infra", "app.js");

    const cdkEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      AWS_REGION: config.awsRegion,
      REMOTE_AGENT_AWS_PROFILE: config.awsProfile,
    };

    try {
      let output: string;

      switch (action) {
        case "deploy": {
          output = execSync(
            `npx cdk deploy --require-approval never --outputs-file cdk-outputs.json --app "node ${cdkApp}"`,
            {
              encoding: "utf-8",
              env: cdkEnv,
              timeout: 600000, // 10 min timeout for deploy
              cwd: projectRoot,
            },
          );

          // Reset config cache so next tool call picks up new outputs
          resetConfigCache();

          return [
            `## Infrastructure Deployed Successfully`,
            ``,
            `The following AWS resources have been created/updated:`,
            `- ECS Fargate Cluster`,
            `- ECR Container Registry`,
            `- S3 Results Bucket`,
            `- VPC with public subnets`,
            `- IAM execution roles`,
            `- CloudWatch Log Group`,
            ``,
            `Next steps:`,
            `1. Build and push the Docker image (see TUTORIAL.md)`,
            `2. Update your config with the CDK outputs`,
            `3. Use remote_run to launch tasks!`,
            ``,
            `CDK output:`,
            `\`\`\``,
            output.slice(-2000),
            `\`\`\``,
          ].join("\n");
        }

        case "status": {
          output = execSync(
            `npx cdk diff --app "node ${cdkApp}" 2>&1 || true`,
            {
              encoding: "utf-8",
              env: cdkEnv,
              timeout: 120000,
              cwd: projectRoot,
            },
          );

          return [
            `## Infrastructure Status`,
            ``,
            `\`\`\``,
            output.slice(-3000),
            `\`\`\``,
          ].join("\n");
        }

        case "destroy": {
          output = execSync(
            `npx cdk destroy --force --app "node ${cdkApp}"`,
            {
              encoding: "utf-8",
              env: cdkEnv,
              timeout: 600000,
              cwd: projectRoot,
            },
          );

          return [
            `## Infrastructure Destroyed`,
            ``,
            `All remote agent AWS resources have been removed.`,
            ``,
            `\`\`\``,
            output.slice(-2000),
            `\`\`\``,
          ].join("\n");
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error during CDK ${action}: ${message}`;
    }
  },
});
