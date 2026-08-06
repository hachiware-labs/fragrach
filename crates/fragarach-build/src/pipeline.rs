use std::collections::{BTreeMap, HashSet};
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use anyhow::{Context, Result, bail};
use chrono::Utc;
use fragarach_ir::{
    ApplicabilityScope, BuildArtifact, BuildMetrics, Claim, CompilationPolicy, Diagnostic,
    DiagnosticCounts, DiagnosticSeverity, DocumentProfile, DocumentRelation, DocumentRole,
    ForceLevel, ForceProfile, IR_SCHEMA_COMPATIBILITY_POLICY, IR_SCHEMA_VERSION,
    KnowledgeBuildManifest, KnowledgeBuildStatus, ParsedDocument, RelationDossier, SourceManifest,
    SourceState, TemporalProfile, UsageIntent, is_compatible_schema,
};
use fragarach_llm::{
    CLAIM_EXTRACTION_CONTRACT_VERSION, ClaimExtractionRequest, ClaimExtractionResponse,
    DOCUMENT_PROFILE_CONTRACT_VERSION, DocumentProfileExtractionRequest,
    DocumentProfileExtractionResponse, KnowledgeExtractor, PromptEvidence,
    claim_extraction_contract_fingerprint, document_profile_contract_fingerprint,
};
use fragarach_resolver::{normalize_document_set, validate_relations};
use fragarach_workspace::WorkspaceLock;
use globset::Glob;
use serde::{Deserialize, Serialize};
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
    pub llm_concurrency: usize,
    pub use_extraction_cache: bool,
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RagDeltaSummary {
    pub base_build_id: String,
    pub target_build_id: String,
    pub upserts: usize,
    pub deletes: usize,
    pub unchanged: usize,
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
    let (_, records) = rag_export_records(build)?;
    let mut text = String::new();
    for record in &records {
        writeln!(&mut text, "{}", serde_json::to_string(record)?).unwrap();
    }
    fs::write(output, text)
        .with_context(|| format!("failed to write RAG export: {}", output.display()))?;
    Ok(records.len())
}

pub fn export_rag_delta_jsonl(
    base_build: &Path,
    target_build: &Path,
    output: &Path,
) -> Result<RagDeltaSummary> {
    let (base_manifest, base_records) = rag_export_records(base_build)?;
    let (target_manifest, target_records) = rag_export_records(target_build)?;
    if base_manifest.intent_id != target_manifest.intent_id {
        bail!(
            "cannot create a RAG delta between different Usage Intents: {} != {}",
            base_manifest.intent_id,
            target_manifest.intent_id
        );
    }
    let base_by_id = records_by_id(base_records)?;
    let target_by_id = records_by_id(target_records)?;
    let upserts = target_by_id
        .iter()
        .filter(|(id, record)| base_by_id.get(*id) != Some(*record))
        .collect::<Vec<_>>();
    let deletes = base_by_id
        .keys()
        .filter(|id| !target_by_id.contains_key(*id))
        .collect::<Vec<_>>();
    let unchanged = target_by_id.len().saturating_sub(upserts.len());
    let summary = RagDeltaSummary {
        base_build_id: base_manifest.build_id.clone(),
        target_build_id: target_manifest.build_id.clone(),
        upserts: upserts.len(),
        deletes: deletes.len(),
        unchanged,
    };
    let mut text = String::new();
    for (id, record) in upserts {
        writeln!(
            &mut text,
            "{}",
            serde_json::to_string(&serde_json::json!({
                "op": "upsert",
                "base_build_id": base_manifest.build_id,
                "target_build_id": target_manifest.build_id,
                "id": id,
                "record": record,
            }))?
        )
        .unwrap();
    }
    for id in deletes {
        writeln!(
            &mut text,
            "{}",
            serde_json::to_string(&serde_json::json!({
                "op": "delete",
                "base_build_id": base_manifest.build_id,
                "target_build_id": target_manifest.build_id,
                "id": id,
            }))?
        )
        .unwrap();
    }
    writeln!(
        &mut text,
        "{}",
        serde_json::to_string(&serde_json::json!({
            "op": "commit",
            "base_build_id": summary.base_build_id,
            "target_build_id": summary.target_build_id,
            "base_source_manifest_hash": base_manifest.source_manifest_hash,
            "target_source_manifest_hash": target_manifest.source_manifest_hash,
            "upserts": summary.upserts,
            "deletes": summary.deletes,
            "unchanged": summary.unchanged,
        }))?
    )
    .unwrap();
    fs::write(output, text)
        .with_context(|| format!("failed to write RAG delta export: {}", output.display()))?;
    Ok(summary)
}

fn records_by_id(records: Vec<serde_json::Value>) -> Result<BTreeMap<String, serde_json::Value>> {
    let mut by_id = BTreeMap::new();
    for record in records {
        let id = record
            .get("id")
            .and_then(serde_json::Value::as_str)
            .context("RAG export record is missing a string id")?
            .to_owned();
        if by_id.insert(id.clone(), record).is_some() {
            bail!("RAG export contains duplicate record id: {id}");
        }
    }
    Ok(by_id)
}

fn rag_export_records(build: &Path) -> Result<(KnowledgeBuildManifest, Vec<serde_json::Value>)> {
    let manifest: KnowledgeBuildManifest =
        serde_json::from_slice(&fs::read(build.join("build-manifest.json"))?)
            .context("failed to parse build-manifest.json")?;
    ensure_schema(&manifest.schema_version, "Knowledge Build")?;
    let claims: Vec<Claim> = read_jsonl(&build.join("claims.jsonl"))?;
    let evidence: Vec<PromptEvidence> = read_jsonl(&build.join("evidence.jsonl"))?;
    let dossiers: Vec<RelationDossier> = read_jsonl(&build.join("relation-dossiers.jsonl"))?;
    let conflicts: Vec<fragarach_ir::Conflict> = read_jsonl(&build.join("conflicts.jsonl"))?;
    let diagnostics: Vec<Diagnostic> = read_jsonl(&build.join("diagnostics.jsonl"))?;
    let mut records = Vec::new();
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
        records.push(record);
    }
    for dossier in dossiers {
        records.push(serde_json::json!({
            "id": format!("dossier:{}", dossier.id),
            "text": dossier.text.clone(),
            "metadata": {
                "intent_id": manifest.intent_id,
                "unit_type": "relation_dossier",
                "relation_dossier": dossier,
            }
        }));
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
        records.push(record);
    }
    Ok((manifest, records))
}

