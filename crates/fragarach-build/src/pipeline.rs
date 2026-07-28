use std::collections::HashSet;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use chrono::Utc;
use fragarach_ir::{
    BuildArtifact, BuildMetrics, Claim, CompilationPolicy, Diagnostic, DiagnosticCounts,
    DiagnosticSeverity, IR_SCHEMA_COMPATIBILITY_POLICY, IR_SCHEMA_VERSION, KnowledgeBuildManifest,
    KnowledgeBuildStatus, ParsedDocument, SourceManifest, SourceState, UsageIntent,
    is_compatible_schema,
};
use fragarach_llm::{ClaimExtractionRequest, ClaimExtractor, PromptEvidence};
use fragarach_workspace::WorkspaceLock;
use globset::Glob;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::{
    ConflictContext, analyze_conflicts, load_usage_intent, prompt_evidence_from_documents,
    validate_extraction,
};

#[derive(Debug, Clone)]
pub struct CompileOptions {
    pub workspace: PathBuf,
    pub intent_file: PathBuf,
    pub output: PathBuf,
    pub batch_size: usize,
    pub conflict_context: ConflictContext,
    pub policy: CompilationPolicy,
}

#[derive(Debug, Clone)]
pub struct RecompileOptions {
    pub workspace: PathBuf,
    pub input: PathBuf,
    pub output: PathBuf,
    pub conflict_context: ConflictContext,
    pub policy: CompilationPolicy,
}

#[derive(Debug, Clone)]
pub struct CompileResult {
    pub manifest: KnowledgeBuildManifest,
    pub output: PathBuf,
}

#[derive(Debug, Clone)]
pub struct BuildReport {
    pub manifest: KnowledgeBuildManifest,
    pub diagnostics: Vec<Diagnostic>,
}

pub fn read_build_report(build: &Path) -> Result<BuildReport> {
    let manifest: KnowledgeBuildManifest =
        serde_json::from_slice(&fs::read(build.join("build-manifest.json"))?)
            .context("failed to parse build-manifest.json")?;
    ensure_schema(&manifest.schema_version, "Knowledge Build")?;
    Ok(BuildReport {
        manifest,
        diagnostics: read_jsonl(&build.join("diagnostics.jsonl"))?,
    })
}

pub fn export_rag_jsonl(build: &Path, output: &Path) -> Result<usize> {
    let manifest: KnowledgeBuildManifest =
        serde_json::from_slice(&fs::read(build.join("build-manifest.json"))?)
            .context("failed to parse build-manifest.json")?;
    ensure_schema(&manifest.schema_version, "Knowledge Build")?;
    let claims: Vec<Claim> = read_jsonl(&build.join("claims.jsonl"))?;
    let evidence: Vec<PromptEvidence> = read_jsonl(&build.join("evidence.jsonl"))?;
    let conflicts: Vec<fragarach_ir::Conflict> = read_jsonl(&build.join("conflicts.jsonl"))?;
    let diagnostics: Vec<Diagnostic> = read_jsonl(&build.join("diagnostics.jsonl"))?;
    let mut text = String::new();
    let mut exported = 0;
    for cited in &evidence {
        let related_claims = claims
            .iter()
            .filter(|claim| {
                claim.evidence.iter().any(|reference| {
                    cited.source_id == reference.source_id
                        && cited.evidence_id == reference.evidence_id
                })
            })
            .collect::<Vec<_>>();
        if related_claims.is_empty() {
            continue;
        }
        let claim_ids = related_claims
            .iter()
            .map(|claim| claim.id.as_str())
            .collect::<HashSet<_>>();
        let related_conflicts = conflicts
            .iter()
            .filter(|conflict| {
                conflict
                    .claim_ids
                    .iter()
                    .any(|claim_id| claim_ids.contains(claim_id.as_str()))
            })
            .collect::<Vec<_>>();
        let mut unit_text = format!(
            "根拠位置: {}\n根拠本文: {}",
            if cited.heading_path.is_empty() {
                "本文".to_owned()
            } else {
                cited.heading_path.join(" / ")
            },
            cited.text
        );
        for (index, claim) in related_claims.iter().enumerate() {
            write!(
                &mut unit_text,
                "\nClaim {}\n主語: {}\n述語: {}\n目的語: {}",
                index + 1,
                claim.subject,
                claim.predicate,
                claim.object
            )?;
            if let Some(condition) = &claim.condition {
                write!(&mut unit_text, "\n条件: {condition}")?;
            }
            if let Some(status) = &claim.status {
                write!(&mut unit_text, "\n状態: {status}")?;
            }
            if let Some(authority) = &claim.authority {
                write!(&mut unit_text, "\n権威: {authority}")?;
            }
        }
        for conflict in &related_conflicts {
            write!(
                &mut unit_text,
                "\n競合: {:?} / {:?}",
                conflict.kind, conflict.status
            )?;
            if let Some(resolution) = &conflict.resolution {
                write!(&mut unit_text, " / {resolution}")?;
            }
        }
        let record = serde_json::json!({
            "id": format!("unit:{}", cited.evidence_id),
            "text": unit_text,
            "metadata": {
                "intent_id": manifest.intent_id,
                "claim_ids": related_claims.iter().map(|claim| &claim.id).collect::<Vec<_>>(),
                "claims": related_claims,
                "citation": cited,
                "conflict_ids": related_conflicts
                    .iter()
                    .map(|conflict| &conflict.id)
                    .collect::<Vec<_>>()
            }
        });
        writeln!(&mut text, "{}", serde_json::to_string(&record)?).unwrap();
        exported += 1;
    }
    let conflict_diagnostic_ids = conflicts
        .iter()
        .filter_map(|conflict| conflict.diagnostic_id.as_deref())
        .collect::<HashSet<_>>();
    for diagnostic in diagnostics.iter().filter(|diagnostic| {
        !conflict_diagnostic_ids.contains(diagnostic.id.as_str())
            && !diagnostic.evidence_ids.is_empty()
    }) {
        let cited = evidence
            .iter()
            .filter(|item| diagnostic.evidence_ids.contains(&item.evidence_id))
            .collect::<Vec<_>>();
        if cited.is_empty() {
            continue;
        }
        let mut unit_text = format!(
            "種別: Diagnostic\n診断: {}\n理由: {}",
            diagnostic.message, diagnostic.reason
        );
        for suggestion in &diagnostic.suggestions {
            write!(&mut unit_text, "\n対応案: {suggestion}")?;
        }
        for question in &diagnostic.questions {
            write!(&mut unit_text, "\n未解決質問: {question}")?;
        }
        let record = serde_json::json!({
            "id": format!("diagnostic:{}", diagnostic.id),
            "text": unit_text,
            "metadata": {
                "intent_id": manifest.intent_id,
                "diagnostic": diagnostic,
                "citations": cited,
            }
        });
        writeln!(&mut text, "{}", serde_json::to_string(&record)?).unwrap();
        exported += 1;
    }
    fs::write(output, text)
        .with_context(|| format!("failed to write RAG export: {}", output.display()))?;
    Ok(exported)
}

