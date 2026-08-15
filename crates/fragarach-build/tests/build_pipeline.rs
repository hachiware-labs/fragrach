use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

use anyhow::Result;
use fragarach_build::{
    CompileOptions, CompileStrategy, ConflictContext, RecompileOptions, compile_workspace,
    export_rag_delta_jsonl, export_rag_jsonl, read_build_report, read_extraction_cache_report,
    recompile_build,
};
use fragarach_ir::{
    ApplicabilityScope, CompilationPolicy, Diagnostic, DiagnosticSeverity, DocumentProfile,
    DocumentRole, EvidenceReference, ForceLevel, ForceProfile, KnowledgeBuildStatus,
    TemporalProfile,
};
use fragarach_llm::{
    ClaimCandidate, ClaimExtractionRequest, ClaimExtractionResponse, ClaimExtractor,
    DocumentProfileExtractionRequest, DocumentProfileExtractionResponse, DocumentProfileExtractor,
    LlmUsage,
};
use serde_json::json;

fn read_rag_records(path: &Path) -> BTreeMap<String, serde_json::Value> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| {
            let record: serde_json::Value = serde_json::from_str(line).unwrap();
            let id = record["id"].as_str().unwrap().to_owned();
            (id, record)
        })
        .collect()
}

fn assert_delta_reconstructs_target(
    base_build: &Path,
    target_build: &Path,
    delta: &Path,
    scratch: &Path,
    label: &str,
) {
    let base_export = scratch.join(format!("{label}-base.jsonl"));
    let target_export = scratch.join(format!("{label}-target.jsonl"));
    export_rag_jsonl(base_build, &base_export).unwrap();
    export_rag_jsonl(target_build, &target_export).unwrap();
    let mut reconstructed = read_rag_records(&base_export);
    let mut committed = false;
    for line in fs::read_to_string(delta).unwrap().lines() {
        let operation: serde_json::Value = serde_json::from_str(line).unwrap();
        match operation["op"].as_str().unwrap() {
            "upsert" => {
                let id = operation["id"].as_str().unwrap().to_owned();
                let record = operation["record"].clone();
                assert_eq!(record["id"].as_str(), Some(id.as_str()));
                reconstructed.insert(id, record);
            }
            "delete" => {
                let id = operation["id"].as_str().unwrap();
                assert!(reconstructed.remove(id).is_some());
            }
            "commit" => committed = true,
            other => panic!("unexpected RAG delta operation: {other}"),
        }
    }
    assert!(committed);
    assert_eq!(reconstructed, read_rag_records(&target_export));
}

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

fn fixture_profile_response(
    request: &DocumentProfileExtractionRequest,
) -> DocumentProfileExtractionResponse {
    let mut seen = std::collections::HashSet::new();
    let profiles = request
        .evidence
        .iter()
        .filter(|item| seen.insert(item.source_id.clone()))
        .map(|item| DocumentProfile {
            source_id: item.source_id.clone(),
            document_id: None,
            revision: None,
            role: DocumentRole::Reference,
            force: ForceProfile {
                level: ForceLevel::Informational,
                authority_rank: 0,
                approved: true,
            },
            scope: ApplicabilityScope::default(),
            time: TemporalProfile::default(),
            official_record: None,
            evidence: vec![EvidenceReference {
                source_id: item.source_id.clone(),
                evidence_id: item.evidence_id.clone(),
            }],
        })
        .collect();
    DocumentProfileExtractionResponse {
        profiles,
        relations: Vec::new(),
        provider: "fixture".to_owned(),
        model: "deterministic".to_owned(),
        usage: LlmUsage::default(),
    }
}

impl DocumentProfileExtractor for FixtureExtractor {
    fn extract_profiles(
        &self,
        request: &DocumentProfileExtractionRequest,
    ) -> Result<DocumentProfileExtractionResponse> {
        Ok(fixture_profile_response(request))
    }
}

struct CountingExtractor {
    calls: Arc<AtomicUsize>,
    identity: &'static str,
    fail_after: Option<usize>,
}

