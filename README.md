# Cloudflare Alt: Self-Hosted Cloudflare Infrastructure Managed from Cloudflare Edge

A complete architectural specification, analysis of GitHub prior art, and reference implementation for self-hosting alternatives to Cloudflare's expensive services (**R2 Object Storage, Compute/Containers, Workers, Durable Objects, and Workers CI**) while maintaining the **dashboard and management plane hosted directly on Cloudflare Workers and Pages**.

---

## 1. Executive Overview

Cloudflare's serverless edge provides global low-latency routing, DDoS mitigation, and edge compute. However, data-intensive and compute-heavy primitives quickly encounter severe cost or execution limits:

| Cloudflare Service | Constraint / Pain Point | Self-Hosted Alternative | Benefit |
| :--- | :--- | :--- | :--- |
| **Storage (R2)** | $4.50 / million Class A operations | **Garage S3** (`deuxfleurs-org/garage`) | Low-memory (~50MB), WAN-tolerant CRDT, zero op charges |
| **Compute / Containers** | No raw Linux, no root, no long-running daemons | **Docker Engine + gVisor (`runsc`)** / **Nomad** | Unrestricted multi-hour compute, DinD, custom kernels |
| **Workers Runtime** | 30s CPU limit, invocation billing | **`cloudflare/workerd`** standalone | Native Workers API, unmetered CPU, zero invocation fee |
| **Durable Objects (DO)** | Cost scales with connection count and active memory | **`workerd`** (SQLite backend) or **`libSQL/sqld`** | Co-located SQLite per object, hibernated WebSockets |
| **Workers CI** | Strict serverless concurrency & environment caps | **Woodpecker CI** (`woodpecker-ci/woodpecker`) | Native DinD, multi-gigabyte cache mounts, live SSE logs |

### The Core Invariant
- **Management Plane**: Hosted on **Cloudflare Pages (SPA)** + **Cloudflare Workers (API Gateway)** + **D1 / KV**.
- **Data & Compute Plane**: Self-hosted on bare-metal servers (Hetzner, OVH), home labs, or spot VPS.
- **Secure Networking**: Connected via **Cloudflare Tunnels (`cloudflared`)** with **Cloudflare Access Service Tokens**. Zero open inbound firewall ports.
- **Restricted Sandbox Fallback**: Powered by **`talaria0101/cfrs`** for userspace networking and quick tunnels where `cloudflared` cannot run.

---

## 2. Repository Navigation & Specifications

| Document | Description |
| :--- | :--- |
| **[`spec/01-architecture-overview.md`](spec/01-architecture-overview.md)** | End-to-end system design, push vs. pull vs. mirrored models, and threat model. |
| **[`spec/02-compute-sandbox-orchestration.md`](spec/02-compute-sandbox-orchestration.md)** | Docker API, Nomad, Amika analysis, mirrord context mirroring, and cfrs userspace VNet. |
| **[`spec/03-self-hosting-workerd-and-workers.md`](spec/03-self-hosting-workerd-and-workers.md)** | Standalone `cloudflare/workerd`, Cap'n Proto config, SQLite Durable Objects, and `workerLoader`. |
| **[`spec/04-storage-r2-and-durable-objects.md`](spec/04-storage-r2-and-durable-objects.md)** | Garage S3 vs SeaweedFS, edge-assisted S3 presigning, and distributed SQLite (`libSQL`). |
| **[`spec/05-heavy-ci-runner-system.md`](spec/05-heavy-ci-runner-system.md)** | Woodpecker CI engine, edge webhook HMAC verification, and zero-buffering SSE log proxy. |
| **[`spec/06-github-tools-critique.md`](spec/06-github-tools-critique.md)** | Technical evaluation of 17 GitHub projects including Amika, mirrord, cfrs, ServerBee, Homelable, OmnySSH. |

---

## 3. Reference Architecture

