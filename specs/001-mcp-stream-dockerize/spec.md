# Feature Specification: MCP Stream HTTP + Dockerization

**Feature Branch**: `001-mcp-stream-dockerize`

**Created**: 2026-06-14

**Status**: Draft

**Input**: User description: "我有两个需求：一，给现在这个project的MCP加上Stream HTTP或SSE的支持，因为是在本地的网络运行，如果Stream HTTP必须要HTTPS的话，就走SSE，如果Stream HTTP可以不走HTTPS，用HTTP就可以的吧，就支持Stream HTTP。二，要求Dockerize这个。可以一个docker compose运行，并且要求完整的Docker image，不能运行把本地的项目路径mount进行运行。如果可以编译成二进制文件在Docker里运行最好，不行的话，在Docker里用python3运行也可以。"

## Clarifications

### Session 2026-06-14

- Q: Should the Stream HTTP endpoint require authentication? → A: Same Bearer token (`AGENTMEMORY_SECRET`) as the existing REST API.
- Q: Pre-built registry image or local build? → A: Local build via `docker compose build` — no registry publishing required for initial release.
- Q: Keep stdio transport in Docker image? → A: Yes — Docker image supports both stdio (`docker run` as MCP subprocess) and HTTP URL connections.
- Q: Default tool count in Docker? → A: All 53 tools (`AGENTMEMORY_TOOLS=all`) as the Docker compose default for the full experience.
- Q: How should AGENTMEMORY_SECRET be set in Docker? → A: Auto-generate on first boot (random secret), persist to `/data/.hmac` volume, display hint in startup logs.
- Q: [SDK research] Can Stream HTTP work over plain HTTP without SSE? → A: Yes — hand-rolled JSON-RPC server over Node.js `http` module, avoiding the `@modelcontextprotocol/sdk` body-parsing bug with chunked transfer encoding. SSE fallback is unnecessary.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - MCP Stream HTTP Transport (Priority: P1)

An MCP client (such as Claude Code, Cursor, or any MCP-compatible host) connects to agentmemory over HTTP to list and call memory tools. Instead of being limited to stdio (subprocess-based) connections, the client opens an HTTP connection to the agentmemory server and receives responses via a streaming transport — the server processes tool calls and streams results back incrementally as they become available, without waiting for the complete response. Since the deployment runs on a local network, the transport operates over plain HTTP (not HTTPS).

**Why this priority**: This is the foundational change — without it, MCP clients are restricted to stdio connections, which prevents remote/containerized deployments and limits the integration options available to users. All existing MCP tool functionality (memory CRUD, search, sessions, etc.) must be accessible through this new transport.

**Independent Test**: Start the agentmemory server with Stream HTTP enabled, send an MCP `initialize` request via `curl` to the stream endpoint, receive a valid JSON-RPC response with server capabilities, then call `tools/list` and `tools/call` over the same HTTP connection. Verify all 53 tools are listed and callable.

**Acceptance Scenarios**:

1. **Given** agentmemory server is running with Stream HTTP transport enabled, **When** an MCP client sends a JSON-RPC `initialize` request to the stream endpoint, **Then** the server responds with protocol version and capabilities including `tools: {}` support.
2. **Given** an initialized MCP session over Stream HTTP, **When** the client calls `tools/list`, **Then** the server returns the full list of available tools (53 tools with all features enabled).
3. **Given** an initialized MCP session over Stream HTTP, **When** the client calls `tools/call` with tool name `memory_search` and valid arguments, **Then** the server executes the search and returns the results as a JSON-RPC response.
4. **Given** both Stream HTTP and stdio transports are available, **When** a client connects via either transport, **Then** both transports expose the identical set of tools with identical behavior.

---

### User Story 2 - Docker Compose Deployment (Priority: P2)

A user wants to run agentmemory entirely in containers without cloning the source repository. They run a single `docker compose up` command, and the full stack starts — the agentmemory application and its iii-engine dependency — all from pre-built Docker images. No source code directories are bind-mounted into the containers; everything is baked into the images.

**Why this priority**: Dockerization makes agentmemory deployable anywhere Docker runs, without Node.js or npm prerequisites. This unlocks production deployments, CI/CD integration, and self-hosted usage.

**Independent Test**: On a machine with only Docker and docker-compose installed (no Node.js, no cloned repo), run `docker compose up`, wait for the services to report healthy, then `curl http://localhost:3111/agentmemory/livez` and receive `{"status": "ok"}`. Then use an MCP client to connect to the Stream HTTP endpoint and perform a memory save and recall.

**Acceptance Scenarios**:

1. **Given** Docker and docker-compose are installed, **When** the user runs `docker compose up`, **Then** both the iii-engine and agentmemory containers start and reach a healthy state.
2. **Given** the stack is running via docker compose, **When** the user sends a request to the MCP Stream HTTP endpoint, **Then** the request is processed successfully with streaming responses.
3. **Given** the agentmemory container, **When** inspected, **Then** no source code directories are bind-mounted; the application and all dependencies are self-contained in the image.
4. **Given** the docker compose stack is stopped and restarted, **When** the user runs `docker compose down` then `docker compose up`, **Then** previously stored memory data persists (via a named Docker volume).

---

### User Story 3 - Single-Command Setup for New Users (Priority: P3)

A new user with no prior agentmemory installation wants to get started. They download the `docker-compose.yml` file, run `docker compose up`, and within seconds the service is ready. They configure their MCP client with a single HTTP URL (no subprocess paths, no `npx` commands) and immediately have working memory in their AI coding sessions.

**Why this priority**: Streamlined onboarding removes friction for adoption. This is the "it just works" story that turns a complex multi-step setup into two commands.