struct ParallelProbeExtractor {
    active: Arc<AtomicUsize>,
    max_active: Arc<AtomicUsize>,
}

struct ProfileParallelProbeExtractor {
    profile_calls: Arc<AtomicUsize>,
    active: Arc<AtomicUsize>,
    max_active: Arc<AtomicUsize>,
}

impl ClaimExtractor for ParallelProbeExtractor {
    fn extract(&self, request: &ClaimExtractionRequest) -> Result<ClaimExtractionResponse> {
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_active.fetch_max(active, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(40));
        self.active.fetch_sub(1, Ordering::SeqCst);
        FixtureExtractor {
            hallucinate_reference: false,
        }
        .extract(request)
    }
}

impl DocumentProfileExtractor for ParallelProbeExtractor {
    fn extract_profiles(
        &self,
        request: &DocumentProfileExtractionRequest,
    ) -> Result<DocumentProfileExtractionResponse> {
        Ok(fixture_profile_response(request))
    }
}

impl ClaimExtractor for ProfileParallelProbeExtractor {
    fn extract(&self, request: &ClaimExtractionRequest) -> Result<ClaimExtractionResponse> {
        FixtureExtractor {
            hallucinate_reference: false,
        }
        .extract(request)
    }
}

impl DocumentProfileExtractor for ProfileParallelProbeExtractor {
    fn extract_profiles(
        &self,
        request: &DocumentProfileExtractionRequest,
    ) -> Result<DocumentProfileExtractionResponse> {
        self.profile_calls.fetch_add(1, Ordering::SeqCst);
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_active.fetch_max(active, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(40));
        self.active.fetch_sub(1, Ordering::SeqCst);
        Ok(fixture_profile_response(request))
    }
}

impl ClaimExtractor for CountingExtractor {
    fn extract(&self, request: &ClaimExtractionRequest) -> Result<ClaimExtractionResponse> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if self.fail_after.is_some_and(|limit| call >= limit) {
            anyhow::bail!("simulated interrupted extraction");
        }
        FixtureExtractor {
            hallucinate_reference: false,
        }
        .extract(request)
    }

    fn cache_identity(&self) -> Result<Option<String>> {
        Ok(Some(self.identity.to_owned()))
    }
}

impl DocumentProfileExtractor for CountingExtractor {
    fn extract_profiles(
        &self,
        request: &DocumentProfileExtractionRequest,
    ) -> Result<DocumentProfileExtractionResponse> {
        Ok(fixture_profile_response(request))
    }

