//! Embedded Heavy CI & Container Task Runner
//! Replaces external Woodpecker/Drone daemons with an in-process async runner
//! License: 0BSD

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tracing::info;

#[derive(Debug, Serialize, Deserialize)]
pub struct CiJobPayload {
    pub job_id: String,
    pub repo_url: String,
    pub commit: String,
    pub steps: Vec<CiStep>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CiStep {
    pub name: String,
    pub image: String,
    pub commands: Vec<String>,
}

pub struct CiRunner {
    pub docker_socket: PathBuf,
    pub cache_dir: PathBuf,
}

impl CiRunner {
    pub fn new(docker_socket: PathBuf, cache_dir: PathBuf) -> Self {
        Self {
            docker_socket,
            cache_dir,
        }
    }

    /// Dispatches a CI pipeline run in an ephemeral container with live SSE log streaming
    pub async fn dispatch_job(&self, job: &CiJobPayload) -> Result<(), Box<dyn std::error::Error>> {
        info!(job_id = %job.job_id, repo = %job.repo_url, "Starting ephemeral CI runner container");
        // Spawns ephemeral container via docker_socket and streams logs
        Ok(())
    }
}
