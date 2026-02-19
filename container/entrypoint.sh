#!/bin/bash
set -euo pipefail

# Remote Agent Container Entrypoint
# Runs OpenCode CLI with the given task, uploads results to S3

echo "=== Remote Agent Starting ==="
echo "Task ID: ${TASK_ID}"
echo "Timeout: ${TASK_TIMEOUT:-7200}s"
echo "Time: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Update task metadata to running
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BASELINE_COMMIT=""
WORK_DIR="/workspace"

upload_metadata() {
	local status=$1
	local exit_code=${2:-}
	local error_msg=${3:-}
	local completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

	# Truncate prompt to avoid issues with very large prompts from S3
	local short_prompt
	short_prompt=$(echo "${TASK_PROMPT:-}" | head -c 1000)

	local metadata
	metadata=$(jq -n \
		--arg taskId "$TASK_ID" \
		--arg status "$status" \
		--arg prompt "$short_prompt" \
		--arg startedAt "$STARTED_AT" \
		--arg completedAt "$completed_at" \
		--arg exitCode "${exit_code}" \
		--arg error "${error_msg}" \
		'{
            taskId: $taskId,
            status: $status,
            prompt: $prompt,
            startedAt: $startedAt,
            completedAt: $completedAt,
            exitCode: ($exitCode | if . == "" then null else tonumber end),
            error: (if $error == "" then null else $error end)
        }')

	echo "$metadata" | aws s3 cp - "s3://${S3_BUCKET}/tasks/${TASK_ID}/metadata.json" \
		--content-type "application/json" 2>/dev/null || true
}

upload_output() {
	local output_file=$1
	if [ -f "$output_file" ]; then
		aws s3 cp "$output_file" "s3://${S3_BUCKET}/tasks/${TASK_ID}/output.txt" \
			--content-type "text/plain" 2>/dev/null || true
	fi
}

# Trap for cleanup on exit
cleanup() {
	local exit_code=$?
	echo "=== Cleanup (exit code: $exit_code) ==="

	# Generate and upload change patch
	if [ -n "${BASELINE_COMMIT}" ]; then
		echo "=== Generating change patch ==="
		cd "${WORK_DIR}" 2>/dev/null || true

		# Stage all changes (new files, modifications, deletions)
		git add -A 2>/dev/null || true

		# Generate diff: baseline commit vs staged changes
		# Use --cached because we just staged everything
		local patch=""
		patch=$(git diff --cached "${BASELINE_COMMIT}" 2>/dev/null || echo "")

		if [ -n "$patch" ]; then
			echo "$patch" >/tmp/changes.patch
			local patch_size
			patch_size=$(wc -c </tmp/changes.patch)
			echo "Changes detected: ${patch_size} bytes"
			aws s3 cp /tmp/changes.patch \
				"s3://${S3_BUCKET}/tasks/${TASK_ID}/changes.patch" \
				--content-type "text/plain" 2>/dev/null || true
		else
			echo "No file changes detected."
		fi
	else
		echo "No baseline commit — skipping patch generation."
	fi

	if [ $exit_code -eq 0 ]; then
		upload_metadata "completed" "$exit_code"
	elif [ $exit_code -eq 124 ]; then
		upload_metadata "failed" "$exit_code" "Task timed out after ${TASK_TIMEOUT:-7200} seconds"
	else
		upload_metadata "failed" "$exit_code" "Task exited with code $exit_code"
	fi

	upload_output /tmp/agent-output.txt
	echo "=== Remote Agent Finished ==="
}
trap cleanup EXIT

# === Download workspace from S3 ===
if [ -n "${WORKSPACE_S3_KEY:-}" ]; then
	echo "=== Downloading workspace from S3 ==="
	aws s3 cp "s3://${S3_BUCKET}/${WORKSPACE_S3_KEY}" /tmp/workspace.tar.gz
	mkdir -p /workspace/repo
	tar -xzf /tmp/workspace.tar.gz -C /workspace/repo
	rm -f /tmp/workspace.tar.gz

	WORK_DIR="/workspace/repo"
	cd "${WORK_DIR}"

	file_count=$(find . -type f | wc -l)
	echo "Workspace extracted: ${file_count} files"

	# Initialize git repo for change tracking
	if [ ! -d .git ]; then
		git init
	fi
	git add -A
	git commit -m "Workspace baseline (pre-remote-agent)" --allow-empty 2>/dev/null || true
	BASELINE_COMMIT=$(git rev-parse HEAD)
	echo "Baseline commit: ${BASELINE_COMMIT}"

