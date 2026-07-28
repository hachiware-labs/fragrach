use std::time::Duration;

use fragarach_ir::{IntentRequirements, UsageIntent};
use fragarach_llm::{ClaimExtractionRequest, ClaimExtractor, OllamaClaimExtractor, PromptEvidence};

#[test]
#[ignore = "requires a running Ollama server and an installed model"]
fn extracts_a_supported_claim_from_local_ollama() {
    let model = std::env::var("OLLAMA_MODEL").expect("OLLAMA_MODEL must name an installed model");
    let endpoint =
        std::env::var("OLLAMA_ENDPOINT").unwrap_or_else(|_| "http://127.0.0.1:11434".to_owned());
    let extractor =
        OllamaClaimExtractor::new(endpoint, model, Duration::from_secs(120), 42).unwrap();
    let evidence = PromptEvidence {
        source_id: "src_policy".to_owned(),
        evidence_id: "ev_review".to_owned(),
        source_path: "engineering/change-policy.md".to_owned(),
        source_aliases: Vec::new(),
        heading_path: vec!["緊急変更".to_owned()],
        authority: Some("corporate_standard".to_owned()),
        lifecycle: Some("active".to_owned()),
        valid_from: None,
        valid_to: None,
        text: "緊急変更は実施後2営業日以内に事後レビューを行わなければならない。".to_owned(),
    };
    let response = extractor
        .extract(&ClaimExtractionRequest {
            intent: UsageIntent {
                id: "change-review".to_owned(),
                goal: "変更レビューの要否と期限を判断する".to_owned(),
                users: vec!["開発者".to_owned()],
                tasks: vec!["事後レビューの期限を確認する".to_owned()],
                questions: vec!["緊急変更の事後レビューはいつまでか".to_owned()],
                requirements: IntentRequirements {
                    evidence_required: true,
                    temporal_scope_required: true,
                    unresolved_conflicts_allowed: false,
                },
            },
            evidence: vec![evidence.clone()],
        })
        .unwrap();

    assert!(!response.claims.is_empty());
    assert!(response.claims.iter().all(|claim| {
        claim.evidence.iter().all(|reference| {
            reference.source_id == evidence.source_id
                && reference.evidence_id == evidence.evidence_id
        })
    }));
}