**Independent Test**: On a fresh machine, create a new directory, download `docker-compose.yml`, run `docker compose up`, then configure any MCP client with `http://localhost:<port>/mcp` as the connection URL and verify memory tools are available and functional.

**Acceptance Scenarios**:

1. **Given** a fresh environment with only Docker, **When** the user obtains the `docker-compose.yml` and runs `docker compose up`, **Then** within 30 seconds the service is ready to accept MCP connections.
2. **Given** the server is running in Docker, **When** the user follows setup instructions to connect their MCP client via HTTP URL, **Then** the client successfully connects and lists all memory tools.
3. **Given** the server is running in Docker, **When** the user checks the Docker image size, **Then** the agentmemory image is reasonably compact and optimized (no unnecessary build tools, no source code, no `node_modules` bloat).

---

### Edge Cases

- What happens when the iii-engine container starts after the agentmemory container? The agentmemory container must retry the engine connection with backoff until the engine is ready.
- How does the system handle concurrent MCP clients over Stream HTTP? Multiple clients must be able to maintain independent sessions simultaneously.
- What happens when a Stream HTTP connection is dropped mid-stream? The server must clean up session resources and not leak connections.
- How does the server behave when a client sends an invalid JSON-RPC message? Return a proper JSON-RPC error response without crashing.
- What happens to stored memory data when the Docker containers are rebuilt or updated? Data persists in the Docker volume and survives image updates.
- How does the container handle graceful shutdown when `docker compose down` is issued? Connections must close cleanly and data must be flushed.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The MCP server MUST support the Streamable HTTP transport as defined by the MCP specification, operating over plain HTTP — using a hand-rolled JSON-RPC server for direct JSON responses.
- **FR-002**: The new HTTP-based MCP transport MUST expose all existing tools (53 tools with `AGENTMEMORY_TOOLS=all`) with identical inputs and outputs as the existing stdio transport.
- **FR-003**: The existing stdio transport (JSON-RPC 2.0 over stdin/stdout) MUST continue to function alongside the new HTTP transport — both transports must coexist, including when running from within the Docker container.
- **FR-004**: The system MUST provide a complete Docker image for the agentmemory application that contains all runtime dependencies and the built application — no source code or `node_modules` directory mount from the host.
- **FR-005**: The system MUST provide a `docker-compose.yml` that defines and orchestrates both the agentmemory and iii-engine services, including correct startup ordering and health checks.
- **FR-006**: The Docker deployment MUST persist memory data in a named Docker volume, surviving container restarts and image updates.
- **FR-007**: The agentmemory container MUST gracefully handle the iii-engine container starting after it, with connection retries.
- **FR-008**: The MCP Stream HTTP endpoint MUST support concurrent client connections, each with independent session state.
- **FR-009**: Graceful shutdown MUST be handled — connections closed and data flushed on termination signals.
- **FR-010**: The Stream HTTP endpoint MUST require the same Bearer token authentication (`AGENTMEMORY_SECRET`) as the existing REST API, ensuring consistent access control across all transports.
- **FR-011**: The docker-compose.yml MUST default to exposing all 53 MCP tools (`AGENTMEMORY_TOOLS=all`) for a complete out-of-box experience.
- **FR-012**: On first container startup, if `AGENTMEMORY_SECRET` is not set, the container MUST auto-generate a random secret, persist it to a file on the data volume, and log instructions for retrieving it.

### Key Entities

- **MCP Session**: Represents an active client connection over the Stream HTTP transport. Key attributes: session identifier, initialization state, client capabilities, negotiated protocol version.
- **Docker Service (agentmemory)**: The containerized agentmemory application. Depends on the iii-engine service. Exposes MCP and API ports.
- **Docker Service (iii-engine)**: The containerized iii-engine backend. Provides state storage, pub/sub, and HTTP worker infrastructure to agentmemory.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An MCP client can connect to agentmemory over HTTP, complete initialization, list tools, and call any tool — all without using stdio or spawning a subprocess.
- **SC-002**: All 53 MCP tools are accessible and functional through the new HTTP-based transport.
- **SC-003**: A user with only Docker installed can go from zero to a running agentmemory instance with a single `docker compose up` command.
- **SC-004**: The agentmemory Docker image contains no source code and requires no host directory mounts to function.
- **SC-005**: Memory data persists across `docker compose down && docker compose up` cycles.
- **SC-006**: The system handles at least 5 concurrent MCP client connections over Stream HTTP without errors or throughput degradation.
- **SC-007**: The existing stdio-based MCP transport continues to pass all existing tests after the HTTP transport is added.

## Assumptions

- The MCP Streamable HTTP transport is implemented as a hand-rolled JSON-RPC server using Node.js `http` module (not using `@modelcontextprotocol/sdk`) because the SDK's `NodeStreamableHTTPServerTransport` has a body-parsing bug with chunked transfer encoding.
- The `iii-engine` Docker image (`iiidev/iii:0.11.2`) remains the dependency — this feature does not modify or rebuild the iii-engine.
- The Stream HTTP endpoint (`POST /mcp`) is served on port 3114, separate from the existing REST API on port 3111.
- The existing deploy templates in `deploy/` (Fly, Railway, Render, Coolify) are out of scope for this feature — only a new Docker Compose setup targeting local/Docker-host deployments is required.
- Node.js is the runtime for the Docker image. Binary compilation via tools like Bun or `pkg` may be explored but is not required.
- The Docker image is built locally via `docker compose build` — no container registry publishing is required for the initial release. The `docker-compose.yml` includes the build context and Dockerfile reference.
