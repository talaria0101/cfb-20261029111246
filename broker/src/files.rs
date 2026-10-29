//! Web SFTP & Container Archive Handler (OmnySSH Pattern)
//! License: 0BSD

use std::path::PathBuf;
use tracing::info;

pub struct FileManager {
    pub base_dir: PathBuf,
}

impl FileManager {
    pub fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    /// Extracts or streams a tar archive for remote file inspection
    pub async fn stream_archive(&self, relative_path: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let full_path = self.base_dir.join(relative_path);
        info!(path = %full_path.display(), "Streaming container workspace archive");
        Ok(Vec::new())
    }
}
