use std::path::PathBuf;

use fragarach_core::{init_workspace, scan};
use fragarach_ir::SourceState;

#[test]
fn scans_the_aobane_corpus_end_to_end() {
    let repository_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|path| path.parent())
        .unwrap()
        .to_path_buf();
    let source = repository_root.join("tests/corpora/aobane-industries-ja/sources");
    let workspace = tempfile::tempdir().unwrap();
    init_workspace(workspace.path()).unwrap();

    let first = scan(&source, workspace.path()).unwrap();
    assert_eq!(first.summary.total_current, 47);
    assert_eq!(first.summary.added, 47);
    assert_eq!(first.summary.parsed_documents, 46);
    assert_eq!(first.summary.duplicates, 1);
    assert_eq!(first.summary.errors, 0);
    assert_eq!(first.summary.unsupported, 0);
    assert!(
        first
            .documents
            .iter()
            .filter(|document| document.state == SourceState::Parsed)
            .all(|document| document.parsed_artifact.is_some())
    );
    assert!(
        first
            .documents
            .iter()
            .find(|document| document.state == SourceState::Duplicate)
            .unwrap()
            .parsed_artifact
            .is_some()
    );

    let second = scan(&source, workspace.path()).unwrap();
    assert_eq!(second.summary.unchanged, 47);
    assert_eq!(second.summary.parse_cache_hits, 46);
    assert_eq!(second.summary.parsed_now, 0);
}

#[test]
fn scans_the_aobane_medium_corpus_end_to_end() {
    let root = tempfile::tempdir().unwrap();
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/corpora/aobane-industries-ja-medium/sources");
    let workspace = root.path().join("workspace");
    init_workspace(&workspace).unwrap();

    let first = scan(&source, &workspace).unwrap();
    assert_eq!(first.summary.total_current, 100);
    assert_eq!(first.summary.added, 100);
    assert_eq!(first.summary.parsed_documents, 99);
    assert_eq!(first.summary.duplicates, 1);
    assert_eq!(first.summary.errors, 0);
    assert_eq!(first.summary.unsupported, 0);

    let second = scan(&source, &workspace).unwrap();
    assert_eq!(second.summary.unchanged, 100);
    assert_eq!(second.summary.parse_cache_hits, 99);
    assert_eq!(second.summary.parsed_now, 0);
}