pub fn compile_workspace(
    options: &CompileOptions,
    extractor: &dyn KnowledgeExtractor,
) -> Result<CompileResult> {
    if options.batch_size == 0 {
        bail!("batch_size must be greater than zero");
    }
    if options.llm_concurrency == 0 {
        bail!("llm_concurrency must be greater than zero");
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
    let mut extraction_cache_hits = 0;
    let mut extraction_cache_misses = 0;
    let cache_identity = if options.use_extraction_cache {
        extractor.cache_identity()?
    } else {
        None
    };
    let cache_root = control.join("cache").join("claim-extraction-v1");
    let batches = source_aware_batches(&evidence, options.batch_size);
    let batch_executions = execute_claim_batches(
        extractor,
        &intent,
        batches,
        cache_identity.as_deref(),
        &cache_root,
        options.llm_concurrency,
    )?;
    let mut seen_claim_ids = HashSet::new();
    for (batch, execution) in batch_executions {
        let response = execution.response;
        extraction_cache_hits += usize::from(execution.cache_hit);
        extraction_cache_misses += usize::from(execution.cache_miss);
        if !execution.cache_hit && response.provider != "metadata" {
            llm_calls += 1;
            prompt_tokens += response.usage.prompt_tokens;
            completion_tokens += response.usage.completion_tokens;
        }
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
    let profile_request = DocumentProfileExtractionRequest {
        evidence: compact_profile_evidence(&evidence),
    };
    let profile_cache_identity = if options.use_extraction_cache {
        extractor.profile_cache_identity()?
    } else {
        None
    };
    let profile_cache_root = control.join("cache").join("document-profile-extraction-v1");
    let profile_cache_path = profile_cache_identity
        .as_deref()
        .map(|identity| {
            profile_extraction_cache_path(&profile_cache_root, identity, &profile_request)
        })
        .transpose()?;
    let cached_profile_response = profile_cache_path
        .as_deref()
        .map(load_cached_profile_extraction)
        .transpose()?
        .flatten();
    let mut profile_cache_hits = 0;
    let mut profile_cache_misses = 0;
    let mut profile_llm_calls = 0;
    let mut profile_prompt_tokens = 0;
    let mut profile_completion_tokens = 0;
    let profile_response = if let Some(response) = cached_profile_response {
        profile_cache_hits = 1;
        response
    } else {
        let response = extractor.extract_profiles(&profile_request)?;
        if response.provider != "metadata" {
            profile_llm_calls = 1;
            profile_prompt_tokens = response.usage.prompt_tokens;
            profile_completion_tokens = response.usage.completion_tokens;
        }
        if let Some(cache_path) = &profile_cache_path {
            save_cached_profile_extraction(
                cache_path,
                identity_for_cache(&profile_cache_identity),
                &profile_request,
                &response,
            )?;
            profile_cache_misses = 1;
        }
        response
    };
    if profile_response.provider != provider || profile_response.model != model {
        bail!("profile extraction provider or model differs from Claim extraction");
    }
    let metadata_only = profile_response.provider == "metadata";
    let mut validated_profiles = validate_profile_extraction(profile_response, &evidence);
    if metadata_only {
        validated_profiles
            .diagnostics
            .retain(|item| item.code != "FRG-PRF-FALLBACK-PROFILE");
    }
    diagnostics.extend(validated_profiles.diagnostics);
    let normalized = normalize_document_set(
        &validated_profiles.profiles,
        &validated_profiles.relations,
        &fragarach_ir::NormalizationCatalog::default(),
    );
    diagnostics.extend(
        normalized
            .diagnostics
            .into_iter()
            .map(normalization_diagnostic),
    );
    let mut document_profiles = normalized.profiles;
    apply_front_matter_to_profiles(&mut document_profiles, &evidence);
    let document_relations =
        merge_front_matter_positions(&document_profiles, normalized.relations, &evidence);
    diagnostics.extend(
        validate_relations(&document_profiles, &document_relations)
            .into_iter()
            .enumerate()
            .map(|(index, reason)| relation_validation_diagnostic(index, reason)),
    );
    let relation_dossiers = build_relation_dossiers(
        &intent.id,
        &document_profiles,
        &document_relations,
        &evidence,
    );
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
        "document_profiles",
        "document-profiles.jsonl",
        &document_profiles,
        &mut artifacts,
    )?;
    write_jsonl(
        &build_output,
        "document_relations",
        "document-relations.jsonl",
        &document_relations,
        &mut artifacts,
    )?;
    write_jsonl(
        &build_output,
        "relation_dossiers",
        "relation-dossiers.jsonl",
        &relation_dossiers,
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
            "# Knowledge Build\n\n- Intent: `{}`\n- Claims: {}\n- Evidence: {}\n- Document Profiles: {}\n- Document Relations: {}\n- Relation Dossiers: {}\n- Conflicts: {} (unresolved {})\n- Diagnostics: {}\n",
            intent.id,
            claims.len(),
            evidence.len(),
            document_profiles.len(),
            document_relations.len(),
            relation_dossiers.len(),
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
            "prompt_contract": CLAIM_EXTRACTION_CONTRACT_VERSION,
            "prompt_fingerprint": claim_extraction_contract_fingerprint(),
            "profile_contract": DOCUMENT_PROFILE_CONTRACT_VERSION,
            "profile_fingerprint": document_profile_contract_fingerprint(),
            "intent_hash": format!("sha256:{}", sha256_hex(&fs::read(&options.intent_file)?)),
            "batch_size": options.batch_size,
            "llm_concurrency": options.llm_concurrency,
            "extraction_cache": {
                "enabled": options.use_extraction_cache,
                "hits": extraction_cache_hits,
                "misses": extraction_cache_misses
            },
            "profile_extraction_cache": {
                "enabled": options.use_extraction_cache,
                "hits": profile_cache_hits,
                "misses": profile_cache_misses
            },
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
            extraction_cache_hits,
            extraction_cache_misses,
            profile_cache_hits,
            profile_cache_misses,
            profile_llm_calls,
            profile_prompt_tokens,
            profile_completion_tokens,
            document_profiles: document_profiles.len(),
            document_relations: document_relations.len(),
            relation_dossiers: relation_dossiers.len(),
            llm_concurrency: options.llm_concurrency,
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
            extraction_cache_hits: 0,
            extraction_cache_misses: 0,
            profile_cache_hits: 0,
            profile_cache_misses: 0,
            profile_llm_calls: 0,
            profile_prompt_tokens: 0,
            profile_completion_tokens: 0,
            document_profiles: old_manifest.metrics.document_profiles,
            document_relations: old_manifest.metrics.document_relations,
            relation_dossiers: old_manifest.metrics.relation_dossiers,
            llm_concurrency: old_manifest.metrics.llm_concurrency,
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
                    front_matter_value(&item.text, "valid_from")
                        .or_else(|| front_matter_value(&item.text, "effective_from")),
                    front_matter_value(&item.text, "valid_to")
                        .or_else(|| front_matter_value(&item.text, "effective_to")),
                    front_matter_value(&item.text, "authority"),
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
        if let Some((status, valid_from, valid_to, authority)) =
            source_metadata.get(&item.source_id)
        {
            if item.lifecycle.is_none() {
                item.lifecycle.clone_from(status);
            }
            item.valid_from.clone_from(valid_from);
            item.valid_to.clone_from(valid_to);
            if item.authority.is_none() {
                item.authority.clone_from(authority);
            }
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

const EXTRACTION_CACHE_FORMAT_VERSION: u32 = 1;

struct ClaimBatchPlan {
    batch: Vec<PromptEvidence>,
    request: ClaimExtractionRequest,
    cache_path: Option<PathBuf>,
    cached_response: Option<ClaimExtractionResponse>,
}

struct ClaimBatchExecution {
    response: ClaimExtractionResponse,
    cache_hit: bool,
    cache_miss: bool,
}

fn execute_claim_batches(
    extractor: &dyn KnowledgeExtractor,
    intent: &UsageIntent,
    batches: Vec<Vec<PromptEvidence>>,
    cache_identity: Option<&str>,
    cache_root: &Path,
    concurrency: usize,
) -> Result<Vec<(Vec<PromptEvidence>, ClaimBatchExecution)>> {
    let plans = batches
        .into_iter()
        .map(|batch| {
            let request = ClaimExtractionRequest {
                intent: intent.clone(),
                evidence: batch.clone(),
            };
            let cache_path = cache_identity
                .map(|identity| extraction_cache_path(cache_root, identity, &request))
                .transpose()?;
            let cached_response = cache_path
                .as_deref()
                .map(load_cached_extraction)
                .transpose()?
                .flatten();
            Ok(ClaimBatchPlan {
                batch,
                request,
                cache_path,
                cached_response,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let missing = plans
        .iter()
        .enumerate()
        .filter_map(|(index, plan)| plan.cached_response.is_none().then_some(index))
        .collect::<Vec<_>>();
    let results = Mutex::new(
        (0..plans.len())
            .map(|_| None::<Result<ClaimBatchExecution>>)
            .collect::<Vec<_>>(),
    );
    {
        let mut locked = results
            .lock()
            .map_err(|_| anyhow::anyhow!("claim extraction result lock was poisoned"))?;
        for (index, plan) in plans.iter().enumerate() {
            if let Some(response) = &plan.cached_response {
                locked[index] = Some(Ok(ClaimBatchExecution {
                    response: response.clone(),
                    cache_hit: true,
                    cache_miss: false,
                }));
            }
        }
    }
    if !missing.is_empty() {
        let next = AtomicUsize::new(0);
        let workers = concurrency.min(missing.len());
        std::thread::scope(|scope| {
            for _ in 0..workers {
                let results = &results;
                let missing = &missing;
                let plans = &plans;
                let next = &next;
                scope.spawn(move || {
                    loop {
                        let position = next.fetch_add(1, Ordering::Relaxed);
                        let Some(&index) = missing.get(position) else {
                            break;
                        };
                        let plan = &plans[index];
                        let outcome = (|| {
                            let response = extractor.extract(&plan.request)?;
                            let cache_miss = if let Some(path) = &plan.cache_path {
                                save_cached_extraction(
                                    path,
                                    cache_identity.unwrap_or_default(),
                                    &plan.request,
                                    &response,
                                )?;
                                true
                            } else {
                                false
                            };
                            Ok(ClaimBatchExecution {
                                response,
                                cache_hit: false,
                                cache_miss,
                            })
                        })();
                        let mut locked = results.lock().unwrap_or_else(|error| error.into_inner());
                        locked[index] = Some(outcome);
                    }
                });
            }
        });
    }
    let outputs = results
        .into_inner()
        .map_err(|_| anyhow::anyhow!("claim extraction result lock was poisoned"))?;
    plans
        .into_iter()
        .zip(outputs)
        .map(|(plan, output)| {
            let execution =
                output.context("claim extraction worker did not produce a result")??;
            Ok((plan.batch, execution))
        })
        .collect()
}

#[derive(Debug)]
struct ValidatedProfileExtraction {
    profiles: Vec<DocumentProfile>,
    relations: Vec<DocumentRelation>,
    diagnostics: Vec<Diagnostic>,
}

fn validate_profile_extraction(
    response: DocumentProfileExtractionResponse,
    evidence: &[PromptEvidence],
) -> ValidatedProfileExtraction {
    let known_sources = evidence
        .iter()
        .map(|item| item.source_id.as_str())
        .collect::<HashSet<_>>();
    let known_evidence = evidence
        .iter()
        .map(|item| (item.source_id.as_str(), item.evidence_id.as_str()))
        .collect::<HashSet<_>>();
    let mut seen_profiles = HashSet::new();
    let mut diagnostics = Vec::new();
    let mut profiles = response
        .profiles
        .into_iter()
        .filter(|profile| {
            let valid_source = known_sources.contains(profile.source_id.as_str());
            let unique = seen_profiles.insert(profile.source_id.clone());
            let grounded = !profile.evidence.is_empty()
                && profile.evidence.iter().all(|reference| {
                    known_evidence
                        .contains(&(reference.source_id.as_str(), reference.evidence_id.as_str()))
                        && reference.source_id == profile.source_id
                });
            if valid_source && unique && grounded {
                true
            } else {
                diagnostics.push(profile_extraction_diagnostic(
                    "FRG-PRF-INVALID-PROFILE",
                    &profile.source_id,
                    "Document Profileを根拠検証で棄却しました",
                    format!("known_source={valid_source}; unique={unique}; grounded={grounded}"),
                    profile
                        .evidence
                        .iter()
                        .map(|item| item.evidence_id.clone())
                        .collect(),
                ));
                false
            }
        })
        .collect::<Vec<_>>();
    let accepted_sources = profiles
        .iter()
        .map(|profile| profile.source_id.clone())
        .collect::<HashSet<_>>();
    let mut missing_sources = known_sources
        .iter()
        .filter(|source_id| {
            !accepted_sources
                .iter()
                .any(|accepted| accepted.as_str() == **source_id)
        })
        .copied()
        .collect::<Vec<_>>();
    missing_sources.sort_unstable();
    for source_id in missing_sources {
        if let Some(profile) = fallback_document_profile(source_id, evidence) {
            let evidence_ids = profile
                .evidence
                .iter()
                .map(|item| item.evidence_id.clone())
                .collect();
            profiles.push(profile);
            diagnostics.push(profile_extraction_diagnostic(
                "FRG-PRF-FALLBACK-PROFILE",
                source_id,
                "欠けたDocument Profileを原文metadataから保守的に補完しました",
                "Providerが有効なProfileを返さなかったため、Sourceのfront matterと原文根拠だけを使用しました".to_owned(),
                evidence_ids,
            ));
        } else {
            diagnostics.push(profile_extraction_diagnostic(
                "FRG-PRF-MISSING-PROFILE",
                source_id,
                "Sourceに対応するDocument Profileがありません",
                "Providerは入力Sourceごとに一つのProfileを返す必要があります".to_owned(),
                Vec::new(),
            ));
        }
    }
    let profile_ids = profiles
        .iter()
        .map(|profile| profile.source_id.as_str())
        .collect::<HashSet<_>>();
    let mut seen_relations = HashSet::new();
    let relations = response
        .relations
        .into_iter()
        .filter(|relation| {
            let endpoints = relation.source_id != relation.target_id
                && profile_ids.contains(relation.source_id.as_str())
                && profile_ids.contains(relation.target_id.as_str());
            let unique = !relation.id.trim().is_empty() && seen_relations.insert(relation.id.clone());
            let grounded = !relation.evidence.is_empty()
                && relation.evidence.iter().all(|reference| {
                    known_evidence.contains(&(
                        reference.source_id.as_str(),
                        reference.evidence_id.as_str(),
                    ))
                });
            let clauses = relation.kind != fragarach_ir::RelationKind::Amends
                || (!relation.source_clauses.is_empty() && !relation.target_clauses.is_empty());
            if endpoints && unique && grounded && clauses {
                true
            } else {
                diagnostics.push(profile_extraction_diagnostic(
                    "FRG-PRF-INVALID-RELATION",
                    &relation.id,
                    "Document Relationを根拠検証で棄却しました",
                    format!(
                        "valid_endpoints={endpoints}; unique={unique}; grounded={grounded}; clauses={clauses}"
                    ),
                    relation.evidence.iter().map(|item| item.evidence_id.clone()).collect(),
                ));
                false
            }
        })
        .collect();
    ValidatedProfileExtraction {
        profiles,
        relations,
        diagnostics,
    }
}

fn fallback_document_profile(
    source_id: &str,
    evidence: &[PromptEvidence],
) -> Option<DocumentProfile> {
    let source_evidence = evidence
        .iter()
        .filter(|item| item.source_id == source_id)
        .collect::<Vec<_>>();
    let grounded = source_evidence.first()?;
    let metadata = source_evidence
        .iter()
        .find(|item| item.text.trim_start().starts_with("---"))
        .copied()
        .unwrap_or(grounded);
    let document_type = front_matter_value(&metadata.text, "document_type")
        .unwrap_or_else(|| "reference".to_owned());
    let role = role_from_document_type(&document_type);
    let status = front_matter_value(&metadata.text, "status");
    let level = match role {
        DocumentRole::Normative => ForceLevel::Mandatory,
        DocumentRole::Instruction => ForceLevel::Recommended,
        _ => ForceLevel::Informational,
    };
    let official_record = matches!(role, DocumentRole::Record);
    Some(DocumentProfile {
        source_id: source_id.to_owned(),
        document_id: front_matter_value(&metadata.text, "document_id"),
        revision: front_matter_value(&metadata.text, "revision")
            .or_else(|| front_matter_value(&metadata.text, "version")),
        role,
        force: ForceProfile {
            level,
            authority_rank: 0,
            approved: status
                .as_deref()
                .is_some_and(|value| matches!(value, "current" | "approved")),
        },
        scope: ApplicabilityScope::default(),
        time: TemporalProfile {
            valid_from: front_matter_value(&metadata.text, "valid_from")
                .or_else(|| front_matter_value(&metadata.text, "effective_from")),
            valid_to: front_matter_value(&metadata.text, "valid_to")
                .or_else(|| front_matter_value(&metadata.text, "effective_to")),
            observed_at: None,
        },
        official_record: Some(official_record),
        evidence: vec![fragarach_ir::EvidenceReference {
            source_id: source_id.to_owned(),
            evidence_id: metadata.evidence_id.clone(),
        }],
    })
}

fn profile_extraction_diagnostic(
    code: &str,
    target: &str,
    message: &str,
    reason: String,
    evidence_ids: Vec<String>,
) -> Diagnostic {
    Diagnostic {
        id: format!(
            "diag_profile_{}",
            &sha256_hex(format!("{code}:{target}").as_bytes())[..16]
        ),
        code: code.to_owned(),
        severity: DiagnosticSeverity::Warning,
        message: message.to_owned(),
        target_ids: vec![target.to_owned()],
        evidence_ids,
        reason,
        suggestions: vec!["Profile/Relation抽出の原文根拠を確認してください".to_owned()],
        questions: Vec::new(),
    }
}

fn normalization_diagnostic(item: fragarach_resolver::NormalizationDiagnostic) -> Diagnostic {
    profile_extraction_diagnostic(
        &format!(
            "FRG-PRF-{}",
            item.code.replace('.', "-").to_ascii_uppercase()
        ),
        &item.source_id,
        &item.message,
        format!("field={}", item.field),
        Vec::new(),
    )
}

fn relation_validation_diagnostic(index: usize, reason: String) -> Diagnostic {
    profile_extraction_diagnostic(
        "FRG-PRF-INVALID-RELATION",
        &format!("relation:{index}"),
        "Document Relationの整合性検証に失敗しました",
        reason,
        Vec::new(),
    )
}

fn apply_front_matter_to_profiles(profiles: &mut [DocumentProfile], evidence: &[PromptEvidence]) {
    let metadata = evidence
        .iter()
        .filter(|item| item.text.trim_start().starts_with("---"))
        .map(|item| (item.source_id.as_str(), item))
        .collect::<std::collections::HashMap<_, _>>();
    for profile in profiles {
        let Some(item) = metadata.get(profile.source_id.as_str()) else {
            continue;
        };
        profile.document_id =
            front_matter_value(&item.text, "document_id").or_else(|| profile.document_id.clone());
        profile.revision = front_matter_value(&item.text, "revision")
            .or_else(|| front_matter_value(&item.text, "version"))
            .or_else(|| profile.revision.clone());
        profile.time.valid_from = front_matter_value(&item.text, "valid_from")
            .or_else(|| front_matter_value(&item.text, "effective_from"))
            .or_else(|| profile.time.valid_from.clone());
        profile.time.valid_to = front_matter_value(&item.text, "valid_to")
            .or_else(|| front_matter_value(&item.text, "effective_to"))
            .or_else(|| profile.time.valid_to.clone());
        if let Some(value) =
            front_matter_value(&item.text, "approved").and_then(|value| value.parse::<bool>().ok())
        {
            profile.force.approved = value;
        }
        if let Some(value) =
            front_matter_value(&item.text, "force_rank").and_then(|value| value.parse::<i32>().ok())
        {
            profile.force.authority_rank = value.clamp(0, 10);
        }
        if let Some(value) = front_matter_value(&item.text, "force") {
            profile.force.level = match value.as_str() {
                "mandatory" => ForceLevel::Mandatory,
                "recommended" => ForceLevel::Recommended,
                _ => ForceLevel::Informational,
            };
        }
        if let Some(value) = front_matter_value(&item.text, "official_record")
            .and_then(|value| value.parse::<bool>().ok())
        {
            profile.official_record = Some(value);
        }
        if let Some(document_type) = front_matter_value(&item.text, "document_type") {
            profile.role = role_from_document_type(&document_type);
        }
    }
}

fn merge_front_matter_positions(
    profiles: &[DocumentProfile],
    provider_relations: Vec<DocumentRelation>,
    evidence: &[PromptEvidence],
) -> Vec<DocumentRelation> {
    let metadata = evidence
        .iter()
        .filter(|item| item.text.trim_start().starts_with("---"))
        .map(|item| (item.source_id.as_str(), item))
        .collect::<std::collections::HashMap<_, _>>();
    let mut compiled = Vec::new();
    let mut managed_pairs = HashSet::new();
    let mut managed_sources = HashSet::new();

    for source in profiles {
        let Some(item) = metadata.get(source.source_id.as_str()) else {
            continue;
        };
        let Some(position) =
            front_matter_value(&item.text, "position").and_then(|value| match value.as_str() {
                "dominates" => Some(fragarach_ir::DocumentPosition::Dominates),
                "conditional" => Some(fragarach_ir::DocumentPosition::Conditional),
                "non_effective" => Some(fragarach_ir::DocumentPosition::NonEffective),
                "unresolved" => Some(fragarach_ir::DocumentPosition::Unresolved),
                _ => None,
            })
        else {
            continue;
        };
        let Some(target_document_id) =
            front_matter_value(&item.text, "position_target_document_id")
        else {
            continue;
        };
        let target_revision = front_matter_value(&item.text, "position_target_revision");
        let Some(target) = profiles.iter().find(|candidate| {
            candidate.source_id != source.source_id
                && candidate.document_id.as_deref() == Some(target_document_id.as_str())
                && target_revision
                    .as_ref()
                    .is_none_or(|revision| candidate.revision.as_deref() == Some(revision.as_str()))
        }) else {
            continue;
        };

        let mut references = vec![fragarach_ir::EvidenceReference {
            source_id: source.source_id.clone(),
            evidence_id: item.evidence_id.clone(),
        }];
        if let Some(reference) = target.evidence.first() {
            references.push(reference.clone());
        }
        if let Some(verifier_document_id) = front_matter_value(&item.text, "position_verified_by")
            && let Some(verifier) = profiles.iter().find(|candidate| {
                candidate.document_id.as_deref() == Some(verifier_document_id.as_str())
            })
            && let Some(verifier_evidence) = evidence
                .iter()
                .filter(|candidate| candidate.source_id == verifier.source_id)
                .max_by_key(|candidate| {
                    usize::from(
                        candidate
                            .text
                            .contains(source.document_id.as_deref().unwrap_or("")),
                    ) + usize::from(candidate.text.contains(target_document_id.as_str()))
                        + usize::from(candidate.text.contains("現行"))
                        + usize::from(candidate.text.contains("承認"))
                        + usize::from(candidate.text.contains("失効"))
                        + usize::from(candidate.text.contains("却下"))
                })
        {
            references.push(fragarach_ir::EvidenceReference {
                source_id: verifier_evidence.source_id.clone(),
                evidence_id: verifier_evidence.evidence_id.clone(),
            });
        }
        references.dedup_by(|left, right| {
            left.source_id == right.source_id && left.evidence_id == right.evidence_id
        });

        let mut pair = [source.source_id.clone(), target.source_id.clone()];
        pair.sort();
        managed_pairs.insert((pair[0].clone(), pair[1].clone()));
        managed_sources.insert(source.source_id.clone());
        managed_sources.insert(target.source_id.clone());
        let relation_key = format!(
            "{}:{}:{}:{:?}",
            source.source_id, target.source_id, target_document_id, position
        );
        compiled.push(DocumentRelation {
            id: format!("position_{}", &sha256_hex(relation_key.as_bytes())[..16]),
            position,
            kind: fragarach_ir::RelationKind::OperationalPosition,
            source_id: source.source_id.clone(),
            target_id: target.source_id.clone(),
            source_clauses: Vec::new(),
            target_clauses: Vec::new(),
            scope: source.scope.clone(),
            valid_from: source.time.valid_from.clone(),
            valid_to: source.time.valid_to.clone(),
            evidence: references,
        });
    }

    compiled.extend(provider_relations.into_iter().filter(|relation| {
        let mut pair = [relation.source_id.clone(), relation.target_id.clone()];
        pair.sort();
        !managed_sources.contains(&relation.source_id)
            && !managed_sources.contains(&relation.target_id)
            && !managed_pairs.contains(&(pair[0].clone(), pair[1].clone()))
    }));
    compiled.sort_by(|left, right| left.id.cmp(&right.id));
    compiled
}

fn role_from_document_type(document_type: &str) -> DocumentRole {
    match document_type {
        "policy" | "standard" | "master_contract" | "specification" | "amendment" => {
            DocumentRole::Normative
        }
        "procedure" | "site_work_instruction" | "implementation_plan" | "sow" => {
            DocumentRole::Instruction
        }
        "approval_record" | "decision_record" | "test_record" | "execution_log"
        | "release_record" | "audit_record" | "final_report" => DocumentRole::Record,
        "analysis" | "initial_report" => DocumentRole::Analysis,
        "proposal" | "draft" | "vendor_proposal" | "change_request" => DocumentRole::Proposal,
        "faq" => DocumentRole::Communication,
        _ => DocumentRole::Reference,
    }
}

fn build_relation_dossiers(
    intent_id: &str,
    profiles: &[DocumentProfile],
    relations: &[DocumentRelation],
    evidence: &[PromptEvidence],
) -> Vec<RelationDossier> {
    let profile_by_id = profiles
        .iter()
        .map(|profile| (profile.source_id.as_str(), profile))
        .collect::<std::collections::HashMap<_, _>>();
    relations
        .iter()
        .filter_map(|relation| {
            let source = profile_by_id.get(relation.source_id.as_str())?;
            let target = profile_by_id.get(relation.target_id.as_str())?;
            let endpoint_evidence = select_relation_evidence(relation, evidence);
            let mut references = Vec::new();
            let mut seen = HashSet::new();
            for reference in relation.evidence.iter().cloned().chain(endpoint_evidence.iter().map(|item| fragarach_ir::EvidenceReference {
                source_id: item.source_id.clone(),
                evidence_id: item.evidence_id.clone(),
            })) {
                if seen.insert((reference.source_id.clone(), reference.evidence_id.clone())) {
                    references.push(reference);
                }
            }
            let kind = serde_json::to_value(&relation.kind)
                .ok()
                .and_then(|value| value.as_str().map(str::to_owned))
                .unwrap_or_else(|| "relation".to_owned());
            let excerpts = endpoint_evidence
                .iter()
                .map(|item| format!("[{} / {}]\n{}", item.source_id, item.heading_path.join(" / "), item.text))
                .collect::<Vec<_>>()
                .join("\n\n");
            let mut verifier_source_ids = references
                .iter()
                .filter(|reference| {
                    reference.source_id != relation.source_id
                        && reference.source_id != relation.target_id
                })
                .map(|reference| reference.source_id.clone())
                .collect::<HashSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            verifier_source_ids.sort();
            let (operative_source_ids, excluded_source_ids, contender_source_ids) =
                match relation.position {
                    fragarach_ir::DocumentPosition::Dominates => (
                        vec![relation.source_id.clone()],
                        vec![relation.target_id.clone()],
                        Vec::new(),
                    ),
                    fragarach_ir::DocumentPosition::Conditional => (
                        vec![relation.source_id.clone(), relation.target_id.clone()],
                        Vec::new(),
                        Vec::new(),
                    ),
                    fragarach_ir::DocumentPosition::NonEffective => (
                        vec![relation.target_id.clone()],
                        vec![relation.source_id.clone()],
                        Vec::new(),
                    ),
                    fragarach_ir::DocumentPosition::Unresolved => (
                        Vec::new(),
                        Vec::new(),
                        vec![relation.source_id.clone(), relation.target_id.clone()],
                    ),
                };
            let source_identity = format!(
                "{}{}",
                source.document_id.as_deref().unwrap_or(&source.source_id),
                source
                    .revision
                    .as_deref()
                    .map(|revision| format!(" revision {revision}"))
                    .unwrap_or_default()
            );
            let target_identity = format!(
                "{}{}",
                target.document_id.as_deref().unwrap_or(&target.source_id),
                target
                    .revision
                    .as_deref()
                    .map(|revision| format!(" revision {revision}"))
                    .unwrap_or_default()
            );
            Some(RelationDossier {
                id: format!("dossier:{}:{}", intent_id, relation.id),
                intent_id: intent_id.to_owned(),
                relation_id: relation.id.clone(),
                position: relation.position.clone(),
                kind: relation.kind.clone(),
                source_id: relation.source_id.clone(),
                target_id: relation.target_id.clone(),
                operative_source_ids,
                excluded_source_ids,
                contender_source_ids,
                verifier_source_ids,
                evidence: references,
                text: format!(
                    "種別: Decision Packet\n位置づけ: {:?}\n変更側: {}\n基準側: {}\n詳細関係: {} {} {}\n適用範囲: {}\n有効開始: {}\n有効終了: {}\n\n原文証拠:\n{}",
                    relation.position,
                    source_identity,
                    target_identity,
                    relation.source_id,
                    kind,
                    relation.target_id,
                    serde_json::to_string(&relation.scope).unwrap_or_default(),
                    relation.valid_from.as_deref().unwrap_or("未指定"),
                    relation.valid_to.as_deref().unwrap_or("未指定"),
                    excerpts
                ),
            })
        })
        .collect()
}

const PROFILE_EVIDENCE_PER_SOURCE: usize = 8;
const DOSSIER_EVIDENCE_PER_ENDPOINT: usize = 3;

fn compact_profile_evidence(evidence: &[PromptEvidence]) -> Vec<PromptEvidence> {
    let mut source_ids = evidence
        .iter()
        .map(|item| item.source_id.as_str())
        .collect::<Vec<_>>();
    source_ids.sort_unstable();
    source_ids.dedup();
    let mut selected = Vec::new();
    for source_id in source_ids {
        let mut candidates = evidence
            .iter()
            .filter(|item| item.source_id == source_id)
            .enumerate()
            .collect::<Vec<_>>();
        candidates
            .sort_by_key(|(index, item)| (std::cmp::Reverse(profile_evidence_score(item)), *index));
        selected.extend(
            candidates
                .into_iter()
                .take(PROFILE_EVIDENCE_PER_SOURCE)
                .map(|(_, item)| item.clone()),
        );
    }
    selected
}

fn profile_evidence_score(item: &PromptEvidence) -> usize {
    let text = format!("{} {}", item.heading_path.join(" "), item.text).to_lowercase();
    let mut score = usize::from(item.text.trim_start().starts_with("---")) * 1_000;
    for term in [
        "置き換",
        "改訂",
        "修正",
        "例外",
        "優先",
        "食い違",
        "矛盾",
        "反映していない",
        "正式",
        "現行",
        "旧版",
        "適用",
        "終了",
        "承認",
        "決定",
        "実施",
        "記録",
        "準拠",
        "由来",
        "参照",
        "更新",
        "supersed",
        "amend",
        "conflict",
        "precedence",
        "exception",
        "derived",
        "system of record",
        "uncontrolled",
    ] {
        if text.contains(term) {
            score += 20;
        }
    }
    if !item.heading_path.is_empty() {
        score += 2;
    }
    if item.text.trim_start().starts_with('#') || item.text.contains("この節では") {
        score = score.saturating_sub(5);
    }
    score
}

fn select_relation_evidence<'a>(
    relation: &DocumentRelation,
    evidence: &'a [PromptEvidence],
) -> Vec<&'a PromptEvidence> {
    let grounded = relation
        .evidence
        .iter()
        .map(|reference| (reference.source_id.as_str(), reference.evidence_id.as_str()))
        .collect::<HashSet<_>>();
    let mut selected = Vec::new();
    for reference in &relation.evidence {
        if reference.source_id == relation.source_id || reference.source_id == relation.target_id {
            continue;
        }
        if let Some(item) = evidence.iter().find(|item| {
            item.source_id == reference.source_id && item.evidence_id == reference.evidence_id
        }) {
            selected.push(item);
        }
    }
    for source_id in [&relation.source_id, &relation.target_id] {
        let mut candidates = evidence
            .iter()
            .filter(|item| {
                item.source_id.as_str() == source_id.as_str()
                    && !item.text.trim_start().starts_with("---")
                    && !item.text.trim().starts_with('#')
                    && !item.text.contains("架空の評価用社内文書")
                    && !item.text.contains("この節では")
            })
            .enumerate()
            .collect::<Vec<_>>();
        candidates.sort_by_key(|(index, item)| {
            let is_grounded =
                grounded.contains(&(item.source_id.as_str(), item.evidence_id.as_str()));
            (
                std::cmp::Reverse(
                    usize::from(is_grounded) * 1_000 + relation_evidence_score(relation, item),
                ),
                *index,
            )
        });
        selected.extend(
            candidates
                .into_iter()
                .take(DOSSIER_EVIDENCE_PER_ENDPOINT)
                .map(|(_, item)| item),
        );
    }
    selected
}

fn relation_evidence_score(relation: &DocumentRelation, item: &PromptEvidence) -> usize {
    let text = format!("{} {}", item.heading_path.join(" "), item.text).to_lowercase();
    let kind = serde_json::to_value(&relation.kind)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default();
    let terms: &[&str] = match kind.as_str() {
        "operational_position" => &["現行", "承認", "未承認", "却下", "失効", "適用"],
        "supersedes" => &[
            "現行",
            "旧版",
            "適用期間",
            "置き換",
            "終了",
            "第2版",
            "第1版",
        ],
        "conflicts_with" | "order_of_precedence" => &[
            "現行",
            "正式",
            "優先",
            "反映していない",
            "旧案内",
            "食い違",
            "矛盾",
        ],
        "records_execution_of" => &["決定", "承認", "実施", "記録"],
        "amends" => &["改訂", "修正", "変更", "条", "節"],
        "exception_to" => &["例外", "逸脱", "免除", "限定"],
        _ => &["適用", "由来", "参照", "関係"],
    };
    let mut score = terms.iter().filter(|term| text.contains(**term)).count() * 20
        + usize::from(item.valid_from.is_some() || item.valid_to.is_some()) * 3;
    if item
        .heading_path
        .iter()
        .any(|heading| heading.contains("判断に用いる基準"))
    {
        score += 100;
    }
    score
}

#[derive(Debug, Serialize, Deserialize)]
struct CachedExtraction {
    format_version: u32,
    #[serde(default)]
    created_at: Option<chrono::DateTime<Utc>>,
    #[serde(default)]
    identity: String,
    #[serde(default)]
    intent_id: String,
    #[serde(default)]
    source_ids: Vec<String>,
    #[serde(default)]
    evidence_ids: Vec<String>,
    response: ClaimExtractionResponse,
}

#[derive(Debug, Serialize, Deserialize)]
struct CachedProfileExtraction {
    format_version: u32,
    #[serde(default)]
    created_at: Option<chrono::DateTime<Utc>>,
    #[serde(default)]
    identity: String,
    #[serde(default)]
    source_ids: Vec<String>,
    #[serde(default)]
    evidence_ids: Vec<String>,
    response: DocumentProfileExtractionResponse,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExtractionCacheEntrySummary {
    pub path: PathBuf,
    pub created_at: Option<chrono::DateTime<Utc>>,
    pub identity: String,
    pub intent_id: String,
    pub source_ids: Vec<String>,
    pub evidence_units: usize,
    pub claims: usize,
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExtractionCacheReport {
    pub root: PathBuf,
    pub entries: Vec<ExtractionCacheEntrySummary>,
    pub evidence_units: usize,
    pub claims: usize,
}

fn identity_for_cache(identity: &Option<String>) -> &str {
    identity.as_deref().unwrap_or_default()
}

fn extraction_cache_path(
    cache_root: &Path,
    identity: &str,
    request: &ClaimExtractionRequest,
) -> Result<PathBuf> {
    let mut hasher = Sha256::new();
    hasher.update(format!(
        "fragarach-extraction-cache-v{EXTRACTION_CACHE_FORMAT_VERSION}\0"
    ));
    hasher.update(identity.as_bytes());
    hasher.update(b"\0");
    hasher.update(
        serde_json::to_vec(request).context("failed to serialize extraction cache request")?,
    );
    let digest = hasher.finalize();
    let mut key = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut key, "{byte:02x}").unwrap();
    }
    Ok(cache_root.join(&key[..2]).join(format!("{key}.json")))
}

fn load_cached_extraction(path: &Path) -> Result<Option<ClaimExtractionResponse>> {
    if !path.is_file() {
        return Ok(None);
    }
    let entry: CachedExtraction = serde_json::from_slice(
        &fs::read(path)
            .with_context(|| format!("failed to read extraction cache {}", path.display()))?,
    )
    .with_context(|| format!("failed to parse extraction cache {}", path.display()))?;
    if entry.format_version != EXTRACTION_CACHE_FORMAT_VERSION {
        return Ok(None);
    }
    Ok(Some(entry.response))
}

fn save_cached_extraction(
    path: &Path,
    identity: &str,
    request: &ClaimExtractionRequest,
    response: &ClaimExtractionResponse,
) -> Result<()> {
    if path.is_file() {
        return Ok(());
    }
    let parent = path
        .parent()
        .context("extraction cache path has no parent directory")?;
    fs::create_dir_all(parent)?;
    let unique = Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let temporary = parent.join(format!(".cache-write-{unique}.tmp"));
    let mut source_ids = request
        .evidence
        .iter()
        .map(|item| item.source_id.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    source_ids.sort();
    let entry = CachedExtraction {
        format_version: EXTRACTION_CACHE_FORMAT_VERSION,
        created_at: Some(Utc::now()),
        identity: identity.to_owned(),
        intent_id: request.intent.id.clone(),
        source_ids,
        evidence_ids: request
            .evidence
            .iter()
            .map(|item| item.evidence_id.clone())
            .collect(),
        response: response.clone(),
    };
    fs::write(&temporary, serde_json::to_vec(&entry)?)
        .with_context(|| format!("failed to write extraction cache {}", temporary.display()))?;
    fs::rename(&temporary, path).with_context(|| {
        format!(
            "failed to atomically publish extraction cache {}",
            path.display()
        )
    })?;
    Ok(())
}

fn profile_extraction_cache_path(
    cache_root: &Path,
    identity: &str,
    request: &DocumentProfileExtractionRequest,
) -> Result<PathBuf> {
    let mut hasher = Sha256::new();
    hasher.update(format!(
        "fragarach-profile-extraction-cache-v{EXTRACTION_CACHE_FORMAT_VERSION}\0"
    ));
    hasher.update(identity.as_bytes());
    hasher.update(b"\0");
    hasher.update(
        serde_json::to_vec(request)
            .context("failed to serialize profile extraction cache request")?,
    );
    let digest = hasher.finalize();
    let mut key = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut key, "{byte:02x}").unwrap();
    }
    Ok(cache_root.join(&key[..2]).join(format!("{key}.json")))
}

fn load_cached_profile_extraction(
    path: &Path,
) -> Result<Option<DocumentProfileExtractionResponse>> {
    if !path.is_file() {
        return Ok(None);
    }
    let entry: CachedProfileExtraction =
        serde_json::from_slice(&fs::read(path).with_context(|| {
            format!("failed to read profile extraction cache {}", path.display())
        })?)
        .with_context(|| {
            format!(
                "failed to parse profile extraction cache {}",
                path.display()
            )
        })?;
    if entry.format_version != EXTRACTION_CACHE_FORMAT_VERSION {
        return Ok(None);
    }
    Ok(Some(entry.response))
}

fn save_cached_profile_extraction(
    path: &Path,
    identity: &str,
    request: &DocumentProfileExtractionRequest,
    response: &DocumentProfileExtractionResponse,
) -> Result<()> {
    if path.is_file() {
        return Ok(());
    }
    let parent = path
        .parent()
        .context("profile extraction cache path has no parent directory")?;
    fs::create_dir_all(parent)?;
    let unique = Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let temporary = parent.join(format!(".profile-cache-write-{unique}.tmp"));
    let mut source_ids = request
        .evidence
        .iter()
        .map(|item| item.source_id.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    source_ids.sort();
    let entry = CachedProfileExtraction {
        format_version: EXTRACTION_CACHE_FORMAT_VERSION,
        created_at: Some(Utc::now()),
        identity: identity.to_owned(),
        source_ids,
        evidence_ids: request
            .evidence
            .iter()
            .map(|item| item.evidence_id.clone())
            .collect(),
        response: response.clone(),
    };
    fs::write(&temporary, serde_json::to_vec(&entry)?).with_context(|| {
        format!(
            "failed to write profile extraction cache {}",
            temporary.display()
        )
    })?;
    fs::rename(&temporary, path).with_context(|| {
        format!(
            "failed to atomically publish profile extraction cache {}",
            path.display()
        )
    })?;
    Ok(())
}

pub fn read_extraction_cache_report(workspace: &Path) -> Result<ExtractionCacheReport> {
    let root = workspace
        .join(".fragarach")
        .join("cache")
        .join("claim-extraction-v1");
    let mut entries = Vec::new();
    if root.is_dir() {
        for prefix in fs::read_dir(&root)? {
            let prefix = prefix?;
            if !prefix.file_type()?.is_dir() {
                continue;
            }
            for item in fs::read_dir(prefix.path())? {
                let item = item?;
                if !item.file_type()?.is_file()
                    || item.path().extension().and_then(|value| value.to_str()) != Some("json")
                {
                    continue;
                }
                let cached: CachedExtraction = serde_json::from_slice(&fs::read(item.path())?)
                    .with_context(|| {
                        format!("failed to parse extraction cache {}", item.path().display())
                    })?;
                entries.push(ExtractionCacheEntrySummary {
                    path: item.path(),
                    created_at: cached.created_at,
                    identity: cached.identity,
                    intent_id: cached.intent_id,
                    source_ids: cached.source_ids,
                    evidence_units: cached.evidence_ids.len(),
                    claims: cached.response.claims.len(),
                    provider: cached.response.provider,
                    model: cached.response.model,
                });
            }
        }
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(ExtractionCacheReport {
        root,
        evidence_units: entries.iter().map(|entry| entry.evidence_units).sum(),
        claims: entries.iter().map(|entry| entry.claims).sum(),
        entries,
    })
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
        compact_profile_evidence, fallback_document_profile,
        intent_requests_checklist_completeness, merge_front_matter_positions,
        relation_evidence_score, select_relation_evidence, source_aware_batches,
    };
    use fragarach_ir::{
        ApplicabilityScope, DocumentPosition, DocumentRelation, EvidenceReference,
        IntentRequirements, RelationKind, UsageIntent,
    };
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
    fn profile_evidence_is_capped_per_source_and_keeps_relation_signals() {
        let mut items = (0..12)
            .map(|index| evidence("a", index))
            .collect::<Vec<_>>();
        items[0].text = "---\ndocument_type: policy\n---".to_owned();
        items[10].text = "このFAQは第2版を反映していない。".to_owned();
        items[11].text = "正式規程を優先する。".to_owned();

        let selected = compact_profile_evidence(&items);

        assert_eq!(selected.len(), 8);
        assert!(selected.iter().any(|item| item.text.starts_with("---")));
        assert!(
            selected
                .iter()
                .any(|item| item.text.contains("反映していない"))
        );
        assert!(selected.iter().any(|item| item.text.contains("優先")));
    }

    #[test]
    fn relation_dossier_selects_short_relevant_excerpts_from_both_endpoints() {
        let mut items = vec![
            evidence("policy", 0),
            evidence("policy", 1),
            evidence("faq", 0),
            evidence("faq", 1),
            evidence("faq", 2),
        ];
        items[0].text = "2026年4月1日以降は共同承認を得る。".to_owned();
        items[1].text = "無関係な長い背景説明".to_owned();
        items[2].text = "このFAQでは単独承認でよいと案内している。".to_owned();
        items[3].text = "このFAQは第2版を反映していない。".to_owned();
        items[4].text = "この節では、正式規程を優先する注意を書く。".to_owned();
        let relation = DocumentRelation {
            id: "rel".to_owned(),
            position: fragarach_ir::DocumentPosition::Unresolved,
            kind: RelationKind::ConflictsWith,
            source_id: "policy".to_owned(),
            target_id: "faq".to_owned(),
            source_clauses: Vec::new(),
            target_clauses: Vec::new(),
            scope: ApplicabilityScope::default(),
            valid_from: None,
            valid_to: None,
            evidence: vec![EvidenceReference {
                source_id: "faq".to_owned(),
                evidence_id: "ev-faq-0".to_owned(),
            }],
        };

        let selected = select_relation_evidence(&relation, &items);

        assert!(selected.iter().any(|item| item.source_id == "policy"));
        assert!(selected.iter().any(|item| item.text.contains("単独承認")));
        assert!(
            selected
                .iter()
                .any(|item| item.text.contains("反映していない"))
        );
        assert!(!selected.iter().any(|item| item.text.contains("この節では")));
    }

    #[test]
    fn position_dossier_prefers_decision_fact_chunks_over_repeated_filler() {
        let mut fact = evidence("policy", 0);
        fact.heading_path = vec!["判断に用いる基準".to_owned()];
        fact.text = "- 抜取頻度: 20台ごとに1台".to_owned();
        let mut filler = evidence("policy", 1);
        filler.heading_path = vec!["記録と確認 18".to_owned()];
        filler.text = "承認経路と対象範囲を確認する。".to_owned();
        let relation = DocumentRelation {
            id: "position".to_owned(),
            position: DocumentPosition::Dominates,
            kind: RelationKind::OperationalPosition,
            source_id: "policy".to_owned(),
            target_id: "old".to_owned(),
            source_clauses: Vec::new(),
            target_clauses: Vec::new(),
            scope: ApplicabilityScope::default(),
            valid_from: None,
            valid_to: None,
            evidence: Vec::new(),
        };

        assert!(
            relation_evidence_score(&relation, &fact) > relation_evidence_score(&relation, &filler)
        );
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
    fn corpus_front_matter_names_propagate_lifecycle_time_and_authority() {
        let mut items = vec![evidence("a", 0), evidence("a", 1)];
        items[0].text = "---\nstatus: current\nauthority: corporate_policy\nvalid_from: 2026-04-01\nvalid_to: 2027-03-31\n---".to_owned();
        items[1].text = "現行の規則".to_owned();

        apply_corpus_hints(&CorpusSettings::default(), &mut items).unwrap();

        assert_eq!(items[1].lifecycle.as_deref(), Some("current"));
        assert_eq!(items[1].authority.as_deref(), Some("corporate_policy"));
        assert_eq!(items[1].valid_from.as_deref(), Some("2026-04-01"));
        assert_eq!(items[1].valid_to.as_deref(), Some("2027-03-31"));
    }

    #[test]
    fn missing_provider_profile_falls_back_to_grounded_front_matter() {
        let mut items = vec![evidence("faq", 0), evidence("faq", 1)];
        items[0].text =
            "---\ndocument_id: FAQ-QA-002\nrevision: 3\ndocument_type: faq\nstatus: stale\nvalid_from: 2026-04-01\n---".to_owned();
        items[1].text = "このFAQは第2版を反映していない。".to_owned();

        let profile = fallback_document_profile("faq", &items).unwrap();

        assert_eq!(profile.source_id, "faq");
        assert_eq!(profile.document_id.as_deref(), Some("FAQ-QA-002"));
        assert_eq!(profile.revision.as_deref(), Some("3"));
        assert_eq!(profile.role, fragarach_ir::DocumentRole::Communication);
        assert_eq!(profile.force.level, fragarach_ir::ForceLevel::Informational);
        assert!(!profile.force.approved);
        assert_eq!(profile.time.valid_from.as_deref(), Some("2026-04-01"));
        assert_eq!(profile.evidence[0].source_id, "faq");
        assert_eq!(profile.evidence[0].evidence_id, "ev-faq-0");
    }

    #[test]
    fn front_matter_position_compiles_by_document_identity_with_verifier_evidence() {
        let mut items = vec![
            evidence("current", 0),
            evidence("old", 0),
            evidence("register", 0),
            evidence("register", 1),
        ];
        items[0].text = "---\ndocument_id: STD-001\nrevision: 2\ndocument_type: standard\nstatus: current\napproved: true\nposition: dominates\nposition_target_document_id: STD-001\nposition_target_revision: 1\nposition_verified_by: REG-001\n---".to_owned();
        items[1].text = "---\ndocument_id: STD-001\nrevision: 1\ndocument_type: standard\nstatus: superseded\napproved: true\n---".to_owned();
        items[2].text = "---\ndocument_id: REG-001\nrevision: 1\ndocument_type: approval_record\nstatus: current\napproved: true\n---".to_owned();
        items[3].text = "現行正本はSTD-001 revision 2。revision 1は失効。".to_owned();
        let profiles = ["current", "old", "register"]
            .iter()
            .map(|source| fallback_document_profile(source, &items).unwrap())
            .collect::<Vec<_>>();

        let false_provider_relation = DocumentRelation {
            id: "false-cross-family".to_owned(),
            position: DocumentPosition::Conditional,
            kind: RelationKind::ExceptionTo,
            source_id: "current".to_owned(),
            target_id: "register".to_owned(),
            source_clauses: Vec::new(),
            target_clauses: Vec::new(),
            scope: ApplicabilityScope::default(),
            valid_from: None,
            valid_to: None,
            evidence: vec![EvidenceReference {
                source_id: "current".to_owned(),
                evidence_id: "ev-current-0".to_owned(),
            }],
        };
        let relations =
            merge_front_matter_positions(&profiles, vec![false_provider_relation], &items);

        assert_eq!(relations.len(), 1);
        assert_eq!(relations[0].position, DocumentPosition::Dominates);
        assert_eq!(relations[0].kind, RelationKind::OperationalPosition);
        assert_eq!(relations[0].source_id, "current");
        assert_eq!(relations[0].target_id, "old");
        assert!(
            relations[0]
                .evidence
                .iter()
                .any(|reference| reference.source_id == "register")
        );
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
