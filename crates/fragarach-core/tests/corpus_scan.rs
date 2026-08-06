use std::path::PathBuf;

use fragarach_core::{init_workspace, scan};
use fragarach_ir::SourceState;

#[test]
fn scan_tracks_add_edit_delete_and_readdition() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&source).unwrap();
    init_workspace(&workspace).unwrap();

    let policy = source.join("policy.md");
    std::fs::write(&policy, "# 規程\n\n保持期間は3年。\n").unwrap();
    let first = scan(&source, &workspace).unwrap();
    assert_eq!(first.summary.added, 1);
    assert_eq!(first.summary.parsed_now, 1);
    let stable_id = first.documents[0].id.clone();
    let first_hash = first.documents[0].content_hash.clone();

    std::fs::write(&policy, "# 規程\n\n保持期間は5年。\n").unwrap();
    let edited = scan(&source, &workspace).unwrap();
    assert_eq!(edited.summary.changed, 1);
    assert_eq!(edited.summary.parsed_now, 1);
    assert_eq!(edited.documents[0].id, stable_id);
    assert_ne!(edited.documents[0].content_hash, first_hash);

    std::fs::write(source.join("register.md"), "# 台帳\n\nrevision 2を承認。\n").unwrap();
    let added = scan(&source, &workspace).unwrap();
    assert_eq!(added.summary.added, 1);
    assert_eq!(added.summary.unchanged, 1);
    assert_eq!(added.summary.parsed_now, 1);
    assert_eq!(added.summary.parse_cache_hits, 1);

    std::fs::remove_file(&policy).unwrap();
    let deleted = scan(&source, &workspace).unwrap();
    assert_eq!(deleted.summary.removed, 1);
    assert_eq!(deleted.removed_paths, vec!["policy.md"]);
    assert_eq!(deleted.documents.len(), 1);
    assert_eq!(deleted.documents[0].path, "register.md");

    std::fs::write(&policy, "# 規程\n\n保持期間は7年。\n").unwrap();
    let readded = scan(&source, &workspace).unwrap();
    assert_eq!(readded.summary.added, 1);
    assert_eq!(readded.summary.unchanged, 1);
    assert_eq!(
        readded
            .documents
            .iter()
            .find(|item| item.path == "policy.md")
            .unwrap()
            .id,
        stable_id,
    );
}

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
    assert_eq!(first.summary.total_current, 500);
    assert_eq!(first.summary.added, 500);
    assert_eq!(first.summary.parsed_documents, 469);
    assert_eq!(first.summary.duplicates, 31);
    assert_eq!(first.summary.errors, 0);
    assert_eq!(first.summary.unsupported, 0);

    let second = scan(&source, &workspace).unwrap();
    assert_eq!(second.summary.unchanged, 500);
    assert_eq!(second.summary.parse_cache_hits, 469);
    assert_eq!(second.summary.parsed_now, 0);
}
