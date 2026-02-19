# Remote Agent Container
# Runs OpenCode CLI with a task prompt, uploads results to S3
FROM node:22-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    jq \
    python3 \
    python3-pip \
    unzip \
    ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Install AWS CLI v2
RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" \
    && unzip awscliv2.zip \
    && ./aws/install \
    && rm -rf aws awscliv2.zip

# Install OpenCode CLI
RUN npm install -g opencode-ai

# Create non-root user
RUN useradd -m -s /bin/bash agent

# Create workspace directory owned by agent
RUN mkdir -p /workspace && chown agent:agent /workspace

# Copy the entrypoint script
COPY container/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Switch to non-root user
USER agent
WORKDIR /workspace

# Configure git for change tracking (as agent user)
RUN git config --global user.name "remote-agent" && \
    git config --global user.email "remote-agent@opencode.local" && \
    git config --global init.defaultBranch main

# Set default environment
ENV OPENCODE=1

ENTRYPOINT ["/entrypoint.sh"]
