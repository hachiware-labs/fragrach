use std::time::Duration;

use fragarach_ir::{IntentRequirements, UsageIntent};
use fragarach_llm::{
    ClaimExtractionRequest, ClaimExtractor, CodexAppServerClaimExtractor, PromptEvidence,
};

#[test]
#[ignore = "requires Codex CLI authentication and an available model"]
fn extracts_a_supported_claim_from_codex_app_server() {
    let command = std::env::var("CODEX_COMMAND").unwrap_or_else(|_| "codex".to_owned());
    let model = std::env::var("CODEX_MODEL").unwrap_or_else(|_| "gpt-5.6-luna".to_owned());
    let effort = std::env::var("CODEX_REASONING_EFFORT").unwrap_or_else(|_| "low".to_owned());
    let extractor = CodexAppServerClaimExtractor::new(
        command,
        model,
        effort,
        std::env::current_dir().unwrap(),
        Duration::from_secs(180),
    )
    .unwrap();
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

    assert_eq!(response.provider, "codex-app-server");
    assert!(!response.claims.is_empty());
    assert!(response.claims.iter().all(|claim| {
        claim.evidence.iter().all(|reference| {
            reference.source_id == evidence.source_id
                && reference.evidence_id == evidence.evidence_id
        })
    }));
}
