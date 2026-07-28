use std::fs;
use std::path::PathBuf;

#[test]
fn loads_all_aobane_usage_intents() {
    let manifest_directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repository_root = manifest_directory
        .parent()
        .and_then(|path| path.parent())
        .unwrap()
        .to_path_buf();
    let intents = repository_root.join("tests/corpora/aobane-industries-ja/intents");
    let mut loaded = 0;

    for entry in fs::read_dir(intents).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("yaml") {
            continue;
        }
        fragarach_build::load_usage_intent(&path).unwrap();
        loaded += 1;
    }

    assert_eq!(loaded, 4);
}
