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

Communication between the Cloudflare Edge control plane and remote machines is secured via **Cloudflare Tunnels (`cloudflared`)** and **Cloudflare Access**, eliminating public IP exposure, open firewall ports, and dynamic DNS complexities. In restricted sandbox environments where `cloudflared` cannot run, the architecture falls back to **`cfrs`**, a lightweight Rust quick-tunnel client with userspace networking.

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

## 3. Communication Models: Push vs. Pull vs. Mirrored

Managing remote machines from an edge serverless environment requires selecting an orchestration communication model:

### Model A: Push over Cloudflare Tunnel (Recommended Baseline)
- **Mechanism**: The host node runs `cloudflared`. Ingress rules map internal services (Docker Socket Proxy, Nomad, Woodpecker, Garage S3, workerd) to hostnames under a private subdomain (e.g., `docker.node1.infra.example.com`).
- **Edge Behavior**: The Cloudflare Worker acts as an HTTP client. When an admin takes an action on the dashboard, the Worker calls `fetch("https://docker.node1.infra.example.com/...")`, injecting Cloudflare Access Service Token headers (`CF-Access-Client-Id`, `CF-Access-Client-Secret`).
- **Benefits**: Stateless edge architecture; zero open inbound ports on the remote server; granular Zero Trust edge firewall policies.

### Model B: Pull / WebSocket Multiplexing via Durable Objects (Amika Pattern)
- **Mechanism**: An agent daemon on the remote host (`amika-hostd` or custom agent) dials **outbound** to a Cloudflare Durable Object over WebSocket (`wss://edge.example.com/v2/host-tunnel`).
- **Binary Codec**: Uses `@amika/tunnel-protocol` (`amika.tunnel.v2`), an open-source binary multiplexing protocol designed for Cloudflare Workers. It multiplexes arbitrary HTTP requests, responses, and interactive terminal streams over a single WebSocket.
- **Benefits**: Bypasses Cloudflare Access configuration entirely; bi-directional RPC without unique hostnames per node; Cloudflare Durable Objects hibernate (`state.acceptWebSocket()`), incurring **zero compute cost** while idle.

### Model C: Mirrored Remote Execution (mirrord Pattern)
- **Mechanism**: For local developers and AI coding agents working on laptops or CI jobs, [metalbear-co/mirrord](https://github.com/metalbear-co/mirrord) hooks `libc` syscalls via dynamic linker interposition (`LD_PRELOAD`).
- **Data Flow**: When the local process issues network calls (`connect`, `getaddrinfo`) or file reads, calls are intercepted and tunneled over the Cloudflare Tunnel directly into the target container on the remote host.
- **Benefits**: Local processes and AI agents run against live remote databases, S3 buckets, and internal DNS without deploying code, containerizing locally, or exposing private subnets.

### Model D: Userspace Quick-Tunnel Fallback (`cfrs` Pattern)
- **Mechanism**: When deploying into restricted container sandboxes where official Go `cloudflared` fails (due to lack of root, blocked UDP/QUIC, filtered port 7844, or HTTP-proxy only egress), the host uses [talaria0101/cfrs](https://github.com/talaria0101/cfrs).
- **Capabilities**:
  - Automatically provisions credential-free Cloudflare quick-tunnels via HTTP CONNECT proxy.
  - Userspace networking: `cfrs net shim` rewrites `AF_INET` syscalls to `AF_UNIX` abstract sockets, and a `smoltcp` stack provides an in-process `10.66.0.0/24` network without kernel network namespaces.
  - SSH remote forwarding fallback: Slices incoming visitor channels to Unix domain sockets over port 443.

---

## 4. Observability & Visual Management (Homelable, CoreObs, ServerBee)

### 4.1 Topology Visualizer (Homelable Pattern)
The Cloudflare Pages SPA dashboard renders an interactive topological graph of the entire infrastructure:
- **Graph Nodes**: Edge Gateway -> Cloudflare Tunnels -> Host Hardware -> Container Sandboxes, workerd Isolates, Garage S3, CI Runners.
- **Graph Edges**: Real-time throughput indicators, latency measurements, and connection protocols (QUIC, HTTP/2, WebSocket).
- **Auto-Discovery**: Cloudflare Worker queries the Docker Socket Proxy and workerd cluster state to dynamically build the topology without manual configuration files.

### 4.2 Lightweight Host Telemetry (ServerBee Pattern)
To monitor host system health without the multi-gigabyte footprint of Prometheus or Datadog, each node runs `serverbee-agent`, a single Rust binary consuming only **10–15 MiB of RAM**:
- Streams structured telemetry over a persistent WebSocket through the Cloudflare Tunnel:
  - CPU usage (aggregate and per-core)
  - Memory and Swap utilization
  - Disk space and I/O rates
  - Network interface throughput
  - Process tree with CPU/memory consumption
- The Cloudflare Durable Object hub receives the stream and fans it out to connected SPA dashboard clients.

### 4.3 Web SFTP File Explorer & Snippets (OmnySSH & CoreObs Pattern)
- **Web SFTP**: The dashboard includes a dual-pane file manager allowing operators to browse filesystems, inspect build artifacts, and upload files into running containers over authenticated Worker endpoints.
- **Snippet Automation**: Frequently used operational scripts (e.g. database vacuum, log cleanup, container restart) are stored in Cloudflare KV and executed against remote sandboxes with one click.

---

## 5. Security Architecture & Threat Model

| Boundary | Mitigation Strategy |
| :--- | :--- |
| **Public Internet to Cloudflare Worker** | Protected by Cloudflare WAF, Cloudflare Zero Trust Access (SAML/OIDC/GitHub login), and edge rate limiting. |
| **Worker to Cloudflare Tunnel** | Mutual authentication using Cloudflare Access Service Tokens (`CF-Access-Client-Id` / `CF-Access-Client-Secret`). Unauthenticated requests are blocked at Cloudflare POPs. |
| **Tunnel to Docker Engine** | Never expose raw `/var/run/docker.sock`. Route through `tecnativa/docker-socket-proxy` with read-only defaults, blocking host volume mounts and privileged flags. |
| **Untrusted Code Execution** | Multi-tenant code or untrusted scripts run inside **gVisor (`runsc`)** sandbox containers or **Firecracker** microVMs, isolating kernel syscalls from the host. |
| **Restricted Sandbox Egress** | `cfrs` provides userspace TCP/IP via `smoltcp` and abstract Unix sockets, avoiding `CAP_NET_ADMIN` privilege requirements. |
| **Storage Access** | Cloudflare Worker issues time-limited AWS SigV4 presigned URLs with exact object key paths, preventing clients from accessing adjacent bucket data. |

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
│   └── 06-github-tools-critique.md        # Technical evaluation of 17 GitHub projects
├── deploy/                                 # Host Deployment Configurations
│   ├── docker-compose.yml                  # Unified node stack (cloudflared, proxy, S3, CI, probe)
│   ├── cloudflared/config.yml             # Cloudflare Tunnel ingress rules
│   ├── workerd/workerd.capnp              # Cap'n Proto runtime configuration
│   ├── workerd/src/worker.js              # SQLite Durable Object implementation
│   └── garage/garage.toml                 # Garage S3 distributed configuration
└── control-plane/                          # Edge Control Plane Implementation
    ├── worker/                             # Cloudflare Worker API & proxy
    │   ├── src/index.ts                    # Docker, S3, CI, workerd, and telemetry router
    │   ├── wrangler.jsonc
    │   └── package.json
    └── spa/                                # Management Single Page Application
        └── index.html                      # Topology visualizer, metrics, and SFTP explorer
```
