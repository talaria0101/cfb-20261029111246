# Architecture Specification: Cloudflare Alternatives Control Plane

## 1. System Scope & Invariants

This specification defines a self-hosted backend infrastructure for Cloudflare services (Workers, Durable Objects, R2, and container CI) managed from a Cloudflare-hosted control plane.

### Core Invariants

1. Drop-In Code Compatibility:
   Application code written for Cloudflare Workers, Durable Objects, and R2 executes identically on Cloudflare edge and on self-hosted nodes. Standard Cloudflare runtime APIs (including `env.MY_BUCKET.put()`, `env.MY_BUCKET.get()`, `env.MY_DO.get()`, and `state.storage.sql.exec()`) and standard `wrangler.jsonc` configuration files require zero code modifications.

2. Consolidated Host Daemon:
   The host machine runs a single native Rust binary (`cfb-broker`), derived from the networking architecture of `talaria0101/cfrs`. It embeds tunnel ingress, the S3 storage engine, the workerd process supervisor, the CI task runner, and telemetry sampling. Total idle memory is under 20 MiB RAM.

3. Cloudflare-Hosted Control Plane:
   The administrative dashboard and API gateway run on Cloudflare Pages and Cloudflare Workers. All communication between the edge Worker and remote hosts flows over Cloudflare Tunnels authenticated with Cloudflare Access Service Tokens. No inbound ports are exposed on the host.

---

## 2. Compatibility Interface Matrix

| Primitive | Standard Cloudflare API | Cloudflare Native Behavior | Self-Hosted Node (`cfb-broker`) | Delta |
| :--- | :--- | :--- | :--- | :--- |
| Workers Runtime | `export default { fetch(req, env) { ... } }` | Cloudflare Edge V8 Isolates | `cloudflare/workerd` supervised by `cfb-broker` | 0 lines |
| Durable Objects | `class MyDO { constructor(state) { this.sql = state.storage.sql; } }` | Cloudflare Edge DO (SQLite) | `workerd` DO backed by local SQLite on NVMe | 0 lines |
| Object Storage | `await env.MY_BUCKET.put(key, stream)` | Cloudflare R2 | Native `workerd` R2 binding mapped to local NVMe | 0 lines |
| External S3 API | AWS SDK / S3 Client: `s3.putObject(...)` | `<account>.r2.cloudflaredstorage.com` | `https://s3.<tunnel-domain>` served by `cfb-broker` | 0 lines |
| Configuration | Standard `wrangler.jsonc` or `wrangler.toml` | Deployed via `wrangler deploy` | `cfb-broker` parses `wrangler.jsonc` on deploy | 0 lines |
| Heavy CI Runner | Standard Git Webhooks / Container Pipelines | GitHub Actions or Workers CI | `cfb-broker` embedded CI runner with DinD | 0 lines |

---

## 3. System Architecture

