use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use fragarach_ir::{IR_SCHEMA_VERSION, SourceDocument, SourceManifest, SourceState};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

const CONTROL_DIRECTORY: &str = ".fragarach";
const CONFIG_FILE: &str = "config.json";
const DATABASE_FILE: &str = "workspace.db";
const MANIFEST_FILE: &str = "manifest.json";
const PARSED_DIRECTORY: &str = "parsed";
const OPERATION_LOCK_FILE: &str = "operation.lock";

pub struct WorkspaceLock {
    file: File,
}

impl WorkspaceLock {
    pub fn acquire(root: &Path, operation: &str) -> Result<Self> {
        let path = WorkspacePaths::for_root(root)
            .control
            .join(OPERATION_LOCK_FILE);
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .with_context(|| format!("failed to open workspace lock: {}", path.display()))?;
        file.try_lock().map_err(|error| {
            anyhow::anyhow!(
                "workspace is busy with another scan or compile operation: {} ({error})",
                root.display()
            )
        })?;
        file.set_len(0)?;
        file.seek(SeekFrom::Start(0))?;
        writeln!(
            file,
            "operation={operation}\npid={}\nstarted_at={}",
            std::process::id(),
            Utc::now().to_rfc3339()
        )?;
        file.sync_data()?;
        Ok(Self { file })
    }
}

impl Drop for WorkspaceLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceConfig {
    pub schema_version: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct WorkspacePaths {
    pub root: PathBuf,
    pub control: PathBuf,
    pub config: PathBuf,
    pub database: PathBuf,
    pub manifest: PathBuf,
    pub parsed: PathBuf,
}

impl WorkspacePaths {
    pub fn for_root(root: &Path) -> Self {
        let control = root.join(CONTROL_DIRECTORY);
        Self {
            root: root.to_path_buf(),
            config: control.join(CONFIG_FILE),
            database: control.join(DATABASE_FILE),
            manifest: control.join(MANIFEST_FILE),
            parsed: control.join(PARSED_DIRECTORY),
            control,
        }
    }
}

#[derive(Debug, Clone)]
pub struct StoredSource {
    pub content_hash: String,
    pub state: SourceState,
    pub parser_key: Option<String>,
}

pub struct Workspace {
    pub paths: WorkspacePaths,
    connection: Connection,
}

impl Workspace {
    pub fn initialize(root: &Path) -> Result<WorkspacePaths> {
        fs::create_dir_all(root)
            .with_context(|| format!("failed to create workspace root: {}", root.display()))?;
        let paths = WorkspacePaths::for_root(root);
        fs::create_dir_all(&paths.parsed).with_context(|| {
            format!(
                "failed to create workspace control directory: {}",
                paths.parsed.display()
            )
        })?;

        if !paths.config.exists() {
            let config = WorkspaceConfig {
                schema_version: IR_SCHEMA_VERSION.to_owned(),
                created_at: Utc::now(),
            };
            fs::write(&paths.config, serde_json::to_string_pretty(&config)? + "\n")
                .with_context(|| format!("failed to write {}", paths.config.display()))?;
        }

        let connection = Connection::open(&paths.database)
            .with_context(|| format!("failed to open {}", paths.database.display()))?;
        migrate(&connection)?;

        Ok(paths)
    }

    pub fn open(root: &Path) -> Result<Self> {
        let paths = WorkspacePaths::for_root(root);
        if !paths.config.is_file() {
            bail!(
                "workspace is not initialized: {} (run `fragarach init` first)",
                root.display()
            );
        }

        let connection = Connection::open(&paths.database)
            .with_context(|| format!("failed to open {}", paths.database.display()))?;
        migrate(&connection)?;

        Ok(Self { paths, connection })
    }

    pub fn ensure_source_root(&self, source_root: &str) -> Result<()> {
        let existing: Option<String> = self
            .connection
            .query_row(
                "SELECT value FROM metadata WHERE key = 'source_root'",
                [],
                |row| row.get(0),
            )
            .optional()?;

        match existing {
            Some(existing) if existing != source_root => {
                bail!("workspace is already bound to another source root: {existing}")
            }
            Some(_) => Ok(()),
            None => {
                self.connection.execute(
                    "INSERT INTO metadata (key, value) VALUES ('source_root', ?1)",
                    [source_root],
                )?;
                Ok(())
            }
        }
    }

