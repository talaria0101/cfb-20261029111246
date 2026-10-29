# Host Daemon Specification: `cfb-broker`

## 1. Process Model and Resource Envelope

`cfb-broker` is a single static Rust executable running on the host server under systemd or as a rootless daemon.

- Static Binary Size: Under 15 MiB.
- Resident Memory (RSS): Under 20 MiB idle.
- Threading Model: Async event loop driven by Tokio with a multi-threaded runtime.
- External Dependencies: Official `cloudflare/workerd` binary and local Docker or Podman Unix socket.

---

## 2. Subsystem Architecture

```
+------------------------------------------------------------------------------------+
|                         cfb-broker (Single Rust Executable)                        |
+------------------------------------------------------------------------------------+
|                                                                                    |
|  [1. Embedded Tunnel Ingress]                                                      |
|    - QUIC / HTTP/2 transport to Cloudflare Edge.                                   |
|    - Fallback SSH remote forward over port 443 via HTTP CONNECT proxy.             |
|    - Validates CF-Access-Client-Id and CF-Access-Client-Secret headers.            |
|                                                                                    |
|  [2. In-Process Dispatcher]                                                        |
|    Routes incoming tunnel requests to internal async handlers:                     |
|    - /s3/*          -> Embedded S3 storage engine.                                 |
|    - /workerd/*     -> Reverse proxy to supervised workerd process.                |
|    - /ci/*          -> In-process task queue, container runner, and SSE logs.      |
|    - /docker/*      -> Filtered Docker socket proxy for container management.      |
|    - /telemetry/*   -> In-process sysinfo probe streaming host metrics.            |
|    - /files/*       -> Container filesystem archive streamer (Web SFTP).           |
|                                                                                    |
|  [3. workerd Supervisor & Wrangler Compiler]                                       |
|    - Supervises the official workerd process over a local Unix domain socket.      |
|    - Parses incoming wrangler.jsonc files dynamically.                             |
|    - Generates workerd.capnp configuration files in memory.                        |
|    - Binds env.MY_BUCKET to local disk and env.MY_DO to SQLite.                    |
|    - Hot-reloads workerd isolates without dropping existing sockets.               |
|                                                                                    |
|  [4. Embedded CI Runner Engine]                                                    |
|    - Interacts directly with /var/run/docker.sock.                                 |
|    - Spawns ephemeral containers for pipeline steps.                               |
|    - Mounts persistent host cache directories.                                     |
|    - Streams stdout and stderr over Server-Sent Events (SSE).                      |
|                                                                                    |
|  [5. In-Process Telemetry Probe]                                                   |
|    - Samples sysinfo metrics: CPU (per-core), memory, swap, disk I/O, network.     |
|    - Emits JSON payloads over WebSocket and HTTP endpoints.                        |
+------------------------------------------------------------------------------------+
```

---

## 3. Subsystem Technical Contracts

### 3.1 workerd Supervisor
- Execution Target: Spawns `/usr/local/bin/workerd serve <config.capnp>`.
- IPC Mechanism: Communication between `cfb-broker` and `workerd` occurs over loopback TCP (`127.0.0.1:8080`) or Unix domain socket (`/run/cfb-broker/workerd.sock`).
- Dynamic Reload: When a new `wrangler.jsonc` and JavaScript bundle are received at `/workerd/deploy`, `cfb-broker` updates the Cap'n Proto configuration file and signals the `workerd` process or leverages its `workerLoader` API for in-memory module swapping.

### 3.2 In-Process S3 Engine
- Path Mapping: Objects are stored at `<data_dir>/s3/<bucket>/<key>`.
- Concurrency Control: Concurrent writes to the same key use atomic write-and-rename semantics (`.tmp-<uuid>` moved to target key on completion).
- Metadata Storage: Object size, MIME type, and ETag are stored directly on disk alongside the object or in an embedded SQLite index.

### 3.3 CI Task Runner
- Execution Model: Each pipeline step maps to an isolated container run (`docker run --rm`).
- Log Multiplexing: Docker 8-byte frame headers (byte 0: 1=stdout, 2=stderr; bytes 4 to 7: uint32 payload length) are parsed and forwarded line-by-line over SSE.
- Caching: Host directory `/var/cache/cfb-broker/ci/<repo_id>` is mounted into the container at the configured cache path.

### 3.4 Telemetry Probe
- Provider: Compiled Rust `sysinfo` library.
- Metrics Emitted:
  - `cpu_usage_pct`: global and per-core CPU utilization percentage.
  - `mem_used_bytes` / `mem_total_bytes`: physical memory utilization.
  - `swap_used_bytes` / `swap_total_bytes`: swap utilization.
  - `disk_io_read_bytes` / `disk_io_write_bytes`: storage throughput.
  - `net_rx_bytes` / `net_tx_bytes`: network interface throughput.
- Update Frequency: Sampled every 2000 milliseconds.

---

## 4. Host Configuration Schema (`/etc/cfb-broker.toml`)

```toml
[server]
bind_addr = "127.0.0.1:9000"
data_dir = "/var/lib/cfb-broker"
log_level = "info"

[tunnel]
token = "eyJhIjoiY2xvdWRmbGFyZXRva2Vu..."
protocol = "auto" # Values: auto, quic, http2, ssh_fallback

[auth]
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