    fn profile_cache_identity(&self) -> Result<Option<String>> {
        Ok(Some(format!("profile:{}", self.identity)))
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
            llm_concurrency: 1,
            strategy: CompileStrategy::GlobalV1,
            use_extraction_cache: false,
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
    assert!(output.join("document-profiles.jsonl").is_file());
    assert!(output.join("document-relations.jsonl").is_file());
    assert!(output.join("decision-packets.jsonl").is_file());
    assert!(!output.join("relation-dossiers.jsonl").exists());
    assert_eq!(result.manifest.metrics.document_profiles, 1);
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
            llm_concurrency: 1,
            strategy: CompileStrategy::GlobalV1,
            use_extraction_cache: false,
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
fn recompile_rejects_claims_that_fail_current_ir_validation() {
    let (root, intent) = fixture();
    let original = root.path().join("original");
    compile_workspace(
        &CompileOptions {
            workspace: root.path().to_path_buf(),
            intent_file: intent,
            output: original.clone(),
            batch_size: 8,
            llm_concurrency: 1,
            strategy: CompileStrategy::GlobalV1,
            use_extraction_cache: false,
            conflict_context: ConflictContext::default(),
            policy: CompilationPolicy::default(),
        },
        &FixtureExtractor {
            hallucinate_reference: false,
        },
    )
    .unwrap();

    let claims_path = original.join("claims.jsonl");
    let mut claim: serde_json::Value =
        serde_json::from_str(fs::read_to_string(&claims_path).unwrap().trim()).unwrap();
    claim["object"] = json!("");
    fs::write(
        &claims_path,
        format!("{}\n", serde_json::to_string(&claim).unwrap()),
    )
    .unwrap();

    let output = root.path().join("revalidated");
    let result = recompile_build(&RecompileOptions {
        workspace: root.path().to_path_buf(),
        input: original,
        output: output.clone(),
        conflict_context: ConflictContext::default(),
        policy: CompilationPolicy::default(),
    })
    .unwrap();

    assert_eq!(
        result.manifest.status,
        KnowledgeBuildStatus::CompletedWithWarnings
    );
    assert_eq!(result.manifest.metrics.claims, 0);
    assert_eq!(result.manifest.metrics.rejected_claims, 1);
    assert!(
        fs::read_to_string(output.join("diagnostics.jsonl"))
            .unwrap()
            .contains("FRG-CST-INVALID-CLAIM")
    );
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
            llm_concurrency: 1,
            strategy: CompileStrategy::GlobalV1,
            use_extraction_cache: false,
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

#[test]
fn extraction_cache_reuses_identical_requests_and_invalidates_changed_intent() {
    let (root, intent) = fixture();
    let calls = Arc::new(AtomicUsize::new(0));
    let extractor = CountingExtractor {
        calls: Arc::clone(&calls),
        identity: "fixture-model-v1",
        fail_after: None,
    };
    let compile = |output: &str| {
        compile_workspace(
            &CompileOptions {
                workspace: root.path().to_path_buf(),
                intent_file: intent.clone(),
                output: root.path().join(output),
                batch_size: 8,
                llm_concurrency: 1,
                strategy: CompileStrategy::GlobalV1,
                use_extraction_cache: true,
                conflict_context: ConflictContext::default(),
                policy: CompilationPolicy::default(),
            },
            &extractor,
        )
        .unwrap()
    };

    let first = compile("first");
    assert_eq!(first.manifest.metrics.llm_calls, 1);
    assert_eq!(first.manifest.metrics.extraction_cache_hits, 0);
    assert_eq!(first.manifest.metrics.extraction_cache_misses, 1);
    let cache_report = read_extraction_cache_report(root.path()).unwrap();
    assert_eq!(cache_report.entries.len(), 1);
    assert_eq!(cache_report.entries[0].intent_id, "test-intent");
    assert_eq!(cache_report.entries[0].evidence_units, 2);
    assert_eq!(cache_report.entries[0].claims, 1);
    assert_eq!(cache_report.entries[0].identity, "fixture-model-v1");
    assert_eq!(cache_report.entries[0].source_ids.len(), 1);

    let second = compile("second");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(second.manifest.metrics.llm_calls, 0);
    assert_eq!(second.manifest.metrics.extraction_cache_hits, 1);
    assert_eq!(second.manifest.metrics.extraction_cache_misses, 0);

    let changed = fs::read_to_string(&intent)
        .unwrap()
        .replace("期限を確認する", "期限と承認者を確認する");
    fs::write(&intent, changed).unwrap();
    let third = compile("third");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(third.manifest.metrics.llm_calls, 1);
    assert_eq!(third.manifest.metrics.extraction_cache_hits, 0);
    assert_eq!(third.manifest.metrics.extraction_cache_misses, 1);
}

#[test]
fn fresh_build_reflects_added_edited_and_deleted_sources_with_source_local_cache_reuse() {
    let (root, intent) = fixture();
    let source = root.path().join("source");
    let calls = Arc::new(AtomicUsize::new(0));
    let extractor = CountingExtractor {
        calls: Arc::clone(&calls),
        identity: "incremental-fixture-v1",
        fail_after: None,
    };
    let compile = |name: &str| {
        compile_workspace(
            &CompileOptions {
                workspace: root.path().to_path_buf(),
                intent_file: intent.clone(),
                output: root.path().join(name),
                batch_size: 8,
                llm_concurrency: 1,
                strategy: CompileStrategy::GlobalV1,
                use_extraction_cache: true,
                conflict_context: ConflictContext::default(),
                policy: CompilationPolicy::default(),
            },
            &extractor,
        )
        .unwrap()
    };

    let initial = compile("build-initial");
    assert_eq!(initial.manifest.metrics.source_documents, 1);
    assert_eq!(initial.manifest.metrics.extraction_cache_misses, 1);
    let no_change_file = root.path().join("delta-no-change.jsonl");
    let no_change = export_rag_delta_jsonl(
        &root.path().join("build-initial"),
        &root.path().join("build-initial"),
        &no_change_file,
    )
    .unwrap();
    assert_eq!(no_change.upserts, 0);
    assert_eq!(no_change.deletes, 0);
    assert_eq!(no_change.unchanged, 1);
    assert_eq!(
        fs::read_to_string(no_change_file).unwrap().lines().count(),
        1
    );
    assert_delta_reconstructs_target(
        &root.path().join("build-initial"),
        &root.path().join("build-initial"),
        &root.path().join("delta-no-change.jsonl"),
        root.path(),
        "no-change",
    );

    fs::write(
        source.join("register.md"),
        "# 承認台帳\n\n現行規程を承認する。\n",
    )
    .unwrap();
    fragarach_core::scan(&source, root.path()).unwrap();
    let added = compile("build-added");
    assert_eq!(added.manifest.metrics.source_documents, 2);
    assert_eq!(added.manifest.metrics.extraction_cache_hits, 1);
    assert_eq!(added.manifest.metrics.extraction_cache_misses, 1);
    assert_eq!(added.manifest.metrics.profile_cache_misses, 1);
    let add_delta_file = root.path().join("delta-added.jsonl");
    let add_delta = export_rag_delta_jsonl(
        &root.path().join("build-initial"),
        &root.path().join("build-added"),
        &add_delta_file,
    )
    .unwrap();
    assert_eq!(add_delta.upserts, 1);
    assert_eq!(add_delta.deletes, 0);
    assert_eq!(add_delta.unchanged, 1);
    assert_delta_reconstructs_target(
        &root.path().join("build-initial"),
        &root.path().join("build-added"),
        &add_delta_file,
        root.path(),
        "added",
    );

    fs::write(
        source.join("policy.md"),
        "# 緊急変更改訂\n\n事後レビューは7営業日以内に行う。\n",
    )
    .unwrap();
    fragarach_core::scan(&source, root.path()).unwrap();
    let edited = compile("build-edited");
    assert_eq!(edited.manifest.metrics.source_documents, 2);
    assert_eq!(edited.manifest.metrics.extraction_cache_hits, 1);
    assert_eq!(edited.manifest.metrics.extraction_cache_misses, 1);
    let edited_evidence =
        fs::read_to_string(root.path().join("build-edited/evidence.jsonl")).unwrap();
    assert!(edited_evidence.contains("7営業日"));
    assert!(!edited_evidence.contains("2営業日"));
    let edit_delta_file = root.path().join("delta-edited.jsonl");
    let edit_delta = export_rag_delta_jsonl(
        &root.path().join("build-added"),
        &root.path().join("build-edited"),
        &edit_delta_file,
    )
    .unwrap();
    assert_eq!(edit_delta.upserts, 1);
    assert_eq!(edit_delta.deletes, 1);
    assert_eq!(edit_delta.unchanged, 1);
    assert_delta_reconstructs_target(
        &root.path().join("build-added"),
        &root.path().join("build-edited"),
        &edit_delta_file,
        root.path(),
        "edited",
    );

    fs::remove_file(source.join("policy.md")).unwrap();
    let deletion_scan = fragarach_core::scan(&source, root.path()).unwrap();
    assert_eq!(deletion_scan.summary.removed, 1);
    let deleted = compile("build-deleted");
    assert_eq!(deleted.manifest.metrics.source_documents, 1);
    assert_eq!(deleted.manifest.metrics.extraction_cache_hits, 1);
    assert_eq!(deleted.manifest.metrics.extraction_cache_misses, 0);
    assert_eq!(deleted.manifest.metrics.profile_cache_misses, 1);
    let deleted_evidence =
        fs::read_to_string(root.path().join("build-deleted/evidence.jsonl")).unwrap();
    assert!(deleted_evidence.contains("承認台帳"));
    assert!(!deleted_evidence.contains("7営業日"));
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    let delete_delta_file = root.path().join("delta-deleted.jsonl");
    let delete_delta = export_rag_delta_jsonl(
        &root.path().join("build-edited"),
        &root.path().join("build-deleted"),
        &delete_delta_file,
    )
    .unwrap();
    assert_eq!(delete_delta.upserts, 0);
    assert_eq!(delete_delta.deletes, 1);
    assert_eq!(delete_delta.unchanged, 1);
    let operations = fs::read_to_string(&delete_delta_file).unwrap();
    assert_eq!(operations.lines().count(), 2);
    assert_eq!(
        operations
            .lines()
            .map(|line| {
                serde_json::from_str::<serde_json::Value>(line).unwrap()["op"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect::<Vec<_>>(),
        vec!["delete", "commit"],
    );
    assert_delta_reconstructs_target(
        &root.path().join("build-edited"),
        &root.path().join("build-deleted"),
        &delete_delta_file,
        root.path(),
        "deleted",
    );
}

#[test]
fn extraction_cache_resumes_after_an_interrupted_compile() {
    let (root, intent) = fixture();
    let source = root.path().join("source");
    fs::write(
        source.join("second-policy.md"),
        "# 通常変更\n\nレビューは3営業日以内に行う。\n",
    )
    .unwrap();
    fragarach_core::scan(&source, root.path()).unwrap();

    let interrupted_calls = Arc::new(AtomicUsize::new(0));
    let error = compile_workspace(
        &CompileOptions {
            workspace: root.path().to_path_buf(),
            intent_file: intent.clone(),
            output: root.path().join("interrupted"),
            batch_size: 8,
            llm_concurrency: 1,
            strategy: CompileStrategy::GlobalV1,
            use_extraction_cache: true,
            conflict_context: ConflictContext::default(),
            policy: CompilationPolicy::default(),
        },
        &CountingExtractor {
            calls: Arc::clone(&interrupted_calls),
            identity: "fixture-model-v1",
            fail_after: Some(1),
        },
    )
    .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("simulated interrupted extraction")
    );
    assert_eq!(interrupted_calls.load(Ordering::SeqCst), 2);
    assert!(!root.path().join("interrupted").exists());

    let resumed_calls = Arc::new(AtomicUsize::new(0));
    let resumed = compile_workspace(
        &CompileOptions {
            workspace: root.path().to_path_buf(),
            intent_file: intent,
            output: root.path().join("resumed"),
            batch_size: 8,
            llm_concurrency: 1,
            strategy: CompileStrategy::GlobalV1,
            use_extraction_cache: true,
            conflict_context: ConflictContext::default(),
            policy: CompilationPolicy::default(),
        },
        &CountingExtractor {
            calls: Arc::clone(&resumed_calls),
            identity: "fixture-model-v1",
            fail_after: None,
        },
    )
    .unwrap();

    assert_eq!(resumed_calls.load(Ordering::SeqCst), 1);
    assert_eq!(resumed.manifest.metrics.llm_calls, 1);
    assert_eq!(resumed.manifest.metrics.extraction_cache_hits, 1);
    assert_eq!(resumed.manifest.metrics.extraction_cache_misses, 1);
}

#[test]
fn claim_batches_use_bounded_parallelism() {
    let (root, intent) = fixture();
    let source = root.path().join("source");
    for index in 2..=5 {
        fs::write(
            source.join(format!("policy-{index}.md")),
            format!("# 規則{index}\n\nレビューは{index}営業日以内に行う。\n"),
        )
        .unwrap();
    }
    fragarach_core::scan(&source, root.path()).unwrap();
    let active = Arc::new(AtomicUsize::new(0));
    let max_active = Arc::new(AtomicUsize::new(0));
    let result = compile_workspace(
        &CompileOptions {
            workspace: root.path().to_path_buf(),
            intent_file: intent,
            output: root.path().join("parallel"),
            batch_size: 2,
            llm_concurrency: 3,
            strategy: CompileStrategy::GlobalV1,
            use_extraction_cache: false,
            conflict_context: ConflictContext::default(),
            policy: CompilationPolicy::default(),
        },
        &ParallelProbeExtractor {
            active,
            max_active: Arc::clone(&max_active),
        },
    )
    .unwrap();

    assert_eq!(result.manifest.metrics.llm_concurrency, 3);
    assert!(result.manifest.metrics.llm_calls >= 3);
    assert_eq!(max_active.load(Ordering::SeqCst), 3);
}

#[test]
fn linear_strategy_parallelizes_profiles_and_records_relation_work() {
    let (root, intent) = fixture();
    let source = root.path().join("source");
    for index in 1..4 {
        fs::write(
            source.join(format!("policy-{index}.md")),
            format!("# 規則{index}\n\n事後レビューは2営業日以内に行う。\n"),
        )
        .unwrap();
    }
    fragarach_core::scan(&source, root.path()).unwrap();
    let profile_calls = Arc::new(AtomicUsize::new(0));
    let active = Arc::new(AtomicUsize::new(0));
    let max_active = Arc::new(AtomicUsize::new(0));
    let result = compile_workspace(
        &CompileOptions {
            workspace: root.path().to_path_buf(),
            intent_file: intent,
            output: root.path().join("linear"),
            batch_size: 8,
            llm_concurrency: 4,
            strategy: CompileStrategy::LinearV2,
            use_extraction_cache: false,
            conflict_context: ConflictContext::default(),
            policy: CompilationPolicy::default(),
        },
        &ProfileParallelProbeExtractor {
            profile_calls: Arc::clone(&profile_calls),
            active,
            max_active: Arc::clone(&max_active),
        },
    )
    .unwrap();

    assert_eq!(result.manifest.compile_strategy, "linear-v2");
    assert_eq!(result.manifest.metrics.profile_batches, 4);
    assert_eq!(result.manifest.metrics.profile_llm_calls, 4);
    assert_eq!(result.manifest.metrics.relation_candidate_edges, 6);
    assert_eq!(result.manifest.metrics.relation_batches, 1);
    assert_eq!(result.manifest.metrics.relation_llm_calls, 1);
    assert_eq!(profile_calls.load(Ordering::SeqCst), 5);
    assert_eq!(max_active.load(Ordering::SeqCst), 4);
}

#[test]
fn dossier_strategy_uses_parallel_profiles_and_one_dossier_relation_batch() {
    let (root, intent) = fixture();
    let source = root.path().join("source");
    for index in 1..4 {
        fs::write(
            source.join(format!("policy-{index}.md")),
            format!("# 規則{index}\n\n事後レビューは2営業日以内に行う。\n"),
        )
        .unwrap();
    }
    fragarach_core::scan(&source, root.path()).unwrap();
    let profile_calls = Arc::new(AtomicUsize::new(0));
    let active = Arc::new(AtomicUsize::new(0));
    let max_active = Arc::new(AtomicUsize::new(0));
    let result = compile_workspace(
        &CompileOptions {
            workspace: root.path().to_path_buf(),
            intent_file: intent,
            output: root.path().join("dossier"),
            batch_size: 8,
            llm_concurrency: 4,
            strategy: CompileStrategy::DossierV1,
            use_extraction_cache: false,
            conflict_context: ConflictContext::default(),
            policy: CompilationPolicy::default(),
        },
        &ProfileParallelProbeExtractor {
            profile_calls: Arc::clone(&profile_calls),
            active,
            max_active: Arc::clone(&max_active),
        },
    )
    .unwrap();

    assert_eq!(result.manifest.compile_strategy, "dossier-v1");
    assert_eq!(result.manifest.metrics.profile_batches, 4);
    assert_eq!(result.manifest.metrics.relation_candidate_edges, 6);
    assert_eq!(result.manifest.metrics.relation_batches, 1);
    assert_eq!(result.manifest.metrics.relation_llm_calls, 1);
    assert_eq!(profile_calls.load(Ordering::SeqCst), 5);
    assert_eq!(max_active.load(Ordering::SeqCst), 4);
}