pub fn compile_workspace(
    options: &CompileOptions,
    extractor: &dyn ClaimExtractor,
) -> Result<CompileResult> {
    if options.batch_size == 0 {
        bail!("batch_size must be greater than zero");
    }
    let control = options.workspace.join(".fragarach");
    let _lock = WorkspaceLock::acquire(&options.workspace, "compile")?;
    if options.output.exists() {
        bail!(
            "output already exists; choose a new --output path to preserve the previous build: {}",
            options.output.display()
        );
    }
    let output_parent = options
        .output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(output_parent)?;
    let output_name = options
        .output
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("knowledge-build");
    let unique = Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let staging_path = output_parent.join(format!(".{output_name}.fragarach-staging-{unique}"));
    fs::create_dir(&staging_path)
        .with_context(|| format!("failed to create staging build: {}", staging_path.display()))?;
    let mut staging = StagingBuild::new(staging_path);
    let build_started = std::time::Instant::now();
    let manifest_path = control.join("manifest.json");
    let manifest_bytes = fs::read(&manifest_path)
        .with_context(|| format!("scan manifest is missing: {}", manifest_path.display()))?;
    let source_manifest: SourceManifest = serde_json::from_slice(&manifest_bytes)
        .with_context(|| format!("failed to parse {}", manifest_path.display()))?;
    ensure_schema(&source_manifest.schema_version, "Source Manifest")?;
    let intent = load_usage_intent(&options.intent_file)?;
    let documents = load_parsed_documents(&control, &source_manifest)?;
    let mut evidence = prompt_evidence_from_documents(&documents);
    apply_duplicate_aliases(&source_manifest, &mut evidence);
    let corpus_settings = load_corpus_settings(&source_manifest)?;
    apply_corpus_hints(&corpus_settings, &mut evidence)?;
    if evidence.is_empty() {
        bail!("no parsed evidence is available; run `fragarach scan` first");
    }
    let mut conflict_context = options.conflict_context.clone();
    if conflict_context.authority_precedence.is_empty() {
        conflict_context.authority_precedence = corpus_settings.authority_precedence.clone();
    }

    let mut claims = Vec::new();
    let mut diagnostics = if intent_requests_checklist_completeness(&intent) {
        checklist_completeness_diagnostics(&evidence)
    } else {
        Vec::new()
    };
    let mut provider = None;
    let mut model = None;
    let mut claim_candidates = 0;
    let mut rejected_claims = 0;
    let mut llm_calls = 0;
    let mut prompt_tokens = 0;
    let mut completion_tokens = 0;
    let batches = source_aware_batches(&evidence, options.batch_size);
    let mut seen_claim_ids = HashSet::new();
    for batch in batches {
        let response = extractor.extract(&ClaimExtractionRequest {
            intent: intent.clone(),
            evidence: batch.clone(),
        })?;
        if provider
            .as_ref()
            .is_some_and(|value| value != &response.provider)
            || model.as_ref().is_some_and(|value| value != &response.model)
        {
            bail!("LLM provider or model changed during one compilation");
        }
        provider.get_or_insert_with(|| response.provider.clone());
        model.get_or_insert_with(|| response.model.clone());
        claim_candidates += response.claims.len();
        llm_calls += 1;
        prompt_tokens += response.usage.prompt_tokens;
        completion_tokens += response.usage.completion_tokens;
        let validated = validate_extraction(response, &batch);
        rejected_claims += validated.rejected_claims;
        claims.extend(
            validated
                .claims
                .into_iter()
                .filter(|claim| seen_claim_ids.insert(claim.id.clone())),
        );
        diagnostics.extend(validated.diagnostics);
    }
    let provider = provider.context("provider returned no extraction response")?;
    let model = model.context("provider returned no extraction model")?;
    let conflict_analysis = analyze_conflicts(&claims, &conflict_context, &options.policy);
    diagnostics.extend(conflict_analysis.diagnostics);

    let build_id = format!(
        "build-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%SZ"),
        unique.unsigned_abs()
    );
    let build_output = staging.path().to_path_buf();
    let mut artifacts = Vec::new();
    write_artifact(
        &build_output,
        "usage_intent",
        "usage-intent.yaml",
        &(serde_yaml_ng::to_string(&intent)?),
        &mut artifacts,
    )?;
    write_jsonl(
        &build_output,
        "claims",
        "claims.jsonl",
        &claims,
        &mut artifacts,
    )?;
    write_jsonl(
        &build_output,
        "evidence",
        "evidence.jsonl",
        &evidence,
        &mut artifacts,
    )?;
    write_jsonl(
        &build_output,
        "conflicts",
        "conflicts.jsonl",
        &conflict_analysis.conflicts,
        &mut artifacts,
    )?;
    write_jsonl(
        &build_output,
        "diagnostics",
        "diagnostics.jsonl",
        &diagnostics,
        &mut artifacts,
    )?;
    let unresolved = conflict_analysis
        .conflicts
        .iter()
        .filter(|conflict| conflict.status == fragarach_ir::ConflictStatus::Unresolved)
        .count();
    write_artifact(
        &build_output,
        "unresolved_questions",
        "unresolved-questions.md",
        &format!("# Unresolved questions\n\n未解決の矛盾: {unresolved}件\n"),
        &mut artifacts,
    )?;
    write_artifact(
        &build_output,
        "retrieval_profile",
        "retrieval-profile.yaml",
        &render_retrieval_profile(&conflict_context),
        &mut artifacts,
    )?;
    write_artifact(
        &build_output,
        "answer_contract",
        "answer-contract.yaml",
        &format!(
            "schema_version: \"{IR_SCHEMA_VERSION}\"\ncitations_required: true\ndisclose_unresolved_conflicts: true\n"
        ),
        &mut artifacts,
    )?;
    write_artifact(
        &build_output,
        "overview",
        "overview.md",
        &format!(
            "# Knowledge Build\n\n- Intent: `{}`\n- Claims: {}\n- Evidence: {}\n- Conflicts: {} (unresolved {})\n- Diagnostics: {}\n",
            intent.id,
            claims.len(),
            evidence.len(),
            conflict_analysis.conflicts.len(),
            unresolved,
            diagnostics.len()
        ),
        &mut artifacts,
    )?;
    write_artifact(
        &build_output,
        "provenance",
        "provenance.json",
        &(serde_json::to_string_pretty(&serde_json::json!({
            "schema_version": IR_SCHEMA_VERSION,
            "schema_compatibility": IR_SCHEMA_COMPATIBILITY_POLICY,
            "provider": provider,
            "model": model,
            "prompt_contract": "claim-extraction-v1",
            "intent_hash": format!("sha256:{}", sha256_hex(&fs::read(&options.intent_file)?)),
            "batch_size": options.batch_size,
            "as_of": conflict_context.as_of,
            "authority_precedence": conflict_context.authority_precedence,
            "parser_versions": documents
                .iter()
                .map(|document| &document.parser)
                .collect::<Vec<_>>()
        }))? + "\n"),
        &mut artifacts,
    )?;

    let counts = DiagnosticCounts {
        info: diagnostics
            .iter()
            .filter(|item| item.severity == DiagnosticSeverity::Info)
            .count(),
        warnings: diagnostics
            .iter()
            .filter(|item| item.severity == DiagnosticSeverity::Warning)
            .count(),
        errors: diagnostics
            .iter()
            .filter(|item| item.severity == DiagnosticSeverity::Error)
            .count(),
    };
    let failed = diagnostics
        .iter()
        .any(|diagnostic| options.policy.fails_build(diagnostic))
        || (!intent.requirements.unresolved_conflicts_allowed && unresolved > 0);
    let status = if failed {
        KnowledgeBuildStatus::Failed
    } else if counts.warnings > 0 {
        KnowledgeBuildStatus::CompletedWithWarnings
    } else {
        KnowledgeBuildStatus::Completed
    };
    let build_manifest = KnowledgeBuildManifest {
        schema_version: IR_SCHEMA_VERSION.to_owned(),
        build_id: build_id.clone(),
        generated_at: Utc::now(),
        status,
        intent_id: intent.id,
        source_manifest_hash: format!("sha256:{}", sha256_hex(&manifest_bytes)),
        provider,
        model,
        artifacts,
        diagnostics: counts,
        metrics: BuildMetrics {
            source_documents: documents.len(),
            evidence_units: evidence.len(),
            claim_candidates,
            claims: claims.len(),
            rejected_claims,
            conflicts: conflict_analysis.conflicts.len(),
            unresolved_conflicts: unresolved,
            llm_calls,
            prompt_tokens,
            completion_tokens,
            duration_ms: u64::try_from(build_started.elapsed().as_millis()).unwrap_or(u64::MAX),
        },
    };
    fs::write(
        build_output.join("build-manifest.json"),
        serde_json::to_string_pretty(&build_manifest)? + "\n",
    )?;
    let final_output = if failed {
        let failed_root = control.join("failed-builds");
        fs::create_dir_all(&failed_root)?;
        failed_root.join(&build_id)
    } else {
        options.output.clone()
    };
    fs::rename(staging.path(), &final_output).with_context(|| {
        format!(
            "failed to atomically publish build from {} to {}",
            staging.path().display(),
            final_output.display()
        )
    })?;
    staging.disarm();
    Ok(CompileResult {
        manifest: build_manifest,
        output: final_output,
    })
}

