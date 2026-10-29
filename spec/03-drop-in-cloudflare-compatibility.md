# Compatibility Specification: Zero-Code-Change Cloudflare Execution

## 1. Compatibility Contract

The runtime layer guarantees that an application written to standard Cloudflare Workers ES Module specifications runs identically on Cloudflare edge and on self-hosted `cfb-broker` instances.

### Supported Binding Invariants

1. Workers Fetch Handler:
   - Signature: `export default { async fetch(request, env, ctx) { ... } }`.
   - APIs available: `fetch()`, `Request`, `Response`, `Headers`, `ReadableStream`, `WritableStream`, `crypto.subtle`, `WebSocketPair`.

2. R2 Object Storage:
   - Binding: `r2_buckets` in `wrangler.jsonc`.
   - Operations: `env.BUCKET.get(key)`, `env.BUCKET.put(key, body, options)`, `env.BUCKET.delete(key)`, `env.BUCKET.list(options)`.

3. Durable Objects with Native SQLite:
   - Binding: `durable_objects` in `wrangler.jsonc`.
   - In-memory execution: exactly-one actor instance per unique ID.
   - Storage API: `state.storage.sql.exec(query, ...params)` executing against local embedded SQLite.
   - WebSocket Hibernation: `state.acceptWebSocket(ws)`, with lifecycle callbacks `webSocketMessage`, `webSocketClose`, `webSocketError`.
   - Alarms: `state.storage.setAlarm(timestamp)` and `alarm()` handlers.

---

## 2. Standard Cloudflare Application Reference

```javascript
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // R2 Object Storage Binding
    if (url.pathname.startsWith("/storage/")) {
      const key = url.pathname.replace("/storage/", "");

      if (request.method === "PUT") {
        await env.ARTIFACTS.put(key, request.body);
        return new Response(`Stored: ${key}`, { status: 201 });
      }

      const object = await env.ARTIFACTS.get(key);
      if (!object) return new Response("Not Found", { status: 404 });

      return new Response(object.body, {
        headers: { "Content-Type": object.httpMetadata?.contentType || "application/octet-stream" },
      });
    }

    // Durable Object Binding
    if (url.pathname.startsWith("/session/")) {
      const sessionId = url.searchParams.get("id") || "default";
      const id = env.COORDINATOR.idFromName(sessionId);
      const stub = env.COORDINATOR.get(id);
      return stub.fetch(request);
    }

    return new Response("Service Online", { status: 200 });
  },
};

export class SessionCoordinator {
  constructor(state, env) {
    this.state = state;
    this.sql = state.storage.sql;

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        payload TEXT NOT NULL
      )
    `);
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    const cursor = this.sql.exec("SELECT * FROM events ORDER BY id DESC LIMIT 25");
    return Response.json([...cursor]);
  }

  async webSocketMessage(ws, message) {
    this.sql.exec("INSERT INTO events (payload) VALUES (?)", message);
    for (const client of this.state.getWebSockets()) {
      client.send(message);
    }
  }
}
```

---

## 3. Configuration Specification (`wrangler.jsonc`)

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "app-service",
  "main": "src/index.mjs",
  "compatibility_date": "2026-01-01",
  "compatibility_flags": ["nodejs_compat"],
  "r2_buckets": [
    {
      "binding": "ARTIFACTS",
      "bucket_name": "app-artifacts"
    }
  ],
  "durable_objects": {
    "bindings": [
      {
        "name": "COORDINATOR",
        "class_name": "SessionCoordinator"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["SessionCoordinator"]
    }
  ]
}
```

---

## 4. `cfb-broker` Translation Mechanics

When `cfb-broker` receives a deployment payload containing `wrangler.jsonc` and the JavaScript bundle:

1. AST Extraction:
   `cfb-broker` reads `r2_buckets`, `durable_objects`, and `compatibility_flags`.

2. Cap'n Proto Generation:
   - For each entry in `durable_objects.bindings`, `cfb-broker` registers a `DurableObjectNamespace` with `enableSql = true` and binds storage to the local NVMe directory `/var/lib/cfb-broker/do-storage`.
   - For each entry in `r2_buckets`, `cfb-broker` registers an `r2Bucket` service binding pointing to `/var/lib/cfb-broker/s3-data/<bucket_name>`.

3. Generated `workerd.capnp` Output:
```capnp
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .appWorker),
    (name = "doStorage", disk = (path = "/var/lib/cfb-broker/do-storage", writable = true)),
    (name = "internet", network = (allow = ["public"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:8080", http = (), service = "main")
  ]
);

const appWorker :Workerd.Worker = (
  compatibilityDate = "2026-01-01",
  compatibilityFlags = ["nodejs_compat"],
  modules = [(name = "index.mjs", esModule = embed "app.mjs")],
  durableObjectNamespaces = [
    (className = "SessionCoordinator", uniqueKey = "b9f2a41d", enableSql = true)
  ],
  durableObjectStorage = (localDisk = "doStorage"),
  bindings = [
    (name = "COORDINATOR", durableObjectNamespace = "SessionCoordinator"),
    (name = "ARTIFACTS", r2Bucket = (name = "app-artifacts"))
  ]
);
```

4. Process Hot-Reload:
   `cfb-broker` writes the Cap'n Proto configuration to disk and initiates dynamic isolate reloading on `workerd` without socket re-binding.
