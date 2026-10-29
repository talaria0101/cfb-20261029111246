using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .appWorker),
    # Local persistent directory mapping for SQLite-backed Durable Objects
    (name = "doStorage", disk = (path = "/var/lib/workerd/do-data", writable = true)),
    # Network egress service with public IP filtering (SSRF protection)
    (name = "internet", network = (allow = ["public"], tlsOptions = (trustBrowserCas = true))),
  ],

  sockets = [
    (
      name = "http",
      address = "0.0.0.0:8080",
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
    (name = "worker.js", esModule = embed "src/worker.js")
  ],

  # Durable Objects definition
  durableObjectNamespaces = [
    (
      className = "SessionCoordinator",
      uniqueKey = "6a45e483f982467d9834b6b281b378da",
      enableSql = true,
      preventEviction = true
    )
  ],

  # Persist Durable Objects to disk via embedded SQLite
  durableObjectStorage = (localDisk = "doStorage"),

  bindings = [
    (name = "COORDINATOR", durableObjectNamespace = "SessionCoordinator"),
    (name = "LOADER", workerLoader = (id = "dynamic-apps"))
  ]
);
