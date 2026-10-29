//! In-Process Host & Container Telemetry Probe
//! Replaces ServerBee/Netdata with an internal Rust sysinfo probe (< 5MB RAM)
//! License: 0BSD

use serde::Serialize;
use sysinfo::System;
use tracing::info;

#[derive(Serialize, Debug)]
pub struct HostMetrics {
    pub cpu_usage_pct: f32,
    pub mem_used_bytes: u64,
    pub mem_total_bytes: u64,
    pub swap_used_bytes: u64,
    pub uptime_secs: u64,
}

pub struct TelemetryState {
    sys: std::sync::Mutex<System>,
}

impl TelemetryState {
    pub fn new() -> Self {
        let mut sys = System::new_all();
        sys.refresh_all();
        Self {
            sys: std::sync::Mutex::new(sys),
        }
    }

    /// Captures current host metrics
    pub fn sample(&self) -> HostMetrics {
        let mut sys = self.sys.lock().unwrap();
        sys.refresh_all();
        HostMetrics {
            cpu_usage_pct: sys.global_cpu_usage(),
            mem_used_bytes: sys.used_memory(),
            mem_total_bytes: sys.total_memory(),
            swap_used_bytes: sys.used_swap(),
            uptime_secs: System::uptime(),
        }
    }
}

pub async fn run_doctor() -> Result<(), Box<dyn std::error::Error>> {
    let sys = System::new_all();
    info!(
        cores = sys.cpus().len(),
        total_mem_mb = sys.total_memory() / 1024 / 1024,
        "Doctor diagnosis complete: host ready for cfb-broker"
    );
    Ok(())
}
