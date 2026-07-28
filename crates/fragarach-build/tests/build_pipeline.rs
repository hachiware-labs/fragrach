use std::fs;

use anyhow::Result;
use fragarach_build::{
    CompileOptions, ConflictContext, RecompileOptions, compile_workspace, export_rag_jsonl,
    read_build_report, recompile_build,
};
use fragarach_ir::{
    CompilationPolicy, Diagnostic, DiagnosticSeverity, EvidenceReference, KnowledgeBuildStatus,
};
use fragarach_llm::{
    ClaimCandidate, ClaimExtractionRequest, ClaimExtractionResponse, ClaimExtractor, LlmUsage,
};
use serde_json::json;

struct FixtureExtractor {
    hallucinate_reference: bool,
}

impl ClaimExtractor for FixtureExtractor {
    fn extract(&self, request: &ClaimExtractionRequest) -> Result<ClaimExtractionResponse> {
        let evidence = &request.evidence[0];
        Ok(ClaimExtractionResponse {
            claims: vec![ClaimCandidate {
                subject: "緊急変更".to_owned(),
                predicate: "review_deadline".to_owned(),
                object: json!("2営業日"),
                condition: None,
                valid_from: None,
                valid_to: None,
                authority: None,
                status: Some("active".to_owned()),
                confidence: 1.0,
                evidence: vec![EvidenceReference {
                    source_id: evidence.source_id.clone(),
                    evidence_id: if self.hallucinate_reference {
                        "invented".to_owned()
                    } else {
                        evidence.evidence_id.clone()
                    },
                }],
            }],
            provider: "fixture".to_owned(),
            model: "deterministic".to_owned(),
            usage: LlmUsage {
                prompt_tokens: 10,
                completion_tokens: 5,
                duration_ms: 1,
            },
        })
    }
}

fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    fs::create_dir(&source).unwrap();
    fs::write(
        source.join("policy.md"),
        "# 緊急変更\n\n事後レビューは2営業日以内に行う。\n",
    )
    .unwrap();
    fs::write(
        root.path().join("corpus.yaml"),
        "authority_precedence: [corporate_standard, guidance]\n",
    )
    .unwrap();
    fragarach_core::init_workspace(root.path()).unwrap();
    fragarach_core::scan(&source, root.path()).unwrap();
    let intent = root.path().join("intent.yaml");
    fs::write(
        &intent,
        "id: test-intent\ngoal: 期限を確認する\nusers: [developer]\ntasks: [期限確認]\nquestions: [いつまでか]\nrequirements:\n  evidence_required: true\n  temporal_scope_required: true\n  unresolved_conflicts_allowed: true\n",
    )
    .unwrap();
    (root, intent)
}

#[test]
fn atomically_publishes_complete_build_and_exports_it() {
    let (root, intent) = fixture();
    let output = root.path().join("published");
    let result = compile_workspace(
        &CompileOptions {
            workspace: root.path().to_path_buf(),
            intent_file: intent,
            output: output.clone(),
            batch_size: 8,
            conflict_context: ConflictContext::default(),
            policy: CompilationPolicy::default(),
        },
        &FixtureExtractor {
            hallucinate_reference: false,
        },
    )
    .unwrap();

    assert_eq!(result.manifest.status, KnowledgeBuildStatus::Completed);
    assert_eq!(result.manifest.metrics.claims, 1);
    assert_eq!(result.manifest.metrics.prompt_tokens, 10);
    assert!(output.join("provenance.json").is_file());
    assert!(
        fs::read_to_string(output.join("provenance.json"))
            .unwrap()
            .contains("\"authority_precedence\": [")
    );
    assert_eq!(
        read_build_report(&output).unwrap().manifest,
        result.manifest
    );
    let evidence: serde_json::Value = serde_json::from_str(
        fs::read_to_string(output.join("evidence.jsonl"))
            .unwrap()
            .lines()
            .next()
            .unwrap(),
    )
    .unwrap();
    fs::write(
        output.join("diagnostics.jsonl"),
        format!(
            "{}\n",
            serde_json::to_string(&Diagnostic {
                id: "missing-owner".to_owned(),
                code: "FRG-CST-MISSING-OWNER".to_owned(),
                severity: DiagnosticSeverity::Warning,
                message: "担当者がありません".to_owned(),
                target_ids: Vec::new(),
                evidence_ids: vec![evidence["evidence_id"].as_str().unwrap().to_owned()],
                reason: "原文に担当者の記載がありません".to_owned(),
                suggestions: vec!["担当者を決めてください".to_owned()],
                questions: vec!["誰が担当しますか".to_owned()],
            })
            .unwrap()
        ),
    )
    .unwrap();
    let export = root.path().join("rag.jsonl");
    assert_eq!(export_rag_jsonl(&output, &export).unwrap(), 2);
    let exported = fs::read_to_string(export).unwrap();
    assert!(exported.contains("conflict_ids"));
    assert!(exported.contains("担当者がありません"));

    let recompiled_output = root.path().join("recompiled");
    let recompiled = recompile_build(&RecompileOptions {
        workspace: root.path().to_path_buf(),
        input: output.clone(),
        output: recompiled_output.clone(),
        conflict_context: ConflictContext::default(),
        policy: CompilationPolicy::default(),
    })
    .unwrap();
    assert_eq!(recompiled.manifest.status, KnowledgeBuildStatus::Completed);
    assert_eq!(recompiled.manifest.metrics.llm_calls, 0);
    assert!(
        fs::read_to_string(recompiled_output.join("provenance.json"))
            .unwrap()
            .contains("\"recompiled_from\"")
    );

    let error = compile_workspace(
        &CompileOptions {
            workspace: root.path().to_path_buf(),
            intent_file: root.path().join("intent.yaml"),
            output,
            batch_size: 8,
            conflict_context: ConflictContext::default(),
            policy: CompilationPolicy::default(),
        },
        &FixtureExtractor {
            hallucinate_reference: false,
        },
    )
    .unwrap_err();
    assert!(error.to_string().contains("output already exists"));
}

#[test]
fn failed_build_is_preserved_outside_the_publication_path() {
    let (root, intent) = fixture();
    let requested_output = root.path().join("must-not-publish");
    let result = compile_workspace(
        &CompileOptions {
            workspace: root.path().to_path_buf(),
            intent_file: intent,
            output: requested_output.clone(),
            batch_size: 8,
            conflict_context: ConflictContext::default(),
            policy: CompilationPolicy {
                warnings_as_errors: true,
                ..CompilationPolicy::default()
            },
        },
        &FixtureExtractor {
            hallucinate_reference: true,
        },
    )
    .unwrap();

    assert_eq!(result.manifest.status, KnowledgeBuildStatus::Failed);
    assert!(!requested_output.exists());
    assert!(
        result
            .output
            .starts_with(root.path().join(".fragarach/failed-builds"))
    );
    assert!(result.output.join("diagnostics.jsonl").is_file());
}
