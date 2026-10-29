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

---

## 2. Repository Navigation & Specifications

| Document | Description |
| :--- | :--- |
| **[`spec/01-architecture-overview.md`](spec/01-architecture-overview.md)** | End-to-end system design, push vs. pull communication models, and threat model. |
| **[`spec/02-compute-sandbox-orchestration.md`](spec/02-compute-sandbox-orchestration.md)** | Docker API over tunnel, `docker-socket-proxy`, Nomad batch jobs, and `gofixpoint/amika`. |
| **[`spec/03-self-hosting-workerd-and-workers.md`](spec/03-self-hosting-workerd-and-workers.md)** | Standalone `cloudflare/workerd`, Cap'n Proto config, SQLite Durable Objects, and `workerLoader`. |
| **[`spec/04-storage-r2-and-durable-objects.md`](spec/04-storage-r2-and-durable-objects.md)** | Garage S3 vs SeaweedFS, edge-assisted S3 presigning, and distributed SQLite (`libSQL`). |
| **[`spec/05-heavy-ci-runner-system.md`](spec/05-heavy-ci-runner-system.md)** | Woodpecker CI engine, edge webhook HMAC verification, and zero-buffering SSE log proxy. |
| **[`spec/06-github-tools-critique.md`](spec/06-github-tools-critique.md)** | Exhaustive technical evaluation of GitHub prior art, strengths, failure modes, and trade-offs. |

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
│    - Responsive React/Vite/Preact UI for node health, container lifecycle, and build logs.       │
│                                                                                                   │
│  [Cloudflare Worker: API Gateway & Router]                                                        │
│    - Authentication: Cloudflare Zero Trust Access JWT validation & RBAC.                          │
│    - Secret Store: Environment bindings for Cloudflare Access Service Tokens.                    │
│    - Webhook Dispatcher: Verifies HMAC-SHA256 signatures; routes pipeline triggers.               │
│    - S3 Presigner: Generates presigned URLs for direct browser-to-node storage uploads.           │
│    - SSE Log Streamer: Passes through real-time build logs with zero edge buffering.              │
│                                                                                                   │
│  [Cloudflare Durable Objects: State Hub & Tunnel Multiplexer]                                     │
│    - Optional persistent multiplexing hub (implementing @amika/tunnel-protocol v2).               │
│    - Maintains persistent connection state using WebSocket Hibernation API (zero idle CPU cost). │
└─────────────────────────────────────────────────┬─────────────────────────────────────────────────┘
                                                  │
                                                  │ Cloudflare Tunnel (QUIC / HTTP/2 Transport)
                                                  │ Authenticated via CF-Access-Client-Id / Secret
                                                  ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                  REMOTE DATA PLANE (HOST MACHINE)                                 │
│                                                                                                   │
│  [cloudflared daemon]                                                                             │
│    - Establishes persistent outbound-only encrypted tunnel to Cloudflare Edge.                    │
│    - Terminates tunnel routes and proxies to internal loopback / container ports.                │
│                                                                                                   │
│  ┌───────────────────────────────┬───────────────────────────────┬─────────────────────────────┐  │
│  │     CONTAINER & COMPUTE       │        STORAGE PLANE          │     WORKERS & RUNTIMES      │  │
│  │                               │                               │                             │  │
│  │ • Docker Engine via           │ • Garage S3                   │ • cloudflare/workerd        │  │
│  │   docker-socket-proxy         │   - Lightweight Rust S3       │   - Open-source V8 runtime  │  │
│  │ • HashiCorp Nomad             │   - WAN-tolerant CRDT         │   - Persistent SQLite DOs   │  │
│  │ • Sandboxes: gVisor (runsc)   │   - 50MB RAM footprint        │   - Hibernated WebSockets   │  │
│  │ • Amika Agent / hostd         │ • SeaweedFS / libSQL          │   - workerLoader hot-reload │  │
│  ├───────────────────────────────┴───────────────────────────────┴─────────────────────────────┤  │
│  │                                   HEAVY CI & RUNNER ENGINE                                  │  │
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

### 3. Edge-Assisted S3 Presigning for Garage S3
- To prevent Worker memory exhaustion (128 MB limit) when handling large build artifacts, the Cloudflare Worker issues AWS SigV4 presigned upload and download URLs.
- The client streams large payloads directly to Garage S3 over the Cloudflare Tunnel, bypassing Worker CPU/memory entirely.

### 4. Zero-Buffering SSE Live Build Logs
- Woodpecker CI emits real-time build logs via Server-Sent Events (`/api/stream/logs/{repo}/{pipeline}/{step}`).
- The Cloudflare Worker pipes the upstream `ReadableStream` directly to the client with `Cache-Control: no-transform` and `X-Accel-Buffering: no`, providing live terminal feeds to the browser dashboard.

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