pub fn recompile_build(options: &RecompileOptions) -> Result<CompileResult> {
    let started = std::time::Instant::now();
    let control = options.workspace.join(".fragarach");
    let _lock = WorkspaceLock::acquire(&options.workspace, "recompile")?;
    if options.output.exists() {
        bail!(
            "output already exists; choose a new --output path to preserve the previous build: {}",
            options.output.display()
        );
    }
    let old_manifest: KnowledgeBuildManifest =
        serde_json::from_slice(&fs::read(options.input.join("build-manifest.json"))?)
            .context("failed to parse input build-manifest.json")?;
    ensure_schema(&old_manifest.schema_version, "Knowledge Build")?;
    let intent = load_usage_intent(&options.input.join("usage-intent.yaml"))?;
    let mut claims: Vec<Claim> = read_jsonl(&options.input.join("claims.jsonl"))?;
    let mut invalid_claim_diagnostics = Vec::new();
    claims.retain(|claim| {
        let Err(reason) = claim.validate() else {
            return true;
        };
        invalid_claim_diagnostics.push(Diagnostic {
            id: format!("diag_recompile_invalid_{}", claim.id),
            code: "FRG-CST-INVALID-CLAIM".to_owned(),
            severity: DiagnosticSeverity::Warning,
            message: "既存Buildの不正なClaimを再コンパイル時に除外しました".to_owned(),
            target_ids: vec![claim.id.clone()],
            evidence_ids: claim
                .evidence
                .iter()
                .map(|reference| reference.evidence_id.clone())
                .collect(),
            reason: reason.to_owned(),
            suggestions: vec!["元の抽出診断とEvidenceを確認してください".to_owned()],
            questions: Vec::new(),
        });
        false
    });
    let revalidated_rejections = invalid_claim_diagnostics.len();
    let mut evidence: Vec<PromptEvidence> = read_jsonl(&options.input.join("evidence.jsonl"))?;
    let source_manifest: SourceManifest =
        serde_json::from_slice(&fs::read(control.join("manifest.json"))?)
            .context("failed to parse workspace Source Manifest")?;
    apply_duplicate_aliases(&source_manifest, &mut evidence);
    let corpus_settings = load_corpus_settings(&source_manifest)?;
    apply_corpus_hints(&corpus_settings, &mut evidence)?;
    refresh_claim_source_metadata(&mut claims, &evidence);

    let mut context = options.conflict_context.clone();
    if context.authority_precedence.is_empty() {
        context.authority_precedence = corpus_settings.authority_precedence.clone();
    }
    let conflict_analysis = analyze_conflicts(&claims, &context, &options.policy);
    let mut diagnostics: Vec<Diagnostic> =
        read_jsonl::<Diagnostic>(&options.input.join("diagnostics.jsonl"))?
            .into_iter()
            .filter(|item| !item.code.starts_with("FRG-CST-"))
            .collect();
    diagnostics.extend(invalid_claim_diagnostics);
    if intent_requests_checklist_completeness(&intent) {
        diagnostics.extend(checklist_completeness_diagnostics(&evidence));
    }
    diagnostics.extend(conflict_analysis.diagnostics);
    let unresolved = conflict_analysis
        .conflicts
        .iter()
        .filter(|item| item.status == fragarach_ir::ConflictStatus::Unresolved)
        .count();
    let counts = DiagnosticCounts {
        info: diagnostics
            .iter()
            .filter(|item| item.severity == DiagnosticSeverity::Info)
            .count(),
        warnings: diagnostics
            .iter()
            .filter(|item| item.severity == DiagnosticSeverity::Warning)
            .count(),
        errors: diagnostics
            .iter()
            .filter(|item| item.severity == DiagnosticSeverity::Error)
            .count(),
    };
    let failed = diagnostics
        .iter()
        .any(|diagnostic| options.policy.fails_build(diagnostic))
        || (!intent.requirements.unresolved_conflicts_allowed && unresolved > 0);
    let status = if failed {
        KnowledgeBuildStatus::Failed
    } else if counts.warnings > 0 {
        KnowledgeBuildStatus::CompletedWithWarnings
    } else {
        KnowledgeBuildStatus::Completed
    };

    let output_parent = options
        .output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(output_parent)?;
    let output_name = options
        .output
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("knowledge-build");
    let unique = Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let build_id = format!(
        "build-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%SZ"),
        unique.unsigned_abs()
    );
    let staging_path = output_parent.join(format!(".{output_name}.fragarach-staging-{unique}"));
    fs::create_dir(&staging_path)?;
    let mut staging = StagingBuild::new(staging_path);
    copy_directory_contents(&options.input, staging.path())?;
    let mut discarded_artifacts = Vec::new();
    write_jsonl(
        staging.path(),
        "claims",
        "claims.jsonl",
        &claims,
        &mut discarded_artifacts,
    )?;
    write_jsonl(
        staging.path(),
        "evidence",
        "evidence.jsonl",
        &evidence,
        &mut discarded_artifacts,
    )?;
    write_jsonl(
        staging.path(),
        "conflicts",
        "conflicts.jsonl",
        &conflict_analysis.conflicts,
        &mut discarded_artifacts,
    )?;
    write_jsonl(
        staging.path(),
        "diagnostics",
        "diagnostics.jsonl",
        &diagnostics,
        &mut discarded_artifacts,
    )?;
    fs::write(
        staging.path().join("unresolved-questions.md"),
        format!("# Unresolved questions\n\n未解決の矛盾: {unresolved}件\n"),
    )?;
    fs::write(
        staging.path().join("overview.md"),
        format!(
            "# Knowledge Build\n\n- Intent: `{}`\n- Claims: {}\n- Evidence: {}\n- Conflicts: {} (unresolved {})\n- Diagnostics: {}\n- Recompiled from: `{}`\n",
            intent.id,
            claims.len(),
            evidence.len(),
            conflict_analysis.conflicts.len(),
            unresolved,
            diagnostics.len(),
            old_manifest.build_id
        ),
    )?;
    fs::write(
        staging.path().join("retrieval-profile.yaml"),
        render_retrieval_profile(&context),
    )?;
    let provenance_path = staging.path().join("provenance.json");
    let mut provenance: serde_json::Value = serde_json::from_slice(&fs::read(&provenance_path)?)?;
    if let Some(object) = provenance.as_object_mut() {
        object.insert(
            "recompiled_from".to_owned(),
            serde_json::Value::String(old_manifest.build_id.clone()),
        );
        object.insert("as_of".to_owned(), serde_json::json!(context.as_of));
        object.insert(
            "authority_precedence".to_owned(),
            serde_json::json!(context.authority_precedence),
        );
    }
    fs::write(
        &provenance_path,
        serde_json::to_string_pretty(&provenance)? + "\n",
    )?;

    let artifacts = old_manifest
        .artifacts
        .iter()
        .map(|artifact| {
            let bytes = fs::read(staging.path().join(&artifact.path))?;
            Ok(BuildArtifact {
                kind: artifact.kind.clone(),
                path: artifact.path.clone(),
                content_hash: format!("sha256:{}", sha256_hex(&bytes)),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let manifest = KnowledgeBuildManifest {
        schema_version: IR_SCHEMA_VERSION.to_owned(),
        build_id: build_id.clone(),
        generated_at: Utc::now(),
        status,
        intent_id: intent.id,
        source_manifest_hash: old_manifest.source_manifest_hash,
        provider: old_manifest.provider,
        model: old_manifest.model,
        artifacts,
        diagnostics: counts,
        metrics: BuildMetrics {
            source_documents: old_manifest.metrics.source_documents,
            evidence_units: evidence.len(),
            claim_candidates: old_manifest.metrics.claim_candidates,
            claims: claims.len(),
            rejected_claims: old_manifest.metrics.rejected_claims + revalidated_rejections,
            conflicts: conflict_analysis.conflicts.len(),
            unresolved_conflicts: unresolved,
            llm_calls: 0,
            prompt_tokens: 0,
            completion_tokens: 0,
            duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        },
    };
    fs::write(
        staging.path().join("build-manifest.json"),
        serde_json::to_string_pretty(&manifest)? + "\n",
    )?;
    let final_output = if failed {
        let failed_root = control.join("failed-builds");
        fs::create_dir_all(&failed_root)?;
        failed_root.join(&build_id)
    } else {
        options.output.clone()
    };
    fs::rename(staging.path(), &final_output)?;
    staging.disarm();
    Ok(CompileResult {
        manifest,
        output: final_output,
    })
}

#[derive(Debug, Clone, Default, Deserialize)]
struct CorpusSettings {
    #[serde(default)]
    authority_hints: Vec<CorpusHint>,
    #[serde(default)]
    authority_precedence: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct CorpusHint {
    pattern: String,
    #[serde(default)]
    authority: Option<String>,
    #[serde(default)]
    lifecycle: Option<String>,
}

fn load_corpus_settings(manifest: &SourceManifest) -> Result<CorpusSettings> {
    let source_root = PathBuf::from(&manifest.source_root);
    let Some(corpus_root) = source_root.parent() else {
        return Ok(CorpusSettings::default());
    };
    let config_path = corpus_root.join("corpus.yaml");
    if !config_path.is_file() {
        return Ok(CorpusSettings::default());
    }
    serde_yaml_ng::from_slice(&fs::read(&config_path)?)
        .with_context(|| format!("failed to parse {}", config_path.display()))
}

fn apply_corpus_hints(settings: &CorpusSettings, evidence: &mut [PromptEvidence]) -> Result<()> {
    let source_metadata = evidence
        .iter()
        .filter(|item| item.text.trim_start().starts_with("---"))
        .map(|item| {
            (
                item.source_id.clone(),
                (
                    front_matter_value(&item.text, "status"),
                    front_matter_value(&item.text, "effective_from"),
                    front_matter_value(&item.text, "effective_to"),
                ),
            )
        })
        .collect::<std::collections::HashMap<_, _>>();
    let hints = settings
        .authority_hints
        .iter()
        .map(|hint| {
            Ok((
                Glob::new(&hint.pattern)
                    .with_context(|| format!("invalid authority hint: {}", hint.pattern))?
                    .compile_matcher(),
                hint.authority.clone(),
                hint.lifecycle.clone(),
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    for item in evidence {
        if let Some((status, valid_from, valid_to)) = source_metadata.get(&item.source_id) {
            if item.lifecycle.is_none() {
                item.lifecycle.clone_from(status);
            }
            item.valid_from.clone_from(valid_from);
            item.valid_to.clone_from(valid_to);
        }
        let candidate = format!("sources/{}", item.source_path.replace('\\', "/"));
        for (matcher, authority, lifecycle) in &hints {
            if matcher.is_match(&candidate) {
                if authority.is_some() {
                    item.authority.clone_from(authority);
                }
                if lifecycle.is_some() {
                    item.lifecycle.clone_from(lifecycle);
                }
            }
        }
        let normalized = format!("/{}", item.source_path.replace('\\', "/").to_lowercase());
        if item.authority.is_none() {
            item.authority = if normalized.contains("/standards/") {
                Some("corporate_standard".to_owned())
            } else if normalized.contains("/reviews/") {
                Some("approved_review_record".to_owned())
            } else if normalized.contains("/changes/") {
                Some("change_record".to_owned())
            } else if normalized.contains("/guides/") || normalized.contains("/faq/") {
                Some("guidance".to_owned())
            } else if normalized.contains("/notes/") {
                Some("record".to_owned())
            } else {
                None
            };
        }
        if item.lifecycle.is_none() && normalized.contains("/archive/") {
            item.lifecycle = Some("superseded".to_owned());
        }
    }
    Ok(())
}

fn apply_duplicate_aliases(manifest: &SourceManifest, evidence: &mut [PromptEvidence]) {
    let mut aliases: std::collections::HashMap<&str, Vec<String>> =
        std::collections::HashMap::new();
    for document in &manifest.documents {
        if let Some(primary) = document.duplicate_of.as_deref() {
            aliases
                .entry(primary)
                .or_default()
                .push(document.path.clone());
        }
    }
    for item in evidence {
        item.source_aliases = aliases
            .get(item.source_id.as_str())
            .cloned()
            .unwrap_or_default();
        item.source_aliases.sort();
    }
}

fn front_matter_value(text: &str, key: &str) -> Option<String> {
    let mut lines = text.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        let Some((candidate, value)) = line.split_once(':') else {
            continue;
        };
        if candidate.trim() == key {
            let value = value.trim().trim_matches(['"', '\'']);
            return (!value.is_empty() && !value.eq_ignore_ascii_case("null"))
                .then(|| value.to_owned());
        }
    }
    None
}

fn source_aware_batches(evidence: &[PromptEvidence], max_size: usize) -> Vec<Vec<PromptEvidence>> {
    let mut batches = Vec::new();
    let mut source_start = 0;
    while source_start < evidence.len() {
        let source_id = &evidence[source_start].source_id;
        let source_end = evidence[source_start..]
            .iter()
            .position(|item| &item.source_id != source_id)
            .map_or(evidence.len(), |offset| source_start + offset);
        let source_evidence = &evidence[source_start..source_end];
        if source_evidence.len() <= max_size {
            batches.push(source_evidence.to_vec());
        } else {
            let overlap = 2.min(max_size.saturating_sub(1));
            let mut chunk_start = 0;
            while chunk_start < source_evidence.len() {
                let chunk_end = (chunk_start + max_size).min(source_evidence.len());
                batches.push(source_evidence[chunk_start..chunk_end].to_vec());
                if chunk_end == source_evidence.len() {
                    break;
                }
                chunk_start = chunk_end - overlap;
            }
        }
        source_start = source_end;
    }
    batches
}

fn checklist_completeness_diagnostics(evidence: &[PromptEvidence]) -> Vec<Diagnostic> {
    let mut sections: std::collections::HashMap<(&str, String), Vec<(&PromptEvidence, String)>> =
        std::collections::HashMap::new();
    for item in evidence {
        for line in item.text.lines() {
            let text = line.trim_start();
            if text.starts_with("- [ ]") || text.starts_with("- [x]") || text.starts_with("- [X]") {
                sections
                    .entry((&item.source_id, item.heading_path.join(" / ")))
                    .or_default()
                    .push((item, text.to_owned()));
            }
        }
    }
    let mut diagnostics = Vec::new();
    for items in sections.values() {
        if !items
            .iter()
            .any(|(_, text)| text.contains("担当:") || text.contains("担当："))
        {
            continue;
        }
        for (item, text) in items
            .iter()
            .filter(|(_, text)| !text.contains("担当:") && !text.contains("担当："))
        {
            diagnostics.push(Diagnostic {
                id: format!(
                    "diag_missing_owner_{}_{}",
                    item.evidence_id,
                    &sha256_hex(text.as_bytes())[..12]
                ),
                code: "FRG-CST-MISSING-OWNER".to_owned(),
                severity: DiagnosticSeverity::Warning,
                message: format!("チェックリスト項目に担当者がありません: {text}"),
                target_ids: vec![item.evidence_id.clone()],
                evidence_ids: vec![item.evidence_id.clone()],
                reason: "同じ節の他のチェック項目には担当が明記されています".to_owned(),
                suggestions: vec![
                    "担当者を原文へ追記するか、運用時に決定する手順を明記してください".to_owned(),
                ],
                questions: vec!["この確認の担当者を誰が、いつ決めますか".to_owned()],
            });
        }
    }
    diagnostics
}

fn intent_requests_checklist_completeness(intent: &UsageIntent) -> bool {
    std::iter::once(intent.goal.as_str())
        .chain(intent.tasks.iter().map(String::as_str))
        .chain(intent.questions.iter().map(String::as_str))
        .any(|text| {
            let normalized = text.to_ascii_lowercase();
            normalized.contains("チェックリスト")
                || normalized.contains("リリース")
                || normalized.contains("checklist")
                || normalized.contains("release")
        })
}

fn refresh_claim_source_metadata(claims: &mut [Claim], evidence: &[PromptEvidence]) {
    for claim in claims {
        let referenced = evidence
            .iter()
            .filter(|item| {
                claim.evidence.iter().any(|reference| {
                    reference.source_id == item.source_id
                        && reference.evidence_id == item.evidence_id
                })
            })
            .collect::<Vec<_>>();
        let authorities = referenced
            .iter()
            .filter_map(|item| item.authority.as_deref())
            .collect::<HashSet<_>>();
        claim.authority = (authorities.len() == 1)
            .then(|| authorities.into_iter().next().map(str::to_owned))
            .flatten();
        let lifecycles = referenced
            .iter()
            .filter_map(|item| item.lifecycle.as_deref())
            .collect::<HashSet<_>>();
        claim.status = (lifecycles.len() == 1)
            .then(|| lifecycles.into_iter().next().map(str::to_owned))
            .flatten();
        let valid_from = referenced
            .iter()
            .filter_map(|item| item.valid_from.as_deref())
            .collect::<HashSet<_>>();
        claim.valid_from = (valid_from.len() == 1)
            .then(|| valid_from.into_iter().next().map(str::to_owned))
            .flatten();
        let valid_to = referenced
            .iter()
            .filter_map(|item| item.valid_to.as_deref())
            .collect::<HashSet<_>>();
        claim.valid_to = (valid_to.len() == 1)
            .then(|| valid_to.into_iter().next().map(str::to_owned))
            .flatten();
    }
}

fn render_retrieval_profile(context: &ConflictContext) -> String {
    let precedence = context
        .authority_precedence
        .iter()
        .map(|authority| format!("  - {authority}\n"))
        .collect::<String>();
    format!(
        "schema_version: \"{IR_SCHEMA_VERSION}\"\nrequire_evidence: true\nfilters:\n  - intent_id\n  - as_of\nauthority_precedence:\n{precedence}authority_score_step: 0.05\n"
    )
}

fn copy_directory_contents(source: &Path, target: &Path) -> Result<()> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let destination = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            fs::create_dir(&destination)?;
            copy_directory_contents(&entry.path(), &destination)?;
        } else {
            fs::copy(entry.path(), destination)?;
        }
    }
    Ok(())
}

struct StagingBuild {
    path: PathBuf,
    armed: bool,
}

impl StagingBuild {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for StagingBuild {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn load_parsed_documents(control: &Path, manifest: &SourceManifest) -> Result<Vec<ParsedDocument>> {
    let mut seen = HashSet::new();
    let mut documents = Vec::new();
    for source in &manifest.documents {
        if source.state != SourceState::Parsed {
            continue;
        }
        let Some(relative) = &source.parsed_artifact else {
            continue;
        };
        if !seen.insert(relative.clone()) {
            continue;
        }
        let file_name = Path::new(relative)
            .file_name()
            .context("parsed artifact has no file name")?;
        let path = control.join("parsed").join(file_name);
        let document: ParsedDocument = serde_json::from_slice(&fs::read(&path)?)
            .with_context(|| format!("failed to parse {}", path.display()))?;
        ensure_schema(&document.schema_version, "Parsed Document")?;
        documents.push(document);
    }
    Ok(documents)
}

fn ensure_schema(version: &str, artifact: &str) -> Result<()> {
    if !is_compatible_schema(version) {
        bail!(
            "{artifact} schema {version} is incompatible with reader schema {IR_SCHEMA_VERSION}: {IR_SCHEMA_COMPATIBILITY_POLICY}"
        );
    }
    Ok(())
}

fn write_jsonl<T: serde::Serialize>(
    output: &Path,
    kind: &str,
    name: &str,
    values: &[T],
    artifacts: &mut Vec<BuildArtifact>,
) -> Result<()> {
    let mut text = String::new();
    for value in values {
        writeln!(&mut text, "{}", serde_json::to_string(value)?).unwrap();
    }
    write_artifact(output, kind, name, &text, artifacts)
}

fn read_jsonl<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Vec<T>> {
    let text =
        fs::read_to_string(path).with_context(|| format!("failed to read {}", path.display()))?;
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).context("failed to parse JSONL record"))
        .collect()
}

fn write_artifact(
    output: &Path,
    kind: &str,
    name: &str,
    text: &str,
    artifacts: &mut Vec<BuildArtifact>,
) -> Result<()> {
    fs::write(output.join(name), text)?;
    artifacts.push(BuildArtifact {
        kind: kind.to_owned(),
        path: name.to_owned(),
        content_hash: format!("sha256:{}", sha256_hex(text.as_bytes())),
    });
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut output, "{byte:02x}").unwrap();
    }
    output
}

#[cfg(test)]
mod tests {
    use super::{
        CorpusSettings, apply_corpus_hints, checklist_completeness_diagnostics,
        intent_requests_checklist_completeness, source_aware_batches,
    };
    use fragarach_ir::{IntentRequirements, UsageIntent};
    use fragarach_llm::PromptEvidence;

    fn evidence(source_id: &str, index: usize) -> PromptEvidence {
        PromptEvidence {
            source_id: source_id.to_owned(),
            evidence_id: format!("ev-{source_id}-{index}"),
            source_path: format!("{source_id}.md"),
            source_aliases: Vec::new(),
            heading_path: Vec::new(),
            authority: None,
            lifecycle: None,
            valid_from: None,
            valid_to: None,
            text: index.to_string(),
        }
    }

    #[test]
    fn batches_do_not_split_small_documents_or_mix_sources() {
        let items = (0..4)
            .map(|index| evidence("a", index))
            .chain((0..3).map(|index| evidence("b", index)))
            .collect::<Vec<_>>();

        let batches = source_aware_batches(&items, 5);

        assert_eq!(batches.len(), 2);
        assert!(batches[0].iter().all(|item| item.source_id == "a"));
        assert!(batches[1].iter().all(|item| item.source_id == "b"));
    }

    #[test]
    fn oversized_documents_keep_boundary_context() {
        let items = (0..7).map(|index| evidence("a", index)).collect::<Vec<_>>();

        let batches = source_aware_batches(&items, 5);

        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0][3].evidence_id, batches[1][0].evidence_id);
        assert_eq!(batches[0][4].evidence_id, batches[1][1].evidence_id);
    }

    #[test]
    fn front_matter_temporal_scope_is_attached_to_all_source_evidence() {
        let mut items = vec![evidence("a", 0), evidence("a", 1)];
        items[0].text =
            "---\nstatus: active\neffective_from: 2026-04-01\neffective_to: 2027-03-31\n---"
                .to_owned();
        items[1].text = "現行の規則".to_owned();

        apply_corpus_hints(&CorpusSettings::default(), &mut items).unwrap();

        assert_eq!(items[1].lifecycle.as_deref(), Some("active"));
        assert_eq!(items[1].valid_from.as_deref(), Some("2026-04-01"));
        assert_eq!(items[1].valid_to.as_deref(), Some("2027-03-31"));
    }

    #[test]
    fn checklist_items_missing_an_owner_are_reported() {
        let mut items = vec![evidence("a", 0), evidence("a", 1)];
        items[0].heading_path = vec!["リリースと復旧".to_owned()];
        items[0].text = "- [ ] リリース手順を確認した。担当: リリース担当".to_owned();
        items[1].heading_path = vec!["リリースと復旧".to_owned()];
        items[1].text = "- [ ] ロールバック手順が最新であることを確認した。".to_owned();

        let diagnostics = checklist_completeness_diagnostics(&items);

        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].code, "FRG-CST-MISSING-OWNER");
        assert_eq!(diagnostics[0].evidence_ids, vec!["ev-a-1"]);
    }

    #[test]
    fn checklist_completeness_is_only_enabled_for_relevant_intents() {
        let intent = |question: &str| UsageIntent {
            id: "test".to_owned(),
            goal: "根拠付きで判断する".to_owned(),
            users: vec!["user".to_owned()],
            tasks: Vec::new(),
            questions: vec![question.to_owned()],
            requirements: IntentRequirements {
                evidence_required: true,
                temporal_scope_required: false,
                unresolved_conflicts_allowed: true,
            },
        };

        assert!(intent_requests_checklist_completeness(&intent(
            "リリース前の確認担当は誰か"
        )));
        assert!(!intent_requests_checklist_completeness(&intent(
            "障害時の通知先はどこか"
        )));
    }
}
