# Self-Hosting Cloudflare's `workerd` Engine: Standalone Workers & Durable Objects

## 1. Overview of `cloudflare/workerd`

[cloudflare/workerd](https://github.com/cloudflare/workerd) is the open-source, C++/V8-based JavaScript and WebAssembly runtime that powers Cloudflare Workers. While deployed globally across Cloudflare's edge network, **`workerd` can run completely standalone as a daemon or container on any standard Linux server**.

Running `workerd` on self-hosted infrastructure allows developers to:
1. Execute Cloudflare Worker scripts without edge CPU execution caps (e.g. run 10-minute long-running computations).
2. Host stateful **Durable Objects backed by local SQLite databases** (`localDisk`).
3. Leverage **hibernatable WebSockets** that consume zero memory when idle.
4. Eliminate request billing and isolate invocation fees.
5. Expose instances securely to the Cloudflare Edge dashboard via **Cloudflare Tunnels (`cloudflared`)**.

---

## 2. Standalone Deployment Options

1. **Pre-Built Binaries**: Installed via NPM (`npm install -g workerd`) or compiled from source using Bazel.
2. **Container Image**: Official images available at `ghcr.io/cloudflare/workerd:latest`.
3. **Self-Contained Executable**: Statically bundles configuration and code into a single binary:
   ```bash
   workerd compile workerd.capnp config -o /usr/local/bin/workerd-server
   ```
4. **Systemd Socket Activation**: Supports `--socket-fd <name>=<fd>`, allowing systemd to listen on privileged ports or Unix domain sockets and hand file descriptors to unprivileged `workerd` processes.

---

## 3. Configuration Model: Cap’n Proto (`workerd.capnp`)

`workerd` uses [Cap'n Proto](https://capnproto.org/) for its strongly-typed configuration schema defined in `src/workerd/server/workerd.capnp`.

### Core Configuration Schema Entities

```capnp
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .appWorker),
    # Local persistent directory mapping for SQLite-backed Durable Objects
    (name = "doStorage", disk = (path = "/var/lib/workerd/do-data", writable = true)),
    # Network egress service with SSRF protection
    (name = "internet", network = (allow = ["public"], tlsOptions = (trustBrowserCas = true))),
  ],

  sockets = [
    (
      name = "http",
      address = "127.0.0.1:8080",
      http = (
        forwardedProtoHeader = "X-Forwarded-Proto",
        cfBlobHeader = "CF-Blob"
      ),
      service = "main"
    )
  ]
);

const appWorker :Workerd.Worker = (
  compatibilityDate = "2026-01-01",
  compatibilityFlags = ["nodejs_compat"],

  modules = [
    (name = "index.mjs", esModule = embed "dist/index.mjs")
  ],

  # Durable Objects definition
  durableObjectNamespaces = [
    (
      className = "SessionManager",
      uniqueKey = "6a45e483f982467d9834b6b281b378da",
      enableSql = true,
      preventEviction = true
    )
  ],

  # Persist Durable Objects to disk via embedded SQLite
  durableObjectStorage = (localDisk = "doStorage"),

  bindings = [
    (name = "SESSIONS", durableObjectNamespace = "SessionManager"),
    (name = "LOADER", workerLoader = (id = "dynamic-apps"))
  ]
);
```

---

## 4. Key Runtime Capabilities

### 4.1 Durable Objects with Embedded SQLite
When configured with `durableObjectStorage = (localDisk = "doStorage")` and `enableSql = true`:
- Each Durable Object instance is allocated its own SQLite database file on disk: `/var/lib/workerd/do-data/<uniqueKey>/<objectId>.sqlite`.
- Worker code can execute relational SQL queries directly against `state.storage.sql.exec("SELECT ...")` with sub-millisecond local latency.
- Full support for `state.storage.setAlarm(timestamp)` and scheduled wakeups.

### 4.2 Hibernatable WebSockets
In a standard Node.js server, 50,000 idle WebSocket connections consume gigabytes of RAM. Inside `workerd` Durable Objects:
- Calling `state.acceptWebSocket(ws)` hands the socket off to the underlying C++ runtime.
- The V8 isolate can be garbage collected or put to sleep.
- When a client sends a message, `workerd` wakes the object and invokes `webSocketMessage()`, slashing idle memory overhead.

### 4.3 Multi-Node Cluster Coordination (`ClusterConfig`)
Multiple `workerd` instances across independent servers can form a coordinated cluster using an S3-compatible bucket (such as **Garage S3**) for lease management:
```capnp
cluster = (
  bucket = "s3://workerd-leases/cluster-prod",
  bucketOptions = [
    "aws_endpoint=http://127.0.0.1:3900",
    "aws_access_key_id=YOUR_KEY",
    "aws_secret_access_key=YOUR_SECRET"
  ],
  address = "10.0.0.1:9090",
  advertise = "10.0.0.1:9090",
  key = "32_BYTE_HEX_SHARED_HMAC_SECRET"
)
```
Nodes synchronize ownership of Durable Objects via conditional S3 writes. Requests arriving at Node A for an object hosted on Node B are proxied peer-to-peer automatically.

### 4.4 Dynamic Code Loading via `workerLoader`
Rather than restarting `workerd` to deploy code, use the `workerLoader` binding:
```javascript
export default {
  async fetch(request, env) {
    if (request.method === "POST" && new URL(request.url).pathname === "/deploy") {
      const { appName, script } = await request.json();

      // Dynamically instantiate or update a Worker isolate from code
      const dynamicWorker = await env.LOADER.get(appName, {
        modules: { "index.js": script },
        compatibilityDate: "2026-01-01"
      });

      return new Response("Deployed successfully");
    }

    // Dispatch request to loaded worker
    const worker = await env.LOADER.get("my-tenant-app");
    return worker.fetch(request);
  }
};
```

---

## 5. Integrating `workerd` with Cloudflare Tunnels

To expose `workerd` securely to the Cloudflare Workers dashboard without opening public ports:

```
[ Browser / Dashboard ]
         │
         ▼  HTTPS / WSS
┌─────────────────────────────────────────────────────────────┐
│                 Cloudflare Global Network                   │
│                                                             │
│  [ Cloudflare Worker / Router Gateway ]                     │
│   • Validates user session / API Key                        │
│   • Injects CF-Access-Client-Id & Secret                    │
│   • Routes path: /api/workerd/*                             │
└──────────────┬──────────────────────────────────────────────┘
               │
               │  Cloudflare Tunnel (Encrypted QUIC)
               ▼
┌─────────────────────────────────────────────────────────────┐
│                      Host Machine                           │
│                                                             │
│  [ cloudflared daemon ]                                     │
│         │                                                   │
│         ▼ HTTP / WSS to 127.0.0.1:8080                      │
│  [ workerd runtime ]                                        │
│         │                                                   │
│         ├── Main Worker Isolate                             │
│         ├── Persistent SQLite Durable Objects               │
│         └── Hibernated WebSockets                           │
└─────────────────────────────────────────────────────────────┘
```

### Edge Worker Proxy Implementation
```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Target the private Cloudflare Tunnel hostname
    const targetUrl = new URL(url.pathname + url.search, "https://workerd.infra.example.com");

    const headers = new Headers(request.headers);
    headers.set("CF-Access-Client-Id", env.CF_ACCESS_CLIENT_ID);
    headers.set("CF-Access-Client-Secret", env.CF_ACCESS_CLIENT_SECRET);
    headers.set("X-Forwarded-Host", url.hostname);

    return fetch(new Request(targetUrl, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual"
    }));
  }
};
```

---

## 6. Security & Multi-Tenancy Boundary Warning

While `workerd` isolates memory via V8 Isolates, **V8 isolates do not provide defense-in-depth against speculative execution hardware bugs (e.g. Spectre/Meltdown) or zero-day engine escapes**.

If running untrusted third-party code:
- Wrap `workerd` inside a **gVisor (`runsc`) sandbox container** or a **Firecracker microVM**.
- Set memory limits using Linux cgroups (`MemoryMax=4G`).
- Filter egress traffic using `Service.network` to prevent internal SSRF.
