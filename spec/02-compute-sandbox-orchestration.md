# Compute & Sandbox Orchestration: Docker, Nomad, MicroVMs, and Amika

## 1. Remote Container Management from Edge Isolates

Cloudflare Workers run in stateless V8 isolates without Linux kernel namespaces, cgroups, or raw sockets. To provision, start, stop, and monitor long-running containers from a Cloudflare Worker control plane, requests must be proxied over **Cloudflare Tunnels** to an orchestration agent or container engine API on the host.

---

## 2. Docker & Podman Engine API over Cloudflare Tunnel

### 2.1 The Docker Engine API
The Docker daemon exposes a comprehensive REST API over Unix domain socket (`/var/run/docker.sock`) or TCP (`http://127.0.0.1:2375`).
- Container lifecycle: `POST /v1.44/containers/create`, `POST /v1.44/containers/{id}/start`, `POST /v1.44/containers/{id}/stop`, `DELETE /v1.44/containers/{id}`.
- Real-time logs: `GET /v1.44/containers/{id}/logs?follow=1&stdout=1&stderr=1`.
- Interactive terminal: `POST /v1.44/containers/{id}/attach/ws` (WebSocket).

### 2.2 Security Hardening: `tecnativa/docker-socket-proxy`
Exposing the raw Docker socket to any network interface—even over an authenticated private tunnel—presents extreme risk. A compromised API token could allow mounting the host root filesystem (`-v /:/host`) or executing privileged containers.

To mitigate this, deploy [Tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy), an HAProxy-based filtering proxy that blocks destructive API paths and restricts access to safe container operations:

```yaml
services:
  docker-proxy:
    image: tecnativa/docker-socket-proxy:latest
    container_name: docker-proxy
    restart: unless-stopped
    ports:
      - "127.0.0.1:2375:2375"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    environment:
      # Enable safe container management
      CONTAINERS: 1
      IMAGES: 1
      INFO: 1
      PING: 1
      VERSION: 1
      # Disable dangerous host manipulation
      VOLUMES: 0
      NETWORKS: 0
      SYSTEM: 0
      SWARM: 0
      NODES: 0
      SERVICES: 0
      SECRETS: 0
      CONFIGS: 0
      PLUGINS: 0
      POST: 1
      DELETE: 1
      AUTH: 0
```

### 2.3 Interactive Terminal over WebSocket
The Cloudflare Worker initiates a WebSocket upgrade against Docker's attach endpoint:
```typescript
// Edge Worker routes /api/sandboxes/terminal/:containerId
const wsUrl = new URL(env.DOCKER_TUNNEL_HOST);
wsUrl.protocol = "wss:";
wsUrl.pathname = `/v1.44/containers/${containerId}/attach/ws`;
wsUrl.search = "?stream=1&stdin=1&stdout=1&stderr=1";

const originWsRes = await fetch(wsUrl.toString(), {
  headers: {
    Upgrade: "websocket",
    "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
    "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
  },
});

const serverSocket = originWsRes.webSocket;
if (!serverSocket) {
  return new Response("Failed to connect to container terminal", { status: 502 });
}

// Pair WebSockets to stream terminal I/O to the browser
const [client, worker] = Object.values(new WebSocketPair());
worker.accept();
serverSocket.accept();

worker.addEventListener("message", (e) => serverSocket.send(e.data));
serverSocket.addEventListener("message", (e) => worker.send(e.data));
serverSocket.addEventListener("close", () => worker.close());
worker.addEventListener("close", () => serverSocket.close());

return new Response(null, { status: 101, webSocket: client });
```

### 2.4 Demultiplexing Docker Binary Log Streams
Docker prefixes log frames with an 8-byte header:
- `Byte 0`: Stream type (`1` = stdout, `2` = stderr).
- `Bytes 1–3`: Reserved null bytes (`0x00, 0x00, 0x00`).
- `Bytes 4–7`: Big-endian unsigned 32-bit integer indicating frame size.

The Cloudflare Worker uses a `TransformStream` to demux stdout and stderr into JSON or SSE frames in real time without buffering the entire output.

---

## 3. Multi-Node Orchestration: HashiCorp Nomad vs. K3s

When managing multiple servers, a cluster scheduler is required.

