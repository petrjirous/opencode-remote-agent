#!/usr/bin/env npx ts-node
import * as cdk from "aws-cdk-lib";
import { RemoteAgentStack } from "./stack.js";

const app = new cdk.App();

new RemoteAgentStack(app, "RemoteAgentStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
  resourcePrefix: process.env.REMOTE_AGENT_PREFIX ?? "remote-agent",
  description: "Infrastructure for running OpenCode agent tasks on ECS Fargate",
});

app.synth();