    pub fn existing_sources(&self) -> Result<HashMap<String, StoredSource>> {
        let mut statement = self.connection.prepare(
            "SELECT path, content_hash, state, parser_key
             FROM source_documents",
        )?;
        let rows = statement.query_map([], |row| {
            let state: String = row.get(2)?;
            Ok((
                row.get::<_, String>(0)?,
                StoredSource {
                    content_hash: row.get(1)?,
                    state: parse_state(&state),
                    parser_key: row.get(3)?,
                },
            ))
        })?;

        let mut sources = HashMap::new();
        for row in rows {
            let (path, source) = row?;
            sources.insert(path, source);
        }
        Ok(sources)
    }

    pub fn upsert_source(
        &self,
        document: &SourceDocument,
        parser_key: Option<&str>,
        scan_id: &str,
    ) -> Result<()> {
        let warnings = serde_json::to_string(&document.warnings)?;
        self.connection.execute(
            "INSERT INTO source_documents (
                path, source_id, content_hash, size_bytes, modified_at, format,
                state, duplicate_of, parsed_artifact, warnings_json, parser_key,
                last_seen_scan, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(path) DO UPDATE SET
                source_id = excluded.source_id,
                content_hash = excluded.content_hash,
                size_bytes = excluded.size_bytes,
                modified_at = excluded.modified_at,
                format = excluded.format,
                state = excluded.state,
                duplicate_of = excluded.duplicate_of,
                parsed_artifact = excluded.parsed_artifact,
                warnings_json = excluded.warnings_json,
                parser_key = excluded.parser_key,
                last_seen_scan = excluded.last_seen_scan,
                updated_at = excluded.updated_at",
            params![
                document.path,
                document.id,
                document.content_hash,
                i64::try_from(document.size_bytes).unwrap_or(i64::MAX),
                document.modified_at.map(|value| value.to_rfc3339()),
                document.format,
                document.state.as_str(),
                document.duplicate_of,
                document.parsed_artifact,
                warnings,
                parser_key,
                scan_id,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn mark_removed_not_seen(&self, scan_id: &str) -> Result<Vec<String>> {
        let removed_paths = {
            let mut statement = self.connection.prepare(
                "SELECT path FROM source_documents
                 WHERE last_seen_scan <> ?1 AND state <> 'removed'
                 ORDER BY path",
            )?;
            let rows = statement.query_map([scan_id], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };

        self.connection.execute(
            "UPDATE source_documents
             SET state = 'removed', updated_at = ?2
             WHERE last_seen_scan <> ?1 AND state <> 'removed'",
            params![scan_id, Utc::now().to_rfc3339()],
        )?;

        Ok(removed_paths)
    }

    pub fn write_manifest(&self, manifest: &SourceManifest) -> Result<()> {
        let json = serde_json::to_string_pretty(manifest)?;
        fs::write(&self.paths.manifest, json + "\n")
            .with_context(|| format!("failed to write {}", self.paths.manifest.display()))
    }
}

fn migrate(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS source_documents (
            path TEXT PRIMARY KEY,
            source_id TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            modified_at TEXT,
            format TEXT NOT NULL,
            state TEXT NOT NULL,
            duplicate_of TEXT,
            parsed_artifact TEXT,
            warnings_json TEXT NOT NULL,
            parser_key TEXT,
            last_seen_scan TEXT NOT NULL,
            updated_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_source_documents_hash
            ON source_documents(content_hash);
         CREATE INDEX IF NOT EXISTS idx_source_documents_scan
            ON source_documents(last_seen_scan);",
    )?;
    Ok(())
}

fn parse_state(state: &str) -> SourceState {
    match state {
        "parsed" => SourceState::Parsed,
        "duplicate" => SourceState::Duplicate,
        "unsupported" => SourceState::Unsupported,
        "error" => SourceState::Error,
        "removed" => SourceState::Removed,
        _ => SourceState::Error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initializes_and_reopens_workspace() {
        let temporary = tempfile::tempdir().unwrap();
        let paths = Workspace::initialize(temporary.path()).unwrap();

        assert!(paths.config.is_file());
        assert!(paths.database.is_file());
        assert!(paths.parsed.is_dir());
        Workspace::open(temporary.path()).unwrap();
    }

    #[test]
    fn operation_lock_is_exclusive_and_released_on_drop() {
        let temporary = tempfile::tempdir().unwrap();
        Workspace::initialize(temporary.path()).unwrap();

        let first = WorkspaceLock::acquire(temporary.path(), "scan").unwrap();
        assert!(WorkspaceLock::acquire(temporary.path(), "compile").is_err());
        drop(first);
        WorkspaceLock::acquire(temporary.path(), "compile").unwrap();
    }
}
