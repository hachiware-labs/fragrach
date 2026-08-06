#[allow(dead_code)]
#[path = "../examples/compare_oracle.rs"]
mod compare_oracle;

#[test]
fn oracle_comparison_keeps_layer_differences_visible() {
    let report: serde_json::Value =
        serde_json::from_str(&compare_oracle::build_report_json().unwrap()).unwrap();
    assert_eq!(report["cases"], 28);
    let reports = report["reports"].as_array().unwrap();
    let metric = |resolver: &str, name: &str| {
        reports
            .iter()
            .find(|report| report["resolver"] == resolver)
            .unwrap()["metrics"][name]
            .as_f64()
            .unwrap()
    };

    let relevance = metric("r0_relevance_only", "decision_accuracy");
    let weighted = metric("s1_weighted_metadata", "decision_accuracy");
    let filter_first = metric("s2_filter_first", "decision_accuracy");
    let relation_graph = metric("s3_relation_graph", "decision_accuracy");
    assert!(relevance < weighted);
    assert!(weighted < filter_first);
    assert!(filter_first < relation_graph);
    assert_eq!(relation_graph, 1.0);
    assert_eq!(metric("s2_filter_first", "abstention_accuracy"), 1.0);
}

#[test]
fn holdout_oracle_preserves_relation_graph_regressions() {
    let report: serde_json::Value = serde_json::from_str(
        &compare_oracle::build_report_json_for_corpus(
            "tests/corpora/aobane-industries-ja-validity-holdout",
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(report["cases"], 20);
    let relation_graph = report["reports"]
        .as_array()
        .unwrap()
        .iter()
        .find(|report| report["resolver"] == "s3_relation_graph")
        .unwrap();
    assert_eq!(relation_graph["metrics"]["strict_case_accuracy"], 1.0);
    assert_eq!(relation_graph["metrics"]["decision_accuracy"], 1.0);
    assert_eq!(relation_graph["metrics"]["abstention_accuracy"], 1.0);
}
