# Cloudflare Alt: Zero-Bloat Host Daemon with Drop-In Cloudflare Compatibility

A complete architectural specification, analysis of GitHub prior art, and reference implementation for self-hosting alternatives to Cloudflare's expensive services (**R2 Object Storage, Compute/Containers, Workers, Durable Objects, and Heavy CI**) with:
1. **Zero-Code-Change Drop-In Compatibility**: Code written with standard Cloudflare APIs (`env.MY_BUCKET.put()`, `env.MY_DO.get()`, `state.storage.sql.exec()`) and configured via standard `wrangler.jsonc` runs identically on Cloudflare edge and on self-hosted infrastructure.
2. **Single Lightweight Rust Host Daemon (`cfb-broker`)**: Eliminates multi-container Docker Compose sprawl. Replaces 7 separate daemons with a single ~15MB Rust binary derived from the architecture of [talaria0101/cfrs](https://github.com/talaria0101/cfrs), consuming **< 20 MiB RAM total**.
3. **Cloudflare-Hosted Control Plane**: The management dashboard and API gateway remain hosted directly on Cloudflare Pages and Workers.

---

## 1. Drop-In Cloudflare Compatibility Matrix

| Cloudflare Primitive | Application Code (Standard Cloudflare) | Cloudflare Production | Self-Hosted Node (`cfb-broker`) | Code Changes |
| :--- | :--- | :--- | :--- | :--- |
| **Workers Runtime** | `export default { fetch(req, env) { ... } }` | Cloudflare Edge Isolates | **`workerd`** supervised by `cfb-broker` | **0 lines** (Identical bundle) |
| **Durable Objects (DO)** | `class MyDO { constructor(state) { this.sql = state.storage.sql; } }` | Cloudflare Edge DO (SQLite) | **`workerd`** DO with embedded SQLite on NVMe | **0 lines** (Identical class) |
| **Object Storage (R2)** | `await env.MY_BUCKET.put("key", stream)` / `get("key")` | Cloudflare R2 | Native `workerd` R2 binding mapped to local NVMe | **0 lines** (Identical binding) |
| **External S3 API** | AWS SDK / S3 Client: `s3.putObject(...)` | `<account>.r2.cloudflaredstorage.com` | `https://s3.<tunnel-domain>` served by `cfb-broker` | **0 lines** (Only endpoint changes) |
| **Configuration** | Standard `wrangler.jsonc` or `wrangler.toml` | Deployed via `wrangler deploy` | `cfb-broker` parses `wrangler.jsonc` on deploy | **0 lines** (Identical config) |
| **Heavy CI Runner** | GitHub Actions / Git Webhook / CI Pipeline | GitHub Actions or Workers CI | `cfb-broker` embedded CI runner with DinD & caching | Standard YAML / Webhook |

---

## 2. Why Single-Binary `cfb-broker` Beats Multi-Container Bloat

Traditional self-hosted setups suffer from extreme container bloat: running `cloudflared` (Go), `docker-socket-proxy` (HAProxy), `woodpecker-server` (Go), `woodpecker-agent` (Go), `serverbee-agent` (Rust), and `garage` (Rust) consumes **~350–800 MB RAM idle** across 7 separate containers.

**`cfb-broker` replaces all of them with ONE single Rust binary**:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                    cfb-broker (Single Unified Rust Daemon, < 20MB RAM)                 │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ • Embedded Cloudflare Tunnel Ingress (QUIC / HTTP/2 + SSH/CONNECT fallback from cfrs)  │
│ • Embedded S3 Storage Engine (serves external S3 and internal workerd R2 bindings)     │
│ • workerd Runtime Supervisor (translates wrangler.jsonc -> workerd.capnp dynamically)  │
│ • Embedded Heavy CI Task Runner (Docker/Podman socket runner + live SSE log streaming) │
│ • Embedded Telemetry Probe (sysinfo: CPU, RAM, disk, network, and process tree)        │
│ • Web SFTP & File Explorer (OmnySSH pattern: browse and stream container archives)     │
│ • mirrord & cfrs net integration (mirrors remote sandbox traffic to local AI agents)   │
└────────────────────────────────────────────────────────────────────────────────────────┘
                                            │
                                            ▼ IPC / Unix Domain Socket
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ cloudflare/workerd (V8 Execution Engine for Workers & SQLite Durable Objects)          │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Specifications Index

| Specification | Description |
| :--- | :--- |
| **[`spec/01-architecture-overview.md`](spec/01-architecture-overview.md)** | End-to-end system design, drop-in compatibility invariants, and threat model. |
| **[`spec/02-unified-broker-cfrs-architecture.md`](spec/02-unified-broker-cfrs-architecture.md)** | Single-binary `cfb-broker` architecture in Rust (derived from `cfrs`). |
| **[`spec/03-drop-in-cloudflare-compatibility.md`](spec/03-drop-in-cloudflare-compatibility.md)** | Zero-code-change Worker execution, SQLite Durable Objects, and Wrangler compilation. |
| **[`spec/04-storage-and-s3-broker.md`](spec/04-storage-and-s3-broker.md)** | In-process S3 storage engine, direct NVMe streaming, and presigned URLs. |
| **[`spec/05-zero-bloat-ci-and-sandboxes.md`](spec/05-zero-bloat-ci-and-sandboxes.md)** | In-process CI container runner, host cache mounting, and live SSE log streams. |
| **[`spec/06-github-tools-critique.md`](spec/06-github-tools-critique.md)** | Technical critique of 17 GitHub prior art projects. |

---

## 4. Single-Binary Quickstart

### Step 1: Install & Run `cfb-broker` on Host (Bare Metal / VPS)

#### Option A: Direct Systemd Service (Recommended)
1. Download or compile `cfb-broker`:
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

#### Option B: Single Container Deployment
```bash
cd deploy && docker compose up -d
```

### Step 2: Deploy Cloudflare Control Plane
1. Navigate to `control-plane/worker`:
   ```bash
   cd control-plane/worker && npm install
   ```
2. Configure `wrangler.jsonc` with your `BROKER_TUNNEL_HOST`.
3. Set your Cloudflare Zero Trust Service Token secrets:
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
