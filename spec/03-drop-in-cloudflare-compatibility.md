# Drop-In Cloudflare Compatibility: Zero-Code-Change Worker & Durable Object Execution

## 1. The Core Invariant: Zero Code Changes

When building applications, developers should not have to maintain two separate codebases—one with proprietary custom HTTP endpoints for self-hosting and another using standard Cloudflare bindings for production.

**The Invariant**:
Any application code written using standard Cloudflare Workers syntax, Durable Objects classes, R2 bucket bindings, and standard `wrangler.jsonc` configurations must run **without changing a single line of code** whether deployed to Cloudflare's global edge or to self-hosted infrastructure running `cfb-broker`.

---

## 2. Standard Cloudflare Application Code Example

The following standard Cloudflare Worker code utilizes Workers, Durable Objects with native SQLite (`state.storage.sql`), and R2 Object Storage:

```javascript
/**
 * Standard Cloudflare Worker: Zero Custom APIs
 * File: src/index.mjs
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. R2 Object Storage Binding (env.ARTIFACTS)
    if (url.pathname.startsWith("/storage/")) {
      const key = url.pathname.replace("/storage/", "");

      if (request.method === "PUT") {
        await env.ARTIFACTS.put(key, request.body);
        return new Response(`Saved to R2: ${key}`, { status: 201 });
      }

      const object = await env.ARTIFACTS.get(key);
      if (!object) return new Response("Object Not Found", { status: 404 });

      return new Response(object.body, {
        headers: { "Content-Type": object.httpMetadata?.contentType || "application/octet-stream" },
      });
    }

    // 2. Durable Objects Binding (env.COORDINATOR)
    if (url.pathname.startsWith("/chat/") || url.pathname.startsWith("/state/")) {
      const roomId = url.searchParams.get("room") || "default";
      const id = env.COORDINATOR.idFromName(roomId);
      const stub = env.COORDINATOR.get(id);
      return stub.fetch(request);
    }

    return new Response("Cloudflare Worker Online", { status: 200 });
  },
};

/**
 * Standard Cloudflare Durable Object Class with Native SQLite & Hibernated WebSockets
 */
export class SessionCoordinator {
  constructor(state, env) {
    this.state = state;
    this.sql = state.storage.sql; // Native SQLite query engine!

    // Create relational schema directly in Durable Object storage
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        author TEXT NOT NULL,
        content TEXT NOT NULL
      )
    `);
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Hibernated WebSockets (consumes zero memory when idle)
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // Relational SQL query
    if (url.pathname.endsWith("/messages")) {
      const cursor = this.sql.exec("SELECT * FROM messages ORDER BY id DESC LIMIT 50");
      return Response.json([...cursor]);
    }

    return new Response("Durable Object Ready", { status: 200 });
  }

  async webSocketMessage(ws, message) {
    const data = JSON.parse(message);
    this.sql.exec("INSERT INTO messages (author, content) VALUES (?, ?)", data.author, data.content);

    // Broadcast to active hibernated clients
    for (const client of this.state.getWebSockets()) {
      client.send(JSON.stringify(data));
    }
  }
}
```

---

## 3. The Shared `wrangler.jsonc` Configuration

The developer defines standard Cloudflare bindings in `wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "my-cloud-app",
  "main": "src/index.mjs",
  "compatibility_date": "2026-01-01",
  "compatibility_flags": ["nodejs_compat"],

  // Standard R2 Bucket Binding
  "r2_buckets": [
    {
      "binding": "ARTIFACTS",
      "bucket_name": "app-artifacts"
    }
  ],

  // Standard Durable Object Binding
  "durable_objects": {
    "bindings": [
      {
        "name": "COORDINATOR",
        "class_name": "SessionCoordinator"
      }
    ]
  },

  // Standard Migration for Durable Object SQLite
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["SessionCoordinator"]
    }
  ]
}
```

---

## 4. How `cfb-broker` Executes This Code with Zero Changes

When deploying to Cloudflare edge:
- Running `wrangler deploy` pushes the bundle to Cloudflare.
- Cloudflare edge attaches proprietary R2 and Durable Object bindings.

When deploying to the self-hosted node running `cfb-broker`:
- The Cloudflare Worker control plane (or local CLI) sends the `wrangler.jsonc` and JavaScript bundle to `cfb-broker` via `POST /workerd/deploy`.
- `cfb-broker`'s **Supervisor Subsystem**:
  1. Parses `wrangler.jsonc`.
  2. Identifies `r2_buckets`: Automatically maps `env.ARTIFACTS` to `cfb-broker`'s local S3/NVMe directory.
  3. Identifies `durable_objects`: Automatically maps `env.COORDINATOR` to `workerd`'s local SQLite disk directory (`/var/lib/cfb-broker/do-storage`).
  4. Generates the equivalent Cap'n Proto schema in memory:
     ```capnp
     const appWorker :Workerd.Worker = (
       modules = [(name = "index.mjs", esModule = embed "dist/index.mjs")],
       compatibilityDate = "2026-01-01",
       compatibilityFlags = ["nodejs_compat"],
       durableObjectNamespaces = [
         (className = "SessionCoordinator", uniqueKey = "hash_of_binding", enableSql = true)
       ],
       durableObjectStorage = (localDisk = "doStorage"),
       bindings = [
         (name = "COORDINATOR", durableObjectNamespace = "SessionCoordinator"),
         (name = "ARTIFACTS", r2Bucket = (name = "app-artifacts"))
       ]
     );
     ```
  5. Dynamically hot-reloads the supervised `workerd` process without dropping open WebSocket connections.

---

## 5. Seamless Swapping Between Edge and Self-Hosted

Developers can switch traffic dynamically at the edge:

```typescript
/**
 * Cloudflare Worker Edge Gateway: Environment Swapper
 */
export default {
  async fetch(request, env) {
    const useHostedBackend = request.headers.get("X-Backend") === "self-hosted" 
      || env.DEFAULT_BACKEND === "self-hosted";

    if (useHostedBackend) {
      // Forward to self-hosted cfb-broker over Cloudflare Tunnel
      const tunnelUrl = new URL(request.url);
      tunnelUrl.hostname = "workerd.infra.yourdomain.com";

      const headers = new Headers(request.headers);
      headers.set("CF-Access-Client-Id", env.CF_ACCESS_CLIENT_ID);
      headers.set("CF-Access-Client-Secret", env.CF_ACCESS_CLIENT_SECRET);

      return fetch(new Request(tunnelUrl, {
        method: request.method,
        headers,
        body: request.body
      }));
    }

    // Execute directly on Cloudflare Native Edge
    return env.NATIVE_WORKER.fetch(request);
  }
};
```

### Result:
- **Zero code changes**: Application code uses identical `env.ARTIFACTS` and `env.COORDINATOR` calls.
- **Zero data migration friction**: The SQLite queries in `state.storage.sql` are identical standard SQL.
- **Cost control**: Move heavy batch processing, high-frequency WebSockets, or large artifact uploads to the self-hosted node while leaving edge-routed low-latency requests on Cloudflare.
