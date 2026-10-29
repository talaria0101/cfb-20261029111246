# Architecture Specification: Self-Hosted Cloudflare Alternatives Managed from Cloudflare Edge

## 1. Problem Statement & Motivation

Cloudflare provides a compelling developer ecosystem, but several critical primitives encounter severe operational or pricing friction at scale:

1. **Storage (R2)**: While egress bandwidth is free, Class A operations ($4.50 / million) and Class B operations ($0.36 / million) accumulate rapidly during data-intensive workloads, lakehouse indexing, continuous WAL archiving, or heavy CI caching.
2. **Compute (Containers, Sandboxes, "Computer")**: Cloudflare Workers enforces a strict serverless model (128 MB to 512 MB memory, limited CPU burst times, no root, no `/dev/kvm`, and no persistent Linux background daemons). Workloads requiring long-running processes, Docker-in-Docker, multi-hour batch runs, or custom kernel modules cannot execute on Workers.
3. **Workers & Runtime Limits**: Large V8 applications hit CPU time caps (50ms on free, 30s on standard paid). Background jobs, heavy compilers, and unmetered internal services require dedicated compute.
4. **Durable Objects (DO)**: While providing strong single-actor concurrency and SQLite persistence, Durable Objects become costly for persistent thousands of open WebSocket connections, continuous storage I/O, or cross-cloud state synchronization.
5. **Workers CI / Heavy CI**: Building OCI container images, compiling C++/Rust projects, and running multi-service integration tests exceed serverless execution envelopes.

### The Architectural Invariant: Cloudflare as Control Plane
The management interface, authentication boundary, and dashboard **must remain hosted directly on Cloudflare** (Cloudflare Pages, Workers, D1, KV, and Durable Objects). The compute, heavy storage, and runner infrastructure run on cost-effective, self-hosted hardware (Hetzner bare-metal, OVH, home labs, or spot cloud instances).

Communication between the Cloudflare Edge control plane and remote machines is secured via **Cloudflare Tunnels (`cloudflared`)** and **Cloudflare Access**, eliminating public IP exposure, open firewall ports, and dynamic DNS complexities.

---

## 2. High-Level System Architecture

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

## 3. Communication Models: Push vs. Pull

Managing remote machines from an edge serverless environment requires selecting an orchestration communication model:

### Model A: Push over Cloudflare Tunnel (Recommended Baseline)
- **Mechanism**: The host node runs `cloudflared`. Ingress rules map internal services (Docker Socket Proxy, Nomad, Woodpecker, Garage S3, workerd) to hostnames under a private subdomain (e.g., `docker.node1.infra.example.com`).
- **Edge Behavior**: The Cloudflare Worker acts as an HTTP client. When an admin takes an action on the dashboard, the Worker calls `fetch("https://docker.node1.infra.example.com/...")`, injecting Cloudflare Access Service Token headers (`CF-Access-Client-Id`, `CF-Access-Client-Secret`).
- **Benefits**:
  - Stateless edge architecture: no open idle connections required on Workers.
  - Zero open inbound ports on the remote server: all connections are outbound from `cloudflared` to Cloudflare POPs.
  - Granular Zero Trust policies at Cloudflare's edge firewall.

### Model B: Pull / WebSocket Multiplexing via Durable Objects (Amika Pattern)
- **Mechanism**: An agent daemon on the remote host (`amika-hostd` or custom agent) dials **outbound** to a Cloudflare Durable Object over WebSocket (`wss://edge.example.com/v2/host-tunnel`).
- **Binary Codec**: Uses `@amika/tunnel-protocol` (`amika.tunnel.v2`), an open-source binary multiplexing protocol designed for Cloudflare Workers. It multiplexes arbitrary HTTP requests, responses, and interactive terminal streams over a single WebSocket.
- **Benefits**:
  - Bypasses Cloudflare Access configuration entirely.
  - Enables bi-directional RPC without needing unique hostnames per node.
  - Cloudflare Durable Objects hibernate (`state.acceptWebSocket()`), incurring **zero compute cost** while idle.

