use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use fragarach_ir::{IR_SCHEMA_VERSION, ScanSummary, SourceDocument, SourceManifest, SourceState};
use fragarach_workspace::{StoredSource, Workspace, WorkspaceLock, WorkspacePaths};
use globset::{Glob, GlobSet, GlobSetBuilder};
use sha2::{Digest, Sha256};
use walkdir::{DirEntry, WalkDir};

pub fn init_workspace(root: &Path) -> Result<WorkspacePaths> {
    Workspace::initialize(root)
}

pub fn scan(source_root: &Path, workspace_root: &Path) -> Result<SourceManifest> {
    scan_with_options(source_root, workspace_root, &ScanOptions::default())
}

#[derive(Debug, Clone, Default)]
pub struct ScanOptions {
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub max_file_size: Option<u64>,
}

pub fn scan_with_options(
    source_root: &Path,
    workspace_root: &Path,
    options: &ScanOptions,
) -> Result<SourceManifest> {
    let started = std::time::Instant::now();
    let source_root = fs::canonicalize(source_root)
        .with_context(|| format!("source root does not exist: {}", source_root.display()))?;
    if !source_root.is_dir() {
        bail!("source root is not a directory: {}", source_root.display());
    }

    let workspace_root = fs::canonicalize(workspace_root).with_context(|| {
        format!(
            "workspace root does not exist: {}",
            workspace_root.display()
        )
    })?;
    let _lock = WorkspaceLock::acquire(&workspace_root, "scan")?;
    let workspace = Workspace::open(&workspace_root)?;
    let normalized_source_root = normalize_absolute_path(&source_root);
    workspace.ensure_source_root(&normalized_source_root)?;

    let existing = workspace.existing_sources()?;
    let scan_id = format!(
        "scan-{}",
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    );
    let include = build_globset(&options.include)?;
    let exclude = build_globset(&options.exclude)?;
    let mut files = collect_files(&source_root, include.as_ref(), exclude.as_ref());
    files.sort_by_key(|path| normalize_relative_path(path, &source_root));

    let parser_key = fragarach_parser::cache_key();
    let mut documents = Vec::with_capacity(files.len());
    let mut seen_hashes: HashMap<String, String> = HashMap::new();
    let mut summary = ScanSummary::default();

    for file_path in files {
        let relative_path = normalize_relative_path(&file_path, &source_root);
        let source_id = source_id(&relative_path);
        let format = file_format(&file_path);
        let previous = existing.get(&relative_path);

        let mut document = match inspect_file(
            &file_path,
            &source_id,
            &relative_path,
            &format,
            options.max_file_size,
        ) {
            Ok(document) => document,
            Err(error) => SourceDocument {
                id: source_id,
                path: relative_path.clone(),
                content_hash: String::new(),
                size_bytes: 0,
                modified_at: None,
                format,
                state: SourceState::Error,
                duplicate_of: None,
                parsed_artifact: None,
                warnings: vec![format!("{error:#}")],
            },
        };
        summary.bytes_scanned = summary.bytes_scanned.saturating_add(document.size_bytes);

        classify_change(previous, &document, &mut summary);

        let artifact_base = workspace.paths.parsed.join(&document.id);
        let artifact_json = artifact_base.with_extension("json");
        let artifact_markdown = artifact_base.with_extension("md");
        let supports_parser = fragarach_parser::supports(&file_path);
        let mut stored_parser_key = None;

        if document.state != SourceState::Error {
            if let Some(primary_source_id) = seen_hashes.get(&document.content_hash) {
                document.state = SourceState::Duplicate;
                document.duplicate_of = Some(primary_source_id.clone());
                if workspace
                    .paths
                    .parsed
                    .join(primary_source_id)
                    .with_extension("json")
                    .is_file()
                {
                    document.parsed_artifact =
                        Some(parsed_artifact_path(primary_source_id, "json"));
                }
            } else {
                seen_hashes.insert(document.content_hash.clone(), document.id.clone());

                if supports_parser {
                    stored_parser_key = Some(parser_key.as_str());
                    let cache_hit = previous.is_some_and(|source| {
                        source.content_hash == document.content_hash
                            && source.state == SourceState::Parsed
                            && source.parser_key.as_deref() == Some(parser_key.as_str())
                            && artifact_json.is_file()
                            && artifact_markdown.is_file()
                    });

                    if cache_hit {
                        document.state = SourceState::Parsed;
                        document.parsed_artifact = Some(parsed_artifact_path(&document.id, "json"));
                        summary.parse_cache_hits += 1;
                    } else {
                        match fragarach_parser::parse(&file_path, &document.id, &document.path) {
                            Ok(parsed) => {
                                fs::write(
                                    &artifact_json,
                                    serde_json::to_string_pretty(&parsed)? + "\n",
                                )
                                .with_context(|| {
                                    format!("failed to write {}", artifact_json.display())
                                })?;
                                fs::write(
                                    &artifact_markdown,
                                    fragarach_parser::render_markdown(&parsed),
                                )
                                .with_context(|| {
                                    format!("failed to write {}", artifact_markdown.display())
                                })?;
                                document.state = SourceState::Parsed;
                                document.parsed_artifact =
                                    Some(parsed_artifact_path(&document.id, "json"));
                                summary.parsed_now += 1;
                            }
                            Err(error) => {
                                document.state = SourceState::Error;
                                document.warnings.push(format!("{error:#}"));
                            }
                        }
                    }
                } else {
                    document.state = SourceState::Unsupported;
                    document.warnings.push(format!(
                        "no parser is available for .{} files",
                        document.format
                    ));
                }
            }
        }

        update_state_totals(&document.state, &mut summary);
        workspace.upsert_source(&document, stored_parser_key, &scan_id)?;
        documents.push(document);
    }

    let removed_paths = workspace.mark_removed_not_seen(&scan_id)?;
    summary.total_current = documents.len();
    summary.removed = removed_paths.len();
    summary.duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

    let manifest = SourceManifest {
        schema_version: IR_SCHEMA_VERSION.to_owned(),
        source_root: normalized_source_root,
        generated_at: Utc::now(),
        summary,
        documents,
        removed_paths,
    };
    workspace.write_manifest(&manifest)?;

    Ok(manifest)
}

