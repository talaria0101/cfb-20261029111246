// JavaScript Worker implementation running inside standalone workerd
// Demonstrates native SQLite Durable Objects, SQL querying, and WebSocket hibernation

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === "/healthz") {
      return Response.json({
        status: "ok",
        runtime: "workerd-standalone",
        timestamp: new Date().toISOString()
      });
    }

    // Dynamic Worker Deployment endpoint
    if (request.method === "POST" && url.pathname === "/api/deploy") {
      const { appName, script } = await request.json();
      await env.LOADER.get(appName, {
        modules: { "index.js": script },
        compatibilityDate: "2026-01-01"
      });
      return Response.json({ success: true, app: appName });
    }

    // Route stateful coordination and WebSocket sessions to Durable Object
    if (url.pathname.startsWith("/ws") || url.pathname.startsWith("/state")) {
      const roomId = url.searchParams.get("room") || "default";
      const id = env.COORDINATOR.idFromName(roomId);
      const stub = env.COORDINATOR.get(id);
      return stub.fetch(request);
    }

    return new Response("workerd edge-alt runtime active", { status: 200 });
  }
};

export class SessionCoordinator {
  constructor(state, env) {
    this.state = state;
    this.sql = state.storage.sql;

    // Initialize embedded SQLite relational schema inside the Durable Object
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        action TEXT NOT NULL,
        data TEXT
      )
    `);
  }

  async fetch(request) {
    const url = new URL(request.url);

    // 1. WebSocket Upgrade with Hibernation
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // Hibernates socket: wakes up isolate only when frames arrive (zero idle CPU)
      this.state.acceptWebSocket(server);

      this.sql.exec(
        "INSERT INTO audit_log (action, data) VALUES (?, ?)",
        "ws_connect",
        JSON.stringify({ clientIp: request.headers.get("CF-Connecting-IP") })
      );

      return new Response(null, { status: 101, webSocket: client });
    }

    // 2. Query embedded SQLite database
    if (url.pathname === "/state/history") {
      const cursor = this.sql.exec("SELECT * FROM audit_log ORDER BY id DESC LIMIT 25");
      const rows = [...cursor];
      return Response.json({ count: rows.length, rows });
    }

    return new Response("SessionCoordinator ready", { status: 200 });
  }

  // Invoked when an incoming WebSocket message arrives on a hibernated socket
  async webSocketMessage(ws, message) {
    this.sql.exec(
      "INSERT INTO audit_log (action, data) VALUES (?, ?)",
      "message",
      typeof message === "string" ? message : "[binary]"
    );

    // Broadcast to all active connected hibernated clients
    for (const client of this.state.getWebSockets()) {
      client.send(`[room-echo]: ${message}`);
    }
  }

  async webSocketClose(ws, code, reason) {
    ws.close(code, "Closed by DO");
  }
}
