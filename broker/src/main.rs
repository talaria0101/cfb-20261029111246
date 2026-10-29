//! cfb-broker: Single unified Cloudflare alternative broker daemon
//! License: 0BSD

#![allow(dead_code, unused_variables)]

use clap::{Parser, Subcommand};
use std::net::SocketAddr;
use std::path::PathBuf;
use tracing::{info, Level};
use tracing_subscriber::FmtSubscriber;

mod ci;
mod files;
mod s3;
mod supervisor;
mod telemetry;
mod tunnel;

#[derive(Parser, Debug)]
#[command(
    name = "cfb-broker",
    about = "Single unified Cloudflare alternative broker daemon: embedded tunnel, workerd supervisor, S3 broker, CI runner, and telemetry"
)]
struct Cli {
    #[arg(short, long, default_value = "/etc/cfb-broker.toml")]
    config: PathBuf,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Start the unified broker daemon
    Run,
    /// Provision an anonymous quick-tunnel (from cfrs)
    QuickTunnel,
    /// Diagnose network connectivity and constraints
    Doctor,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let subscriber = FmtSubscriber::builder()
        .with_max_level(Level::INFO)
        .finish();
    tracing::subscriber::set_global_default(subscriber)?;

    let cli = Cli::parse();
    let command = cli.command.unwrap_or(Commands::Run);

    match command {
        Commands::Run => {
            info!("Starting cfb-broker unified daemon...");

            // 1. Initialize Telemetry Probe (sysinfo)
            let _telemetry_state = telemetry::TelemetryState::new();
            info!("In-process host telemetry probe initialized");

            // 2. Initialize S3 Storage Broker
            let _s3_state = s3::S3State::new(PathBuf::from("/var/lib/cfb-broker/s3"));
            info!("In-process S3 storage engine initialized");

            // 3. Initialize workerd Supervisor
            let _supervisor = supervisor::WorkerdSupervisor::new(
                PathBuf::from("/usr/local/bin/workerd"),
                PathBuf::from("/var/lib/cfb-broker/do-storage"),
                8080,
            );
            info!("workerd runtime supervisor initialized");

            // 4. Initialize CI Task Runner
            let _ci_runner = ci::CiRunner::new(
                PathBuf::from("/var/run/docker.sock"),
                PathBuf::from("/var/cache/cfb-broker/ci"),
            );
            info!("In-process CI container runner initialized");

            // 5. Connect to Cloudflare Tunnel (QUIC / HTTP2 or quick-tunnel fallback)
            let _tunnel_manager = tunnel::TunnelManager::new();
            info!("Cloudflare Tunnel connector starting...");

            let listen_addr: SocketAddr = "127.0.0.1:9000".parse()?;
            info!(addr = %listen_addr, "cfb-broker HTTP & RPC dispatcher active");

            // Main server loop (simulated listener)
            tokio::signal::ctrl_c().await?;
            info!("Shutdown signal received, terminating cfb-broker cleanly.");
        }
        Commands::QuickTunnel => {
            info!("Requesting anonymous Cloudflare quick-tunnel via cfrs engine...");
            let url = tunnel::provision_anonymous_quick_tunnel().await?;
            println!("Anonymous quick-tunnel active at: {}", url);
        }
        Commands::Doctor => {
            info!("Running host constraints doctor...");
            telemetry::run_doctor().await?;
        }
    }

    Ok(())
}
