# Architecture Specification: Zero-Bloat Cloudflare Alternative with Drop-In Compatibility

## 1. Executive Summary & Core Requirements

This architecture solves two critical engineering requirements:

1. **Zero-Code-Change Drop-In Compatibility with Cloudflare Native**:
   - Application code written for Cloudflare Workers, Durable Objects, and R2 must run **identically on Cloudflare's global edge and on self-hosted infrastructure** without proprietary wrappers or rewrites.
   - Standard Cloudflare APIs (`env.MY_BUCKET.put()`, `env.MY_BUCKET.get()`, `env.MY_DO.get(id)`, `state.storage.sql.exec()`) and standard configuration files (`wrangler.jsonc` / `wrangler.toml`) must execute without modification.
   - A single repository codebase can be deployed to Cloudflare production or pointed to self-hosted compute simply by changing the deployment target.

2. **Single Lightweight Broker Daemon (Zero-Bloat Host)**:
   - Eliminates the operational anti-pattern of running a bloated zoo of 6–7 separate third-party Docker containers (cloudflared in Go, Woodpecker server in Go, Woodpecker agent in Go, docker-socket-proxy in HAProxy, ServerBee in Rust, Garage in Rust, etc.) on every host machine.
   - Replaces the multi-container stack with **`cfb-broker`**: a single, unified, ultra-lightweight Rust binary derived from the architecture of [talaria0101/cfrs](https://github.com/talaria0101/cfrs).
   - Consumes **< 20 MiB of RAM total** on the host.
   - Directly embeds:
     - The Cloudflare Tunnel client (QUIC/HTTP2 with SSH/CONNECT fallback).
     - The local orchestrator and container/sandbox manager.
     - The heavy CI task runner with real-time SSE log streaming.
     - The in-process host telemetry probe (`sysinfo`).
     - The S3-compatible object storage broker.
     - The `workerd` runtime supervisor, dynamically compiling `wrangler.jsonc` into Cap'n Proto configs.

3. **Cloudflare-Hosted Control Plane**:
   - The dashboard and management plane remain hosted entirely on **Cloudflare Pages (SPA) and Cloudflare Workers (API Gateway)**.
   - Management traffic traverses the Cloudflare Tunnel authenticated by Cloudflare Zero Trust Access Service Tokens. No inbound ports are opened on the host.

---

## 2. Drop-In Cloudflare Compatibility Matrix

| Primitive | Application Code (Standard Cloudflare) | Execution on Cloudflare Native | Execution on Self-Hosted Node (`cfb-broker`) | Code Delta |
| :--- | :--- | :--- | :--- | :--- |
| **Workers Runtime** | Standard ES Modules `export default { fetch(req, env) { ... } }` | Cloudflare Edge V8 Isolates (30s CPU limit, invocation billing) | **`cloudflare/workerd`** supervised by `cfb-broker` (unmetered CPU, zero invocation fee) | **0 lines** (Identical bundle) |
| **Durable Objects (DO)** | `export class MyDO { constructor(state) { this.sql = state.storage.sql; } }` | Cloudflare Edge DO with embedded SQLite | **`workerd`** native DO with embedded SQLite on NVMe (`localDisk`) | **0 lines** (Identical class) |
| **Object Storage (R2)** | `await env.MY_BUCKET.put("key", stream)` / `await env.MY_BUCKET.get("key")` | Cloudflare R2 ($4.50/M Class A ops) | Native `workerd` R2 binding mapped by `cfb-broker` to local NVMe storage | **0 lines** (Identical binding) |
| **External S3 API** | AWS SDK / S3 Client: `s3.putObject({ Bucket, Key, Body })` | `https://<account>.r2.cloudflaredstorage.com` | `https://s3.<tunnel-domain>` served directly by `cfb-broker` S3 engine | **0 lines** (Only endpoint changes) |
| **Configuration** | Standard `wrangler.jsonc` or `wrangler.toml` | Deployed via `wrangler deploy` | `cfb-broker` parses `wrangler.jsonc` on upload and configures `workerd` | **0 lines** (Identical config) |
| **Heavy CI / Workflows** | GitHub Actions / Git Webhook / CI Pipeline | GitHub Actions or Workers CI (concurrency caps, no DinD) | `cfb-broker` embedded CI runner: executes Docker-in-Docker with host caching | Standard YAML / Webhook |

---

## 3. High-Level Architecture Diagram

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
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│                               CLOUDFLARE EDGE CONTROL PLANE                                   │
│                                                                                               │
│  [Cloudflare Pages: SPA Dashboard]                                                            │
│    - Topology Visualizer (Homelable pattern): interactive node-to-service graph.              │
│    - Real-Time Telemetry: Live CPU, memory, disk, and container stream from cfb-broker.        │
│    - Web SFTP / Terminal: Dual-pane file browser and interactive terminal shell.              │
│    - Build Monitor: Live Server-Sent Events (SSE) build logs stream.                          │
│                                                                                               │
│  [Cloudflare Worker: API Gateway & Router]                                                    │
│    - Auth: Cloudflare Zero Trust Access JWT validation.                                       │
│    - Injects Cloudflare Access Service Token headers (CF-Access-Client-Id / Secret).          │
│    - Webhook Gateway: Verifies HMAC-SHA256 signatures; dispatches CI jobs to cfb-broker.       │
│    - Presigns direct S3 upload/download URLs against cfb-broker S3 endpoint.                  │
│    - Proxies live SSE logs and interactive terminal WebSockets with zero edge buffering.      │
└──────────────────────────────────────────────┬────────────────────────────────────────────────┘
                                               │
                                               │ Cloudflare Tunnel (QUIC / HTTP/2 Transport)
                                               │ Fallback: cfrs quick-tunnel over port 443
                                               │ Authenticated via CF-Access-Client-Id / Secret
                                               ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│                               REMOTE DATA PLANE (HOST SERVER)                                 │
│                                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                    cfb-broker (SINGLE UNIFIED RUST DAEMON, < 20MB RAM)                  │  │
│  │                    Based on talaria0101/cfrs Architecture                               │  │
│  │                                                                                         │  │
│  │  [Embedded Cloudflare Tunnel Ingress]                                                   │  │
│  │    • Native QUIC / HTTP/2 tunnel to Cloudflare Edge (no 40MB cloudflared Go binary).   │  │
│  │    • Automatic fallback: quick-tunnel via HTTP CONNECT / port 443 SSH remote forward.   │  │
│  │                                                                                         │  │
│  │  [Embedded S3 Storage Broker (R2 Alternative)]                                          │  │
│  │    • In-process S3 engine (GetObject, PutObject, ListObjectsV2) backed by local NVMe.   │  │
│  │    • Serves external S3 clients and internal workerd R2 bucket bindings.                │  │
│  │                                                                                         │  │
│  │  [workerd Runtime Supervisor]                                                           │  │
│  │    • Translates standard wrangler.jsonc -> workerd.capnp dynamically.                   │  │
│  │    • Supervises official cloudflare/workerd process.                                    │  │
│  │    • Maps env.MY_BUCKET to local S3 directory; maps env.MY_DO to persistent SQLite.     │  │
│  │                                                                                         │  │
│  │  [Embedded CI & Sandbox Orchestrator]                                                   │  │
│  │    • Replaces heavy Woodpecker/Drone containers.                                        │  │
│  │    • Talks directly to local /var/run/docker.sock or uses cfrs net userspace VNet.      │  │
│  │    • Executes multi-stage container pipelines with volume caching.                      │  │
│  │    • Streams live build logs over native Server-Sent Events (SSE).                      │  │
│  │                                                                                         │  │
│  │  [Embedded Telemetry Probe (ServerBee / sysinfo)]                                       │  │
│  │    • In-process CPU, RAM, disk I/O, network throughput, and process inspection.         │  │
│  │    • Streams metrics over WebSockets to Cloudflare Pages dashboard.                     │  │
│  │                                                                                         │  │
│  │  [Developer & AI Agent Bridge (mirrord / cfrs net)]                                     │  │
│  │    • Hooks local agent processes to mirror remote sandbox traffic, DNS, and env.        │  │
│  └───────────────────────────────────────────┬─────────────────────────────────────────────┘  │
│                                              │                                                │
│                                              ▼ Unix Domain Socket / IPC                       │
│  ┌─────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │  cloudflare/workerd (V8 Runtime)                                                        │  │
│  │    • Unmodified Cloudflare Workers ES Module execution.                                 │  │
│  │    • Native Durable Objects with embedded SQLite (state.storage.sql).                   │  │
│  │    • Hibernated WebSockets (state.acceptWebSocket).                                     │  │
│  └─────────────────────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Why This Completely Eliminates Host Bloat

| Component | Previous Old Design (Multi-Container Zoo) | New Design (`cfb-broker` + `workerd`) | Memory Saving | Maintenance Saving |
| :--- | :--- | :--- | :--- | :--- |
| **Cloudflare Tunnel** | `cloudflared` (Go binary, 40MB disk, 40MB RAM) | **Embedded in `cfb-broker`** (Rust, async tokio) | -35 MiB RAM | No external tunnel daemon to manage |
| **Docker Security Proxy**| `tecnativa/docker-socket-proxy` (HAProxy container) | **In-process filtering router in `cfb-broker`** | -15 MiB RAM | No HAProxy configuration drift |
| **CI Server** | `woodpecker-server` (Go container, SQLite, 80MB RAM)| **In-process task queue in `cfb-broker`** | -70 MiB RAM | No separate CI server daemon or DB |
| **CI Agent** | `woodpecker-agent` (Go container, 40MB RAM) | **In-process runner in `cfb-broker`** | -35 MiB RAM | Directly manages runner containers |
| **S3 Object Storage** | `dxflrs/garage` or MinIO (40MB–2GB RAM) | **Embedded S3 broker in `cfb-broker`** | -40 MiB RAM | Direct NVMe filesystem mapping |
| **Host Telemetry** | `serverbee-agent` (Container, 15MB RAM) | **Embedded `sysinfo` module in `cfb-broker`** | -12 MiB RAM | Compiled into single binary |
| **Workers Runtime** | `workerd` container | `workerd` supervised binary by `cfb-broker` | Same | Automatic capnp generation from wrangler |
| **TOTALS** | **7 separate containers, ~350MB–800MB RAM** | **1 Rust binary + workerd, < 25MB RAM** | **> 90% reduction** | **1 binary to deploy & update** |

---

## 5. Directory Structure of this Repository

```
cfb-20261029111246/
├── LICENSE                                    # 0BSD License
├── README.md                                  # Complete architecture guide and quickstart
├── spec/                                      # Technical Specifications
│   ├── 01-architecture-overview.md            # End-to-end design & drop-in compatibility
│   ├── 02-unified-broker-cfrs-architecture.md # Single-binary cfb-broker architecture in Rust
│   ├── 03-drop-in-cloudflare-compatibility.md # Zero-code-change Workers, DOs, and R2
│   ├── 04-storage-and-s3-broker.md            # Embedded S3 broker and direct presigning
│   ├── 05-zero-bloat-ci-and-sandboxes.md       # Embedded CI runner with live SSE streaming
│   └── 06-github-tools-critique.md            # Technical critique of prior art & tools
├── broker/                                    # cfb-broker Single Rust Binary Source Code
│   ├── Cargo.toml                             # Rust crate dependencies (tokio, hyper, sysinfo)
│   └── src/
│       ├── main.rs                            # Unified daemon entrypoint
│       ├── tunnel.rs                          # Embedded Cloudflare Tunnel client (from cfrs)
│       ├── supervisor.rs                      # workerd process supervisor & wrangler compiler
│       ├── s3.rs                              # Embedded lightweight S3 storage broker
│       ├── ci.rs                              # Embedded CI runner with Docker/podman execution
│       ├── telemetry.rs                       # In-process host metrics probe (sysinfo)
│       └── files.rs                           # Web SFTP & container file archive handler
├── deploy/                                    # Deployment Artifacts
│   ├── cfb-broker.service                     # Systemd service unit for bare metal / VPS
│   ├── Dockerfile                             # Minimal Alpine container packaging broker + workerd
│   ├── docker-compose.yml                     # Single-service compose file
│   └── .env.example                           # Configuration variables
└── control-plane/                             # Cloudflare Edge Control Plane
    ├── worker/                                # Cloudflare Worker API Gateway
    │   ├── src/index.ts                       # Routes to cfb-broker over tunnel
    │   ├── wrangler.jsonc
    │   └── package.json
    └── spa/                                   # Cloudflare Pages Dashboard
        └── index.html                         # Topology map, telemetry, and CI monitor
```
