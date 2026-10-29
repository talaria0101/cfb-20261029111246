# Unified Host Daemon: The `cfb-broker` Architecture in Rust

## 1. Motivation: Eliminating the Multi-Container Anti-Pattern

Deploying self-hosted compute typically deteriorates into container sprawl:
- `cloudflared` daemon in Go (~40 MB disk, ~40 MB RAM)
- `docker-socket-proxy` in HAProxy (~15 MB RAM)
- `woodpecker-server` in Go (~80 MB RAM)
- `woodpecker-agent` in Go (~40 MB RAM)
- `serverbee-agent` in Rust (~15 MB RAM)
- `garage` S3 storage in Rust (~50 MB RAM)
- `workerd` in C++ (~30 MB RAM)

Total idle footprint: **~270 MB to 600 MB RAM**, 7 running containers, multiple volume mounts, complex Docker bridge networking, and frequent version drift.

### The `cfb-broker` Solution
Instead of orchestrating seven distinct tools, we consolidate all host responsibilities into **one single, unified Rust binary: `cfb-broker`**.

Derived from the battle-tested networking architecture of [talaria0101/cfrs](https://github.com/talaria0101/cfrs), `cfb-broker` runs directly on the host (as a systemd service or minimal container) and acts as:
1. The **Cloudflare Tunnel Client**.
2. The **`workerd` Runtime Supervisor**.
3. The **S3 Storage Engine**.
4. The **Heavy CI Task Runner**.
5. The **Host Telemetry Probe**.
6. The **Docker / Sandbox Proxy**.

Total idle footprint: **< 20 MB RAM**.

---

## 2. Internal Subsystems of `cfb-broker`

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                         cfb-broker (Single Rust Executable)                            │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│  [1. Embedded Cloudflare Tunnel Transport (cfrs)]                                      │
│    • Direct connection to Cloudflare Edge via QUIC or HTTP/2 over port 7844.           │
│    • Resilient fallback: SSH remote forward on port 443 / HTTP CONNECT proxy.           │
│    • Zero dependency on the official 40MB cloudflared Go binary.                       │
│    • Authenticates requests via Cloudflare Access Service Token verification.          │
│                                                                                        │
│  [2. In-Process HTTP / RPC Dispatcher (Axum / Hyper / Tokio)]                          │
│    • Routes incoming tunnel streams internally to modular subsystem handlers:          │
│                                                                                        │
│    ├── /s3/*          ──► Embedded S3 Storage Engine (NVMe directory backend)         │
│    ├── /workerd/*     ──► Reverse proxy to supervised local workerd process            │
│    ├── /ci/*          ──► Embedded CI task queue, runner, and live SSE log streamer    │
│    ├── /docker/*      ──► Filtered Docker/Podman socket proxy (safe container ops)     │
│    ├── /telemetry/*   ──► In-process sysinfo probe streaming CPU/RAM over WebSocket    │
│    ├── /files/*       ──► Web SFTP archive handler (inspect/download container files)  │
│    └── /mirrord/*     ──► mirrord remote agent bridge for local dev traffic mirroring   │
│                                                                                        │
│  [3. workerd Process Supervisor & Wrangler Compiler]                                   │
│    • Supervises the official cloudflare/workerd C++ binary on a private Unix socket.   │
│    • Ingests standard wrangler.jsonc files deployed from the Cloudflare Worker API.     │
│    • Compiles wrangler.jsonc dynamically into workerd.capnp configurations.             │
│    • Maps env.MY_BUCKET to local S3 directories; maps env.MY_DO to local SQLite.        │
│    • Triggers seamless hot reloads via Cap'n Proto without dropping active sockets.    │
│                                                                                        │
│  [4. Embedded CI Runner Engine]                                                        │
│    • Replaces Woodpecker / Drone.                                                      │
│    • Connects to local /var/run/docker.sock to spawn ephemeral runner containers.      │
│    • Mounts host cache directories (/var/cache/cfb-broker/...) for instant builds.     │
│    • Streams stdout/stderr directly over Server-Sent Events (SSE) back over tunnel.    │
│                                                                                        │
│  [5. In-Process Telemetry Probe]                                                       │
│    • Compiles the Rust sysinfo crate directly into the binary.                         │
│    • Samples CPU (per-core), memory, swap, disk I/O, network RX/TX, and process trees. │
│    • Replaces separate monitoring daemons with 0.1% CPU overhead.                      │
│                                                                                        │
│  [6. Userspace Virtual Networking Stack (cfrs net)]                                    │
│    • Integrates smoltcp and libcfrsnet.so LD_PRELOAD interposer.                       │
│    • Allows sandboxed processes to bind virtual 10.66.0.0/24 networks without root.    │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. How `cfb-broker` Interfaces with Cloudflare

### Tunnel Ingress: Two Operation Modes
1. **Registered Production Tunnel**:
   - `cfb-broker run --tunnel-token <TOKEN>`
   - Authenticates directly against Cloudflare's Argo Tunnel edge using credentials issued in Cloudflare Zero Trust dashboard.
   - Routes ingress traffic matching hostnames (`s3.infra.domain`, `workerd.infra.domain`, `ci.infra.domain`) directly to internal async handlers.
2. **Anonymous Quick-Tunnel (Ad-Hoc / Preview Mode)**:
   - `cfb-broker quick-tunnel`
   - Leverages `cfrs::quicktunnel` to provision an anonymous `*.trycloudflare.com` URL with zero stored credentials.
   - Ideal for temporary sandboxes, ephemeral PR previews, or staging environments.

### Fallback Transport in Restricted Sandboxes
If outbound UDP/QUIC and port 7844 are blocked by enterprise firewalls or locked-down cloud VPS security groups, `cfb-broker` uses the proven fallback mechanism from `cfrs`:
- Establishes an SSH remote forward over port 443 through an HTTP CONNECT proxy.
- Splices incoming visitor channels to an internal Unix domain socket.
- The tunnel remains fully operational even on networks that block official `cloudflared`.

---

## 4. Resource & Footprint Comparison

| Dimension | 7-Container Docker Compose Stack | Single Binary `cfb-broker` + `workerd` |
| :--- | :--- | :--- |
| **Processes Running** | 7 daemons + auxiliary helpers | **2 processes** (`cfb-broker` + supervised `workerd`) |
| **Disk Footprint** | ~1.4 GB (Multiple base images) | **~65 MB** (`cfb-broker` ~15MB, `workerd` ~50MB) |
| **Idle Memory Consumption**| **350 MiB – 800 MiB RAM** | **< 25 MiB RAM total** |
| **Startup Time** | 15–30 seconds | **< 200 milliseconds** |
| **Configuration Files** | 7 files (compose, toml, yml, json) | **1 unified TOML file** (`/etc/cfb-broker.toml`) |
| **Installation** | Requires Docker, Compose, and root | Single static binary; runs under unprivileged user |

---

## 5. Host Configuration File (`/etc/cfb-broker.toml`)

```toml
[server]
bind_addr = "127.0.0.1:9000"
data_dir = "/var/lib/cfb-broker"
log_level = "info"

[tunnel]
token = "eyJhIjoiY2xvdWRmbGFyZXRva2Vu..."
protocol = "auto" # Tries QUIC -> HTTP/2 -> SSH/CONNECT fallback

[auth]
# Validates Cloudflare Access Service Token on incoming tunnel requests
cf_access_client_id = "your-service-token-id.access"
cf_access_client_secret = "your-service-token-secret"

[workerd]
enabled = true
binary_path = "/usr/local/bin/workerd"
listen_port = 8080
storage_dir = "/var/lib/cfb-broker/do-storage"

[s3]
enabled = true
listen_port = 3900
storage_dir = "/var/lib/cfb-broker/s3-data"
region = "auto"

[ci]
enabled = true
docker_socket = "/var/run/docker.sock"
cache_dir = "/var/cache/cfb-broker/ci"
max_concurrent_jobs = 4

[telemetry]
enabled = true
sample_interval_secs = 2
```
