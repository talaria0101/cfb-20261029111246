# Minimal container packaging cfb-broker + workerd in one image
FROM rust:1.82-alpine AS builder
RUN apk add --no-cache musl-dev
WORKDIR /build
COPY broker/ .
RUN cargo build --release

FROM alpine:3.20
RUN apk add --no-cache ca-certificates docker-cli
WORKDIR /app

# Copy unified Rust daemon
COPY --from=builder /build/target/release/cfb-broker /usr/local/bin/cfb-broker

# Install official workerd V8 runtime binary
RUN wget -qO /tmp/workerd.tar.gz https://github.com/cloudflare/workerd/releases/download/v1.20241022.0/workerd-linux-64.gz \
    && gzip -d /tmp/workerd.tar.gz \
    && mv /tmp/workerd /usr/local/bin/workerd \
    && chmod +x /usr/local/bin/workerd

COPY deploy/cfb-broker.toml /etc/cfb-broker.toml

EXPOSE 9000
ENTRYPOINT ["/usr/local/bin/cfb-broker"]
CMD ["run", "--config", "/etc/cfb-broker.toml"]