```
                                  PUBLIC INTERNET / OPERATOR SURFACES
                                                   │
                  ┌────────────────────────────────┴────────────────────────────────┐
                  │                                                                 │
                  ▼                                                                 ▼
      ┌───────────────────────┐                                         ┌───────────────────────┐
      │  Developer / Admin    │                                         │   Git Webhook Source  │
      │  Browser (SPA Client) │                                         │    (GitHub / GitLab)  │
      └───────────┬───────────┘                                         └───────────┬───────────┘
                  │                                                                 │
                  │ HTTPS / WSS                                                     │ POST Webhook
                  ▼                                                                 ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   CLOUDFLARE EDGE CONTROL PLANE                                   │
│                                                                                                   │
│  [Cloudflare Pages: Single-Page Dashboard]                                                        │
│    - Topology Visualizer: Interactive network and container graph (Homelable pattern).            │
│    - Multi-Server Manager: Aggregated status, uptime tracking, and service bookmarks (CoreObs).  │
│    - Web SFTP & Terminal: Dual-pane remote file browser and tabbed shell (OmnySSH pattern).       │
│    - Live Telemetry Viewer: Real-time CPU, RAM, network, and process stream (ServerBee pattern).  │
│                                                                                                   │
│  [Cloudflare Worker: API Gateway & Router]                                                        │
│    - Authentication: Cloudflare Zero Trust Access JWT validation & RBAC.                          │
│    - Secret Store: Environment bindings for Cloudflare Access Service Tokens.                    │
│    - Webhook Dispatcher: Verifies HMAC-SHA256 signatures; routes pipeline triggers to CI.         │
│    - S3 Presigner: Generates AWS SigV4 presigned URLs for direct browser-to-node storage uploads. │
│    - SSE Log Streamer: Passes through real-time build logs with zero edge buffering.              │
│    - Snippets Runner: Executes parameterized operational scripts stored in Cloudflare KV.         │
│                                                                                                   │
│  [Cloudflare Durable Objects: State Hub & Tunnel Multiplexer]                                     │
│    - Persistent multiplexing hub (implementing @amika/tunnel-protocol v2).                       │
│    - Maintains persistent connection state using WebSocket Hibernation API (zero idle CPU cost). │
│    - Telemetry aggregator piping ServerBee probe metrics to active dashboard clients.             │
└─────────────────────────────────────────────────┬─────────────────────────────────────────────────┘
                                                  │
                                                  │ Cloudflare Tunnel (QUIC / HTTP/2 Transport)
                                                  │ Fallback: cfrs quick-tunnel over SSH/CONNECT
                                                  │ Authenticated via CF-Access-Client-Id / Secret
                                                  ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                  REMOTE DATA PLANE (HOST MACHINE)                                 │
│                                                                                                   │
│  [Tunnel Ingress: cloudflared / cfrs]                                                             │
│    - cloudflared: Outbound encrypted QUIC tunnel to Cloudflare Edge.                              │
│    - cfrs (Fallback): Rust quick-tunnel + userspace networking for restricted sandboxes.          │
│                                                                                                   │
│  ┌───────────────────────────────┬───────────────────────────────┬─────────────────────────────┐  │
│  │     CONTAINER & COMPUTE       │        STORAGE PLANE          │     WORKERS & RUNTIMES      │  │
│  │                               │                               │                             │  │
│  │ • Docker Engine via           │ • Garage S3                   │ • cloudflare/workerd        │  │
│  │   docker-socket-proxy         │   - Lightweight Rust S3       │   - Open-source V8 runtime  │  │
│  │ • HashiCorp Nomad             │   - WAN-tolerant CRDT         │   - Persistent SQLite DOs   │  │
│  │ • Sandboxes: gVisor (runsc)   │   - 50MB RAM footprint        │   - Hibernated WebSockets   │  │
│  │ • Amika Agent / hostd         │ • SeaweedFS / libSQL          │   - workerLoader hot-reload │  │
│  │ • mirrord Agent: traffic &    │ • Remote File Bridge: Web     │ • Embedded SQL API          │  │
│  │   env mirroring to local dev  │   SFTP service (OmnySSH)      │   (state.storage.sql)       │  │
│  ├───────────────────────────────┴───────────────────────────────┴─────────────────────────────┤  │
│  │                        OBSERVABILITY, TELEMETRY & RUNNER ENGINES                            │  │
│  │ • ServerBee Agent: 10MB Rust probe streaming CPU, RAM, disk, and process trees over WS     │  │
│  │ • Woodpecker CI Server (REST / Webhook / SSE)                                               │  │
│  │ • Woodpecker Agents (Docker-in-Docker, multi-stage builders, local pipelines)               │  │
│  └─────────────────────────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Key Architectural Patterns & Findings

### 1. `gofixpoint/amika` and `@amika/tunnel-protocol`
- **What it is**: Open-source infrastructure for on-demand coding workstations ("Rigs").
- **Key Insight**: Its core tunneling package (`@amika/tunnel-protocol`) uses zero Node.js dependencies (`Uint8Array`, `DataView`, `TextEncoder`) and was explicitly authored to execute inside Cloudflare Workers and Durable Objects.
- **Loopback SSH Security**: In-guest daemon `amikad` binds OpenSSH to `127.0.0.1:22` and pipes bytes over authenticated WebSockets (`/v1/ssh-sessions`), avoiding raw port 22 exposure.
- **Zero-Cost Sleep**: Host sends periodic ping strings (`amika.tunnel.v2.ping`), which Cloudflare Durable Objects answer via `setWebSocketAutoResponse` without waking the isolate.

### 2. Standalone `cloudflare/workerd`
- Cloudflare's own runtime can be deployed on Linux servers (`ghcr.io/cloudflare/workerd:latest`).
- By setting `durableObjectStorage = (localDisk = "diskService")` and `enableSql = true`, `workerd` automatically backs every Durable Object instance with an **embedded SQLite database on disk**, granting relational SQL query execution (`state.storage.sql.exec`).
- Supports **hibernatable WebSockets** (`state.acceptWebSocket()`), dropping memory consumption to near zero during idle connection states.

### 3. Remote Context & Traffic Mirroring (`metalbear-co/mirrord`)
- Solves remote developer and AI coding agent ergonomics.
- Through dynamic linker interposition (`LD_PRELOAD`), local processes or Cursor/Claude Code agents run on developer machines as if they were physically inside the remote container on Hetzner, accessing the remote database, S3 storage, and internal DNS over Cloudflare Tunnel.

### 4. Userspace Virtual Networking & Sandbox Fallback (`talaria0101/cfrs`)
- Provides a lightweight (~8MB) Rust Cloudflare quick-tunnel client and userspace virtual networking stack for locked-down container environments.
- Implements `cfrs net`: an `LD_PRELOAD` shim (`libcfrsnet.so`) that maps `AF_INET` socket calls to `AF_UNIX` abstract sockets, and an in-process `smoltcp` stack that creates a private `10.66.0.0/24` network without root or `CAP_NET_ADMIN`.
- Slices incoming traffic over port 443 SSH remote forwarding when Cloudflare edge port 7844 is filtered.

### 5. Topology Visualization & Telemetry (`Pouzor/homelable`, `ServerBee`, `crocofied/CoreObs`)
- The Cloudflare Pages SPA renders an interactive infrastructure graph showing Edge POPs, Tunnels, Host servers, and Sandboxes.
- Ultra-lightweight Rust telemetry agent (`serverbee-agent`) streams CPU, RAM, disk, and process trees over WebSockets into the control plane using only 10 to 15 MiB of RAM.
- Web SFTP file explorer and snippet automation adapted from `timhartmann7/omnyssh`.

---

## 5. Quickstart Deployment

### Step 1: Deploy Host Services (Host Machine)
1. Clone this repository on your host machine.
2. Configure `.env` with your Cloudflare Tunnel token and credentials:
   ```bash
   cp .env.example .env
   ```
3. Start the host infrastructure stack:
   ```bash
   cd deploy
   docker compose up -d
   ```

### Step 2: Deploy Edge Control Plane (Cloudflare Workers)
1. Navigate to `control-plane/worker`:
   ```bash
   cd control-plane/worker
   npm install
   ```
2. Configure your tunnel endpoints in `wrangler.jsonc`.
3. Set your Cloudflare Access Service Token secrets:
   ```bash
   npx wrangler secret put CF_ACCESS_CLIENT_ID
   npx wrangler secret put CF_ACCESS_CLIENT_SECRET
   npx wrangler secret put GITHUB_WEBHOOK_SECRET
   ```
4. Deploy the Worker:
   ```bash
   npx wrangler deploy
   ```

### Step 3: Access Management Dashboard
Deploy `control-plane/spa/index.html` to Cloudflare Pages or serve it directly from your Worker.

---

## 6. License

This project is licensed under the **BSD 0-Clause License (0BSD)**. See [`LICENSE`](LICENSE) for details.