# === Clone git repo if specified (alternative to workspace upload) ===
elif [ -n "${GIT_REPO_URL:-}" ]; then
	echo "=== Cloning repository: ${GIT_REPO_URL} ==="
	git clone "${GIT_REPO_URL}" /workspace/repo

	WORK_DIR="/workspace/repo"
	cd "${WORK_DIR}"

	if [ -n "${GIT_BRANCH:-}" ]; then
		echo "Checking out branch: ${GIT_BRANCH}"
		git checkout "${GIT_BRANCH}"
	fi

	BASELINE_COMMIT=$(git rev-parse HEAD)
	echo "Repo cloned successfully. Baseline: ${BASELINE_COMMIT}"
	ls -la

# === No workspace — init empty git repo for change tracking ===
else
	echo "=== No workspace provided, initializing empty repo for change tracking ==="
	WORK_DIR="/workspace"
	cd "${WORK_DIR}"

	git init
	git commit --allow-empty -m "Empty baseline (no workspace)" 2>/dev/null || true
	BASELINE_COMMIT=$(git rev-parse HEAD)
	echo "Baseline commit: ${BASELINE_COMMIT}"
fi

# === Download auth credentials from S3 ===
# Auth is uploaded to S3 to avoid the 8KB ECS overrides limit.
# AUTH_FORMAT determines how the auth data is applied:
#   "opencode-auth" = Full OpenCode auth.json — written to ~/.local/share/opencode/auth.json
#   "env-vars"      = Simple key=value pairs — exported as env vars (direct API keys)
if [ -n "${AUTH_S3_KEY:-}" ]; then
	echo "=== Downloading auth from S3 ==="
	auth_json=$(aws s3 cp "s3://${S3_BUCKET}/${AUTH_S3_KEY}" - 2>/dev/null || echo "")
	if [ -n "$auth_json" ]; then
		if [ "${AUTH_FORMAT:-env-vars}" = "opencode-auth" ]; then
			# Write as OpenCode's native auth.json so `opencode run` picks it up
			OPENCODE_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
			mkdir -p "$OPENCODE_DATA_DIR"
			echo "$auth_json" >"$OPENCODE_DATA_DIR/auth.json"
			echo "Auth written to $OPENCODE_DATA_DIR/auth.json (OpenCode native format)"
			echo "Providers: $(echo "$auth_json" | jq -r 'keys | join(", ")')"
		else
			# Parse each key-value pair and export as env vars
			for key in $(echo "$auth_json" | jq -r 'keys[]'); do
				value=$(echo "$auth_json" | jq -r --arg k "$key" '.[$k]')
				export "$key"="$value"
			done
			echo "Auth loaded as env vars ($(echo "$auth_json" | jq -r 'keys | join(", ")'))"
		fi

		# Delete auth from S3 immediately — tokens should not persist
		aws s3 rm "s3://${S3_BUCKET}/${AUTH_S3_KEY}" 2>/dev/null || true
		echo "Auth deleted from S3"
	else
		echo "Warning: Failed to download auth from S3"
	fi
else
	echo "No AUTH_S3_KEY set — using auth from env vars"
fi

# === Download prompt from S3 (overrides TASK_PROMPT env var) ===
if [ -n "${PROMPT_S3_KEY:-}" ]; then
	echo "=== Downloading prompt from S3 ==="
	s3_prompt=$(aws s3 cp "s3://${S3_BUCKET}/${PROMPT_S3_KEY}" - 2>/dev/null || echo "")
	if [ -n "$s3_prompt" ]; then
		TASK_PROMPT="$s3_prompt"
		prompt_size=$(echo -n "$TASK_PROMPT" | wc -c)
		echo "Prompt loaded from S3: ${prompt_size} bytes"
	else
		echo "Warning: Failed to download prompt from S3, using fallback TASK_PROMPT env var"
	fi
fi

# === Determine model flag ===
# REMOTE_AGENT_MODEL controls which model OpenCode uses.
# Default to anthropic/claude-sonnet-4-5 — a capable, cost-effective model.
# Without this, OpenCode may pick an invalid default from its config.
REMOTE_AGENT_MODEL="${REMOTE_AGENT_MODEL:-anthropic/claude-sonnet-4-5}"
MODEL_FLAG="-m ${REMOTE_AGENT_MODEL}"
echo "Using model: ${REMOTE_AGENT_MODEL}"

# Run OpenCode with the task prompt
echo "=== Running OpenCode ==="
echo "Working directory: ${WORK_DIR}"
echo "Prompt length: $(echo -n "${TASK_PROMPT}" | wc -c) chars"
echo ""

# Use timeout to enforce max runtime
# OpenCode CLI in headless mode with `run` command (auto-approves all tool operations)
timeout "${TASK_TIMEOUT:-7200}" opencode run ${MODEL_FLAG} "${TASK_PROMPT}" \
	2>&1 | tee /tmp/agent-output.txt

echo ""
echo "=== OpenCode Finished ==="