```
                              PUBLIC INTERNET / OPERATORS
                                           |
             +-----------------------------+-----------------------------+
             |                                                           |
             v                                                           v
   +--------------------+                                      +--------------------+
   | Dashboard Client   |                                      | Git Webhook Source |
   | (Browser SPA)      |                                      | (GitHub / GitLab)  |
   +---------+----------+                                      +---------+----------+
             |                                                           |
             | HTTPS / WSS                                               | POST Webhook
             v                                                           v
+-----------------------------------------------------------------------------------+
|                           CLOUDFLARE EDGE CONTROL PLANE                           |
|                                                                                   |
|  [Cloudflare Pages: SPA Dashboard]                                                |
|    - Topology Visualizer: node and container network graph.                       |
|    - Telemetry Display: live CPU, memory, disk, and container stream.             |
|    - Web SFTP / Terminal: container file browsing and interactive terminal shell. |
|    - Build Monitor: live Server-Sent Events (SSE) build logs stream.              |
|                                                                                   |
|  [Cloudflare Worker: API Gateway]                                                 |
|    - Auth: Cloudflare Zero Trust Access JWT validation.                           |
|    - Service Token Injection: CF-Access-Client-Id and CF-Access-Client-Secret.    |
|    - Webhook Gateway: HMAC-SHA256 signature verification.                         |
|    - S3 Presigning: AWS SigV4 presigned upload and download URLs.                 |
|    - Stream Proxy: zero-buffering SSE logs and WebSocket terminal proxy.          |
+------------------------------------------+----------------------------------------+
                                           |
                                           | Cloudflare Tunnel (QUIC / HTTP/2)
                                           | Fallback: cfrs quick-tunnel (port 443)
                                           v
+-----------------------------------------------------------------------------------+
|                           REMOTE DATA PLANE (HOST SERVER)                         |
|                                                                                   |
|  +-----------------------------------------------------------------------------+  |
|  |                 cfb-broker (Unified Rust Daemon, < 20MB RAM)                |  |
|  |                                                                             |  |
|  |  [Embedded Tunnel Ingress]                                                  |  |
|  |    - Direct QUIC and HTTP/2 connection to Cloudflare Edge.                  |  |
|  |    - Fallback: quick-tunnel via HTTP CONNECT and port 443 SSH forward.      |  |
|  |                                                                             |  |
|  |  [Embedded S3 Storage Engine]                                               |  |
|  |    - S3 API (GetObject, PutObject, ListObjectsV2) backed by local NVMe.    |  |
|  |    - Backs external S3 clients and internal workerd R2 bucket bindings.     |  |
|  |                                                                             |  |
|  |  [workerd Runtime Supervisor]                                               |  |
|  |    - Dynamic compilation: wrangler.jsonc to workerd.capnp.                  |  |
|  |    - Supervises official cloudflare/workerd process.                        |  |
|  |    - Maps env.MY_BUCKET to local disk and env.MY_DO to SQLite.               |  |
|  |                                                                             |  |
|  |  [Embedded CI & Sandbox Runner]                                             |  |
|  |    - Executes container jobs via local /var/run/docker.sock.                |  |
|  |    - Mounts host cache directories for builds.                              |  |
|  |    - Streams stdout and stderr over Server-Sent Events (SSE).               |  |
|  |                                                                             |  |
|  |  [Embedded Telemetry Probe]                                                 |  |
|  |    - In-process sysinfo sampling: CPU, memory, disk, network.               |  |
|  +---------------------------------------+-------------------------------------+  |
|                                          |                                        |
|                                          v Unix Domain Socket / IPC               |
|  +-----------------------------------------------------------------------------+  |
|  | cloudflare/workerd (V8 Runtime)                                             |  |
|  |   - Standard Cloudflare Workers ES Module execution.                        |  |
|  |   - Native Durable Objects with embedded SQLite (state.storage.sql).        |  |
|  |   - Hibernated WebSockets (state.acceptWebSocket).                          |  |
|  +-----------------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------------+
```

---

## 4. Network and Ingress Protocols

### Tunnel Ingress
- Primary Transport: Outbound QUIC datagrams over UDP port 7844 to Cloudflare Edge.
- Secondary Transport: Multiplexed HTTP/2 streams over TCP port 7844.
- Restricted Network Fallback: When port 7844 is filtered, the daemon establishes an SSH remote forward on port 443 via an HTTP CONNECT proxy, splicing connections to a local Unix domain socket.

### Authentication
- Ingress requests from the Cloudflare Worker carry HTTP headers `CF-Access-Client-Id` and `CF-Access-Client-Secret`.
- `cfb-broker` verifies these headers against local configuration before dispatching to internal subsystem handlers. Requests failing validation receive HTTP 403 Forbidden.

---

## 5. Security Model & Isolation Boundaries

| Boundary | Enforcement Mechanism |
| :--- | :--- |
| Public Internet to Control Plane | Cloudflare Edge WAF, Zero Trust identity policies, and rate limits. |
| Edge Worker to Host Daemon | Cloudflare Access Service Token validation on all tunnel routes. |
| Host Daemon to Docker Socket | `cfb-broker` exposes explicit internal routes (`/docker/spawn`, `/docker/containers/json`), blocking raw host filesystem mounts and administrative socket endpoints. |
| Untrusted Code Execution | Ephemeral CI steps and multi-tenant code execute under the gVisor (`runsc`) OCI runtime. |
| S3 Storage Access | The edge Worker generates time-limited AWS SigV4 presigned URLs. Direct unauthenticated access to the S3 bucket root is rejected. |