fn collect_files(
    source_root: &Path,
    include: Option<&GlobSet>,
    exclude: Option<&GlobSet>,
) -> Vec<PathBuf> {
    WalkDir::new(source_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| should_visit(entry, source_root))
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(DirEntry::into_path)
        .filter(|path| {
            let relative = normalize_relative_path(path, source_root);
            include.is_none_or(|patterns| patterns.is_match(&relative))
                && exclude.is_none_or(|patterns| !patterns.is_match(&relative))
        })
        .collect()
}

fn build_globset(patterns: &[String]) -> Result<Option<GlobSet>> {
    if patterns.is_empty() {
        return Ok(None);
    }
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        builder
            .add(Glob::new(pattern).with_context(|| format!("invalid glob pattern: {pattern}"))?);
    }
    Ok(Some(builder.build()?))
}

fn should_visit(entry: &DirEntry, source_root: &Path) -> bool {
    if entry.path() == source_root {
        return true;
    }
    let name = entry.file_name().to_string_lossy();
    !matches!(name.as_ref(), ".git" | ".fragarach" | "node_modules")
}

fn inspect_file(
    file_path: &Path,
    source_id: &str,
    relative_path: &str,
    format: &str,
    max_file_size: Option<u64>,
) -> Result<SourceDocument> {
    let metadata = fs::metadata(file_path)
        .with_context(|| format!("failed to read metadata: {}", file_path.display()))?;
    if max_file_size.is_some_and(|limit| metadata.len() > limit) {
        bail!(
            "file size {} bytes exceeds configured maximum {} bytes: {}",
            metadata.len(),
            max_file_size.unwrap_or_default(),
            file_path.display()
        );
    }
    let content_hash = hash_file(file_path)?;
    let modified_at = metadata.modified().ok().map(DateTime::<Utc>::from);

    Ok(SourceDocument {
        id: source_id.to_owned(),
        path: relative_path.to_owned(),
        content_hash,
        size_bytes: metadata.len(),
        modified_at,
        format: format.to_owned(),
        state: SourceState::Unsupported,
        duplicate_of: None,
        parsed_artifact: None,
        warnings: Vec::new(),
    })
}

fn classify_change(
    previous: Option<&StoredSource>,
    current: &SourceDocument,
    summary: &mut ScanSummary,
) {
    match previous {
        None
        | Some(StoredSource {
            state: SourceState::Removed,
            ..
        }) => summary.added += 1,
        Some(previous)
            if previous.content_hash != current.content_hash
                || previous.state == SourceState::Error =>
        {
            summary.changed += 1;
        }
        Some(_) => summary.unchanged += 1,
    }
}

fn update_state_totals(state: &SourceState, summary: &mut ScanSummary) {
    match state {
        SourceState::Parsed => summary.parsed_documents += 1,
        SourceState::Duplicate => summary.duplicates += 1,
        SourceState::Unsupported => summary.unsupported += 1,
        SourceState::Error => summary.errors += 1,
        SourceState::Removed => {}
    }
}

