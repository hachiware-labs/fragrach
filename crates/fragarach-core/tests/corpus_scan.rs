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
    assert_eq!(first.summary.total_current, 25);
    assert_eq!(first.summary.added, 25);
    assert_eq!(first.summary.parsed_documents, 24);
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
    assert_eq!(second.summary.unchanged, 25);
    assert_eq!(second.summary.parse_cache_hits, 24);
    assert_eq!(second.summary.parsed_now, 0);
}
