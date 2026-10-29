# CI & Compute Specification: Embedded Runner Subsystem

## 1. Subsystem Scope

The CI runner subsystem inside `cfb-broker` manages the execution of containerized build pipelines and ephemeral sandboxes on the host server without external CI server daemons.

---

## 2. Job Dispatch API & Payload Schema

Jobs are submitted to `POST /ci/dispatch` over the Cloudflare Tunnel:

```json
{
  "jobId": "job-8491",
  "repoUrl": "https://github.com/org/project.git",
  "commit": "a1b2c3d4",
  "steps": [
    {
      "name": "build",
      "image": "rust:1.82-alpine",
      "commands": [
        "cargo check --release",
        "cargo test"
      ],
      "caches": [
        {
          "hostPath": "/var/cache/cfb/cargo",
          "containerPath": "/usr/local/cargo/registry"
        }
      ]
    }
  ]
}
```

---

## 3. Container Lifecycle Mechanics

1. Image Validation: `cfb-broker` checks image existence via Docker Engine API (`GET /images/{name}/json`). Missing images are pulled dynamically.
2. Volume Mounts: Host cache paths are verified and mounted into the container specification.
3. Execution: Containers launch with stdin/stdout piped to an internal multiplexer.
4. Teardown: On step completion, `cfb-broker` records exit code status and issues an immediate container removal (`DELETE /containers/{id}?v=1&force=true`).

---

## 4. Live Server-Sent Events (SSE) Streaming

Clients listen to `GET /ci/stream/:jobId`:

### Wire Protocol Framing
```http
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no

data: {"step":"build","stream":"stdout","line":"   Compiling app v1.0.0"}

data: {"step":"build","stream":"stdout","line":"    Finished release target"}

event: complete
data: {"jobId":"job-8491","status":"success","exitCode":0}

```

### Docker 8-Byte Stream Demultiplexing
Raw container stdout/stderr streams carry an 8-byte binary header:
- Byte 0: Stream Type (1 = stdout, 2 = stderr).
- Bytes 1 to 3: Reserved null bytes.
- Bytes 4 to 7: Big-endian 32-bit unsigned integer (payload length).

`cfb-broker` parses this header in-stream, splits payloads on newline boundaries, and emits formatted SSE events without intermediary buffer accumulation.

---

## 5. Security & Isolation

- OCI Runtime: Containers execute under the gVisor (`runsc`) sandboxed runtime.
- Filesystem Scope: Only designated cache directories (`/var/cache/cfb/ci/...`) are accessible to container mounts.
- User Isolation: Steps run as unprivileged UID 1000 unless root is explicitly required.