---

## 4. Security Architecture & Threat Model

| Boundary | Mitigation Strategy |
| :--- | :--- |
| **Public Internet to Cloudflare Worker** | Protected by Cloudflare Web Application Firewall (WAF), Cloudflare Zero Trust Access (SAML/OIDC/GitHub login), and rate-limiting rules. |
| **Worker to Cloudflare Tunnel** | Mutual authentication using Cloudflare Access Service Tokens (`CF-Access-Client-Id` / `CF-Access-Client-Secret`). Requests lacking valid tokens are blocked at Cloudflare's edge before hitting the tunnel. |
| **Tunnel to Docker Engine** | Never expose raw `/var/run/docker.sock`. Route through `tecnativa/docker-socket-proxy` with read-only defaults, blocking destructive host volume mounts and privileged flags. |
| **Untrusted Code Execution** | Multi-tenant code or untrusted scripts run inside **gVisor (`runsc`)** sandbox containers or **Firecracker / smolvm** microVMs, isolating kernel syscalls from the host. |
| **Storage Access** | Cloudflare Worker issues time-limited AWS SigV4 presigned URLs with exact object key paths, preventing clients from accessing adjacent bucket data. |

---

## 5. Cost & Resource Comparison Matrix

| Component | Cloudflare Native Cost | Self-Hosted Alternative | Monthly Cost Delta (at Scale) |
| :--- | :--- | :--- | :--- |
| **Object Storage (R2)** | $0.015/GB storage + $4.50/M Class A ops | **Garage S3** on dedicated NVMe drives | Saves 80–95% on high-operation workloads |
| **Long-Running Compute** | Workers limited to 30s CPU / no containers | **Docker / Nomad / workerd** on Hetzner EX44 (64GB RAM, 10Gbps) | ~$45/mo flat vs thousands on serverless |
| **Stateful Actor Coordination** | DO: $0.15/M requests + duration + storage | **workerd** local SQLite DOs or **libSQL/sqld** | Near-zero marginal cost per connection |
| **CI / Runner Pipeline** | Workers CI concurrency caps | **Woodpecker CI** with DinD agents | Uncapped concurrency, 10x faster caching |

---

## 6. Directory Structure of this Repository

```
cfb-20261029111246/
├── LICENSE                                # 0BSD License
├── README.md                               # Project documentation and navigation
├── spec/                                   # Detailed Technical Specifications
│   ├── 01-architecture-overview.md         # End-to-end system design & data flows
│   ├── 02-compute-sandbox-orchestration.md # Containers, Nomad, Amika, and microVMs
│   ├── 03-self-hosting-workerd-and-workers.md # workerd standalone, Cap'n Proto, SQLite DOs
│   ├── 04-storage-r2-and-durable-objects.md # Garage S3, SeaweedFS, libSQL, DO clustering
│   ├── 05-heavy-ci-runner-system.md       # Woodpecker CI, webhooks, SSE live log streaming
│   └── 06-github-tools-critique.md        # Technical evaluation of GitHub projects
├── deploy/                                 # Host Deployment Configurations
│   ├── docker-compose.yml                  # Unified node stack (cloudflared, proxy, S3, CI)
│   ├── cloudflared/config.yml             # Cloudflare Tunnel ingress rules
│   ├── workerd/workerd.capnp              # Cap'n Proto runtime configuration
│   ├── workerd/src/worker.js              # SQLite Durable Object implementation
│   └── garage/garage.toml                 # Garage S3 distributed configuration
└── control-plane/                          # Edge Control Plane Implementation
    ├── worker/                             # Cloudflare Worker API & proxy
    │   ├── src/index.ts
    │   ├── wrangler.jsonc
    │   └── package.json
    └── spa/                                # Management Single Page Application
        └── index.html
```