| Feature | HashiCorp Nomad ([hashicorp/nomad](https://github.com/hashicorp/nomad)) | K3s / Kubernetes ([k3s-io/k3s](https://github.com/k3s-io/k3s)) |
| :--- | :--- | :--- |
| **API Philosophy** | Clean REST API with flat JSON payloads | Verbose declarative Kubernetes API with deep nesting |
| **Auth Model** | Simple header: `X-Nomad-Token: <token>` | Bearer token / client certificates |
| **Ad-Hoc / Batch Jobs** | **Parameterized Jobs** (`POST /v1/job/{id}/dispatch`) | Requires generating custom `Job`/`Pod` manifests per run |
| **Footprint** | Single ~80MB Go binary; **40–80MB RAM idle** | Single binary, but runs apiserver/etcd; **500MB–1.2GB RAM** |
| **Execution Drivers** | Docker, Podman, Firecracker, raw_exec, QEMU | OCI containers only (CRI) |
| **CF Worker Ergonomics**| **Optimal**: Easy to dispatch and monitor via standard `fetch()` | High overhead for serverless edge workers |

### Dispatching Parameterized Jobs in Nomad from Cloudflare Worker
1. Define a template job in Nomad:
   ```hcl
   job "sandbox-task" {
     type = "batch"
     parameterized {
       payload       = "forbidden"
       meta_required = ["SANDBOX_ID", "IMAGE", "COMMAND"]
     }
     group "task" {
       task "runner" {
         driver = "docker"
         config {
           image   = "${NOMAD_META_IMAGE}"
           command = "${NOMAD_META_COMMAND}"
           runtime = "runsc" # gVisor sandboxing
         }
         resources {
           cpu    = 2000
           memory = 2048
         }
       }
     }
   }
   ```
2. The Cloudflare Worker triggers runs dynamically:
   ```typescript
   const res = await fetch(`${env.NOMAD_URL}/v1/job/sandbox-task/dispatch`, {
     method: "POST",
     headers: {
       "Content-Type": "application/json",
       "X-Nomad-Token": env.NOMAD_TOKEN,
       "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
       "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
     },
     body: JSON.stringify({
       Meta: {
         SANDBOX_ID: "sandbox-9481",
         IMAGE: "ghcr.io/org/ci-builder:latest",
         COMMAND: "npm test",
       },
     }),
   });
   ```

---

## 4. In-Depth Analysis of `gofixpoint/amika`

[gofixpoint/amika](https://github.com/gofixpoint/amika) provides a reference blueprint for orchestrating remote VMs and coding environments from Cloudflare edge services.

### 4.1 Core Subsystems
1. **`go/cmd/amikad/` (In-Guest Daemon)**:
   - Runs inside the VM sandbox at `/usr/local/bin/amikad`.
   - Binds OpenSSH `sshd` strictly to `127.0.0.1:22` (loopback only).
   - Starts an authenticated loopback HTTP server on port `60999` exposing `GET /v1/ssh-sessions`.
   - When an SSH client connects, it upgrades the connection to WebSocket, verifies a one-time 32-byte secret token, and pipes bytes bidirectionally between the WebSocket and `127.0.0.1:22`. This grants terminal access without exposing raw SSH ports.
2. **`js/amika-hostd/` (Host Compute Daemon)**:
   - Runs on the physical host, wrapping `smolvm serve` to manage local microVMs via KVM or Apple Hypervisor.
   - Dials outbound to the control plane, eliminating incoming firewall configuration.
3. **`js/tunnel-protocol/` (`amika.tunnel.v2`)**:
   - Pure Web-standard multiplexing binary codec using `Uint8Array`, `DataView`, and `TextEncoder`.
   - Zero Node.js dependencies: runs natively inside Cloudflare Workers and Durable Objects.
   - Binary frame structure (5-byte header):
     - Byte 0: `Frame Type` (1=OPEN, 2=RESPONSE, 3=DATA, 4=END, 5=RESET, 6=WINDOW, 7=TEXT, 8=BINARY, 9=CLOSE).
     - Bytes 1–4: `Stream ID` (big-endian 32-bit unsigned int).
   - **Credit-Based Flow Control**: Senders are restricted to 256 KiB credit windows until receivers emit `WINDOW` frames, preventing fast compute nodes from overwhelming Cloudflare Worker memory buffers.
   - **Zero-Cost WebSocket Auto-Response**:
     - Host emits ping frame `amika.tunnel.v2.ping` every 30s.
     - Cloudflare Durable Object configures `setWebSocketAutoResponse`, allowing Cloudflare Edge to return `amika.tunnel.v2.pong` **without waking the Durable Object from sleep**, incurring zero execution cost.

### 4.2 Repurposing Amika Components
- Extract `@amika/tunnel-protocol` to serve as a high-density multiplexer between Cloudflare Durable Objects and remote compute agents.
- Adopt the `amikad` loopback SSH bridge design for browser-based interactive terminal access to CI sandboxes.

---

## 5. MicroVM & Sandbox Runtimes

For untrusted multi-tenant workloads, raw Docker containers share the host Linux kernel. To achieve true virtualization:

1. **gVisor (`runsc`)**:
   - Intercepts and executes Linux syscalls in user space.
   - Plugs directly into Docker (`--runtime=runsc`) and Nomad.
   - Adds ~10–15% CPU overhead on heavy I/O, but provides robust defense against kernel exploits.
2. **Firecracker ([firecracker-microvm/firecracker](https://github.com/firecracker-microvm/firecracker))**:
   - Minimalist KVM-based Virtual Machine Monitor written in Rust.
   - Boots Linux kernels in ~5ms with ~5MB RAM overhead.
   - Can be scheduled directly via Nomad using `nomad-driver-firecracker`.
3. **Incus / LXC ([zabbly/incus](https://github.com/zabbly/incus))**:
   - High-density system containers and lightweight VMs with REST API access.
   - Excellent for stateful multi-user persistent dev boxes.
