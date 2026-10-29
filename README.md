# Cloudflare Alt: Drop-In Cloudflare Services on Self-Hosted Nodes

A technical specification and reference implementation for self-hosting Cloudflare services (Workers, Durable Objects, R2 Object Storage, and Container CI) managed from a Cloudflare-hosted control plane.

---

## 1. Compatibility Matrix

Application code written for standard Cloudflare Workers requires zero modifications to execute on the self-hosted node:

| Primitive | Standard Cloudflare API | Cloudflare Native | Self-Hosted Node (`cfb-broker`) | Delta |
| :--- | :--- | :--- | :--- | :--- |
| Workers Runtime | `export default { fetch(req, env) { ... } }` | Cloudflare Edge V8 | `workerd` supervised by `cfb-broker` | 0 lines |
| Durable Objects | `class MyDO { constructor(state) { this.sql = state.storage.sql; } }` | Cloudflare Edge DO | `workerd` DO with local SQLite on NVMe | 0 lines |
| Object Storage | `await env.MY_BUCKET.put(key, stream)` | Cloudflare R2 | Native `workerd` R2 binding mapped to local NVMe | 0 lines |
| External S3 API | AWS SDK: `s3.putObject(...)` | `<account>.r2.cloudflaredstorage.com` | `https://s3.<tunnel-domain>` served by `cfb-broker` | 0 lines |
| Configuration | Standard `wrangler.jsonc` or `wrangler.toml` | `wrangler deploy` | `cfb-broker` parses `wrangler.jsonc` on deploy | 0 lines |
| Heavy CI Runner | Standard Git Webhooks / Container Pipelines | GitHub Actions or Workers CI | `cfb-broker` embedded CI runner with DinD | 0 lines |

---

## 2. Architecture Overview

The system consists of two planes:
1. Control Plane (Cloudflare Edge): Hosted on Cloudflare Pages (SPA dashboard) and Cloudflare Workers (API gateway). Manages node inventory, dispatches CI jobs, signs S3 presigned URLs, and proxies real-time SSE logs.
2. Data Plane (Host Server): Runs `cfb-broker`, a single static Rust binary derived from `talaria0101/cfrs` consuming under 20 MiB RAM. It embeds Cloudflare Tunnel ingress, an S3 storage engine, an OCI container CI runner, an in-process telemetry probe, and supervises the official `cloudflare/workerd` engine.

```
+------------------------------------------------------------------------------------+
|                cfb-broker (Single Unified Rust Daemon, < 20MB RAM)                 |
+------------------------------------------------------------------------------------+
| - Embedded Cloudflare Tunnel Ingress (QUIC / HTTP/2 + SSH/CONNECT fallback)        |
| - Embedded S3 Storage Engine (serves external S3 and internal workerd R2 bindings) |
| - workerd Runtime Supervisor (translates wrangler.jsonc -> workerd.capnp on deploy)|
| - Embedded Heavy CI Task Runner (Docker/Podman socket runner + live SSE logs)      |
| - Embedded Telemetry Probe (sysinfo: CPU, RAM, disk, network, process tree)        |
| - Web SFTP & File Explorer (inspects and streams container archives)               |
| - mirrord & cfrs net integration (mirrors remote sandbox traffic to local agents)  |
+-----------------------------------------+------------------------------------------+
                                          |
                                          v Unix Domain Socket / IPC
+------------------------------------------------------------------------------------+
| cloudflare/workerd (V8 Execution Engine for Workers & SQLite Durable Objects)      |
+------------------------------------------------------------------------------------+
```

---

## 3. Specifications Index

| Specification | Description |
| :--- | :--- |
| **[`spec/01-architecture-overview.md`](spec/01-architecture-overview.md)** | System scope, compatibility matrix, network protocols, and security boundaries. |
| **[`spec/02-unified-broker-cfrs-architecture.md`](spec/02-unified-broker-cfrs-architecture.md)** | Single-binary `cfb-broker` architecture in Rust (derived from `cfrs`). |
| **[`spec/03-drop-in-cloudflare-compatibility.md`](spec/03-drop-in-cloudflare-compatibility.md)** | Zero-code-change Worker execution, SQLite Durable Objects, and Wrangler compilation. |
| **[`spec/04-storage-and-s3-broker.md`](spec/04-storage-and-s3-broker.md)** | In-process S3 storage engine, direct NVMe streaming, and presigned URLs. |
| **[`spec/05-zero-bloat-ci-and-sandboxes.md`](spec/05-zero-bloat-ci-and-sandboxes.md)** | In-process CI container runner, host cache mounting, and live SSE log streams. |
| **[`spec/06-github-tools-critique.md`](spec/06-github-tools-critique.md)** | Technical evaluation of referenced GitHub projects. |

---

## 4. Quickstart

### Step 1: Install and Run `cfb-broker` on Host (Bare Metal / VPS)

#### Option A: Direct Systemd Service (Recommended)
1. Build `cfb-broker`:
   ```bash
   cd broker && cargo build --release
   cp target/release/cfb-broker /usr/local/bin/
   ```
2. Configure `/etc/cfb-broker.toml`:
   ```bash
   cp deploy/cfb-broker.toml /etc/cfb-broker.toml
   ```
3. Enable and start systemd unit:
   ```bash
   cp deploy/cfb-broker.service /etc/systemd/system/
   systemctl daemon-reload && systemctl enable --now cfb-broker
   ```

#### Option B: Container Deployment
```bash
cd deploy && docker compose up -d
```

### Step 2: Deploy Cloudflare Control Plane
1. Navigate to `control-plane/worker`:
   ```bash
   cd control-plane/worker && npm install
   ```
2. Configure `wrangler.jsonc` with your `BROKER_TUNNEL_HOST`.
3. Set Cloudflare Zero Trust Service Token secrets:
   ```bash
   npx wrangler secret put CF_ACCESS_CLIENT_ID
   npx wrangler secret put CF_ACCESS_CLIENT_SECRET
   ```
4. Deploy the Edge Gateway:
   ```bash
   npx wrangler deploy
   ```

### Step 3: Access Management Dashboard
Deploy `control-plane/spa/index.html` to Cloudflare Pages or access it via your Worker domain.

---

## 5. License

This project is licensed under the **BSD 0-Clause License (0BSD)**. See [`LICENSE`](LICENSE) for details.