fn hash_file(path: &Path) -> Result<String> {
    let file = File::open(path)
        .with_context(|| format!("failed to open for hashing: {}", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];

    loop {
        let count = reader
            .read(&mut buffer)
            .with_context(|| format!("failed to hash {}", path.display()))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }

    Ok(bytes_to_hex(&digest.finalize()))
}

fn source_id(relative_path: &str) -> String {
    let digest = Sha256::digest(relative_path.as_bytes());
    let hex = bytes_to_hex(&digest);
    format!("src_{}", &hex[..16])
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut output, "{byte:02x}").expect("writing to a String cannot fail");
    }
    output
}

fn file_format(path: &Path) -> String {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| "unknown".to_owned())
}

fn normalize_relative_path(path: &Path, root: &Path) -> String {
    let relative = path.strip_prefix(root).unwrap_or(path);
    relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn normalize_absolute_path(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if let Some(unc_path) = normalized.strip_prefix("//?/UNC/") {
        format!("//{unc_path}")
    } else {
        normalized
            .strip_prefix("//?/")
            .unwrap_or(&normalized)
            .to_owned()
    }
}

fn parsed_artifact_path(source_id: &str, extension: &str) -> String {
    format!(".fragarach/parsed/{source_id}.{extension}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_detects_cache_duplicates_changes_and_removals() {
        let source = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        fs::write(source.path().join("a.md"), "# A\n\n本文\n").unwrap();
        fs::write(source.path().join("copy.md"), "# A\n\n本文\n").unwrap();
        fs::write(source.path().join("memo.txt"), "メモ\n\n内容\n").unwrap();
        fs::write(source.path().join("image.bin"), [0_u8, 1, 2]).unwrap();
        init_workspace(workspace.path()).unwrap();

        let first = scan(source.path(), workspace.path()).unwrap();
        assert_eq!(first.summary.total_current, 4);
        assert_eq!(first.summary.added, 4);
        assert_eq!(first.summary.parsed_documents, 2);
        assert_eq!(first.summary.duplicates, 1);
        assert_eq!(first.summary.unsupported, 1);
        assert_eq!(first.summary.parsed_now, 2);
        assert!(
            first
                .documents
                .iter()
                .find(|document| document.state == SourceState::Duplicate)
                .unwrap()
                .parsed_artifact
                .is_some()
        );

        let second = scan(source.path(), workspace.path()).unwrap();
        assert_eq!(second.summary.unchanged, 4);
        assert_eq!(second.summary.parse_cache_hits, 2);
        assert_eq!(second.summary.parsed_now, 0);

        fs::write(source.path().join("memo.txt"), "メモ\n\n更新内容\n").unwrap();
        fs::remove_file(source.path().join("image.bin")).unwrap();
        let third = scan(source.path(), workspace.path()).unwrap();
        assert_eq!(third.summary.changed, 1);
        assert_eq!(third.summary.removed, 1);
        assert_eq!(third.summary.parsed_now, 1);
        assert_eq!(third.removed_paths, ["image.bin"]);
    }

    #[test]
    fn removes_windows_extended_path_prefix() {
        assert_eq!(
            normalize_absolute_path(Path::new(r"\\?\C:\documents")),
            "C:/documents"
        );
        assert_eq!(
            normalize_absolute_path(Path::new(r"\\?\UNC\server\share")),
            "//server/share"
        );
    }

    #[test]
    fn scan_applies_include_exclude_and_size_limits() {
        let source = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir(source.path().join("nested")).unwrap();
        fs::write(source.path().join("keep.md"), "# Keep\n\nsmall\n").unwrap();
        fs::write(source.path().join("skip.txt"), "skip\n").unwrap();
        fs::write(
            source.path().join("nested").join("excluded.md"),
            "# Excluded\n",
        )
        .unwrap();
        init_workspace(workspace.path()).unwrap();

        let filtered = scan_with_options(
            source.path(),
            workspace.path(),
            &ScanOptions {
                include: vec!["**/*.md".to_owned()],
                exclude: vec!["nested/**".to_owned()],
                max_file_size: None,
            },
        )
        .unwrap();
        assert_eq!(filtered.summary.total_current, 1);
        assert_eq!(filtered.documents[0].path, "keep.md");

        let oversized = scan_with_options(
            source.path(),
            workspace.path(),
            &ScanOptions {
                include: vec!["**/*.md".to_owned()],
                exclude: vec!["nested/**".to_owned()],
                max_file_size: Some(1),
            },
        )
        .unwrap();
        assert_eq!(oversized.summary.errors, 1);
        assert!(oversized.documents[0].warnings[0].contains("exceeds"));
    }
}
