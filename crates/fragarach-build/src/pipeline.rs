use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use anyhow::{Context, Result, bail};
use chrono::Utc;
use fragarach_ir::{
    ApplicabilityScope, BuildArtifact, BuildMetrics, Claim, CompilationPolicy, DecisionPacket,
    Diagnostic, DiagnosticCounts, DiagnosticSeverity, DocumentProfile, DocumentRelation,
    DocumentRole, ForceLevel, ForceProfile, IR_SCHEMA_COMPATIBILITY_POLICY, IR_SCHEMA_VERSION,
    KnowledgeBuildManifest, KnowledgeBuildStatus, PacketMaterial, PacketMaterialRole,
    PacketPurpose, ParsedDocument, SourceManifest, SourceState, TemporalProfile, UsageIntent,
    is_compatible_schema,
};
use fragarach_llm::{
    CLAIM_EXTRACTION_CONTRACT_VERSION, ClaimExtractionRequest, ClaimExtractionResponse,
    DOCUMENT_PROFILE_CONTRACT_VERSION, DOCUMENT_RELATION_CONTRACT_VERSION,
    DocumentProfileExtractionRequest, DocumentProfileExtractionResponse, DocumentRelationCandidate,
    DocumentRelationExtractionRequest, DocumentRelationExtractionResponse, KnowledgeExtractor,
    PromptEvidence, SOURCE_PROFILE_CONTRACT_VERSION, claim_extraction_contract_fingerprint,
    document_profile_contract_fingerprint, document_relation_contract_fingerprint,
    source_profile_contract_fingerprint,
};
use fragarach_resolver::{
    CONTENDER_OFFSET, EXCLUDED_OFFSET, GOVERNING_OFFSET, STANDARD_RERANK_CANDIDATE_LIMIT,
    STANDARD_RERANKER_NAME, UNCLASSIFIED_OFFSET, VERIFIER_OFFSET, normalize_document_set,
    validate_relations,
};
use fragarach_workspace::WorkspaceLock;
use globset::Glob;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    ConflictContext, analyze_conflicts_with_metadata, load_usage_intent,
    prompt_evidence_from_documents, validate_extraction,
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CompileStrategy {
    GlobalV1,
    LinearV2,
    #[serde(rename = "dossier-v1", alias = "hybrid-v2")]
    DossierV1,
}

impl CompileStrategy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::GlobalV1 => "global-v1",
            Self::LinearV2 => "linear-v2",
            Self::DossierV1 => "dossier-v1",
        }
    }
}

impl Default for CompileStrategy {
    fn default() -> Self {
        Self::DossierV1
    }
}

#[derive(Debug, Clone)]
pub struct CompileOptions {
    pub workspace: PathBuf,
    pub intent_file: PathBuf,
    pub output: PathBuf,
    pub batch_size: usize,
    pub llm_concurrency: usize,
    pub use_extraction_cache: bool,
    pub strategy: CompileStrategy,
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
    let packet_path = build.join("decision-packets.jsonl");
    let packets: Vec<DecisionPacket> = if packet_path.exists() {
        read_jsonl(&packet_path)?
    } else {
        Vec::new()
    };
    let profiles: Vec<DocumentProfile> = read_jsonl(&build.join("document-profiles.jsonl"))?;
    let relations: Vec<DocumentRelation> = read_jsonl(&build.join("document-relations.jsonl"))?;
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
    for packet in packets {
        let text = render_decision_packet(&packet, &profiles, &relations, &evidence);
        records.push(serde_json::json!({
            "id": format!("packet:{}", packet.id),
            "text": text,
            "metadata": {
                "intent_id": manifest.intent_id,
                "unit_type": "decision_packet",
                "decision_packet": packet,
            }
        }));
    }
    if !packet_path.exists() {
        for dossier in read_jsonl::<serde_json::Value>(&build.join("relation-dossiers.jsonl"))? {
            let id = dossier
                .get("id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("legacy");
            let text = dossier
                .get("text")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            records.push(serde_json::json!({
                "id": format!("dossier:{id}"),
                "text": text,
                "metadata": {
                    "intent_id": manifest.intent_id,
                    "unit_type": "relation_dossier",
                    "relation_dossier": dossier,
                }
            }));
        }
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
    let ProfileCompilation {
        profiles: extracted_profiles,
        relations: extracted_relations,
        diagnostics: profile_diagnostics,
        metrics: profile_metrics,
        provider: profile_provider,
        model: profile_model,
    } = compile_document_profiles(
        options.strategy,
        extractor,
        &control,
        &evidence,
        &claims,
        options.use_extraction_cache,
        options.llm_concurrency,
    )?;
    if profile_provider != provider || profile_model != model {
        bail!("profile extraction provider or model differs from Claim extraction");
    }
    let profile_cache_hits = profile_metrics.profile_cache_hits;
    let profile_cache_misses = profile_metrics.profile_cache_misses;
    let profile_llm_calls = profile_metrics.profile_llm_calls;
    let profile_prompt_tokens = profile_metrics.profile_prompt_tokens;
    let profile_completion_tokens = profile_metrics.profile_completion_tokens;
    diagnostics.extend(profile_diagnostics);
    let normalized = normalize_document_set(
        &extracted_profiles,
        &extracted_relations,
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
    let mut document_relations =
        merge_front_matter_positions(&document_profiles, normalized.relations, &evidence);
    refine_stale_guidance_relations(&mut document_relations, &document_profiles, &claims);
    complete_relation_family_coverage(
        &mut document_relations,
        &document_profiles,
        &claims,
        &evidence,
    );
    diagnostics.extend(unresolved_required_relation_diagnostics(
        &document_relations,
        &evidence,
    ));
    diagnostics.extend(
        validate_relations(&document_profiles, &document_relations)
            .into_iter()
            .enumerate()
            .map(|(index, reason)| relation_validation_diagnostic(index, reason)),
    );
    let decision_packets = build_decision_packets(&intent.id, &document_relations, &evidence);
    let conflict_analysis = analyze_conflicts_with_metadata(
        &claims,
        &document_profiles,
        &document_relations,
        &conflict_context,
        &options.policy,
    );
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
        "decision_packets",
        "decision-packets.jsonl",
        &decision_packets,
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
            "# Knowledge Build\n\n- Intent: `{}`\n- Claims: {}\n- Evidence: {}\n- Document Profiles: {}\n- Document Relations: {}\n- Decision Packets: {}\n- Conflicts: {} (unresolved {})\n- Diagnostics: {}\n",
            intent.id,
            claims.len(),
            evidence.len(),
            document_profiles.len(),
            document_relations.len(),
            decision_packets.len(),
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
            "source_profile_contract": SOURCE_PROFILE_CONTRACT_VERSION,
            "source_profile_fingerprint": source_profile_contract_fingerprint(),
            "relation_contract": DOCUMENT_RELATION_CONTRACT_VERSION,
            "relation_fingerprint": document_relation_contract_fingerprint(),
            "compile_strategy": options.strategy.as_str(),
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
            "relation_extraction_cache": {
                "enabled": options.use_extraction_cache,
                "hits": profile_metrics.relation_cache_hits,
                "misses": profile_metrics.relation_cache_misses
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
        compile_strategy: options.strategy.as_str().to_owned(),
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
            profile_duration_ms: profile_metrics.profile_duration_ms,
            profile_wall_duration_ms: profile_metrics.profile_wall_duration_ms,
            profile_batches: profile_metrics.profile_batches,
            relation_candidate_edges: profile_metrics.relation_candidate_edges,
            relation_batches: profile_metrics.relation_batches,
            relation_cache_hits: profile_metrics.relation_cache_hits,
            relation_cache_misses: profile_metrics.relation_cache_misses,
            relation_llm_calls: profile_metrics.relation_llm_calls,
            relation_prompt_tokens: profile_metrics.relation_prompt_tokens,
            relation_completion_tokens: profile_metrics.relation_completion_tokens,
            relation_duration_ms: profile_metrics.relation_duration_ms,
            relation_wall_duration_ms: profile_metrics.relation_wall_duration_ms,
            document_profiles: document_profiles.len(),
            document_relations: document_relations.len(),
            decision_packets: decision_packets.len(),
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
    let relations_path = options.input.join("document-relations.jsonl");
    let had_relations_artifact = relations_path.exists();
    let mut document_relations: Vec<DocumentRelation> = if had_relations_artifact {
        read_jsonl(&relations_path)?
    } else {
        Vec::new()
    };
    let profiles_path = options.input.join("document-profiles.jsonl");
    let had_profiles_artifact = profiles_path.exists();
    let mut document_profiles: Vec<DocumentProfile> = if had_profiles_artifact {
        read_jsonl(&profiles_path)?
    } else {
        Vec::new()
    };
    apply_front_matter_to_profiles(&mut document_profiles, &evidence);
    complete_relation_family_coverage(
        &mut document_relations,
        &document_profiles,
        &claims,
        &evidence,
    );
    let decision_packets = build_decision_packets(&intent.id, &document_relations, &evidence);

    let mut context = options.conflict_context.clone();
    if context.authority_precedence.is_empty() {
        context.authority_precedence = corpus_settings.authority_precedence.clone();
    }
    let conflict_analysis = analyze_conflicts_with_metadata(
        &claims,
        &document_profiles,
        &document_relations,
        &context,
        &options.policy,
    );
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
    if had_profiles_artifact {
        write_jsonl(
            staging.path(),
            "document_profiles",
            "document-profiles.jsonl",
            &document_profiles,
            &mut discarded_artifacts,
        )?;
    }
    if had_relations_artifact {
        write_jsonl(
            staging.path(),
            "document_relations",
            "document-relations.jsonl",
            &document_relations,
            &mut discarded_artifacts,
        )?;
        write_jsonl(
            staging.path(),
            "decision_packets",
            "decision-packets.jsonl",
            &decision_packets,
            &mut discarded_artifacts,
        )?;
        let legacy_packet_path = staging.path().join("relation-dossiers.jsonl");
        if legacy_packet_path.exists() {
            fs::remove_file(legacy_packet_path)?;
        }
    }
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

    let mut artifact_kinds = old_manifest
        .artifacts
        .iter()
        .filter(|artifact| artifact.path != "relation-dossiers.jsonl")
        .map(|artifact| (artifact.path.clone(), artifact.kind.clone()))
        .collect::<BTreeMap<_, _>>();
    for artifact in discarded_artifacts {
        artifact_kinds.insert(artifact.path, artifact.kind);
    }
    let artifacts = artifact_kinds
        .into_iter()
        .map(|(path, kind)| {
            let bytes = fs::read(staging.path().join(&path))?;
            Ok(BuildArtifact {
                kind,
                path,
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
        compile_strategy: old_manifest.compile_strategy,
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
            document_profiles: document_profiles.len(),
            document_relations: document_relations.len(),
            decision_packets: decision_packets.len(),
            llm_concurrency: old_manifest.metrics.llm_concurrency,
            llm_calls: 0,
            prompt_tokens: 0,
            completion_tokens: 0,
            duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            ..BuildMetrics::default()
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

fn front_matter_scope(text: &str) -> Option<ApplicabilityScope> {
    let raw = front_matter_value(text, "scope")?;
    let value = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    let object = value.as_object()?;
    let values = |keys: &[&str]| {
        let mut result = keys
            .iter()
            .filter_map(|key| object.get(*key))
            .flat_map(|value| match value {
                serde_json::Value::String(value) => vec![value.clone()],
                serde_json::Value::Array(values) => values
                    .iter()
                    .filter_map(|value| value.as_str().map(str::to_owned))
                    .collect(),
                _ => Vec::new(),
            })
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        result.sort();
        result.dedup();
        result
    };
    Some(ApplicabilityScope {
        jurisdictions: values(&["jurisdiction", "jurisdictions"]),
        entities: values(&["organization", "organizations", "entity", "entities"]),
        sites: values(&["site", "sites"]),
        products: values(&["product", "products"]),
        assets: values(&["asset", "assets"]),
        persons: values(&["person", "persons"]),
        projects: values(&["project", "projects"]),
        lots: values(&["lot", "lots"]),
        contracts: values(&["contract", "contracts"]),
    })
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
        "schema_version: \"{IR_SCHEMA_VERSION}\"\nrequire_evidence: true\nfilters:\n  - intent_id\n  - as_of\nauthority_precedence:\n{precedence}authority_score_step: 0.05\nrerank:\n  algorithm: {STANDARD_RERANKER_NAME}\n  candidate_limit: {STANDARD_RERANK_CANDIDATE_LIMIT}\n  candidate_set: preserve\n  adjusted_rank: original_rank + role_offset\n  tie_breaker: original_rank\n  role_offsets:\n    governing: {GOVERNING_OFFSET}\n    verifier: {VERIFIER_OFFSET}\n    unclassified: {UNCLASSIFIED_OFFSET}\n    contender: {CONTENDER_OFFSET}\n    excluded: {EXCLUDED_OFFSET}\n"
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

#[derive(Debug, Default)]
struct ProfileCompilationMetrics {
    profile_cache_hits: usize,
    profile_cache_misses: usize,
    profile_llm_calls: usize,
    profile_prompt_tokens: u64,
    profile_completion_tokens: u64,
    profile_duration_ms: u64,
    profile_wall_duration_ms: u64,
    profile_batches: usize,
    relation_candidate_edges: usize,
    relation_batches: usize,
    relation_cache_hits: usize,
    relation_cache_misses: usize,
    relation_llm_calls: usize,
    relation_prompt_tokens: u64,
    relation_completion_tokens: u64,
    relation_duration_ms: u64,
    relation_wall_duration_ms: u64,
}

#[derive(Debug)]
struct ProfileCompilation {
    profiles: Vec<DocumentProfile>,
    relations: Vec<DocumentRelation>,
    diagnostics: Vec<Diagnostic>,
    metrics: ProfileCompilationMetrics,
    provider: String,
    model: String,
}

struct ProfileRequestPlan {
    request: DocumentProfileExtractionRequest,
    cache_path: Option<PathBuf>,
    cached_response: Option<DocumentProfileExtractionResponse>,
}

struct ProfileRequestExecution {
    request: DocumentProfileExtractionRequest,
    response: DocumentProfileExtractionResponse,
    cache_hit: bool,
    cache_miss: bool,
}

fn execute_profile_requests(
    extractor: &dyn KnowledgeExtractor,
    requests: Vec<DocumentProfileExtractionRequest>,
    cache_identity: Option<&str>,
    cache_root: &Path,
    concurrency: usize,
    source_profiles_only: bool,
) -> Result<Vec<ProfileRequestExecution>> {
    let plans = requests
        .into_iter()
        .map(|request| {
            let cache_path = cache_identity
                .map(|identity| profile_extraction_cache_path(cache_root, identity, &request))
                .transpose()?;
            let cached_response = cache_path
                .as_deref()
                .map(load_cached_profile_extraction)
                .transpose()?
                .flatten();
            Ok(ProfileRequestPlan {
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
            .map(|_| None::<Result<(DocumentProfileExtractionResponse, bool, bool)>>)
            .collect::<Vec<_>>(),
    );
    {
        let mut locked = results
            .lock()
            .map_err(|_| anyhow::anyhow!("profile extraction result lock was poisoned"))?;
        for (index, plan) in plans.iter().enumerate() {
            if let Some(response) = &plan.cached_response {
                locked[index] = Some(Ok((response.clone(), true, false)));
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
                            let response = if source_profiles_only {
                                extractor.extract_source_profiles(&plan.request)?
                            } else {
                                extractor.extract_profiles(&plan.request)?
                            };
                            let cache_miss = if let Some(path) = &plan.cache_path {
                                save_cached_profile_extraction(
                                    path,
                                    cache_identity.unwrap_or_default(),
                                    &plan.request,
                                    &response,
                                )?;
                                true
                            } else {
                                false
                            };
                            Ok((response, false, cache_miss))
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
        .map_err(|_| anyhow::anyhow!("profile extraction result lock was poisoned"))?;
    plans
        .into_iter()
        .zip(outputs)
        .map(|(plan, output)| {
            let (response, cache_hit, cache_miss) =
                output.context("profile extraction worker did not produce a result")??;
            Ok(ProfileRequestExecution {
                request: plan.request,
                response,
                cache_hit,
                cache_miss,
            })
        })
        .collect()
}

struct RelationRequestExecution {
    response: DocumentRelationExtractionResponse,
    cache_hit: bool,
    cache_miss: bool,
}

fn execute_relation_requests(
    extractor: &dyn KnowledgeExtractor,
    requests: Vec<DocumentRelationExtractionRequest>,
    cache_identity: Option<&str>,
    cache_root: &Path,
    concurrency: usize,
) -> Result<Vec<RelationRequestExecution>> {
    let plans = requests
        .into_iter()
        .map(|request| {
            let cache_path = cache_identity
                .map(|identity| relation_extraction_cache_path(cache_root, identity, &request))
                .transpose()?;
            let cached_response = cache_path
                .as_deref()
                .map(load_cached_relation_extraction)
                .transpose()?
                .flatten();
            Ok((request, cache_path, cached_response))
        })
        .collect::<Result<Vec<_>>>()?;
    let results = Mutex::new(
        (0..plans.len())
            .map(|_| None::<Result<(DocumentRelationExtractionResponse, bool, bool)>>)
            .collect::<Vec<_>>(),
    );
    {
        let mut locked = results
            .lock()
            .map_err(|_| anyhow::anyhow!("relation extraction result lock was poisoned"))?;
        for (index, (_, _, cached)) in plans.iter().enumerate() {
            if let Some(response) = cached {
                locked[index] = Some(Ok((response.clone(), true, false)));
            }
        }
    }
    let missing = plans
        .iter()
        .enumerate()
        .filter_map(|(index, (_, _, cached))| cached.is_none().then_some(index))
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        let next = AtomicUsize::new(0);
        let workers = concurrency.min(missing.len());
        std::thread::scope(|scope| {
            for _ in 0..workers {
                let results = &results;
                let plans = &plans;
                let missing = &missing;
                let next = &next;
                scope.spawn(move || {
                    loop {
                        let position = next.fetch_add(1, Ordering::Relaxed);
                        let Some(&index) = missing.get(position) else {
                            break;
                        };
                        let (request, cache_path, _) = &plans[index];
                        let outcome = (|| {
                            let response = extractor.extract_relations(request)?;
                            let cache_miss = if let Some(path) = cache_path {
                                save_cached_relation_extraction(
                                    path,
                                    cache_identity.unwrap_or_default(),
                                    request,
                                    &response,
                                )?;
                                true
                            } else {
                                false
                            };
                            Ok((response, false, cache_miss))
                        })();
                        let mut locked = results.lock().unwrap_or_else(|error| error.into_inner());
                        locked[index] = Some(outcome);
                    }
                });
            }
        });
    }
    results
        .into_inner()
        .map_err(|_| anyhow::anyhow!("relation extraction result lock was poisoned"))?
        .into_iter()
        .map(|output| {
            let (response, cache_hit, cache_miss) =
                output.context("relation extraction worker did not produce a result")??;
            Ok(RelationRequestExecution {
                response,
                cache_hit,
                cache_miss,
            })
        })
        .collect()
}

fn compile_document_profiles(
    strategy: CompileStrategy,
    extractor: &dyn KnowledgeExtractor,
    control: &Path,
    evidence: &[PromptEvidence],
    claims: &[Claim],
    use_cache: bool,
    concurrency: usize,
) -> Result<ProfileCompilation> {
    match strategy {
        CompileStrategy::GlobalV1 => {
            compile_document_profiles_global(extractor, control, evidence, use_cache)
        }
        CompileStrategy::LinearV2 => compile_document_profiles_linear(
            extractor,
            control,
            evidence,
            claims,
            use_cache,
            concurrency,
            RelationPlanning::FixedEdges,
        ),
        CompileStrategy::DossierV1 => compile_document_profiles_linear(
            extractor,
            control,
            evidence,
            claims,
            use_cache,
            concurrency,
            RelationPlanning::Dossiers,
        ),
    }
}

fn compile_document_profiles_global(
    extractor: &dyn KnowledgeExtractor,
    control: &Path,
    evidence: &[PromptEvidence],
    use_cache: bool,
) -> Result<ProfileCompilation> {
    let cache_identity = if use_cache {
        extractor.profile_cache_identity()?
    } else {
        None
    };
    let wall_started = std::time::Instant::now();
    let executions = execute_profile_requests(
        extractor,
        vec![DocumentProfileExtractionRequest {
            evidence: compact_profile_evidence(evidence),
        }],
        cache_identity.as_deref(),
        &control.join("cache").join("document-profile-extraction-v1"),
        1,
        false,
    )?;
    let execution = executions
        .into_iter()
        .next()
        .context("global profile extraction produced no response")?;
    let mut metrics = ProfileCompilationMetrics {
        profile_cache_hits: usize::from(execution.cache_hit),
        profile_cache_misses: usize::from(execution.cache_miss),
        profile_batches: 1,
        profile_wall_duration_ms: u64::try_from(wall_started.elapsed().as_millis())
            .unwrap_or(u64::MAX),
        ..ProfileCompilationMetrics::default()
    };
    if !execution.cache_hit && execution.response.provider != "metadata" {
        metrics.profile_llm_calls = 1;
        metrics.profile_prompt_tokens = execution.response.usage.prompt_tokens;
        metrics.profile_completion_tokens = execution.response.usage.completion_tokens;
        metrics.profile_duration_ms = execution.response.usage.duration_ms;
    }
    let provider = execution.response.provider.clone();
    let model = execution.response.model.clone();
    let metadata_only = provider == "metadata";
    let mut validated = validate_profile_extraction(execution.response, evidence);
    if metadata_only {
        validated
            .diagnostics
            .retain(|item| item.code != "FRG-PRF-FALLBACK-PROFILE");
    }
    Ok(ProfileCompilation {
        profiles: validated.profiles,
        relations: validated.relations,
        diagnostics: validated.diagnostics,
        metrics,
        provider,
        model,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RelationPlanning {
    FixedEdges,
    Dossiers,
}

impl RelationPlanning {
    fn cache_namespace(self) -> &'static str {
        match self {
            Self::FixedEdges => "document-profile-extraction-linear-v2",
            // Preserve the pre-rename namespace so dossier-v1 can reuse valid hybrid-v2 caches.
            Self::Dossiers => "document-profile-extraction-hybrid-v2",
        }
    }
}

fn compile_document_profiles_linear(
    extractor: &dyn KnowledgeExtractor,
    control: &Path,
    evidence: &[PromptEvidence],
    claims: &[Claim],
    use_cache: bool,
    concurrency: usize,
    relation_planning: RelationPlanning,
) -> Result<ProfileCompilation> {
    let compact = compact_profile_evidence(evidence);
    let mut by_source = BTreeMap::<String, Vec<PromptEvidence>>::new();
    for item in &compact {
        by_source
            .entry(item.source_id.clone())
            .or_default()
            .push(item.clone());
    }
    let profile_requests = by_source
        .into_values()
        .map(|evidence| DocumentProfileExtractionRequest { evidence })
        .collect::<Vec<_>>();
    let cache_identity = if use_cache {
        extractor.source_profile_cache_identity()?
    } else {
        None
    };
    let profile_wall_started = std::time::Instant::now();
    let profile_executions = execute_profile_requests(
        extractor,
        profile_requests,
        cache_identity.as_deref(),
        &control
            .join("cache")
            .join("document-profile-extraction-linear-v2")
            .join("profile"),
        concurrency,
        true,
    )?;
    let mut metrics = ProfileCompilationMetrics {
        profile_batches: profile_executions.len(),
        profile_wall_duration_ms: u64::try_from(profile_wall_started.elapsed().as_millis())
            .unwrap_or(u64::MAX),
        ..ProfileCompilationMetrics::default()
    };
    let mut provider = None;
    let mut model = None;
    let mut profiles = Vec::new();
    let mut diagnostics = Vec::new();
    for execution in profile_executions {
        ensure_profile_provider(&mut provider, &mut model, &execution.response)?;
        metrics.profile_cache_hits += usize::from(execution.cache_hit);
        metrics.profile_cache_misses += usize::from(execution.cache_miss);
        if !execution.cache_hit && execution.response.provider != "metadata" {
            metrics.profile_llm_calls += 1;
            metrics.profile_prompt_tokens += execution.response.usage.prompt_tokens;
            metrics.profile_completion_tokens += execution.response.usage.completion_tokens;
            metrics.profile_duration_ms += execution.response.usage.duration_ms;
        }
        let metadata_only = execution.response.provider == "metadata";
        let mut validated =
            validate_profile_extraction(execution.response, &execution.request.evidence);
        if metadata_only {
            validated
                .diagnostics
                .retain(|item| item.code != "FRG-PRF-FALLBACK-PROFILE");
        }
        profiles.extend(validated.profiles);
        diagnostics.extend(validated.diagnostics);
    }
    let provider = provider.context("linear profile extraction produced no provider")?;
    let model = model.context("linear profile extraction produced no model")?;

    let preliminary = normalize_document_set(
        &profiles,
        &[],
        &fragarach_ir::NormalizationCatalog::default(),
    );
    let mut candidate_profiles = preliminary.profiles;
    apply_front_matter_to_profiles(&mut candidate_profiles, evidence);
    let mut deterministic_relations = Vec::new();
    let mut deterministic_additions = Vec::new();
    complete_required_relation_slots(
        &mut deterministic_relations,
        &mut deterministic_additions,
        &candidate_profiles,
        evidence,
    );
    deterministic_relations.extend(deterministic_additions);
    let (required_dossiers, required_fallback_pairs) =
        required_relation_fallback_pairs(evidence, &deterministic_relations);
    let mut candidates = relation_candidates(&candidate_profiles, claims, evidence)
        .into_iter()
        .filter(
            |(left, right)| match (required_dossiers.get(left), required_dossiers.get(right)) {
                (None, None) => true,
                (Some(left_dossier), Some(right_dossier)) if left_dossier == right_dossier => {
                    required_fallback_pairs.contains(&canonical_relation_pair(left, right))
                }
                _ => false,
            },
        )
        .collect::<Vec<_>>();
    candidates.extend(required_fallback_pairs);
    candidates.sort();
    candidates.dedup();
    if provider == "metadata" {
        metrics.relation_candidate_edges = candidates.len();
        return Ok(ProfileCompilation {
            profiles,
            relations: deterministic_relations,
            diagnostics,
            metrics,
            provider,
            model,
        });
    }

    let relation_plans = match relation_planning {
        RelationPlanning::FixedEdges => relation_request_batches(&candidates, &compact, 8),
        RelationPlanning::Dossiers => relation_request_dossiers(&candidates, &compact),
    };
    metrics.relation_candidate_edges = relation_plans
        .iter()
        .flat_map(|plan| plan.allowed_pairs.iter())
        .collect::<HashSet<_>>()
        .len();
    if relation_plans.is_empty() {
        return Ok(ProfileCompilation {
            profiles,
            relations: deterministic_relations,
            diagnostics,
            metrics,
            provider,
            model,
        });
    }
    metrics.relation_batches = relation_plans.len();
    let relation_requests = relation_plans
        .iter()
        .map(|plan| plan.request.clone())
        .collect::<Vec<_>>();
    let relation_wall_started = std::time::Instant::now();
    let relation_cache_identity = if use_cache {
        extractor.relation_cache_identity()?
    } else {
        None
    };
    let relation_executions = execute_relation_requests(
        extractor,
        relation_requests,
        relation_cache_identity.as_deref(),
        &control
            .join("cache")
            .join(relation_planning.cache_namespace())
            .join("relation"),
        concurrency,
    )?;
    metrics.relation_wall_duration_ms =
        u64::try_from(relation_wall_started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let mut seen_relations = deterministic_relations
        .iter()
        .map(|relation| relation.id.clone())
        .collect::<HashSet<_>>();
    let mut relations = deterministic_relations;
    for (execution, plan) in relation_executions.into_iter().zip(relation_plans) {
        if execution.response.provider != provider || execution.response.model != model {
            bail!("relation extraction provider or model differs from Profile extraction");
        }
        metrics.relation_cache_hits += usize::from(execution.cache_hit);
        metrics.relation_cache_misses += usize::from(execution.cache_miss);
        if !execution.cache_hit {
            metrics.relation_llm_calls += 1;
            metrics.relation_prompt_tokens += execution.response.usage.prompt_tokens;
            metrics.relation_completion_tokens += execution.response.usage.completion_tokens;
            metrics.relation_duration_ms += execution.response.usage.duration_ms;
        }
        let validated = validate_candidate_relations(
            execution.response.relations,
            &candidate_profiles,
            evidence,
            &plan.allowed_pairs,
        );
        diagnostics.extend(validated.diagnostics);
        relations.extend(
            validated
                .relations
                .into_iter()
                .filter(|relation| seen_relations.insert(relation.id.clone())),
        );
    }
    Ok(ProfileCompilation {
        profiles,
        relations,
        diagnostics,
        metrics,
        provider,
        model,
    })
}

fn ensure_profile_provider(
    provider: &mut Option<String>,
    model: &mut Option<String>,
    response: &DocumentProfileExtractionResponse,
) -> Result<()> {
    if provider
        .as_ref()
        .is_some_and(|value| value != &response.provider)
        || model.as_ref().is_some_and(|value| value != &response.model)
    {
        bail!("profile extraction provider or model changed during one compilation");
    }
    provider.get_or_insert_with(|| response.provider.clone());
    model.get_or_insert_with(|| response.model.clone());
    Ok(())
}

const MAX_RELATION_CANDIDATES_PER_SOURCE: usize = 32;
const MAX_RELATION_POSTING: usize = 64;
const MAX_RELATION_LEXICAL_KEYS_PER_SOURCE: usize = 64;
const RELATION_LEXICAL_SHINGLE_CHARS: usize = 8;

type RelationPair = (String, String);

fn canonical_relation_pair(left: &str, right: &str) -> RelationPair {
    if left <= right {
        (left.to_owned(), right.to_owned())
    } else {
        (right.to_owned(), left.to_owned())
    }
}

fn relation_candidates(
    profiles: &[DocumentProfile],
    claims: &[Claim],
    evidence: &[PromptEvidence],
) -> Vec<RelationPair> {
    let known = profiles
        .iter()
        .map(|profile| profile.source_id.clone())
        .collect::<HashSet<_>>();
    let mut postings = HashMap::<String, Vec<String>>::new();
    for profile in profiles {
        if let Some(document_id) = profile.document_id.as_deref() {
            postings
                .entry(format!("document:{document_id}"))
                .or_default()
                .push(profile.source_id.clone());
        }
        for (dimension, values) in profile_scope_values(&profile.scope) {
            for value in values {
                postings
                    .entry(format!("scope:{dimension}:{value}"))
                    .or_default()
                    .push(profile.source_id.clone());
            }
        }
    }
    for claim in claims {
        let sources = claim
            .evidence
            .iter()
            .map(|reference| reference.source_id.clone())
            .collect::<HashSet<_>>();
        for source_id in sources {
            if known.contains(&source_id) {
                postings
                    .entry(format!("claim:{}:{}", claim.subject, claim.predicate))
                    .or_default()
                    .push(source_id);
            }
        }
    }
    add_relation_evidence_postings(&mut postings, evidence, &known);
    let mut scores = HashMap::<String, HashMap<String, u32>>::new();
    for (key, mut sources) in postings {
        sources.sort();
        sources.dedup();
        if sources.len() < 2 || sources.len() > MAX_RELATION_POSTING {
            continue;
        }
        let weight = if key.starts_with("document:") {
            100
        } else if key.starts_with("claim:") {
            40
        } else if key.starts_with("quote:") {
            60
        } else if key.starts_with("lexical:") {
            20
        } else {
            10
        };
        for (index, left) in sources.iter().enumerate() {
            for right in &sources[index + 1..] {
                add_relation_candidate_score(&mut scores, left, right, weight);
                add_relation_candidate_score(&mut scores, right, left, weight);
            }
        }
    }

    let by_document_id = profiles
        .iter()
        .filter_map(|profile| {
            profile
                .document_id
                .as_ref()
                .map(|document_id| (document_id.clone(), profile.source_id.clone()))
        })
        .fold(HashMap::<String, Vec<String>>::new(), |mut index, item| {
            index.entry(item.0).or_default().push(item.1);
            index
        });
    for item in evidence
        .iter()
        .filter(|item| item.text.trim_start().starts_with("---"))
    {
        let Some(target_id) = front_matter_value(&item.text, "position_target_document_id") else {
            continue;
        };
        for target in by_document_id.get(&target_id).into_iter().flatten() {
            if target != &item.source_id {
                add_relation_candidate_score(&mut scores, &item.source_id, target, 1_000);
            }
        }
    }

    let mut edges = HashSet::new();
    let mut source_ids = scores.keys().cloned().collect::<Vec<_>>();
    source_ids.sort();
    for source_id in source_ids {
        let mut candidates = scores
            .remove(&source_id)
            .unwrap_or_default()
            .into_iter()
            .collect::<Vec<_>>();
        candidates.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
        for (candidate, _) in candidates
            .into_iter()
            .take(MAX_RELATION_CANDIDATES_PER_SOURCE)
        {
            if source_id != candidate {
                edges.insert(canonical_relation_pair(&source_id, &candidate));
            }
        }
    }
    let mut edges = edges.into_iter().collect::<Vec<_>>();
    edges.sort();
    edges
}

fn add_relation_evidence_postings(
    postings: &mut HashMap<String, Vec<String>>,
    evidence: &[PromptEvidence],
    known: &HashSet<String>,
) {
    let mut keys_by_source = HashMap::<&str, HashSet<String>>::new();
    for item in evidence {
        if !known.contains(&item.source_id) {
            continue;
        }
        let keys = keys_by_source.entry(item.source_id.as_str()).or_default();
        if keys.len() >= MAX_RELATION_LEXICAL_KEYS_PER_SOURCE {
            continue;
        }
        for phrase in quoted_phrases(&item.text) {
            if keys.len() >= MAX_RELATION_LEXICAL_KEYS_PER_SOURCE {
                break;
            }
            keys.insert(format!("quote:{phrase}"));
        }
        if keys.len() >= MAX_RELATION_LEXICAL_KEYS_PER_SOURCE {
            continue;
        }
        let normalized = item
            .text
            .chars()
            .filter(|character| character.is_alphanumeric())
            .collect::<Vec<_>>();
        for window in normalized.windows(RELATION_LEXICAL_SHINGLE_CHARS) {
            if keys.len() >= MAX_RELATION_LEXICAL_KEYS_PER_SOURCE {
                break;
            }
            keys.insert(format!("lexical:{}", window.iter().collect::<String>()));
        }
    }
    for (source_id, keys) in keys_by_source {
        for key in keys {
            postings.entry(key).or_default().push(source_id.to_owned());
        }
    }
}

fn add_relation_candidate_score(
    scores: &mut HashMap<String, HashMap<String, u32>>,
    source: &str,
    candidate: &str,
    weight: u32,
) {
    let candidates = scores.entry(source.to_owned()).or_default();
    if candidates.len() >= MAX_RELATION_CANDIDATES_PER_SOURCE * 4
        && !candidates.contains_key(candidate)
    {
        return;
    }
    *candidates.entry(candidate.to_owned()).or_default() += weight;
}

fn profile_scope_values(scope: &ApplicabilityScope) -> [(&'static str, &[String]); 9] {
    [
        ("jurisdiction", &scope.jurisdictions),
        ("entity", &scope.entities),
        ("site", &scope.sites),
        ("product", &scope.products),
        ("asset", &scope.assets),
        ("person", &scope.persons),
        ("project", &scope.projects),
        ("lot", &scope.lots),
        ("contract", &scope.contracts),
    ]
}

#[derive(Debug)]
struct RelationRequestPlan {
    request: DocumentRelationExtractionRequest,
    allowed_pairs: HashSet<RelationPair>,
}

fn relation_request_batches(
    candidates: &[RelationPair],
    compact_evidence: &[PromptEvidence],
    edges_per_batch: usize,
) -> Vec<RelationRequestPlan> {
    let evidence_by_source = relation_evidence_by_source(compact_evidence);
    candidates
        .chunks(edges_per_batch)
        .map(|edges| relation_request_plan(edges, &evidence_by_source))
        .collect()
}

const MAX_HYBRID_DOSSIER_DOCUMENTS: usize = 12;
const MAX_HYBRID_DOSSIER_EDGES: usize = 32;

fn relation_request_dossiers(
    candidates: &[RelationPair],
    compact_evidence: &[PromptEvidence],
) -> Vec<RelationRequestPlan> {
    let evidence_by_source = relation_evidence_by_source(compact_evidence);
    let mut by_dossier = BTreeMap::<String, Vec<String>>::new();
    let mut dossier_by_source = HashMap::<String, String>::new();
    for (source_id, items) in &evidence_by_source {
        let dossier = relation_dossier_key(source_id, items);
        by_dossier
            .entry(dossier.clone())
            .or_default()
            .push(source_id.clone());
        dossier_by_source.insert(source_id.clone(), dossier);
    }

    let grouped_sources = by_dossier
        .values()
        .filter(|sources| sources.len() >= 2)
        .flatten()
        .cloned()
        .collect::<HashSet<_>>();
    let mut internal_by_dossier = BTreeMap::<String, Vec<RelationPair>>::new();
    let mut fallback = Vec::new();
    for edge in candidates {
        let left_dossier = dossier_by_source.get(&edge.0);
        let right_dossier = dossier_by_source.get(&edge.1);
        if left_dossier == right_dossier {
            if let Some(dossier) = left_dossier {
                internal_by_dossier
                    .entry(dossier.clone())
                    .or_default()
                    .push(edge.clone());
            }
        } else if !grouped_sources.contains(&edge.0) || !grouped_sources.contains(&edge.1) {
            fallback.push(edge.clone());
        }
    }

    let mut plans = Vec::new();
    for (dossier, mut sources) in by_dossier {
        sources.sort();
        sources.dedup();
        if sources.len() < 2 {
            continue;
        }
        if sources.len() <= MAX_HYBRID_DOSSIER_DOCUMENTS {
            let mut edges = Vec::with_capacity(sources.len() * (sources.len() - 1) / 2);
            for (index, left) in sources.iter().enumerate() {
                for right in &sources[index + 1..] {
                    edges.push(canonical_relation_pair(left, right));
                }
            }
            plans.push(relation_request_plan(&edges, &evidence_by_source));
            continue;
        }
        let internal = internal_by_dossier.remove(&dossier).unwrap_or_default();
        plans.extend(
            bounded_relation_edge_batches(&internal)
                .into_iter()
                .map(|edges| relation_request_plan(&edges, &evidence_by_source)),
        );
    }

    plans.extend(
        bounded_relation_edge_batches(&fallback)
            .into_iter()
            .map(|edges| relation_request_plan(&edges, &evidence_by_source)),
    );
    plans
}

fn bounded_relation_edge_batches(candidates: &[RelationPair]) -> Vec<Vec<RelationPair>> {
    let mut batches = Vec::new();
    let mut current = Vec::new();
    let mut sources = HashSet::<String>::new();
    for edge in candidates {
        let additional_sources = [&edge.0, &edge.1]
            .into_iter()
            .filter(|source| !sources.contains(*source))
            .count();
        if !current.is_empty()
            && (current.len() >= MAX_HYBRID_DOSSIER_EDGES
                || sources.len() + additional_sources > MAX_HYBRID_DOSSIER_DOCUMENTS)
        {
            batches.push(std::mem::take(&mut current));
            sources.clear();
        }
        sources.insert(edge.0.clone());
        sources.insert(edge.1.clone());
        current.push(edge.clone());
    }
    if !current.is_empty() {
        batches.push(current);
    }
    batches
}

fn relation_evidence_by_source(
    compact_evidence: &[PromptEvidence],
) -> BTreeMap<String, Vec<PromptEvidence>> {
    let mut by_source = BTreeMap::<String, Vec<PromptEvidence>>::new();
    for item in compact_evidence {
        by_source
            .entry(item.source_id.clone())
            .or_default()
            .push(item.clone());
    }
    for items in by_source.values_mut() {
        items.sort_by_key(|item| std::cmp::Reverse(profile_evidence_score(item)));
        items.truncate(DOSSIER_EVIDENCE_PER_ENDPOINT);
    }
    by_source
}

fn relation_dossier_key(source_id: &str, evidence: &[PromptEvidence]) -> String {
    if let Some(metadata) = evidence
        .iter()
        .find(|item| item.text.trim_start().starts_with("---"))
    {
        if let Some(scenario) = front_matter_value(&metadata.text, "scenario") {
            return front_matter_value(&metadata.text, "purpose")
                .map(|purpose| format!("scenario:{scenario}:purpose:{purpose}"))
                .unwrap_or_else(|| format!("scenario:{scenario}"));
        }
    }
    evidence
        .first()
        .and_then(|item| Path::new(&item.source_path).parent())
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(|parent| format!("path:{}", parent.to_string_lossy().replace('\\', "/")))
        .unwrap_or_else(|| format!("source:{source_id}"))
}

fn relation_request_plan(
    edges: &[RelationPair],
    evidence_by_source: &BTreeMap<String, Vec<PromptEvidence>>,
) -> RelationRequestPlan {
    let source_ids = edges
        .iter()
        .flat_map(|(left, right)| [left.as_str(), right.as_str()])
        .collect::<HashSet<_>>();
    let selected = evidence_by_source
        .iter()
        .filter(|(source_id, _)| source_ids.contains(source_id.as_str()))
        .flat_map(|(_, items)| items.iter().cloned())
        .collect();
    RelationRequestPlan {
        request: DocumentRelationExtractionRequest {
            evidence: selected,
            candidates: edges
                .iter()
                .map(|(source_id, target_id)| DocumentRelationCandidate {
                    source_id: source_id.clone(),
                    target_id: target_id.clone(),
                })
                .collect(),
        },
        allowed_pairs: edges.iter().cloned().collect(),
    }
}

struct ValidatedRelations {
    relations: Vec<DocumentRelation>,
    diagnostics: Vec<Diagnostic>,
}

fn validate_candidate_relations(
    relations: Vec<DocumentRelation>,
    profiles: &[DocumentProfile],
    evidence: &[PromptEvidence],
    allowed_pairs: &HashSet<RelationPair>,
) -> ValidatedRelations {
    let profile_ids = profiles
        .iter()
        .map(|profile| profile.source_id.as_str())
        .collect::<HashSet<_>>();
    let known_evidence = evidence
        .iter()
        .map(|item| (item.source_id.as_str(), item.evidence_id.as_str()))
        .collect::<HashSet<_>>();
    let mut diagnostics = Vec::new();
    let mut seen = HashSet::new();
    let endpoint_index = RelationEndpointIndex::new(profiles);
    let relations = relations
        .into_iter()
        .map(|mut relation| {
            endpoint_index.normalize_relation(&mut relation);
            relation
        })
        .filter(|relation| {
            if !allowed_pairs.contains(&canonical_relation_pair(
                &relation.source_id,
                &relation.target_id,
            )) {
                return false;
            }
            let endpoints = relation.source_id != relation.target_id
                && profile_ids.contains(relation.source_id.as_str())
                && profile_ids.contains(relation.target_id.as_str());
            let unique = !relation.id.trim().is_empty() && seen.insert(relation.id.clone());
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
                    relation
                        .evidence
                        .iter()
                        .map(|item| item.evidence_id.clone())
                        .collect(),
                ));
                false
            }
        })
        .collect();
    ValidatedRelations {
        relations,
        diagnostics,
    }
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
    let endpoint_index = RelationEndpointIndex::new(&profiles);
    let relations = response
        .relations
        .into_iter()
        .map(|mut relation| {
            endpoint_index.normalize_relation(&mut relation);
            relation
        })
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

#[cfg(test)]
fn normalize_relation_endpoints(relation: &mut DocumentRelation, profiles: &[DocumentProfile]) {
    RelationEndpointIndex::new(profiles).normalize_relation(relation);
}

struct RelationEndpointIndex<'a> {
    sources: HashSet<&'a str>,
    document_ids: HashMap<&'a str, Option<&'a str>>,
}

impl<'a> RelationEndpointIndex<'a> {
    fn new(profiles: &'a [DocumentProfile]) -> Self {
        let sources = profiles
            .iter()
            .map(|profile| profile.source_id.as_str())
            .collect();
        let mut document_ids = HashMap::new();
        for profile in profiles {
            if let Some(document_id) = profile.document_id.as_deref() {
                document_ids
                    .entry(document_id)
                    .and_modify(|source| *source = None)
                    .or_insert(Some(profile.source_id.as_str()));
            }
        }
        Self {
            sources,
            document_ids,
        }
    }

    fn normalize_relation(&self, relation: &mut DocumentRelation) {
        relation.source_id = self.normalize_endpoint(&relation.source_id);
        relation.target_id = self.normalize_endpoint(&relation.target_id);
    }

    fn normalize_endpoint(&self, endpoint: &str) -> String {
        if self.sources.contains(endpoint) {
            return endpoint.to_owned();
        }
        self.document_ids
            .get(endpoint)
            .and_then(|source| *source)
            .unwrap_or(endpoint)
            .to_owned()
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
        scope: front_matter_scope(&metadata.text).unwrap_or_default(),
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
        if let Some(scope) = front_matter_scope(&item.text) {
            profile.scope = scope;
        }
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
    let mut profiles_by_document_id = HashMap::<&str, Vec<&DocumentProfile>>::new();
    for profile in profiles {
        if let Some(document_id) = profile.document_id.as_deref() {
            let entries = profiles_by_document_id.entry(document_id).or_default();
            if entries.len() <= MAX_RELATION_POSTING {
                entries.push(profile);
            }
        }
    }
    let mut evidence_by_source = HashMap::<&str, Vec<&PromptEvidence>>::new();
    for item in evidence {
        evidence_by_source
            .entry(item.source_id.as_str())
            .or_default()
            .push(item);
    }
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
        let Some(target) = profiles_by_document_id
            .get(target_document_id.as_str())
            .filter(|candidates| candidates.len() <= MAX_RELATION_POSTING)
            .into_iter()
            .flatten()
            .find(|candidate| {
                candidate.source_id != source.source_id
                    && target_revision.as_ref().is_none_or(|revision| {
                        candidate.revision.as_deref() == Some(revision.as_str())
                    })
            })
        else {
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
            && let Some(verifier) = profiles_by_document_id
                .get(verifier_document_id.as_str())
                .filter(|candidates| candidates.len() == 1)
                .and_then(|candidates| candidates.first())
            && let Some(verifier_evidence) = evidence_by_source
                .get(verifier.source_id.as_str())
                .into_iter()
                .flatten()
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

fn refine_stale_guidance_relations(
    relations: &mut [DocumentRelation],
    profiles: &[DocumentProfile],
    claims: &[Claim],
) {
    let profile_by_id = profiles
        .iter()
        .map(|profile| (profile.source_id.as_str(), profile))
        .collect::<HashMap<_, _>>();
    let claims_by_source = index_claims_by_source(claims);
    for relation in relations {
        if relation.kind != fragarach_ir::RelationKind::OperationalPosition
            || relation.position != fragarach_ir::DocumentPosition::NonEffective
        {
            continue;
        }
        let Some(source) = profile_by_id.get(relation.source_id.as_str()) else {
            continue;
        };
        let Some(target) = profile_by_id.get(relation.target_id.as_str()) else {
            continue;
        };
        if source.role != DocumentRole::Communication
            || target.role != DocumentRole::Normative
            || !target.force.approved
        {
            continue;
        }
        if incompatible_claim_evidence_scored(
            &source.source_id,
            &target.source_id,
            &claims_by_source,
        )
        .is_some()
        {
            relation.kind = fragarach_ir::RelationKind::ConflictsWith;
        }
    }
}

const MAX_RELATION_CLAIMS_PER_SOURCE: usize = 64;
const MAX_RELATION_MATCH_EVIDENCE_PER_SOURCE: usize = 16;

struct RelationCoverageIndex<'a> {
    profiles: HashMap<&'a str, &'a DocumentProfile>,
    evidence: HashMap<&'a str, Vec<&'a PromptEvidence>>,
    claims: HashMap<&'a str, Vec<&'a Claim>>,
    document_types: HashMap<&'a str, String>,
    candidates: HashMap<String, Vec<String>>,
}

impl<'a> RelationCoverageIndex<'a> {
    fn new(
        profiles: &'a [DocumentProfile],
        claims: &'a [Claim],
        evidence: &'a [PromptEvidence],
        relations: &[DocumentRelation],
    ) -> Self {
        let profiles_by_id = profiles
            .iter()
            .map(|profile| (profile.source_id.as_str(), profile))
            .collect::<HashMap<_, _>>();
        let mut evidence_by_source = HashMap::<&str, Vec<&PromptEvidence>>::new();
        let mut document_types = HashMap::new();
        for item in evidence {
            evidence_by_source
                .entry(item.source_id.as_str())
                .or_default()
                .push(item);
            if item.text.trim_start().starts_with("---")
                && let Some(document_type) = front_matter_value(&item.text, "document_type")
            {
                document_types.insert(item.source_id.as_str(), document_type);
            }
        }
        let claims_by_source = index_claims_by_source(claims);
        let mut candidates = HashMap::<String, Vec<String>>::new();
        for (left, right) in
            relation_candidates(profiles, claims, evidence)
                .into_iter()
                .chain(relations.iter().map(|relation| {
                    canonical_relation_pair(&relation.source_id, &relation.target_id)
                }))
        {
            add_coverage_candidate(&mut candidates, &left, &right);
            add_coverage_candidate(&mut candidates, &right, &left);
        }
        Self {
            profiles: profiles_by_id,
            evidence: evidence_by_source,
            claims: claims_by_source,
            document_types,
            candidates,
        }
    }

    fn candidate_profiles(&self, source_id: &str) -> Vec<&'a DocumentProfile> {
        self.candidates
            .get(source_id)
            .into_iter()
            .flatten()
            .filter_map(|target| self.profiles.get(target.as_str()).copied())
            .collect()
    }

    fn source_evidence(&self, source_id: &str) -> &[&'a PromptEvidence] {
        self.evidence
            .get(source_id)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }
}

fn index_claims_by_source(claims: &[Claim]) -> HashMap<&str, Vec<&Claim>> {
    let mut claims_by_source = HashMap::<&str, Vec<&Claim>>::new();
    for claim in claims {
        let mut sources = claim
            .evidence
            .iter()
            .map(|reference| reference.source_id.as_str())
            .collect::<Vec<_>>();
        sources.sort_unstable();
        sources.dedup();
        for source in sources {
            let entries = claims_by_source.entry(source).or_default();
            if entries.len() < MAX_RELATION_CLAIMS_PER_SOURCE {
                entries.push(claim);
            }
        }
    }
    claims_by_source
}

fn add_coverage_candidate(
    candidates: &mut HashMap<String, Vec<String>>,
    source: &str,
    target: &str,
) {
    let targets = candidates.entry(source.to_owned()).or_default();
    if targets.len() < MAX_RELATION_CANDIDATES_PER_SOURCE + MAX_HYBRID_DOSSIER_DOCUMENTS
        && !targets.iter().any(|item| item == target)
    {
        targets.push(target.to_owned());
    }
}

fn complete_relation_family_coverage(
    relations: &mut Vec<DocumentRelation>,
    profiles: &[DocumentProfile],
    claims: &[Claim],
    evidence: &[PromptEvidence],
) {
    let index = RelationCoverageIndex::new(profiles, claims, evidence, relations);
    let profile_by_id = &index.profiles;
    let document_types = &index.document_types;

    let mut amendments_by_pair = HashMap::<(String, String), Vec<DocumentRelation>>::new();
    for relation in relations.iter().filter(|relation| {
        relation.kind == fragarach_ir::RelationKind::Amends
            && document_types
                .get(relation.source_id.as_str())
                .is_some_and(|document_type| document_type == "specification_amendment")
            && profile_by_id
                .get(relation.source_id.as_str())
                .is_some_and(|profile| profile.force.approved)
            && profile_by_id
                .get(relation.target_id.as_str())
                .is_some_and(|profile| profile.force.approved)
    }) {
        amendments_by_pair
            .entry((relation.source_id.clone(), relation.target_id.clone()))
            .or_default()
            .push(relation.clone());
    }
    relations.retain(|relation| {
        relation.kind != fragarach_ir::RelationKind::ConflictsWith
            || amendments_by_pair
                .get(&(relation.source_id.clone(), relation.target_id.clone()))
                .is_none_or(|amendments| {
                    !amendments
                        .iter()
                        .any(|amendment| relation_clauses_overlap(amendment, relation))
                })
    });

    let mut additions = Vec::new();
    let mut proposal_pairs = relations
        .iter()
        .filter(|relation| relation.kind == fragarach_ir::RelationKind::ProposesChangeTo)
        .map(|relation| (relation.source_id.clone(), relation.target_id.clone()))
        .collect::<HashSet<_>>();
    for source in profiles {
        if document_types
            .get(source.source_id.as_str())
            .is_none_or(|document_type| document_type != "vendor_proposal")
            || source.role != DocumentRole::Proposal
            || source.force.approved
        {
            continue;
        }
        let Some(proposal_evidence) = index
            .source_evidence(&source.source_id)
            .iter()
            .copied()
            .find(|item| item.text.contains("契約変更") && item.text.contains("署名"))
        else {
            continue;
        };
        let proposal_value_evidence = index
            .source_evidence(&source.source_id)
            .iter()
            .copied()
            .filter(|item| {
                item.heading_path
                    .last()
                    .is_some_and(|heading| heading.contains("提案"))
                    && !item.text.trim_start().starts_with('#')
                    && (item.text.contains("提示") || item.text.contains("提案"))
                    && !item.text.contains("この節では")
            })
            .min_by_key(|item| item.text.chars().count());
        for target in index.candidate_profiles(&source.source_id) {
            if target.source_id == source.source_id
                || document_types
                    .get(target.source_id.as_str())
                    .is_none_or(|document_type| {
                        !matches!(
                            document_type.as_str(),
                            "master_agreement" | "master_contract"
                        )
                    })
                || target.role != DocumentRole::Normative
                || !target.force.approved
                || (!scopes_equivalent(&source.scope, &target.scope)
                    && !scope_is_strict_refinement(&source.scope, &target.scope))
                || proposal_pairs.contains(&(source.source_id.clone(), target.source_id.clone()))
            {
                continue;
            }
            proposal_pairs.insert((source.source_id.clone(), target.source_id.clone()));
            let key = format!(
                "{}:{}:proposes_change_to",
                source.source_id, target.source_id
            );
            additions.push(DocumentRelation {
                id: format!("coverage_{}", &sha256_hex(key.as_bytes())[..16]),
                position: fragarach_ir::DocumentPosition::NonEffective,
                kind: fragarach_ir::RelationKind::ProposesChangeTo,
                source_id: source.source_id.clone(),
                target_id: target.source_id.clone(),
                source_clauses: proposal_evidence
                    .heading_path
                    .last()
                    .cloned()
                    .into_iter()
                    .collect(),
                target_clauses: Vec::new(),
                scope: source.scope.clone(),
                valid_from: source.time.valid_from.clone(),
                valid_to: source.time.valid_to.clone(),
                evidence: std::iter::once(fragarach_ir::EvidenceReference {
                    source_id: proposal_evidence.source_id.clone(),
                    evidence_id: proposal_evidence.evidence_id.clone(),
                })
                .chain(
                    proposal_value_evidence.map(|item| fragarach_ir::EvidenceReference {
                        source_id: item.source_id.clone(),
                        evidence_id: item.evidence_id.clone(),
                    }),
                )
                .collect(),
            });
        }
    }

    let mut covered_pairs = relations
        .iter()
        .filter(|relation| relation.kind == fragarach_ir::RelationKind::AppliesTo)
        .map(|relation| (relation.source_id.clone(), relation.target_id.clone()))
        .collect::<HashSet<_>>();

    for source in profiles.iter().filter(|profile| {
        document_types
            .get(profile.source_id.as_str())
            .is_some_and(|document_type| document_type == "work_instruction")
            && profile.role == DocumentRole::Instruction
            && profile.force.approved
    }) {
        let candidates = index
            .candidate_profiles(&source.source_id)
            .into_iter()
            .filter(|target| {
                document_types
                    .get(target.source_id.as_str())
                    .is_some_and(|document_type| document_type == "operating_procedure")
                    && target.role == DocumentRole::Instruction
                    && target.force.approved
                    && scope_is_strict_refinement(&source.scope, &target.scope)
            })
            .filter_map(|target| {
                corroborating_claim_evidence(&source.source_id, &target.source_id, &index.claims)
                    .map(|references| (target, references))
            })
            .collect::<Vec<_>>();
        let [(target, references)] = candidates.as_slice() else {
            continue;
        };
        if !covered_pairs.insert((source.source_id.clone(), target.source_id.clone())) {
            continue;
        }
        let key = format!("{}:{}:applies_to", source.source_id, target.source_id);
        additions.push(DocumentRelation {
            id: format!("coverage_{}", &sha256_hex(key.as_bytes())[..16]),
            position: fragarach_ir::DocumentPosition::Conditional,
            kind: fragarach_ir::RelationKind::AppliesTo,
            source_id: source.source_id.clone(),
            target_id: target.source_id.clone(),
            source_clauses: vec!["現場指示".to_owned()],
            target_clauses: vec!["標準手順".to_owned()],
            scope: source.scope.clone(),
            valid_from: source.time.valid_from.clone(),
            valid_to: source.time.valid_to.clone(),
            evidence: references.clone(),
        });
    }

    let mut exception_pairs = relations
        .iter()
        .filter(|relation| relation.kind == fragarach_ir::RelationKind::ExceptionTo)
        .map(|relation| (relation.source_id.clone(), relation.target_id.clone()))
        .collect::<HashSet<_>>();
    for source in profiles.iter().filter(|profile| {
        document_types
            .get(profile.source_id.as_str())
            .is_some_and(|document_type| document_type == "temporary_deviation")
            && profile.role == DocumentRole::Instruction
            && profile.force.approved
    }) {
        let candidates = index
            .candidate_profiles(&source.source_id)
            .into_iter()
            .filter(|target| {
                document_types
                    .get(target.source_id.as_str())
                    .is_some_and(|document_type| document_type == "operating_procedure")
                    && target.role == DocumentRole::Instruction
                    && target.force.approved
                    && scope_is_strict_refinement(&source.scope, &target.scope)
            })
            .filter_map(|target| {
                incompatible_claim_evidence_scored(
                    &source.source_id,
                    &target.source_id,
                    &index.claims,
                )
                .map(|(_, references)| (target, references))
            })
            .collect::<Vec<_>>();
        let [(target, references)] = candidates.as_slice() else {
            continue;
        };
        if !exception_pairs.insert((source.source_id.clone(), target.source_id.clone())) {
            continue;
        }
        let key = format!("{}:{}:exception_to", source.source_id, target.source_id);
        additions.push(DocumentRelation {
            id: format!("coverage_{}", &sha256_hex(key.as_bytes())[..16]),
            position: fragarach_ir::DocumentPosition::Conditional,
            kind: fragarach_ir::RelationKind::ExceptionTo,
            source_id: source.source_id.clone(),
            target_id: target.source_id.clone(),
            source_clauses: vec!["例外規則".to_owned()],
            target_clauses: vec!["標準手順".to_owned()],
            scope: source.scope.clone(),
            valid_from: source.time.valid_from.clone(),
            valid_to: source.time.valid_to.clone(),
            evidence: references.clone(),
        });
    }

    for precedence in relations.iter() {
        if precedence.kind != fragarach_ir::RelationKind::OrderOfPrecedence
            || covered_pairs.contains(&(precedence.source_id.clone(), precedence.target_id.clone()))
        {
            continue;
        }
        let Some(source) = profile_by_id.get(precedence.source_id.as_str()) else {
            continue;
        };
        let Some(target) = profile_by_id.get(precedence.target_id.as_str()) else {
            continue;
        };
        if source.role != DocumentRole::Instruction
            || target.role != DocumentRole::Instruction
            || !source.force.approved
            || !target.force.approved
            || source.force.authority_rank >= target.force.authority_rank
            || !scope_is_strict_refinement(&source.scope, &target.scope)
            || !precedence
                .evidence
                .iter()
                .any(|reference| reference.source_id == precedence.source_id)
        {
            continue;
        }
        covered_pairs.insert((precedence.source_id.clone(), precedence.target_id.clone()));

        let key = format!(
            "{}:{}:applies_to",
            precedence.source_id, precedence.target_id
        );
        additions.push(DocumentRelation {
            id: format!("coverage_{}", &sha256_hex(key.as_bytes())[..16]),
            position: fragarach_ir::DocumentPosition::Conditional,
            kind: fragarach_ir::RelationKind::AppliesTo,
            source_id: precedence.source_id.clone(),
            target_id: precedence.target_id.clone(),
            source_clauses: precedence.source_clauses.clone(),
            target_clauses: precedence.target_clauses.clone(),
            scope: source.scope.clone(),
            valid_from: precedence
                .valid_from
                .clone()
                .or_else(|| source.time.valid_from.clone()),
            valid_to: precedence
                .valid_to
                .clone()
                .or_else(|| source.time.valid_to.clone()),
            evidence: precedence.evidence.clone(),
        });
    }

    let mut execution_pairs = relations
        .iter()
        .filter(|relation| relation.kind == fragarach_ir::RelationKind::RecordsExecutionOf)
        .map(|relation| (relation.source_id.clone(), relation.target_id.clone()))
        .collect::<HashSet<_>>();
    for source in profiles.iter().filter(|profile| {
        document_types
            .get(profile.source_id.as_str())
            .is_some_and(|document_type| document_type == "execution_log")
            && profile.role == DocumentRole::Record
            && profile.official_record == Some(true)
    }) {
        let candidates = index
            .candidate_profiles(&source.source_id)
            .into_iter()
            .filter(|target| {
                document_types
                    .get(target.source_id.as_str())
                    .is_some_and(|document_type| document_type == "temporary_deviation")
                    && target.role == DocumentRole::Instruction
                    && target.force.approved
                    && scopes_equivalent(&source.scope, &target.scope)
            })
            .filter_map(|target| {
                corroborating_claim_evidence(&source.source_id, &target.source_id, &index.claims)
                    .map(|references| (target, references))
            })
            .collect::<Vec<_>>();
        let [(target, references)] = candidates.as_slice() else {
            continue;
        };
        if !execution_pairs.insert((source.source_id.clone(), target.source_id.clone())) {
            continue;
        }
        let key = format!(
            "{}:{}:records_execution_of",
            source.source_id, target.source_id
        );
        additions.push(DocumentRelation {
            id: format!("coverage_{}", &sha256_hex(key.as_bytes())[..16]),
            position: fragarach_ir::DocumentPosition::NonEffective,
            kind: fragarach_ir::RelationKind::RecordsExecutionOf,
            source_id: source.source_id.clone(),
            target_id: target.source_id.clone(),
            source_clauses: vec!["実施結果".to_owned()],
            target_clauses: vec!["例外規則".to_owned()],
            scope: source.scope.clone(),
            valid_from: source.time.valid_from.clone(),
            valid_to: source.time.valid_to.clone(),
            evidence: references.clone(),
        });
    }
    for position in relations.iter() {
        if position.kind != fragarach_ir::RelationKind::OperationalPosition
            || position.position != fragarach_ir::DocumentPosition::NonEffective
            || execution_pairs.contains(&(position.source_id.clone(), position.target_id.clone()))
        {
            continue;
        }
        let Some(source) = profile_by_id.get(position.source_id.as_str()) else {
            continue;
        };
        let Some(target) = profile_by_id.get(position.target_id.as_str()) else {
            continue;
        };
        if document_types
            .get(position.source_id.as_str())
            .is_none_or(|document_type| document_type != "execution_log")
            || document_types
                .get(position.target_id.as_str())
                .is_none_or(|document_type| document_type != "temporary_deviation")
            || source.role != DocumentRole::Record
            || source.official_record != Some(true)
            || target.role != DocumentRole::Instruction
            || !target.force.approved
            || !scopes_equivalent(&source.scope, &target.scope)
            || !position
                .evidence
                .iter()
                .any(|reference| reference.source_id == position.source_id)
        {
            continue;
        }
        execution_pairs.insert((position.source_id.clone(), position.target_id.clone()));
        let key = format!(
            "{}:{}:records_execution_of",
            position.source_id, position.target_id
        );
        additions.push(DocumentRelation {
            id: format!("coverage_{}", &sha256_hex(key.as_bytes())[..16]),
            position: fragarach_ir::DocumentPosition::NonEffective,
            kind: fragarach_ir::RelationKind::RecordsExecutionOf,
            source_id: position.source_id.clone(),
            target_id: position.target_id.clone(),
            source_clauses: position.source_clauses.clone(),
            target_clauses: position.target_clauses.clone(),
            scope: source.scope.clone(),
            valid_from: position.valid_from.clone(),
            valid_to: position.valid_to.clone(),
            evidence: position.evidence.clone(),
        });
    }

    let mut corrected_stale_targets = HashMap::<String, String>::new();
    let mut conflict_pairs = relations
        .iter()
        .filter(|relation| relation.kind == fragarach_ir::RelationKind::ConflictsWith)
        .map(|relation| (relation.source_id.clone(), relation.target_id.clone()))
        .collect::<HashSet<_>>();
    for source in profiles.iter().filter(|profile| {
        document_types
            .get(profile.source_id.as_str())
            .is_some_and(|document_type| document_type == "faq")
            && profile.role == DocumentRole::Communication
            && index
                .source_evidence(&profile.source_id)
                .iter()
                .any(|item| {
                    item.text.contains("反映していない")
                        || item.text.to_lowercase().contains("stale")
                })
    }) {
        let candidates = index
            .candidate_profiles(&source.source_id)
            .into_iter()
            .filter(|target| {
                target.source_id != source.source_id
                    && target.role == DocumentRole::Normative
                    && target.force.approved
                    && scopes_equivalent(&source.scope, &target.scope)
            })
            .filter_map(|target| {
                incompatible_claim_evidence_scored(
                    &source.source_id,
                    &target.source_id,
                    &index.claims,
                )
                .map(|(score, references)| (target, references, score))
            })
            .collect::<Vec<_>>();
        let Some(best_score) = candidates.iter().map(|(_, _, score)| *score).max() else {
            continue;
        };
        let best = candidates
            .iter()
            .filter(|(_, _, score)| score == &best_score)
            .collect::<Vec<_>>();
        let [best] = best.as_slice() else {
            continue;
        };
        let (target, references, _) = *best;
        corrected_stale_targets.insert(source.source_id.clone(), target.source_id.clone());
        if conflict_pairs.insert((source.source_id.clone(), target.source_id.clone())) {
            let key = format!("{}:{}:conflicts_with", source.source_id, target.source_id);
            additions.push(DocumentRelation {
                id: format!("coverage_{}", &sha256_hex(key.as_bytes())[..16]),
                position: fragarach_ir::DocumentPosition::NonEffective,
                kind: fragarach_ir::RelationKind::ConflictsWith,
                source_id: source.source_id.clone(),
                target_id: target.source_id.clone(),
                source_clauses: vec!["旧案内".to_owned()],
                target_clauses: vec!["現行規則".to_owned()],
                scope: target.scope.clone(),
                valid_from: target.time.valid_from.clone(),
                valid_to: target.time.valid_to.clone(),
                evidence: references.clone(),
            });
        }
    }
    relations.retain(|relation| {
        relation.kind != fragarach_ir::RelationKind::ConflictsWith
            || corrected_stale_targets
                .get(&relation.source_id)
                .is_none_or(|target_id| target_id == &relation.target_id)
    });

    for source in profiles.iter().filter(|profile| {
        document_types
            .get(profile.source_id.as_str())
            .is_some_and(|document_type| document_type == "test_record")
            && profile.role == DocumentRole::Record
            && profile.official_record == Some(true)
    }) {
        let candidates = index
            .candidate_profiles(&source.source_id)
            .into_iter()
            .filter(|target| {
                document_types
                    .get(target.source_id.as_str())
                    .is_some_and(|document_type| document_type == "specification_amendment")
                    && target.role == DocumentRole::Normative
                    && target.force.approved
                    && scopes_equivalent(&source.scope, &target.scope)
            })
            .filter_map(|target| {
                corroborating_claim_evidence(&source.source_id, &target.source_id, &index.claims)
                    .map(|references| (target, references))
            })
            .collect::<Vec<_>>();
        let [(target, references)] = candidates.as_slice() else {
            continue;
        };
        if !execution_pairs.insert((source.source_id.clone(), target.source_id.clone())) {
            continue;
        }
        let key = format!(
            "{}:{}:records_execution_of",
            source.source_id, target.source_id
        );
        additions.push(DocumentRelation {
            id: format!("coverage_{}", &sha256_hex(key.as_bytes())[..16]),
            position: fragarach_ir::DocumentPosition::NonEffective,
            kind: fragarach_ir::RelationKind::RecordsExecutionOf,
            source_id: source.source_id.clone(),
            target_id: target.source_id.clone(),
            source_clauses: vec!["判定".to_owned()],
            target_clauses: vec!["変更値".to_owned()],
            scope: target.scope.clone(),
            valid_from: source.time.valid_from.clone(),
            valid_to: source.time.valid_to.clone(),
            evidence: references.clone(),
        });
    }

    for source in profiles.iter().filter(|profile| {
        document_types
            .get(profile.source_id.as_str())
            .is_some_and(|document_type| document_type == "technical_draft")
            && profile.role == DocumentRole::Proposal
            && !profile.force.approved
    }) {
        let Some((topic_evidence, topic)) = proposed_technical_change_topic(
            &source.source_id,
            index.source_evidence(&source.source_id),
        ) else {
            continue;
        };
        let candidates = index
            .candidate_profiles(&source.source_id)
            .into_iter()
            .filter(|target| {
                document_types
                    .get(target.source_id.as_str())
                    .is_some_and(|document_type| document_type == "technical_specification")
                    && target.role == DocumentRole::Normative
                    && target.force.approved
            })
            .filter_map(|target| {
                index
                    .source_evidence(&target.source_id)
                    .iter()
                    .copied()
                    .filter(|item| item.text.contains(&topic))
                    .min_by_key(|item| item.text.chars().count())
                    .map(|target_evidence| (target, target_evidence))
            })
            .collect::<Vec<_>>();
        let [(target, target_evidence)] = candidates.as_slice() else {
            continue;
        };
        if !proposal_pairs.insert((source.source_id.clone(), target.source_id.clone())) {
            continue;
        }
        let Some(status_evidence) = index
            .source_evidence(&source.source_id)
            .iter()
            .copied()
            .find(|item| {
                item.text.contains("未承認")
                    && (item.text.contains("適用") || item.text.contains("正式"))
            })
        else {
            continue;
        };
        let key = format!(
            "{}:{}:proposes_change_to",
            source.source_id, target.source_id
        );
        additions.push(DocumentRelation {
            id: format!("coverage_{}", &sha256_hex(key.as_bytes())[..16]),
            position: fragarach_ir::DocumentPosition::NonEffective,
            kind: fragarach_ir::RelationKind::ProposesChangeTo,
            source_id: source.source_id.clone(),
            target_id: target.source_id.clone(),
            source_clauses: vec!["検討目的".to_owned(), "承認状態".to_owned()],
            target_clauses: target_evidence
                .heading_path
                .last()
                .cloned()
                .into_iter()
                .collect(),
            scope: target.scope.clone(),
            valid_from: source.time.valid_from.clone(),
            valid_to: source.time.valid_to.clone(),
            evidence: vec![
                fragarach_ir::EvidenceReference {
                    source_id: topic_evidence.source_id.clone(),
                    evidence_id: topic_evidence.evidence_id.clone(),
                },
                fragarach_ir::EvidenceReference {
                    source_id: status_evidence.source_id.clone(),
                    evidence_id: status_evidence.evidence_id.clone(),
                },
                fragarach_ir::EvidenceReference {
                    source_id: target_evidence.source_id.clone(),
                    evidence_id: target_evidence.evidence_id.clone(),
                },
            ],
        });
    }

    let mut decision_relation_keys = relations
        .iter()
        .map(|relation| {
            (
                relation.source_id.clone(),
                relation.target_id.clone(),
                relation_kind_name(&relation.kind),
            )
        })
        .collect::<HashSet<_>>();
    for decision in profiles.iter().filter(|profile| {
        document_types
            .get(profile.source_id.as_str())
            .is_some_and(|document_type| document_type == "decision_minutes")
            && profile.role == DocumentRole::Record
            && profile.force.approved
            && profile.official_record == Some(true)
    }) {
        let candidates = index
            .candidate_profiles(&decision.source_id)
            .into_iter()
            .filter(|plan| {
                document_types
                    .get(plan.source_id.as_str())
                    .is_some_and(|document_type| document_type == "implementation_plan")
                    && plan.role == DocumentRole::Instruction
                    && plan.force.approved
            })
            .filter_map(|plan| {
                matching_decision_plan_evidence(
                    index.source_evidence(&decision.source_id),
                    index.source_evidence(&plan.source_id),
                )
                .map(|references| (plan, references))
            })
            .collect::<Vec<_>>();
        let [(plan, references)] = candidates.as_slice() else {
            continue;
        };
        for (kind, source_id, target_id) in [
            (
                fragarach_ir::RelationKind::Approves,
                &decision.source_id,
                &plan.source_id,
            ),
            (
                fragarach_ir::RelationKind::ImplementsDecision,
                &plan.source_id,
                &decision.source_id,
            ),
        ] {
            let kind_name = serde_json::to_value(&kind)
                .ok()
                .and_then(|value| value.as_str().map(str::to_owned))
                .unwrap_or_else(|| "decision_relation".to_owned());
            if !decision_relation_keys.insert((
                source_id.to_string(),
                target_id.to_string(),
                kind_name.clone(),
            )) {
                continue;
            }
            let key = format!("{source_id}:{target_id}:{kind_name}");
            additions.push(DocumentRelation {
                id: format!("coverage_{}", &sha256_hex(key.as_bytes())[..16]),
                position: fragarach_ir::DocumentPosition::NonEffective,
                kind,
                source_id: source_id.clone(),
                target_id: target_id.clone(),
                source_clauses: vec!["決定".to_owned()],
                target_clauses: vec!["採用方式".to_owned()],
                scope: plan.scope.clone(),
                valid_from: plan.time.valid_from.clone(),
                valid_to: plan.time.valid_to.clone(),
                evidence: references.clone(),
            });
        }
    }

    complete_incident_change_relations(relations, &mut additions, profiles, evidence);
    complete_required_relation_slots(relations, &mut additions, profiles, evidence);

    relations.extend(additions);
    relations.sort_by(|left, right| left.id.cmp(&right.id));
}

struct RequiredRelationSlot {
    purpose: &'static str,
    source_types: &'static [&'static str],
    source_status: Option<&'static str>,
    target_types: &'static [&'static str],
    target_status: Option<&'static str>,
    kind: fragarach_ir::RelationKind,
    position: fragarach_ir::DocumentPosition,
    source_headings: &'static [&'static str],
    target_headings: &'static [&'static str],
}

const REQUIRED_RELATION_SLOTS: &[RequiredRelationSlot] = &[
    RequiredRelationSlot {
        purpose: "technical_spec",
        source_types: &["specification_amendment"],
        source_status: None,
        target_types: &["technical_specification"],
        target_status: None,
        kind: fragarach_ir::RelationKind::Amends,
        position: fragarach_ir::DocumentPosition::Dominates,
        source_headings: &["対象条項", "変更値"],
        target_headings: &["変更管理", "基準値"],
    },
    RequiredRelationSlot {
        purpose: "technical_spec",
        source_types: &["test_record"],
        source_status: None,
        target_types: &["specification_amendment"],
        target_status: None,
        kind: fragarach_ir::RelationKind::RecordsExecutionOf,
        position: fragarach_ir::DocumentPosition::NonEffective,
        source_headings: &["試験対象", "判定", "記録性"],
        target_headings: &["対象条項", "変更値"],
    },
    RequiredRelationSlot {
        purpose: "technical_spec",
        source_types: &["technical_draft"],
        source_status: None,
        target_types: &["technical_specification"],
        target_status: None,
        kind: fragarach_ir::RelationKind::ProposesChangeTo,
        position: fragarach_ir::DocumentPosition::NonEffective,
        source_headings: &["検討目的", "候補値"],
        target_headings: &["変更管理", "基準値"],
    },
    RequiredRelationSlot {
        purpose: "operations",
        source_types: &["work_instruction"],
        source_status: None,
        target_types: &["operating_procedure"],
        target_status: None,
        kind: fragarach_ir::RelationKind::AppliesTo,
        position: fragarach_ir::DocumentPosition::Conditional,
        source_headings: &["上位手順", "実施"],
        target_headings: &["対象", "頻度"],
    },
    RequiredRelationSlot {
        purpose: "operations",
        source_types: &["temporary_deviation"],
        source_status: None,
        target_types: &["operating_procedure"],
        target_status: None,
        kind: fragarach_ir::RelationKind::ExceptionTo,
        position: fragarach_ir::DocumentPosition::Conditional,
        source_headings: &["適用対象", "例外規則"],
        target_headings: &["例外", "対象"],
    },
    RequiredRelationSlot {
        purpose: "operations",
        source_types: &["execution_log"],
        source_status: None,
        target_types: &["temporary_deviation"],
        target_status: None,
        kind: fragarach_ir::RelationKind::RecordsExecutionOf,
        position: fragarach_ir::DocumentPosition::NonEffective,
        source_headings: &["位置づけ", "実施結果"],
        target_headings: &["適用対象", "例外規則"],
    },
    RequiredRelationSlot {
        purpose: "incident_change",
        source_types: &["incident_report"],
        source_status: Some("closed"),
        target_types: &["incident_report"],
        target_status: Some("open"),
        kind: fragarach_ir::RelationKind::Supersedes,
        position: fragarach_ir::DocumentPosition::Dominates,
        source_headings: &["終結", "確定原因"],
        target_headings: &["初報", "発生", "概要"],
    },
    RequiredRelationSlot {
        purpose: "incident_change",
        source_types: &["change_request"],
        source_status: None,
        target_types: &["incident_report"],
        target_status: Some("closed"),
        kind: fragarach_ir::RelationKind::DerivedFrom,
        position: fragarach_ir::DocumentPosition::NonEffective,
        source_headings: &["変更理由", "変更内容"],
        target_headings: &["確定原因"],
    },
    RequiredRelationSlot {
        purpose: "incident_change",
        source_types: &["release_record"],
        source_status: None,
        target_types: &["change_request"],
        target_status: None,
        kind: fragarach_ir::RelationKind::RecordsExecutionOf,
        position: fragarach_ir::DocumentPosition::NonEffective,
        source_headings: &["実施内容", "位置づけ"],
        target_headings: &["承認", "変更内容"],
    },
    RequiredRelationSlot {
        purpose: "planning",
        source_types: &["analysis", "options_analysis"],
        source_status: None,
        target_types: &["proposal"],
        target_status: None,
        kind: fragarach_ir::RelationKind::Evaluates,
        position: fragarach_ir::DocumentPosition::NonEffective,
        source_headings: &["比較対象", "評価"],
        target_headings: &["初期案", "提案"],
    },
    RequiredRelationSlot {
        purpose: "planning",
        source_types: &["decision_minutes"],
        source_status: None,
        target_types: &["implementation_plan"],
        target_status: None,
        kind: fragarach_ir::RelationKind::Approves,
        position: fragarach_ir::DocumentPosition::NonEffective,
        source_headings: &["決定"],
        target_headings: &["採用方式", "実施方式"],
    },
    RequiredRelationSlot {
        purpose: "planning",
        source_types: &["implementation_plan"],
        source_status: None,
        target_types: &["decision_minutes"],
        target_status: None,
        kind: fragarach_ir::RelationKind::ImplementsDecision,
        position: fragarach_ir::DocumentPosition::NonEffective,
        source_headings: &["採用方式", "実施方式"],
        target_headings: &["決定"],
    },
    RequiredRelationSlot {
        purpose: "commercial_compliance",
        source_types: &["statement_of_work"],
        source_status: None,
        target_types: &["master_agreement", "master_contract"],
        target_status: None,
        kind: fragarach_ir::RelationKind::OrderOfPrecedence,
        position: fragarach_ir::DocumentPosition::Dominates,
        source_headings: &["優先", "個別条件"],
        target_headings: &["優先順位", "標準条件"],
    },
    RequiredRelationSlot {
        purpose: "commercial_compliance",
        source_types: &["vendor_proposal"],
        source_status: None,
        target_types: &["master_agreement", "master_contract"],
        target_status: None,
        kind: fragarach_ir::RelationKind::ProposesChangeTo,
        position: fragarach_ir::DocumentPosition::NonEffective,
        source_headings: &["契約状態", "提案"],
        target_headings: &["契約対象", "標準条件"],
    },
    RequiredRelationSlot {
        purpose: "commercial_compliance",
        source_types: &["audit_record"],
        source_status: None,
        target_types: &["statement_of_work"],
        target_status: None,
        kind: fragarach_ir::RelationKind::RecordsExecutionOf,
        position: fragarach_ir::DocumentPosition::NonEffective,
        source_headings: &["監査対象", "評価基準"],
        target_headings: &["個別条件", "対象"],
    },
    RequiredRelationSlot {
        purpose: "governance",
        source_types: &["policy"],
        source_status: Some("current"),
        target_types: &["policy"],
        target_status: Some("superseded"),
        kind: fragarach_ir::RelationKind::Supersedes,
        position: fragarach_ir::DocumentPosition::Dominates,
        source_headings: &["旧版の扱い", "現行規則"],
        target_headings: &["承認規則", "旧版"],
    },
    RequiredRelationSlot {
        purpose: "governance",
        source_types: &["faq"],
        source_status: None,
        target_types: &["policy"],
        target_status: Some("current"),
        kind: fragarach_ir::RelationKind::ConflictsWith,
        position: fragarach_ir::DocumentPosition::NonEffective,
        source_headings: &["旧案内", "更新状況"],
        target_headings: &["現行規則"],
    },
    RequiredRelationSlot {
        purpose: "governance",
        source_types: &["approval_record"],
        source_status: None,
        target_types: &["policy"],
        target_status: Some("current"),
        kind: fragarach_ir::RelationKind::Approves,
        position: fragarach_ir::DocumentPosition::NonEffective,
        source_headings: &["承認対象", "決定"],
        target_headings: &["現行規則", "目的"],
    },
];

#[derive(Default)]
struct RequiredRelationDossier {
    purpose: String,
    endpoints: Vec<RequiredRelationEndpoint>,
}

struct RequiredRelationEndpoint {
    source_id: String,
    document_type: String,
    status: String,
}

fn required_relation_fallback_pairs(
    evidence: &[PromptEvidence],
    deterministic_relations: &[DocumentRelation],
) -> (HashMap<String, String>, HashSet<RelationPair>) {
    let mut dossiers = BTreeMap::<String, RequiredRelationDossier>::new();
    let mut dossier_by_source = HashMap::new();
    for item in evidence
        .iter()
        .filter(|item| item.text.trim_start().starts_with("---"))
    {
        let Some(scenario) = front_matter_value(&item.text, "scenario") else {
            continue;
        };
        let Some(purpose) = front_matter_value(&item.text, "purpose") else {
            continue;
        };
        if !REQUIRED_RELATION_SLOTS
            .iter()
            .any(|slot| slot.purpose == purpose)
        {
            continue;
        }
        let Some(document_type) = front_matter_value(&item.text, "document_type") else {
            continue;
        };
        let status = front_matter_value(&item.text, "status").unwrap_or_default();
        let dossier_key = format!("{scenario}\0{purpose}");
        let dossier = dossiers.entry(dossier_key.clone()).or_default();
        dossier.purpose = purpose;
        if !dossier
            .endpoints
            .iter()
            .any(|endpoint| endpoint.source_id == item.source_id)
        {
            dossier.endpoints.push(RequiredRelationEndpoint {
                source_id: item.source_id.clone(),
                document_type,
                status,
            });
        }
        dossier_by_source.insert(item.source_id.clone(), dossier_key);
    }
    let resolved = deterministic_relations
        .iter()
        .map(|relation| {
            (
                relation.source_id.as_str(),
                relation_kind_name(&relation.kind),
            )
        })
        .collect::<HashSet<_>>();
    let mut fallback_pairs = HashSet::new();
    for dossier in dossiers.values() {
        for slot in REQUIRED_RELATION_SLOTS
            .iter()
            .filter(|slot| slot.purpose == dossier.purpose)
        {
            let mut targets = dossier
                .endpoints
                .iter()
                .filter(|endpoint| {
                    slot.target_types.contains(&endpoint.document_type.as_str())
                        && slot
                            .target_status
                            .is_none_or(|required| endpoint.status == required)
                })
                .map(|endpoint| endpoint.source_id.as_str())
                .collect::<Vec<_>>();
            targets.sort_unstable();
            for source in dossier.endpoints.iter().filter(|endpoint| {
                slot.source_types.contains(&endpoint.document_type.as_str())
                    && slot
                        .source_status
                        .is_none_or(|required| endpoint.status == required)
                    && !resolved
                        .contains(&(endpoint.source_id.as_str(), relation_kind_name(&slot.kind)))
            }) {
                fallback_pairs.extend(
                    targets
                        .iter()
                        .copied()
                        .filter(|target| *target != source.source_id)
                        .take(MAX_RELATION_CANDIDATES_PER_SOURCE)
                        .map(|target| canonical_relation_pair(&source.source_id, target)),
                );
            }
        }
    }
    (dossier_by_source, fallback_pairs)
}

fn unresolved_required_relation_diagnostics(
    relations: &[DocumentRelation],
    evidence: &[PromptEvidence],
) -> Vec<Diagnostic> {
    let resolved = relations
        .iter()
        .map(|relation| {
            (
                relation.source_id.as_str(),
                relation_kind_name(&relation.kind),
            )
        })
        .collect::<HashSet<_>>();
    let mut diagnostics = Vec::new();
    for item in evidence
        .iter()
        .filter(|item| item.text.trim_start().starts_with("---"))
    {
        let Some(purpose) = front_matter_value(&item.text, "purpose") else {
            continue;
        };
        let Some(document_type) = front_matter_value(&item.text, "document_type") else {
            continue;
        };
        let status = front_matter_value(&item.text, "status").unwrap_or_default();
        for slot in REQUIRED_RELATION_SLOTS.iter().filter(|slot| {
            slot.purpose == purpose
                && slot.source_types.contains(&document_type.as_str())
                && slot.source_status.is_none_or(|required| status == required)
                && !resolved.contains(&(item.source_id.as_str(), relation_kind_name(&slot.kind)))
        }) {
            let kind = relation_kind_name(&slot.kind);
            diagnostics.push(Diagnostic {
                id: format!(
                    "diag_relation_slot_{}",
                    &sha256_hex(
                        format!("{}:{}:{kind}", item.source_id, slot.purpose).as_bytes()
                    )[..16]
                ),
                code: "FRG-REL-UNRESOLVED-REQUIRED-SLOT".to_owned(),
                severity: DiagnosticSeverity::Warning,
                message: "必須Document Relationの接続先を一意に確定できませんでした"
                    .to_owned(),
                target_ids: vec![item.source_id.clone()],
                evidence_ids: vec![item.evidence_id.clone()],
                reason: format!(
                    "purpose={}; document_type={document_type}; relation_kind={kind}",
                    slot.purpose
                ),
                suggestions: vec![
                    "front matterのscopeへ対象文書IDを明示するか、LLM providerで不足Relationを補完してください"
                        .to_owned(),
                ],
                questions: vec!["この文書が参照・評価する対象文書はどれですか？".to_owned()],
            });
        }
    }
    diagnostics.sort_by(|left, right| left.id.cmp(&right.id));
    diagnostics.dedup_by(|left, right| left.id == right.id);
    diagnostics
}

fn complete_required_relation_slots(
    relations: &mut Vec<DocumentRelation>,
    additions: &mut Vec<DocumentRelation>,
    profiles: &[DocumentProfile],
    evidence: &[PromptEvidence],
) {
    let profile_by_id = profiles
        .iter()
        .map(|profile| (profile.source_id.as_str(), profile))
        .collect::<HashMap<_, _>>();
    let mut dossiers = BTreeMap::<String, RequiredRelationDossier>::new();
    let mut dossier_by_source = HashMap::<String, String>::new();
    let mut evidence_by_source = HashMap::<&str, Vec<&PromptEvidence>>::new();
    for item in evidence {
        evidence_by_source
            .entry(item.source_id.as_str())
            .or_default()
            .push(item);
        if !item.text.trim_start().starts_with("---") {
            continue;
        }
        let Some(scenario) = front_matter_value(&item.text, "scenario") else {
            continue;
        };
        let Some(purpose) = front_matter_value(&item.text, "purpose") else {
            continue;
        };
        let Some(document_type) = front_matter_value(&item.text, "document_type") else {
            continue;
        };
        let status = front_matter_value(&item.text, "status").unwrap_or_default();
        let dossier_key = format!("{scenario}\0{purpose}");
        let dossier = dossiers.entry(dossier_key.clone()).or_default();
        dossier.purpose = purpose.clone();
        if !dossier
            .endpoints
            .iter()
            .any(|endpoint| endpoint.source_id == item.source_id)
        {
            dossier.endpoints.push(RequiredRelationEndpoint {
                source_id: item.source_id.clone(),
                document_type: document_type.clone(),
                status: status.clone(),
            });
        }
        dossier_by_source.insert(item.source_id.clone(), dossier_key);
    }
    let explicit_document_references = required_relation_document_references(profiles, evidence);

    let mut required_edges = Vec::<(&RequiredRelationSlot, String, String)>::new();
    for dossier in dossiers.values() {
        for slot in REQUIRED_RELATION_SLOTS
            .iter()
            .filter(|slot| slot.purpose == dossier.purpose)
        {
            required_edges.extend(
                required_relation_endpoint_pairs(
                    dossier,
                    slot,
                    &profile_by_id,
                    &explicit_document_references,
                )
                .into_iter()
                .map(|(source_id, target_id)| (slot, source_id, target_id)),
            );
        }
    }
    required_edges.sort_by(|left, right| {
        left.1
            .cmp(&right.1)
            .then_with(|| left.2.cmp(&right.2))
            .then_with(|| relation_kind_name(&left.0.kind).cmp(&relation_kind_name(&right.0.kind)))
    });
    required_edges.dedup_by(|left, right| {
        left.1 == right.1 && left.2 == right.2 && left.0.kind == right.0.kind
    });
    let allowed_edges = required_edges
        .iter()
        .map(|(slot, source_id, target_id)| {
            (
                source_id.clone(),
                target_id.clone(),
                relation_kind_name(&slot.kind),
            )
        })
        .collect::<HashSet<_>>();

    relations.retain(|relation| {
        required_relation_shape_allowed(relation, &dossiers, &dossier_by_source, &allowed_edges)
    });
    additions.retain(|relation| {
        required_relation_shape_allowed(relation, &dossiers, &dossier_by_source, &allowed_edges)
    });
    deduplicate_required_relation_edges(relations, &dossiers, &dossier_by_source);

    let mut existing = relations
        .iter()
        .chain(additions.iter())
        .map(|relation| {
            (
                relation.source_id.clone(),
                relation.target_id.clone(),
                relation_kind_name(&relation.kind),
            )
        })
        .collect::<HashSet<_>>();
    for (slot, source_id, target_id) in required_edges {
        let kind_name = relation_kind_name(&slot.kind);
        if !existing.insert((source_id.clone(), target_id.clone(), kind_name.clone())) {
            continue;
        }
        let references = [
            required_slot_evidence(
                &source_id,
                slot.source_headings,
                evidence_by_source
                    .get(source_id.as_str())
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
            ),
            required_slot_evidence(
                &target_id,
                slot.target_headings,
                evidence_by_source
                    .get(target_id.as_str())
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
            ),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
        if references.len() < 2 {
            continue;
        }
        let Some(source_profile) = profile_by_id.get(source_id.as_str()).copied() else {
            continue;
        };
        let key = format!("{source_id}:{target_id}:{kind_name}:required-slot");
        additions.push(DocumentRelation {
            id: format!("slot_{}", &sha256_hex(key.as_bytes())[..16]),
            position: slot.position.clone(),
            kind: slot.kind.clone(),
            source_id,
            target_id,
            source_clauses: slot
                .source_headings
                .first()
                .map(|heading| (*heading).to_owned())
                .into_iter()
                .collect(),
            target_clauses: slot
                .target_headings
                .first()
                .map(|heading| (*heading).to_owned())
                .into_iter()
                .collect(),
            scope: source_profile.scope.clone(),
            valid_from: source_profile.time.valid_from.clone(),
            valid_to: source_profile.time.valid_to.clone(),
            evidence: references,
        });
    }
}

fn required_relation_endpoint_pairs(
    dossier: &RequiredRelationDossier,
    slot: &RequiredRelationSlot,
    profiles: &HashMap<&str, &DocumentProfile>,
    explicit_document_references: &HashMap<String, Vec<String>>,
) -> Vec<(String, String)> {
    let sources = dossier
        .endpoints
        .iter()
        .filter(|endpoint| {
            slot.source_types.contains(&endpoint.document_type.as_str())
                && slot
                    .source_status
                    .is_none_or(|status| endpoint.status == status)
        })
        .collect::<Vec<_>>();
    let targets = dossier
        .endpoints
        .iter()
        .filter(|endpoint| {
            slot.target_types.contains(&endpoint.document_type.as_str())
                && slot
                    .target_status
                    .is_none_or(|status| endpoint.status == status)
        })
        .collect::<Vec<_>>();
    if sources.is_empty() || targets.is_empty() {
        return Vec::new();
    }
    if targets.len() == 1 {
        return sources
            .into_iter()
            .filter(|source| source.source_id != targets[0].source_id)
            .map(|source| (source.source_id.clone(), targets[0].source_id.clone()))
            .collect();
    }

    let mut targets_by_document_id = HashMap::<String, Option<&RequiredRelationEndpoint>>::new();
    let mut scope_postings = HashMap::<String, Vec<&RequiredRelationEndpoint>>::new();
    for target in &targets {
        let Some(profile) = profiles.get(target.source_id.as_str()).copied() else {
            continue;
        };
        if let Some(document_id) = profile.document_id.as_deref() {
            targets_by_document_id
                .entry(required_relation_match_value(document_id))
                .and_modify(|entry| *entry = None)
                .or_insert(Some(target));
        }
        for token in required_relation_scope_tokens(profile) {
            let posting = scope_postings.entry(token).or_default();
            if posting.len() <= MAX_RELATION_POSTING {
                posting.push(target);
            }
        }
    }
    scope_postings.retain(|_, posting| posting.len() <= MAX_RELATION_POSTING);

    let mut pairs = Vec::new();
    for source in sources {
        let Some(profile) = profiles.get(source.source_id.as_str()).copied() else {
            continue;
        };
        let mut direct = profile_scope_values(&profile.scope)
            .into_iter()
            .flat_map(|(_, values)| values)
            .map(String::as_str)
            .chain(
                explicit_document_references
                    .get(&source.source_id)
                    .into_iter()
                    .flatten()
                    .map(String::as_str),
            )
            .filter_map(|value| {
                targets_by_document_id
                    .get(&required_relation_match_value(value))
                    .copied()
                    .flatten()
            })
            .filter(|target| target.source_id != source.source_id)
            .collect::<Vec<_>>();
        direct.sort_by(|left, right| left.source_id.cmp(&right.source_id));
        direct.dedup_by(|left, right| left.source_id == right.source_id);
        if let [target] = direct.as_slice() {
            pairs.push((source.source_id.clone(), target.source_id.clone()));
            continue;
        }

        let mut scores = HashMap::<&str, u16>::new();
        for token in required_relation_scope_tokens(profile) {
            for target in scope_postings.get(&token).into_iter().flatten() {
                if target.source_id != source.source_id {
                    *scores.entry(target.source_id.as_str()).or_default() += 1;
                }
            }
        }
        let Some(max_score) = scores.values().copied().max() else {
            continue;
        };
        let mut best = scores
            .into_iter()
            .filter(|(_, score)| *score == max_score)
            .map(|(target_id, _)| target_id);
        let Some(target_id) = best.next() else {
            continue;
        };
        if best.next().is_none() {
            pairs.push((source.source_id.clone(), target_id.to_owned()));
        }
    }
    pairs
}

fn required_relation_document_references(
    profiles: &[DocumentProfile],
    evidence: &[PromptEvidence],
) -> HashMap<String, Vec<String>> {
    let mut document_ids = HashMap::<String, Option<String>>::new();
    for profile in profiles {
        let Some(document_id) = profile.document_id.as_deref() else {
            continue;
        };
        document_ids
            .entry(required_relation_match_value(document_id))
            .and_modify(|source_id| *source_id = None)
            .or_insert_with(|| Some(profile.source_id.clone()));
    }
    document_ids.retain(|_, source_id| source_id.is_some());

    let mut references = HashMap::<String, Vec<String>>::new();
    for item in evidence
        .iter()
        .filter(|item| !item.text.trim_start().starts_with("---"))
    {
        let targets = references.entry(item.source_id.clone()).or_default();
        if targets.len() >= MAX_RELATION_LEXICAL_KEYS_PER_SOURCE {
            continue;
        }
        let mut token = String::new();
        for character in item.text.chars().chain(std::iter::once(' ')) {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                token.push(character);
                continue;
            }
            if !token.is_empty() {
                let normalized = required_relation_match_value(token.trim_matches('.'));
                if document_ids.contains_key(&normalized)
                    && !targets.iter().any(|target| target == &normalized)
                {
                    targets.push(normalized);
                    if targets.len() >= MAX_RELATION_LEXICAL_KEYS_PER_SOURCE {
                        break;
                    }
                }
                token.clear();
            }
        }
    }
    references
}

fn required_relation_scope_tokens(profile: &DocumentProfile) -> Vec<String> {
    profile_scope_values(&profile.scope)
        .into_iter()
        .flat_map(|(dimension, values)| {
            values
                .iter()
                .map(move |value| format!("{dimension}:{}", required_relation_match_value(value)))
        })
        .take(MAX_RELATION_LEXICAL_KEYS_PER_SOURCE)
        .collect()
}

fn required_relation_match_value(value: &str) -> String {
    value.trim().to_lowercase()
}

fn required_relation_shape_allowed(
    relation: &DocumentRelation,
    dossiers: &BTreeMap<String, RequiredRelationDossier>,
    dossier_by_source: &HashMap<String, String>,
    allowed_edges: &HashSet<(String, String, String)>,
) -> bool {
    if relation.id.starts_with("position_") {
        return true;
    }
    let Some(dossier_key) = dossier_by_source.get(&relation.source_id) else {
        return true;
    };
    let Some(dossier) = dossiers.get(dossier_key) else {
        return true;
    };
    if !REQUIRED_RELATION_SLOTS
        .iter()
        .any(|slot| slot.purpose == dossier.purpose)
    {
        return true;
    }
    if dossier_by_source.get(&relation.target_id) != Some(dossier_key) {
        return false;
    }
    let kind = relation_kind_name(&relation.kind);
    if allowed_edges.contains(&(
        relation.source_id.clone(),
        relation.target_id.clone(),
        kind.clone(),
    )) {
        return true;
    }
    if allowed_edges.iter().any(|(source_id, _, allowed_kind)| {
        source_id == &relation.source_id && allowed_kind == &kind
    }) {
        return false;
    }
    let Some(source) = dossier
        .endpoints
        .iter()
        .find(|endpoint| endpoint.source_id == relation.source_id)
    else {
        return false;
    };
    let Some(target) = dossier
        .endpoints
        .iter()
        .find(|endpoint| endpoint.source_id == relation.target_id)
    else {
        return false;
    };
    REQUIRED_RELATION_SLOTS.iter().any(|slot| {
        slot.purpose == dossier.purpose
            && relation_kind_name(&slot.kind) == kind
            && slot.source_types.contains(&source.document_type.as_str())
            && slot
                .source_status
                .is_none_or(|required| source.status == required)
            && slot.target_types.contains(&target.document_type.as_str())
            && slot
                .target_status
                .is_none_or(|required| target.status == required)
    })
}

fn deduplicate_required_relation_edges(
    relations: &mut Vec<DocumentRelation>,
    dossiers: &BTreeMap<String, RequiredRelationDossier>,
    dossier_by_source: &HashMap<String, String>,
) {
    let mut seen = HashSet::new();
    relations.retain(|relation| {
        if relation.id.starts_with("position_") {
            return true;
        }
        let Some(dossier) = dossier_by_source
            .get(&relation.source_id)
            .and_then(|key| dossiers.get(key))
        else {
            return true;
        };
        let kind = relation_kind_name(&relation.kind);
        if !REQUIRED_RELATION_SLOTS
            .iter()
            .any(|slot| slot.purpose == dossier.purpose && relation_kind_name(&slot.kind) == kind)
        {
            return true;
        }
        seen.insert((relation.source_id.clone(), relation.target_id.clone(), kind))
    });
}

fn required_slot_evidence(
    source_id: &str,
    headings: &[&str],
    evidence: &[&PromptEvidence],
) -> Option<fragarach_ir::EvidenceReference> {
    evidence
        .iter()
        .copied()
        .filter(|item| {
            !item.text.trim_start().starts_with("---")
                && item
                    .heading_path
                    .iter()
                    .any(|heading| headings.iter().any(|candidate| heading.contains(candidate)))
                && !item.text.contains("この節では")
        })
        .min_by_key(|item| item.text.chars().count())
        .or_else(|| {
            evidence
                .iter()
                .copied()
                .find(|item| item.text.trim_start().starts_with("---"))
        })
        .map(|item| fragarach_ir::EvidenceReference {
            source_id: source_id.to_owned(),
            evidence_id: item.evidence_id.clone(),
        })
}

#[derive(Default)]
struct IncidentChangeDossier {
    initial: Option<String>,
    final_report: Option<String>,
    change_request: Option<String>,
    release_record: Option<String>,
}

fn complete_incident_change_relations(
    relations: &mut Vec<DocumentRelation>,
    additions: &mut Vec<DocumentRelation>,
    profiles: &[DocumentProfile],
    evidence: &[PromptEvidence],
) {
    let profile_by_id = profiles
        .iter()
        .map(|profile| (profile.source_id.as_str(), profile))
        .collect::<HashMap<_, _>>();
    let mut dossiers = BTreeMap::<String, IncidentChangeDossier>::new();
    let mut source_dossier = HashMap::<String, String>::new();
    let mut evidence_by_source = HashMap::<&str, Vec<&PromptEvidence>>::new();
    for item in evidence {
        evidence_by_source
            .entry(item.source_id.as_str())
            .or_default()
            .push(item);
        if !item.text.trim_start().starts_with("---") {
            continue;
        }
        let Some(scenario) = front_matter_value(&item.text, "scenario") else {
            continue;
        };
        let Some(document_type) = front_matter_value(&item.text, "document_type") else {
            continue;
        };
        let status = front_matter_value(&item.text, "status").unwrap_or_default();
        let dossier = dossiers.entry(scenario.clone()).or_default();
        match (document_type.as_str(), status.as_str()) {
            ("incident_report", "open") => dossier.initial = Some(item.source_id.clone()),
            ("incident_report", "closed") => dossier.final_report = Some(item.source_id.clone()),
            ("change_request", _) => dossier.change_request = Some(item.source_id.clone()),
            ("release_record", _) => dossier.release_record = Some(item.source_id.clone()),
            _ => continue,
        }
        source_dossier.insert(item.source_id.clone(), scenario);
    }

    relations.retain(|relation| {
        let Some(scenario) = source_dossier.get(&relation.source_id) else {
            return true;
        };
        if source_dossier.get(&relation.target_id) != Some(scenario) {
            return true;
        }
        let dossier = &dossiers[scenario];
        let expected = match relation.kind {
            fragarach_ir::RelationKind::Supersedes => {
                dossier.final_report.as_ref() == Some(&relation.source_id)
                    && dossier.initial.as_ref() == Some(&relation.target_id)
            }
            fragarach_ir::RelationKind::RecordsExecutionOf => {
                dossier.release_record.as_ref() == Some(&relation.source_id)
                    && dossier.change_request.as_ref() == Some(&relation.target_id)
            }
            fragarach_ir::RelationKind::DerivedFrom => {
                dossier.change_request.as_ref() == Some(&relation.source_id)
                    && dossier.final_report.as_ref() == Some(&relation.target_id)
            }
            _ => false,
        };
        expected
    });

    let mut existing = relations
        .iter()
        .chain(additions.iter())
        .map(|relation| {
            (
                relation.source_id.clone(),
                relation.target_id.clone(),
                relation_kind_name(&relation.kind),
            )
        })
        .collect::<HashSet<_>>();
    for dossier in dossiers.values() {
        let Some(initial) = dossier.initial.as_deref() else {
            continue;
        };
        let Some(final_report) = dossier.final_report.as_deref() else {
            continue;
        };
        let Some(change_request) = dossier.change_request.as_deref() else {
            continue;
        };
        let Some(release_record) = dossier.release_record.as_deref() else {
            continue;
        };
        if let Some(reference) = explicit_incident_relation_evidence(
            evidence_by_source
                .get(final_report)
                .map(Vec::as_slice)
                .unwrap_or(&[]),
            &["最終報", "初報", "更新"],
        ) {
            push_completed_incident_relation(
                additions,
                &mut existing,
                profile_by_id.get(final_report).copied(),
                final_report,
                initial,
                fragarach_ir::RelationKind::Supersedes,
                fragarach_ir::DocumentPosition::Dominates,
                reference,
            );
        }
        if let Some(reference) = explicit_incident_relation_evidence(
            evidence_by_source
                .get(release_record)
                .map(Vec::as_slice)
                .unwrap_or(&[]),
            &["変更申請", "実施証跡"],
        ) {
            push_completed_incident_relation(
                additions,
                &mut existing,
                profile_by_id.get(release_record).copied(),
                release_record,
                change_request,
                fragarach_ir::RelationKind::RecordsExecutionOf,
                fragarach_ir::DocumentPosition::NonEffective,
                reference,
            );
        }
    }
}

fn explicit_incident_relation_evidence(
    evidence: &[&PromptEvidence],
    required_terms: &[&str],
) -> Option<fragarach_ir::EvidenceReference> {
    evidence
        .iter()
        .copied()
        .filter(|item| required_terms.iter().all(|term| item.text.contains(term)))
        .min_by_key(|item| item.text.chars().count())
        .map(|item| fragarach_ir::EvidenceReference {
            source_id: item.source_id.clone(),
            evidence_id: item.evidence_id.clone(),
        })
}

fn push_completed_incident_relation(
    additions: &mut Vec<DocumentRelation>,
    existing: &mut HashSet<(String, String, String)>,
    source_profile: Option<&DocumentProfile>,
    source_id: &str,
    target_id: &str,
    kind: fragarach_ir::RelationKind,
    position: fragarach_ir::DocumentPosition,
    evidence: fragarach_ir::EvidenceReference,
) {
    let kind_name = relation_kind_name(&kind);
    if !existing.insert((
        source_id.to_owned(),
        target_id.to_owned(),
        kind_name.clone(),
    )) {
        return;
    }
    let key = format!("{source_id}:{target_id}:{kind_name}");
    additions.push(DocumentRelation {
        id: format!("coverage_{}", &sha256_hex(key.as_bytes())[..16]),
        position,
        kind,
        source_id: source_id.to_owned(),
        target_id: target_id.to_owned(),
        source_clauses: Vec::new(),
        target_clauses: Vec::new(),
        scope: source_profile
            .map(|profile| profile.scope.clone())
            .unwrap_or_default(),
        valid_from: source_profile.and_then(|profile| profile.time.valid_from.clone()),
        valid_to: source_profile.and_then(|profile| profile.time.valid_to.clone()),
        evidence: vec![evidence],
    });
}

fn relation_kind_name(kind: &fragarach_ir::RelationKind) -> String {
    serde_json::to_value(kind)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "relation".to_owned())
}

fn incompatible_claim_evidence_scored(
    source_id: &str,
    target_id: &str,
    claims: &HashMap<&str, Vec<&Claim>>,
) -> Option<(usize, Vec<fragarach_ir::EvidenceReference>)> {
    claim_pair_evidence_scored(source_id, target_id, claims, |left, right| {
        crate::predicate_is_single_valued(&left.predicate)
            && left
                .predicate
                .trim()
                .eq_ignore_ascii_case(right.predicate.trim())
            && !crate::claim_objects_equivalent(left, right)
            && relation_subjects_overlap(&left.subject, &right.subject)
    })
}

fn corroborating_claim_evidence(
    source_id: &str,
    target_id: &str,
    claims: &HashMap<&str, Vec<&Claim>>,
) -> Option<Vec<fragarach_ir::EvidenceReference>> {
    claim_pair_evidence_scored(source_id, target_id, claims, |left, right| {
        crate::claim_objects_equivalent(left, right)
            && left
                .object
                .as_str()
                .is_some_and(|value| value.trim().chars().count() >= 2)
            && relation_subjects_overlap(&left.subject, &right.subject)
    })
    .map(|(_, references)| references)
}

fn claim_pair_evidence_scored<F>(
    source_id: &str,
    target_id: &str,
    claims: &HashMap<&str, Vec<&Claim>>,
    matches: F,
) -> Option<(usize, Vec<fragarach_ir::EvidenceReference>)>
where
    F: Fn(&Claim, &Claim) -> bool,
{
    let mut best = None;
    for left in claims.get(source_id).into_iter().flatten() {
        for right in claims.get(target_id).into_iter().flatten() {
            if !matches(left, right) {
                continue;
            }
            let mut references = left
                .evidence
                .iter()
                .filter(|reference| reference.source_id == source_id)
                .chain(
                    right
                        .evidence
                        .iter()
                        .filter(|reference| reference.source_id == target_id),
                )
                .cloned()
                .collect::<Vec<_>>();
            references.dedup_by(|left, right| {
                left.source_id == right.source_id && left.evidence_id == right.evidence_id
            });
            if references.is_empty() {
                continue;
            }
            let score = left
                .subject
                .trim()
                .chars()
                .count()
                .min(right.subject.trim().chars().count());
            if best
                .as_ref()
                .is_none_or(|(best_score, _): &(usize, Vec<_>)| score > *best_score)
            {
                best = Some((score, references));
            }
        }
    }
    best
}

fn proposed_technical_change_topic<'a>(
    source_id: &str,
    evidence: &'a [&'a PromptEvidence],
) -> Option<(&'a PromptEvidence, String)> {
    evidence
        .iter()
        .copied()
        .filter(|item| {
            item.source_id == source_id
                && item
                    .heading_path
                    .iter()
                    .any(|heading| heading.contains("検討目的"))
        })
        .filter_map(|item| {
            let (topic, _) = item.text.split_once("の次期改訂")?;
            let topic = topic.trim();
            (topic.chars().count() >= 6).then_some((item, topic.to_owned()))
        })
        .min_by_key(|(_, topic)| topic.chars().count())
}

fn matching_decision_plan_evidence(
    decision_evidence: &[&PromptEvidence],
    plan_evidence: &[&PromptEvidence],
) -> Option<Vec<fragarach_ir::EvidenceReference>> {
    let decision_items = decision_evidence
        .iter()
        .copied()
        .filter(|item| {
            item.heading_path
                .iter()
                .any(|heading| heading.contains("決定"))
                && (item.text.contains("正式採用") || item.text.contains("正式な実施方式"))
        })
        .take(MAX_RELATION_MATCH_EVIDENCE_PER_SOURCE);
    let plan_items = plan_evidence
        .iter()
        .copied()
        .filter(|item| {
            item.heading_path
                .iter()
                .any(|heading| heading.contains("採用方式"))
                && item.text.contains("実施方式")
        })
        .take(MAX_RELATION_MATCH_EVIDENCE_PER_SOURCE);
    let mut candidates = decision_items
        .flat_map(|decision| {
            let decision_phrases = quoted_phrases(&decision.text);
            plan_items.clone().filter_map(move |plan| {
                let shares_decision = quoted_phrases(&plan.text)
                    .iter()
                    .any(|phrase| decision_phrases.contains(phrase));
                shares_decision.then_some((decision, plan))
            })
        })
        .collect::<Vec<_>>();
    candidates
        .sort_by_key(|(decision, plan)| decision.text.chars().count() + plan.text.chars().count());
    let (decision, plan) = candidates.first()?;
    Some(vec![
        fragarach_ir::EvidenceReference {
            source_id: decision.source_id.clone(),
            evidence_id: decision.evidence_id.clone(),
        },
        fragarach_ir::EvidenceReference {
            source_id: plan.source_id.clone(),
            evidence_id: plan.evidence_id.clone(),
        },
    ])
}

fn quoted_phrases(text: &str) -> Vec<String> {
    let mut phrases = Vec::new();
    let mut current = None;
    for (index, character) in text.char_indices() {
        if character == '「' {
            current = Some(index + character.len_utf8());
        } else if character == '」'
            && let Some(start) = current.take()
        {
            let phrase = text[start..index].trim();
            if phrase.chars().count() >= 4 && !phrases.iter().any(|item| item == phrase) {
                phrases.push(phrase.to_owned());
            }
        }
    }
    phrases
}

fn relation_clauses_overlap(left: &DocumentRelation, right: &DocumentRelation) -> bool {
    let left_clauses = left
        .source_clauses
        .iter()
        .chain(&left.target_clauses)
        .filter(|clause| !clause.trim().is_empty())
        .collect::<Vec<_>>();
    let right_clauses = right
        .source_clauses
        .iter()
        .chain(&right.target_clauses)
        .filter(|clause| !clause.trim().is_empty())
        .collect::<Vec<_>>();

    !left_clauses.is_empty()
        && !right_clauses.is_empty()
        && left_clauses.iter().any(|left_clause| {
            right_clauses
                .iter()
                .any(|right_clause| left_clause.trim().eq_ignore_ascii_case(right_clause.trim()))
        })
}

fn scopes_equivalent(left: &ApplicabilityScope, right: &ApplicabilityScope) -> bool {
    scope_dimensions(left)
        .into_iter()
        .zip(scope_dimensions(right))
        .all(|(left_values, right_values)| {
            left_values.len() == right_values.len()
                && left_values.iter().all(|left_value| {
                    right_values
                        .iter()
                        .any(|right_value| left_value.eq_ignore_ascii_case(right_value))
                })
        })
}

fn scope_is_strict_refinement(narrow: &ApplicabilityScope, broad: &ApplicabilityScope) -> bool {
    let narrow_dimensions = scope_dimensions(narrow);
    let broad_dimensions = scope_dimensions(broad);
    let mut is_stricter = false;

    for (narrow_values, broad_values) in narrow_dimensions
        .into_iter()
        .zip(broad_dimensions.into_iter())
    {
        if broad_values.is_empty() {
            is_stricter |= !narrow_values.is_empty();
            continue;
        }
        if narrow_values.is_empty()
            || !narrow_values.iter().all(|narrow_value| {
                broad_values
                    .iter()
                    .any(|broad_value| narrow_value.eq_ignore_ascii_case(broad_value))
            })
        {
            return false;
        }
        is_stricter |= narrow_values.len() < broad_values.len();
    }

    is_stricter
}

fn scope_dimensions(scope: &ApplicabilityScope) -> [&[String]; 9] {
    [
        &scope.jurisdictions,
        &scope.entities,
        &scope.sites,
        &scope.products,
        &scope.assets,
        &scope.persons,
        &scope.projects,
        &scope.lots,
        &scope.contracts,
    ]
}

fn relation_subjects_overlap(left: &str, right: &str) -> bool {
    let left = left.trim().to_lowercase();
    let right = right.trim().to_lowercase();
    left == right
        || (left.chars().count().min(right.chars().count()) >= 4
            && (left.starts_with(&right)
                || right.starts_with(&left)
                || left.ends_with(&right)
                || right.ends_with(&left)))
}

fn role_from_document_type(document_type: &str) -> DocumentRole {
    match document_type {
        "policy"
        | "standard"
        | "master_contract"
        | "master_agreement"
        | "specification"
        | "amendment"
        | "technical_specification"
        | "specification_amendment" => DocumentRole::Normative,
        "procedure"
        | "operating_procedure"
        | "site_work_instruction"
        | "work_instruction"
        | "implementation_plan"
        | "temporary_deviation"
        | "sow"
        | "statement_of_work" => DocumentRole::Instruction,
        "approval_record" | "decision_record" | "decision_minutes" | "test_record"
        | "execution_log" | "release_record" | "audit_record" | "final_report" => {
            DocumentRole::Record
        }
        "analysis" | "options_analysis" | "initial_report" => DocumentRole::Analysis,
        "proposal" | "draft" | "technical_draft" | "vendor_proposal" | "change_request" => {
            DocumentRole::Proposal
        }
        "faq" => DocumentRole::Communication,
        _ => DocumentRole::Reference,
    }
}

fn build_decision_packets(
    intent_id: &str,
    relations: &[DocumentRelation],
    evidence: &[PromptEvidence],
) -> Vec<DecisionPacket> {
    let packets = relations
        .iter()
        .map(|relation| {
            let endpoint_evidence = select_relation_evidence(relation, evidence);
            let mut references = Vec::new();
            let mut seen = HashSet::new();
            for reference in relation
                .evidence
                .iter()
                .cloned()
                .chain(
                    endpoint_evidence
                        .iter()
                        .map(|item| fragarach_ir::EvidenceReference {
                            source_id: item.source_id.clone(),
                            evidence_id: item.evidence_id.clone(),
                        }),
                )
            {
                if seen.insert((reference.source_id.clone(), reference.evidence_id.clone())) {
                    references.push(reference);
                }
            }
            let (source_role, target_role) = match relation.kind {
                fragarach_ir::RelationKind::Approves
                | fragarach_ir::RelationKind::RecordsExecutionOf
                | fragarach_ir::RelationKind::Evaluates => {
                    (PacketMaterialRole::Verifier, PacketMaterialRole::Governing)
                }
                fragarach_ir::RelationKind::ImplementsDecision => {
                    (PacketMaterialRole::Governing, PacketMaterialRole::Verifier)
                }
                _ => match relation.position {
                    fragarach_ir::DocumentPosition::Dominates => {
                        (PacketMaterialRole::Governing, PacketMaterialRole::Excluded)
                    }
                    fragarach_ir::DocumentPosition::Conditional => {
                        (PacketMaterialRole::Governing, PacketMaterialRole::Governing)
                    }
                    fragarach_ir::DocumentPosition::NonEffective => {
                        (PacketMaterialRole::Excluded, PacketMaterialRole::Governing)
                    }
                    fragarach_ir::DocumentPosition::Unresolved => {
                        (PacketMaterialRole::Contender, PacketMaterialRole::Contender)
                    }
                },
            };
            let mut materials = vec![
                PacketMaterial {
                    source_id: relation.source_id.clone(),
                    role: source_role,
                    evidence_ids: Vec::new(),
                },
                PacketMaterial {
                    source_id: relation.target_id.clone(),
                    role: target_role,
                    evidence_ids: Vec::new(),
                },
            ];
            for reference in references {
                if let Some(material) = materials
                    .iter_mut()
                    .find(|material| material.source_id == reference.source_id)
                {
                    material.evidence_ids.push(reference.evidence_id);
                } else {
                    materials.push(PacketMaterial {
                        source_id: reference.source_id,
                        role: PacketMaterialRole::Verifier,
                        evidence_ids: vec![reference.evidence_id],
                    });
                }
            }
            for material in &mut materials {
                material.evidence_ids.sort();
                material.evidence_ids.dedup();
            }
            DecisionPacket {
                id: format!("packet:{}:{}", intent_id, relation.id),
                intent_id: intent_id.to_owned(),
                purpose: PacketPurpose::Decision {
                    relation_ids: vec![relation.id.clone()],
                },
                materials,
            }
        })
        .collect::<Vec<_>>();
    let mut merged: Vec<DecisionPacket> = Vec::new();
    for packet in packets {
        let compatible = merged.iter_mut().find(|candidate| {
            candidate.materials.len() == packet.materials.len()
                && packet.materials.iter().all(|material| {
                    candidate.materials.iter().any(|candidate_material| {
                        candidate_material.source_id == material.source_id
                            && candidate_material.role == material.role
                    })
                })
        });
        let Some(existing) = compatible else {
            merged.push(packet);
            continue;
        };
        let PacketPurpose::Decision { relation_ids } = &mut existing.purpose;
        let PacketPurpose::Decision {
            relation_ids: incoming_relation_ids,
        } = packet.purpose;
        relation_ids.extend(incoming_relation_ids);
        relation_ids.sort();
        relation_ids.dedup();
        for material in packet.materials {
            let existing_material = existing
                .materials
                .iter_mut()
                .find(|candidate| {
                    candidate.source_id == material.source_id && candidate.role == material.role
                })
                .expect("compatible Packet material must exist");
            existing_material.evidence_ids.extend(material.evidence_ids);
            existing_material.evidence_ids.sort();
            existing_material.evidence_ids.dedup();
        }
    }
    loop {
        let pair = (0..merged.len()).find_map(|context_index| {
            (0..merged.len())
                .filter(|candidate_index| *candidate_index != context_index)
                .find(|candidate_index| {
                    packets_form_complementary_decision(
                        &merged[context_index],
                        &merged[*candidate_index],
                        relations,
                    )
                })
                .map(|candidate_index| (context_index, candidate_index))
        });
        let Some((context_index, candidate_index)) = pair else {
            break;
        };
        let candidate = merged.remove(candidate_index);
        let context_index = if candidate_index < context_index {
            context_index - 1
        } else {
            context_index
        };
        merge_decision_packet(&mut merged[context_index], candidate);
    }
    merged
}

fn packets_form_complementary_decision(
    context: &DecisionPacket,
    candidate: &DecisionPacket,
    relations: &[DocumentRelation],
) -> bool {
    if context
        .materials
        .iter()
        .any(|material| material.role == PacketMaterialRole::Excluded)
        || !candidate
            .materials
            .iter()
            .any(|material| material.role == PacketMaterialRole::Excluded)
    {
        return false;
    }
    let shares_governing_material = context.materials.iter().any(|left| {
        left.role == PacketMaterialRole::Governing
            && candidate.materials.iter().any(|right| {
                right.role == PacketMaterialRole::Governing && right.source_id == left.source_id
            })
    });
    let material_roles_are_compatible = context.materials.iter().all(|left| {
        candidate
            .materials
            .iter()
            .find(|right| right.source_id == left.source_id)
            .is_none_or(|right| right.role == left.role)
    });
    if !shares_governing_material || !material_roles_are_compatible {
        return false;
    }
    let relation_by_id = relations
        .iter()
        .map(|relation| (relation.id.as_str(), relation))
        .collect::<std::collections::HashMap<_, _>>();
    let PacketPurpose::Decision {
        relation_ids: context_relation_ids,
    } = &context.purpose;
    let PacketPurpose::Decision {
        relation_ids: candidate_relation_ids,
    } = &candidate.purpose;
    let context_is_precedence = context_relation_ids.iter().any(|relation_id| {
        relation_by_id
            .get(relation_id.as_str())
            .is_some_and(|relation| relation_expresses_precedence(relation))
    });
    let candidate_is_proposal = candidate_relation_ids.iter().any(|relation_id| {
        relation_by_id
            .get(relation_id.as_str())
            .is_some_and(|relation| {
                relation.kind == fragarach_ir::RelationKind::ProposesChangeTo
                    && relation.position == fragarach_ir::DocumentPosition::NonEffective
            })
    });
    if !context_is_precedence || !candidate_is_proposal {
        return false;
    }
    context_relation_ids.iter().any(|left_id| {
        candidate_relation_ids.iter().any(|right_id| {
            let (Some(left), Some(right)) = (
                relation_by_id.get(left_id.as_str()),
                relation_by_id.get(right_id.as_str()),
            ) else {
                return false;
            };
            scopes_equivalent(&left.scope, &right.scope)
                || scope_is_strict_refinement(&left.scope, &right.scope)
                || scope_is_strict_refinement(&right.scope, &left.scope)
        })
    })
}

fn relation_expresses_precedence(relation: &DocumentRelation) -> bool {
    if relation.kind == fragarach_ir::RelationKind::OrderOfPrecedence {
        return true;
    }
    if relation.position != fragarach_ir::DocumentPosition::Conditional {
        return false;
    }
    relation
        .source_clauses
        .iter()
        .chain(&relation.target_clauses)
        .map(|clause| clause.to_lowercase())
        .any(|clause| {
            clause.contains("優先") || clause.contains("precedence") || clause.contains("priority")
        })
}

fn merge_decision_packet(existing: &mut DecisionPacket, incoming: DecisionPacket) {
    let PacketPurpose::Decision { relation_ids } = &mut existing.purpose;
    let PacketPurpose::Decision {
        relation_ids: incoming_relation_ids,
    } = incoming.purpose;
    relation_ids.extend(incoming_relation_ids);
    relation_ids.sort();
    relation_ids.dedup();
    for material in incoming.materials {
        if let Some(existing_material) = existing.materials.iter_mut().find(|candidate| {
            candidate.source_id == material.source_id && candidate.role == material.role
        }) {
            existing_material.evidence_ids.extend(material.evidence_ids);
            existing_material.evidence_ids.sort();
            existing_material.evidence_ids.dedup();
        } else {
            existing.materials.push(material);
        }
    }
}

fn render_decision_packet(
    packet: &DecisionPacket,
    profiles: &[DocumentProfile],
    relations: &[DocumentRelation],
    evidence: &[PromptEvidence],
) -> String {
    let profile_by_id = profiles
        .iter()
        .map(|profile| (profile.source_id.as_str(), profile))
        .collect::<std::collections::HashMap<_, _>>();
    let relation_by_id = relations
        .iter()
        .map(|relation| (relation.id.as_str(), relation))
        .collect::<std::collections::HashMap<_, _>>();
    let evidence_by_id = evidence
        .iter()
        .map(|item| ((item.source_id.as_str(), item.evidence_id.as_str()), item))
        .collect::<std::collections::HashMap<_, _>>();
    let mut text = String::from("種別: Decision Packet");
    let PacketPurpose::Decision { relation_ids } = &packet.purpose;
    for relation_id in relation_ids {
        let Some(relation) = relation_by_id.get(relation_id.as_str()) else {
            continue;
        };
        let identity = |source_id: &str| {
            let Some(profile) = profile_by_id.get(source_id) else {
                return source_id.to_owned();
            };
            format!(
                "{}{}",
                profile.document_id.as_deref().unwrap_or(&profile.source_id),
                profile
                    .revision
                    .as_deref()
                    .map(|revision| format!(" revision {revision}"))
                    .unwrap_or_default()
            )
        };
        let kind = serde_json::to_value(&relation.kind)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_else(|| "relation".to_owned());
        let _ = write!(
            &mut text,
            "\n位置づけ: {:?}\n変更側: {}\n基準側: {}\n詳細関係: {} {} {}\n適用範囲: {}\n有効開始: {}\n有効終了: {}",
            relation.position,
            identity(&relation.source_id),
            identity(&relation.target_id),
            relation.source_id,
            kind,
            relation.target_id,
            serde_json::to_string(&relation.scope).unwrap_or_default(),
            relation.valid_from.as_deref().unwrap_or("未指定"),
            relation.valid_to.as_deref().unwrap_or("未指定")
        );
    }
    text.push_str("\n\n原文証拠:");
    let mut materials = packet.materials.iter().collect::<Vec<_>>();
    materials.sort_by_key(|material| usize::from(material.role != PacketMaterialRole::Verifier));
    let mut first_excerpt = true;
    for material in materials {
        for evidence_id in &material.evidence_ids {
            let Some(item) =
                evidence_by_id.get(&(material.source_id.as_str(), evidence_id.as_str()))
            else {
                continue;
            };
            let _ = write!(
                &mut text,
                "{}[{} / {}]\n{}",
                if first_excerpt { "\n" } else { "\n\n" },
                item.source_id,
                item.heading_path.join(" / "),
                item.text
            );
            first_excerpt = false;
        }
    }
    text
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
        "approves" => &["承認", "決定", "採用", "施行", "対象"],
        "evaluates" => &["分析", "比較", "評価", "提案", "初期案", "優位"],
        "implements_decision" => &[
            "決定",
            "計画",
            "採用",
            "不採用",
            "実施方式",
            "実施対象",
            "採否",
        ],
        "records_execution_of" => &["決定", "承認", "実施", "実行", "適用", "完了", "記録"],
        "amends" => &["改訂", "修正", "変更", "条", "節"],
        "proposes_change_to" => &["提案", "未署名", "署名", "変更", "義務", "適用"],
        "exception_to" => &["例外", "逸脱", "免除", "限定"],
        _ => &["適用", "由来", "参照", "関係"],
    };
    let endpoint_clauses = if item.source_id == relation.source_id {
        relation.source_clauses.as_slice()
    } else if item.source_id == relation.target_id {
        relation.target_clauses.as_slice()
    } else {
        &[]
    };
    let clause_score = if relation_expresses_precedence(relation) {
        endpoint_clauses
            .iter()
            .filter(|clause| {
                let clause = clause.trim().to_lowercase();
                !clause.is_empty() && text.contains(&clause)
            })
            .count()
            * 100
    } else {
        0
    };
    let mut score = clause_score
        + terms.iter().filter(|term| text.contains(**term)).count() * 20
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

#[derive(Debug, Serialize, Deserialize)]
struct CachedRelationExtraction {
    format_version: u32,
    #[serde(default)]
    created_at: Option<chrono::DateTime<Utc>>,
    #[serde(default)]
    identity: String,
    #[serde(default)]
    source_ids: Vec<String>,
    #[serde(default)]
    evidence_ids: Vec<String>,
    response: DocumentRelationExtractionResponse,
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

fn relation_extraction_cache_path(
    cache_root: &Path,
    identity: &str,
    request: &DocumentRelationExtractionRequest,
) -> Result<PathBuf> {
    let mut hasher = Sha256::new();
    hasher.update(format!(
        "fragarach-relation-extraction-cache-v{EXTRACTION_CACHE_FORMAT_VERSION}\0"
    ));
    hasher.update(identity.as_bytes());
    hasher.update(b"\0");
    hasher.update(
        serde_json::to_vec(request)
            .context("failed to serialize relation extraction cache request")?,
    );
    let digest = hasher.finalize();
    let mut key = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut key, "{byte:02x}").unwrap();
    }
    Ok(cache_root.join(&key[..2]).join(format!("{key}.json")))
}

fn load_cached_relation_extraction(
    path: &Path,
) -> Result<Option<DocumentRelationExtractionResponse>> {
    if !path.is_file() {
        return Ok(None);
    }
    let entry: CachedRelationExtraction =
        serde_json::from_slice(&fs::read(path).with_context(|| {
            format!(
                "failed to read relation extraction cache {}",
                path.display()
            )
        })?)
        .with_context(|| {
            format!(
                "failed to parse relation extraction cache {}",
                path.display()
            )
        })?;
    if entry.format_version != EXTRACTION_CACHE_FORMAT_VERSION {
        return Ok(None);
    }
    Ok(Some(entry.response))
}

fn save_cached_relation_extraction(
    path: &Path,
    identity: &str,
    request: &DocumentRelationExtractionRequest,
    response: &DocumentRelationExtractionResponse,
) -> Result<()> {
    if path.is_file() {
        return Ok(());
    }
    let parent = path
        .parent()
        .context("relation extraction cache path has no parent directory")?;
    fs::create_dir_all(parent)?;
    let unique = Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let temporary = parent.join(format!(".relation-cache-write-{unique}.tmp"));
    let mut source_ids = request
        .evidence
        .iter()
        .map(|item| item.source_id.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    source_ids.sort();
    let entry = CachedRelationExtraction {
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
            "failed to write relation extraction cache {}",
            temporary.display()
        )
    })?;
    fs::rename(&temporary, path).with_context(|| {
        format!(
            "failed to atomically publish relation extraction cache {}",
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
        CompileStrategy, CorpusSettings, apply_corpus_hints, build_decision_packets,
        checklist_completeness_diagnostics, compact_profile_evidence,
        complete_relation_family_coverage, fallback_document_profile,
        intent_requests_checklist_completeness, merge_front_matter_positions,
        normalize_relation_endpoints, refine_stale_guidance_relations, relation_candidates,
        relation_evidence_score, relation_request_dossiers, render_retrieval_profile,
        select_relation_evidence, source_aware_batches,
    };
    use crate::ConflictContext;
    use fragarach_ir::{
        ApplicabilityScope, Claim, DocumentPosition, DocumentProfile, DocumentRelation,
        DocumentRole, EvidenceReference, ForceLevel, ForceProfile, IntentRequirements,
        PacketMaterialRole, PacketPurpose, RelationKind, TemporalProfile, UsageIntent,
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
    fn dossier_strategy_serializes_canonically_and_accepts_hybrid_alias() {
        assert_eq!(CompileStrategy::default(), CompileStrategy::DossierV1);
        assert_eq!(
            serde_json::from_str::<CompileStrategy>("\"dossier-v1\"").unwrap(),
            CompileStrategy::DossierV1
        );
        assert_eq!(
            serde_json::from_str::<CompileStrategy>("\"hybrid-v2\"").unwrap(),
            CompileStrategy::DossierV1
        );
        assert_eq!(
            serde_json::to_string(&CompileStrategy::DossierV1).unwrap(),
            "\"dossier-v1\""
        );
    }

    #[test]
    fn retrieval_profile_declares_the_standard_v1_reranker() {
        let profile = render_retrieval_profile(&ConflictContext::default());
        assert!(profile.contains("algorithm: fragrach-soft-rerank-v1"));
        assert!(profile.contains("candidate_limit: 20"));
        assert!(profile.contains("candidate_set: preserve"));
        assert!(profile.contains("governing: -4"));
        assert!(profile.contains("verifier: -2"));
        assert!(profile.contains("unclassified: 0"));
        assert!(profile.contains("contender: 2"));
        assert!(profile.contains("excluded: 6"));
        assert!(profile.contains("tie_breaker: original_rank"));
    }

    fn dossier_evidence(source_id: &str, scenario: &str) -> PromptEvidence {
        PromptEvidence {
            source_id: source_id.to_owned(),
            evidence_id: format!("ev-{source_id}"),
            source_path: format!("domain/{scenario}/{source_id}.md"),
            source_aliases: Vec::new(),
            heading_path: Vec::new(),
            authority: None,
            lifecycle: None,
            valid_from: None,
            valid_to: None,
            text: format!("---\nscenario: \"{scenario}\"\n---"),
        }
    }

    #[test]
    fn hybrid_relation_plans_keep_complete_dossiers_separate() {
        let mut items = Vec::new();
        let mut candidates = Vec::new();
        for scenario in ["scenario-01", "scenario-02"] {
            let sources = (0..4)
                .map(|index| format!("{scenario}-source-{index}"))
                .collect::<Vec<_>>();
            items.extend(
                sources
                    .iter()
                    .map(|source| dossier_evidence(source, scenario)),
            );
            for (index, left) in sources.iter().enumerate() {
                for right in &sources[index + 1..] {
                    candidates.push(super::canonical_relation_pair(left, right));
                }
            }
        }
        candidates.push(super::canonical_relation_pair(
            "scenario-01-source-0",
            "scenario-02-source-0",
        ));

        let plans = relation_request_dossiers(&candidates, &items);

        assert_eq!(plans.len(), 2);
        assert!(plans.iter().all(|plan| plan.allowed_pairs.len() == 6));
        assert!(plans.iter().all(|plan| {
            let scenarios = plan
                .request
                .evidence
                .iter()
                .map(|item| item.source_path.split('/').nth(1).unwrap())
                .collect::<std::collections::HashSet<_>>();
            scenarios.len() == 1
        }));
    }

    #[test]
    fn hybrid_relation_plans_separate_purposes_within_the_same_scenario() {
        let mut items = Vec::new();
        for purpose in ["governance", "planning"] {
            for document in 0..4 {
                let source_id = format!("{purpose}-{document}");
                let mut item = dossier_evidence(&source_id, "scenario-01");
                item.text = format!(
                    "---\nscenario: scenario-01\npurpose: {purpose}\ndocument_type: note\n---"
                );
                items.push(item);
            }
        }

        let plans = relation_request_dossiers(&[], &items);

        assert_eq!(plans.len(), 2);
        assert!(plans.iter().all(|plan| plan.allowed_pairs.len() == 6));
        assert!(plans.iter().all(|plan| {
            plan.request
                .evidence
                .iter()
                .map(|item| item.source_id.split('-').next().unwrap())
                .collect::<std::collections::HashSet<_>>()
                .len()
                == 1
        }));
    }

    #[test]
    fn hybrid_relation_plans_are_linear_for_bounded_dossiers() {
        let mut items = Vec::new();
        for dossier in 0..80 {
            let scenario = format!("scenario-{dossier:03}");
            for document in 0..4 {
                items.push(dossier_evidence(
                    &format!("source-{dossier:03}-{document}"),
                    &scenario,
                ));
            }
        }

        let plans = relation_request_dossiers(&[], &items);
        let edges = plans
            .iter()
            .map(|plan| plan.allowed_pairs.len())
            .sum::<usize>();

        assert_eq!(plans.len(), 80);
        assert_eq!(edges, 480);
        assert!(edges <= items.len() * 2);
    }

    #[test]
    fn hybrid_relation_plans_shard_large_dossiers_without_losing_candidate_edges() {
        let document_count = 5_000;
        let items = (0..document_count)
            .map(|index| dossier_evidence(&format!("source-{index:03}"), "large-scenario"))
            .collect::<Vec<_>>();
        let candidates = (0..document_count - 1)
            .map(|index| {
                super::canonical_relation_pair(
                    &format!("source-{index:03}"),
                    &format!("source-{:03}", index + 1),
                )
            })
            .collect::<Vec<_>>();

        let plans = relation_request_dossiers(&candidates, &items);
        let planned_edges = plans
            .iter()
            .map(|plan| plan.allowed_pairs.len())
            .sum::<usize>();

        assert_eq!(planned_edges, candidates.len());
        assert!(plans.iter().all(|plan| {
            let sources = plan
                .allowed_pairs
                .iter()
                .flat_map(|(left, right)| [left, right])
                .collect::<std::collections::HashSet<_>>();
            sources.len() <= super::MAX_HYBRID_DOSSIER_DOCUMENTS
                && plan.allowed_pairs.len() <= super::MAX_HYBRID_DOSSIER_EDGES
        }));
    }

    #[test]
    fn incident_metadata_rejects_wrong_relation_shapes_and_completes_explicit_edges() {
        let ids = ["initial", "final", "change", "release"];
        let profiles = ids
            .iter()
            .map(|source_id| DocumentProfile {
                source_id: (*source_id).to_owned(),
                document_id: Some(format!("DOC-{source_id}")),
                revision: None,
                role: DocumentRole::Reference,
                force: ForceProfile {
                    level: ForceLevel::Informational,
                    authority_rank: 1,
                    approved: true,
                },
                scope: ApplicabilityScope::default(),
                time: TemporalProfile::default(),
                official_record: None,
                evidence: vec![EvidenceReference {
                    source_id: (*source_id).to_owned(),
                    evidence_id: format!("meta-{source_id}"),
                }],
            })
            .collect::<Vec<_>>();
        let mut items = vec![
            ("initial", "incident_report", "open"),
            ("final", "incident_report", "closed"),
            ("change", "change_request", "approved"),
            ("release", "release_record", "completed"),
        ]
        .into_iter()
        .map(|(source_id, document_type, status)| PromptEvidence {
            source_id: source_id.to_owned(),
            evidence_id: format!("meta-{source_id}"),
            source_path: format!("scenario-01/{source_id}.md"),
            source_aliases: Vec::new(),
            heading_path: Vec::new(),
            authority: None,
            lifecycle: Some(status.to_owned()),
            valid_from: None,
            valid_to: None,
            text: format!(
                "---\nscenario: scenario-01\ndocument_type: {document_type}\nstatus: {status}\n---"
            ),
        })
        .collect::<Vec<_>>();
        items.push(PromptEvidence {
            source_id: "final".to_owned(),
            evidence_id: "final-update".to_owned(),
            source_path: "scenario-01/final.md".to_owned(),
            source_aliases: Vec::new(),
            heading_path: vec!["終結".to_owned()],
            authority: None,
            lifecycle: None,
            valid_from: None,
            valid_to: None,
            text: "本最終報は初報の未確認事項を更新する。".to_owned(),
        });
        items.push(PromptEvidence {
            source_id: "release".to_owned(),
            evidence_id: "release-proof".to_owned(),
            source_path: "scenario-01/release.md".to_owned(),
            source_aliases: Vec::new(),
            heading_path: vec!["位置づけ".to_owned()],
            authority: None,
            lifecycle: None,
            valid_from: None,
            valid_to: None,
            text: "本記録は変更申請の実施証跡である。".to_owned(),
        });
        let mut relations = vec![DocumentRelation {
            id: "wrong".to_owned(),
            position: DocumentPosition::Dominates,
            kind: RelationKind::ImplementsDecision,
            source_id: "release".to_owned(),
            target_id: "change".to_owned(),
            source_clauses: Vec::new(),
            target_clauses: Vec::new(),
            scope: ApplicabilityScope::default(),
            valid_from: None,
            valid_to: None,
            evidence: vec![EvidenceReference {
                source_id: "release".to_owned(),
                evidence_id: "release-proof".to_owned(),
            }],
        }];

        complete_relation_family_coverage(&mut relations, &profiles, &[], &items);

        assert_eq!(relations.len(), 2);
        assert!(relations.iter().any(|relation| {
            relation.source_id == "final"
                && relation.target_id == "initial"
                && relation.kind == RelationKind::Supersedes
        }));
        assert!(relations.iter().any(|relation| {
            relation.source_id == "release"
                && relation.target_id == "change"
                && relation.kind == RelationKind::RecordsExecutionOf
        }));
    }

    fn grounded_claim(
        source_id: &str,
        evidence_id: &str,
        subject: &str,
        predicate: &str,
        object: serde_json::Value,
    ) -> Claim {
        Claim {
            id: format!("claim-{source_id}-{evidence_id}"),
            subject: subject.to_owned(),
            predicate: predicate.to_owned(),
            object,
            condition: None,
            valid_from: None,
            valid_to: None,
            authority: None,
            status: None,
            confidence: 1.0,
            evidence: vec![EvidenceReference {
                source_id: source_id.to_owned(),
                evidence_id: evidence_id.to_owned(),
            }],
        }
    }

    fn candidate_profile(
        source_id: &str,
        document_id: &str,
        contract: &str,
    ) -> fragarach_ir::DocumentProfile {
        fragarach_ir::DocumentProfile {
            source_id: source_id.to_owned(),
            document_id: Some(document_id.to_owned()),
            revision: None,
            role: DocumentRole::Reference,
            force: ForceProfile {
                level: ForceLevel::Informational,
                authority_rank: 0,
                approved: true,
            },
            scope: ApplicabilityScope {
                contracts: vec![contract.to_owned()],
                ..ApplicabilityScope::default()
            },
            time: TemporalProfile::default(),
            official_record: None,
            evidence: Vec::new(),
        }
    }

    #[test]
    fn relation_candidate_graph_is_bounded_by_constant_sized_postings() {
        let profiles = (0..320)
            .map(|index| {
                candidate_profile(
                    &format!("source-{index:03}"),
                    &format!("DOC-{index:03}"),
                    &format!("contract-{}", index / 32),
                )
            })
            .collect::<Vec<_>>();
        let candidates = relation_candidates(&profiles, &[], &[]);
        assert_eq!(candidates.len(), 10 * (32 * 31 / 2));
        assert!(candidates.len() <= profiles.len() * 32);
    }

    #[test]
    fn relation_candidate_graph_stays_linear_at_5000_documents() {
        let profiles = (0..5_000)
            .map(|index| {
                candidate_profile(
                    &format!("source-{index:04}"),
                    &format!("DOC-{index:04}"),
                    &format!("contract-{}", index / 32),
                )
            })
            .collect::<Vec<_>>();

        let candidates = relation_candidates(&profiles, &[], &[]);

        assert_eq!(candidates.len(), 77_404);
        assert!(candidates.len() <= profiles.len() * super::MAX_RELATION_CANDIDATES_PER_SOURCE);
    }

    #[test]
    fn relation_candidate_graph_skips_unbounded_common_scope_postings() {
        let profiles = (0..100)
            .map(|index| {
                candidate_profile(&format!("source-{index}"), &format!("DOC-{index}"), "all")
            })
            .collect::<Vec<_>>();
        assert!(relation_candidates(&profiles, &[], &[]).is_empty());
    }

    #[test]
    fn explicit_position_metadata_always_adds_its_target_candidate() {
        let profiles = vec![
            candidate_profile("new", "STD-1", "all"),
            candidate_profile("old", "STD-0", "all"),
        ];
        let mut metadata = evidence("new", 0);
        metadata.text =
            "---\nposition: dominates\nposition_target_document_id: STD-0\n---".to_owned();
        assert_eq!(
            relation_candidates(&profiles, &[], &[metadata]),
            vec![("new".to_owned(), "old".to_owned())]
        );
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
    fn execution_packet_keeps_approval_and_execution_evidence() {
        let mut items = vec![
            evidence("release", 0),
            evidence("release", 1),
            evidence("release", 2),
            evidence("change", 0),
            evidence("change", 1),
            evidence("change", 2),
            evidence("change", 3),
        ];
        items[0].text = "本記録は変更申請の実施証跡である。".to_owned();
        items[1].text = "恒久対策を本番適用した。".to_owned();
        items[2].text = "本番適用後の完了を記録した。".to_owned();
        items[3].text = "変更理由は再発防止である。".to_owned();
        items[4].text = "恒久対策の変更内容を記載する。".to_owned();
        items[5].text = "本変更申請は変更諮問会議で承認済みである。".to_owned();
        items[6].text = "補足情報を記載する。".to_owned();
        let relation = DocumentRelation {
            id: "execution".to_owned(),
            position: DocumentPosition::Unresolved,
            kind: RelationKind::RecordsExecutionOf,
            source_id: "release".to_owned(),
            target_id: "change".to_owned(),
            source_clauses: Vec::new(),
            target_clauses: Vec::new(),
            scope: ApplicabilityScope::default(),
            valid_from: None,
            valid_to: None,
            evidence: Vec::new(),
        };

        let selected = select_relation_evidence(&relation, &items);

        assert!(selected.iter().any(|item| item.text.contains("本番適用")));
        assert!(selected.iter().any(|item| item.text.contains("承認済み")));
    }

    #[test]
    fn relation_evidence_prefers_explicit_endpoint_clauses_over_kind_vocabulary() {
        let mut items = vec![
            evidence("sow", 0),
            evidence("master", 0),
            evidence("master", 1),
            evidence("master", 2),
            evidence("master", 3),
        ];
        items[0].heading_path = vec!["優先".to_owned()];
        items[0].text = "本個別条件は基本契約より優先する。".to_owned();
        items[1].heading_path = vec!["契約対象".to_owned()];
        items[1].text = "本契約は共通条件を定める。".to_owned();
        items[2].heading_path = vec!["標準条件".to_owned()];
        items[2].text = "重要依頼の一次応答は四時間以内。".to_owned();
        items[3].heading_path = vec!["背景".to_owned()];
        items[3].text = "契約資料群の背景説明。".to_owned();
        items[4].heading_path = vec!["優先順位".to_owned()];
        items[4].text = "個別契約で変更した条件は基本契約より優先する。".to_owned();
        let relation = DocumentRelation {
            id: "precedence-misclassified".to_owned(),
            position: DocumentPosition::Conditional,
            kind: RelationKind::AppliesTo,
            source_id: "sow".to_owned(),
            target_id: "master".to_owned(),
            source_clauses: vec!["優先".to_owned()],
            target_clauses: vec!["優先順位".to_owned()],
            scope: ApplicabilityScope::default(),
            valid_from: None,
            valid_to: None,
            evidence: vec![EvidenceReference {
                source_id: "sow".to_owned(),
                evidence_id: "ev-sow-0".to_owned(),
            }],
        };

        let selected = select_relation_evidence(&relation, &items);

        assert!(
            selected.iter().any(|item| {
                item.source_id == "master" && item.heading_path == ["優先順位"]
            })
        );
    }

    #[test]
    fn decision_packet_collapses_derived_roles_and_evidence_into_materials() {
        let items = vec![
            evidence("current", 0),
            evidence("old", 0),
            evidence("register", 0),
        ];
        let relation = DocumentRelation {
            id: "position".to_owned(),
            position: DocumentPosition::Dominates,
            kind: RelationKind::OperationalPosition,
            source_id: "current".to_owned(),
            target_id: "old".to_owned(),
            source_clauses: Vec::new(),
            target_clauses: Vec::new(),
            scope: ApplicabilityScope::default(),
            valid_from: None,
            valid_to: None,
            evidence: vec![EvidenceReference {
                source_id: "register".to_owned(),
                evidence_id: "ev-register-0".to_owned(),
            }],
        };

        let packets = build_decision_packets("review", &[relation], &items);

        assert_eq!(packets.len(), 1);
        assert!(packets[0].materials.iter().any(|material| {
            material.source_id == "current" && material.role == PacketMaterialRole::Governing
        }));
        assert!(packets[0].materials.iter().any(|material| {
            material.source_id == "old" && material.role == PacketMaterialRole::Excluded
        }));
        assert!(packets[0].materials.iter().any(|material| {
            material.source_id == "register"
                && material.role == PacketMaterialRole::Verifier
                && material.evidence_ids == ["ev-register-0"]
        }));
        let value = serde_json::to_value(&packets[0]).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 4);
        assert!(value.get("text").is_none());
        assert!(value.get("position").is_none());
    }

    #[test]
    fn compatible_decision_relations_share_one_four_attribute_packet() {
        let items = vec![evidence("minutes", 0), evidence("plan", 0)];
        let relation =
            |id: &str, kind: RelationKind, source: &str, target: &str| DocumentRelation {
                id: id.to_owned(),
                position: DocumentPosition::NonEffective,
                kind,
                source_id: source.to_owned(),
                target_id: target.to_owned(),
                source_clauses: Vec::new(),
                target_clauses: Vec::new(),
                scope: ApplicabilityScope::default(),
                valid_from: None,
                valid_to: None,
                evidence: Vec::new(),
            };
        let relations = vec![
            relation("approval", RelationKind::Approves, "minutes", "plan"),
            relation(
                "implementation",
                RelationKind::ImplementsDecision,
                "plan",
                "minutes",
            ),
        ];

        let packets = build_decision_packets("planning", &relations, &items);

        assert_eq!(packets.len(), 1);
        let PacketPurpose::Decision { relation_ids } = &packets[0].purpose;
        assert_eq!(relation_ids, &["approval", "implementation"]);
        assert!(packets[0].materials.iter().any(|material| {
            material.source_id == "minutes" && material.role == PacketMaterialRole::Verifier
        }));
        assert!(packets[0].materials.iter().any(|material| {
            material.source_id == "plan" && material.role == PacketMaterialRole::Governing
        }));
        assert_eq!(
            serde_json::to_value(&packets[0])
                .unwrap()
                .as_object()
                .unwrap()
                .len(),
            4
        );
    }

    #[test]
    fn excluded_proposal_joins_the_compatible_governing_contract_decision() {
        let mut items = vec![
            evidence("proposal", 0),
            evidence("master", 0),
            evidence("sow", 0),
        ];
        items[0].text = "未署名の提案を契約上の義務として扱ってはならない。".to_owned();
        items[1].text = "個別契約で変更した条件は基本契約より優先する。".to_owned();
        items[2].text = "一次応答は一時間以内。".to_owned();
        let broad_scope = ApplicabilityScope {
            contracts: vec!["保守契約".to_owned()],
            ..ApplicabilityScope::default()
        };
        let narrow_scope = ApplicabilityScope {
            products: vec!["設備A".to_owned()],
            ..broad_scope.clone()
        };
        let relations = vec![
            DocumentRelation {
                id: "proposal-to-master".to_owned(),
                position: DocumentPosition::NonEffective,
                kind: RelationKind::ProposesChangeTo,
                source_id: "proposal".to_owned(),
                target_id: "master".to_owned(),
                source_clauses: vec!["契約状態".to_owned()],
                target_clauses: Vec::new(),
                scope: broad_scope,
                valid_from: None,
                valid_to: None,
                evidence: Vec::new(),
            },
            DocumentRelation {
                id: "sow-over-master".to_owned(),
                position: DocumentPosition::Conditional,
                kind: RelationKind::OrderOfPrecedence,
                source_id: "sow".to_owned(),
                target_id: "master".to_owned(),
                source_clauses: vec!["個別条件".to_owned()],
                target_clauses: vec!["優先順位".to_owned()],
                scope: narrow_scope,
                valid_from: None,
                valid_to: None,
                evidence: Vec::new(),
            },
        ];

        let packets = build_decision_packets("commercial_compliance", &relations, &items);

        assert_eq!(packets.len(), 1);
        let PacketPurpose::Decision { relation_ids } = &packets[0].purpose;
        assert_eq!(relation_ids, &["proposal-to-master", "sow-over-master"]);
        assert!(packets[0].materials.iter().any(|material| {
            material.source_id == "proposal" && material.role == PacketMaterialRole::Excluded
        }));
        assert!(packets[0].materials.iter().any(|material| {
            material.source_id == "sow" && material.role == PacketMaterialRole::Governing
        }));
        assert!(packets[0].materials.iter().any(|material| {
            material.source_id == "master" && material.role == PacketMaterialRole::Governing
        }));
        assert_eq!(
            serde_json::to_value(&packets[0])
                .unwrap()
                .as_object()
                .unwrap()
                .len(),
            4
        );
    }

    #[test]
    fn excluded_proposal_does_not_join_a_different_contract_scope() {
        let items = vec![
            evidence("proposal", 0),
            evidence("master", 0),
            evidence("sow", 0),
        ];
        let relation = |id: &str,
                        position: DocumentPosition,
                        kind: RelationKind,
                        source: &str,
                        contract: &str| DocumentRelation {
            id: id.to_owned(),
            position,
            kind,
            source_id: source.to_owned(),
            target_id: "master".to_owned(),
            source_clauses: Vec::new(),
            target_clauses: Vec::new(),
            scope: ApplicabilityScope {
                contracts: vec![contract.to_owned()],
                ..ApplicabilityScope::default()
            },
            valid_from: None,
            valid_to: None,
            evidence: Vec::new(),
        };
        let relations = vec![
            relation(
                "proposal-to-master",
                DocumentPosition::NonEffective,
                RelationKind::ProposesChangeTo,
                "proposal",
                "契約A",
            ),
            relation(
                "sow-over-master",
                DocumentPosition::Conditional,
                RelationKind::OrderOfPrecedence,
                "sow",
                "契約B",
            ),
        ];

        let packets = build_decision_packets("commercial_compliance", &relations, &items);

        assert_eq!(packets.len(), 2);
    }

    #[test]
    fn excluded_proposal_does_not_join_a_non_precedence_decision() {
        let items = vec![
            evidence("proposal", 0),
            evidence("baseline", 0),
            evidence("amendment", 0),
        ];
        let relation = |id: &str, position: DocumentPosition, kind: RelationKind, source: &str| {
            DocumentRelation {
                id: id.to_owned(),
                position,
                kind,
                source_id: source.to_owned(),
                target_id: "baseline".to_owned(),
                source_clauses: Vec::new(),
                target_clauses: Vec::new(),
                scope: ApplicabilityScope {
                    products: vec!["製品A".to_owned()],
                    ..ApplicabilityScope::default()
                },
                valid_from: None,
                valid_to: None,
                evidence: Vec::new(),
            }
        };
        let relations = vec![
            relation(
                "proposal-to-baseline",
                DocumentPosition::NonEffective,
                RelationKind::ProposesChangeTo,
                "proposal",
            ),
            relation(
                "amendment-to-baseline",
                DocumentPosition::Dominates,
                RelationKind::Amends,
                "amendment",
            ),
        ];

        let packets = build_decision_packets("technical_spec", &relations, &items);

        assert_eq!(packets.len(), 2);
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
    fn explicit_front_matter_scope_populates_fallback_profile() {
        let mut item = evidence("contract", 0);
        item.text = concat!(
            "---\n",
            "document_type: statement_of_work\n",
            "scope: {\"organization\":\"北辰クラウドサービス\",\"contract\":\"MASTER-001\",",
            "\"products\":[\"運用サービス-001\",\"運用サービス-002\"]}\n",
            "---"
        )
        .to_owned();

        let profile = fallback_document_profile("contract", &[item]).unwrap();

        assert_eq!(profile.scope.entities, ["北辰クラウドサービス"]);
        assert_eq!(profile.scope.contracts, ["MASTER-001"]);
        assert_eq!(
            profile.scope.products,
            ["運用サービス-001", "運用サービス-002"]
        );
    }

    #[test]
    fn planning_document_types_map_to_analysis_and_record_roles() {
        let mut analysis = evidence("analysis", 0);
        analysis.text = "---\ndocument_type: options_analysis\nstatus: reviewed\n---".to_owned();
        let mut decision = evidence("decision", 0);
        decision.text = "---\ndocument_type: decision_minutes\nstatus: approved\n---".to_owned();

        let analysis_profile = fallback_document_profile("analysis", &[analysis]).unwrap();
        let decision_profile = fallback_document_profile("decision", &[decision]).unwrap();

        assert_eq!(analysis_profile.role, fragarach_ir::DocumentRole::Analysis);
        assert_eq!(decision_profile.role, fragarach_ir::DocumentRole::Record);
    }

    #[test]
    fn approved_plan_and_matching_minutes_complete_both_decision_relations() {
        let mut minutes_metadata = evidence("minutes", 0);
        minutes_metadata.text =
            "---\ndocument_type: decision_minutes\napproved: true\nofficial_record: true\n---"
                .to_owned();
        let mut minutes_fact = evidence("minutes", 1);
        minutes_fact.heading_path = vec!["決定".to_owned()];
        minutes_fact.text =
            "『段階導入』ではなく「代表案件から段階的に導入する」を正式採用した。".to_owned();
        let mut plan_metadata = evidence("plan", 0);
        plan_metadata.text =
            "---\ndocument_type: implementation_plan\napproved: true\n---".to_owned();
        let mut plan_fact = evidence("plan", 1);
        plan_fact.heading_path = vec!["採用方式".to_owned()];
        plan_fact.text = "実施方式は「代表案件から段階的に導入する」とする。".to_owned();
        let mut minutes =
            fallback_document_profile("minutes", &[minutes_metadata.clone(), minutes_fact.clone()])
                .unwrap();
        minutes.role = DocumentRole::Record;
        minutes.force.approved = true;
        minutes.official_record = Some(true);
        let mut plan =
            fallback_document_profile("plan", &[plan_metadata.clone(), plan_fact.clone()]).unwrap();
        plan.role = DocumentRole::Instruction;
        plan.force.approved = true;
        let mut relations = Vec::new();

        complete_relation_family_coverage(
            &mut relations,
            &[minutes, plan],
            &[],
            &[minutes_metadata, minutes_fact, plan_metadata, plan_fact],
        );

        assert_eq!(relations.len(), 2);
        assert!(relations.iter().any(|relation| {
            relation.kind == RelationKind::Approves
                && relation.source_id == "minutes"
                && relation.target_id == "plan"
        }));
        assert!(relations.iter().any(|relation| {
            relation.kind == RelationKind::ImplementsDecision
                && relation.source_id == "plan"
                && relation.target_id == "minutes"
        }));
    }

    #[test]
    fn required_relation_slots_cover_enterprise_dossier_families_and_reject_wrong_shapes() {
        let definitions = [
            (
                "spec",
                "technical-1",
                "technical_spec",
                "technical_specification",
                "current",
                "変更管理",
            ),
            (
                "amendment",
                "technical-1",
                "technical_spec",
                "specification_amendment",
                "current",
                "対象条項",
            ),
            (
                "test-record",
                "technical-1",
                "technical_spec",
                "test_record",
                "passed",
                "試験対象",
            ),
            (
                "draft",
                "technical-1",
                "technical_spec",
                "technical_draft",
                "draft",
                "検討目的",
            ),
            (
                "procedure",
                "operations-1",
                "operations",
                "operating_procedure",
                "current",
                "対象",
            ),
            (
                "work-instruction",
                "operations-1",
                "operations",
                "work_instruction",
                "current",
                "上位手順",
            ),
            (
                "deviation",
                "operations-1",
                "operations",
                "temporary_deviation",
                "active",
                "例外規則",
            ),
            (
                "execution-log",
                "operations-1",
                "operations",
                "execution_log",
                "completed",
                "位置づけ",
            ),
            (
                "initial",
                "incident-1",
                "incident_change",
                "incident_report",
                "open",
                "初報",
            ),
            (
                "final",
                "incident-1",
                "incident_change",
                "incident_report",
                "closed",
                "確定原因",
            ),
            (
                "change",
                "incident-1",
                "incident_change",
                "change_request",
                "approved",
                "変更理由",
            ),
            (
                "release",
                "incident-1",
                "incident_change",
                "release_record",
                "completed",
                "実施内容",
            ),
            (
                "proposal",
                "planning-1",
                "planning",
                "proposal",
                "draft",
                "初期案",
            ),
            (
                "analysis",
                "planning-1",
                "planning",
                "options_analysis",
                "reviewed",
                "評価",
            ),
            (
                "decision",
                "planning-1",
                "planning",
                "decision_minutes",
                "approved",
                "決定",
            ),
            (
                "plan",
                "planning-1",
                "planning",
                "implementation_plan",
                "approved",
                "採用方式",
            ),
            (
                "master",
                "commercial-1",
                "commercial_compliance",
                "master_agreement",
                "current",
                "優先順位",
            ),
            (
                "sow",
                "commercial-1",
                "commercial_compliance",
                "statement_of_work",
                "current",
                "優先",
            ),
            (
                "vendor",
                "commercial-1",
                "commercial_compliance",
                "vendor_proposal",
                "draft",
                "契約状態",
            ),
            (
                "audit",
                "commercial-1",
                "commercial_compliance",
                "audit_record",
                "completed",
                "評価基準",
            ),
            (
                "policy-v1",
                "governance-1",
                "governance",
                "policy",
                "superseded",
                "承認規則",
            ),
            (
                "policy-v2",
                "governance-1",
                "governance",
                "policy",
                "current",
                "現行規則",
            ),
            (
                "faq",
                "governance-1",
                "governance",
                "faq",
                "stale",
                "旧案内",
            ),
            (
                "approval",
                "governance-1",
                "governance",
                "approval_record",
                "approved",
                "承認対象",
            ),
        ];
        let mut profiles = Vec::new();
        let mut items = Vec::new();
        for (source_id, scenario, purpose, document_type, status, heading) in definitions {
            let mut metadata = evidence(source_id, 0);
            metadata.text = format!(
                "---\nscenario: {scenario}\npurpose: {purpose}\ndocument_type: {document_type}\nstatus: {status}\napproved: true\n---"
            );
            let mut body = evidence(source_id, 1);
            body.heading_path = vec![heading.to_owned()];
            body.text = format!("{heading}について対象文書との関係を明示する。");
            profiles.push(
                fallback_document_profile(source_id, &[metadata.clone(), body.clone()]).unwrap(),
            );
            items.extend([metadata, body]);
        }
        let mut relations = vec![
            DocumentRelation {
                id: "provider_wrong_operational_position".to_owned(),
                position: DocumentPosition::NonEffective,
                kind: RelationKind::OperationalPosition,
                source_id: "analysis".to_owned(),
                target_id: "proposal".to_owned(),
                source_clauses: Vec::new(),
                target_clauses: Vec::new(),
                scope: ApplicabilityScope::default(),
                valid_from: None,
                valid_to: None,
                evidence: vec![EvidenceReference {
                    source_id: "analysis".to_owned(),
                    evidence_id: "ev-analysis-1".to_owned(),
                }],
            },
            DocumentRelation {
                id: "provider_wrong_cross_dossier".to_owned(),
                position: DocumentPosition::NonEffective,
                kind: RelationKind::ProposesChangeTo,
                source_id: "vendor".to_owned(),
                target_id: "policy-v2".to_owned(),
                source_clauses: Vec::new(),
                target_clauses: Vec::new(),
                scope: ApplicabilityScope::default(),
                valid_from: None,
                valid_to: None,
                evidence: vec![EvidenceReference {
                    source_id: "vendor".to_owned(),
                    evidence_id: "ev-vendor-1".to_owned(),
                }],
            },
        ];

        complete_relation_family_coverage(&mut relations, &profiles, &[], &items);

        let actual = relations
            .iter()
            .map(|relation| {
                (
                    relation.source_id.as_str(),
                    relation.target_id.as_str(),
                    super::relation_kind_name(&relation.kind),
                )
            })
            .collect::<std::collections::HashSet<_>>();
        let expected = [
            ("amendment", "spec", "amends".to_owned()),
            (
                "test-record",
                "amendment",
                "records_execution_of".to_owned(),
            ),
            ("draft", "spec", "proposes_change_to".to_owned()),
            ("work-instruction", "procedure", "applies_to".to_owned()),
            ("deviation", "procedure", "exception_to".to_owned()),
            (
                "execution-log",
                "deviation",
                "records_execution_of".to_owned(),
            ),
            ("final", "initial", "supersedes".to_owned()),
            ("change", "final", "derived_from".to_owned()),
            ("release", "change", "records_execution_of".to_owned()),
            ("analysis", "proposal", "evaluates".to_owned()),
            ("decision", "plan", "approves".to_owned()),
            ("plan", "decision", "implements_decision".to_owned()),
            ("sow", "master", "order_of_precedence".to_owned()),
            ("vendor", "master", "proposes_change_to".to_owned()),
            ("audit", "sow", "records_execution_of".to_owned()),
            ("policy-v2", "policy-v1", "supersedes".to_owned()),
            ("faq", "policy-v2", "conflicts_with".to_owned()),
            ("approval", "policy-v2", "approves".to_owned()),
        ]
        .into_iter()
        .collect::<std::collections::HashSet<_>>();

        assert_eq!(actual, expected);
        assert!(
            relations
                .iter()
                .all(|relation| relation.evidence.len() >= 2)
        );
    }

    #[test]
    fn required_relation_slots_match_repeated_commercial_endpoints_at_200_documents() {
        let mut profiles = Vec::new();
        let mut items = Vec::new();
        let mut add_document = |source_id: &str,
                                document_id: &str,
                                document_type: &str,
                                status: &str,
                                heading: &str,
                                contracts: Vec<String>,
                                products: Vec<String>| {
            let mut metadata = evidence(source_id, 0);
            metadata.text = format!(
                "---\ndocument_id: {document_id}\nscenario: large-commercial\npurpose: commercial_compliance\ndocument_type: {document_type}\nstatus: {status}\napproved: true\n---"
            );
            let mut body = evidence(source_id, 1);
            body.heading_path = vec![heading.to_owned()];
            body.text = format!("{heading}について対象文書との関係を明示する。");
            let mut profile =
                fallback_document_profile(source_id, &[metadata.clone(), body.clone()]).unwrap();
            profile.scope.contracts = contracts;
            profile.scope.products = products;
            profiles.push(profile);
            items.extend([metadata, body]);
        };

        add_document(
            "master",
            "MASTER-001",
            "master_agreement",
            "current",
            "優先順位",
            vec!["MASTER-001".to_owned()],
            Vec::new(),
        );
        for index in 0..66 {
            let product = format!("PRODUCT-{index:03}");
            let sow_document_id = format!("SOW-{index:03}");
            add_document(
                &format!("sow-{index:03}"),
                &sow_document_id,
                "statement_of_work",
                "current",
                "優先",
                vec!["MASTER-001".to_owned()],
                vec![product.clone()],
            );
            add_document(
                &format!("proposal-{index:03}"),
                &format!("PROPOSAL-{index:03}"),
                "vendor_proposal",
                "proposed",
                "契約状態",
                vec!["MASTER-001".to_owned()],
                vec![product.clone()],
            );
            add_document(
                &format!("audit-{index:03}"),
                &format!("AUDIT-{index:03}"),
                "audit_record",
                "completed",
                "評価基準",
                vec!["MASTER-001".to_owned(), sow_document_id],
                vec![product],
            );
        }
        add_document(
            "supporting-note",
            "NOTE-001",
            "supporting_note",
            "current",
            "参考情報",
            vec!["MASTER-001".to_owned()],
            Vec::new(),
        );
        let mut relations = Vec::new();

        complete_relation_family_coverage(&mut relations, &profiles, &[], &items);

        assert_eq!(profiles.len(), 200);
        assert_eq!(relations.len(), 198);
        for index in 0..66 {
            assert!(relations.iter().any(|relation| {
                relation.source_id == format!("sow-{index:03}")
                    && relation.target_id == "master"
                    && relation.kind == RelationKind::OrderOfPrecedence
            }));
            assert!(relations.iter().any(|relation| {
                relation.source_id == format!("proposal-{index:03}")
                    && relation.target_id == "master"
                    && relation.kind == RelationKind::ProposesChangeTo
            }));
            assert!(relations.iter().any(|relation| {
                relation.source_id == format!("audit-{index:03}")
                    && relation.target_id == format!("sow-{index:03}")
                    && relation.kind == RelationKind::RecordsExecutionOf
            }));
        }
    }

    #[test]
    fn repeated_endpoints_match_normalized_ids_and_reject_ambiguous_scope() {
        let profile = |source_id: &str, document_id: &str, contracts: Vec<&str>| DocumentProfile {
            source_id: source_id.to_owned(),
            document_id: Some(document_id.to_owned()),
            revision: None,
            role: DocumentRole::Record,
            force: ForceProfile {
                level: ForceLevel::Informational,
                authority_rank: 0,
                approved: true,
            },
            scope: ApplicabilityScope {
                entities: vec!["ORG".to_owned()],
                contracts: contracts.into_iter().map(str::to_owned).collect(),
                ..ApplicabilityScope::default()
            },
            time: TemporalProfile::default(),
            official_record: Some(true),
            evidence: Vec::new(),
        };
        let dossier = super::RequiredRelationDossier {
            purpose: "commercial_compliance".to_owned(),
            endpoints: vec![
                super::RequiredRelationEndpoint {
                    source_id: "audit".to_owned(),
                    document_type: "audit_record".to_owned(),
                    status: "completed".to_owned(),
                },
                super::RequiredRelationEndpoint {
                    source_id: "sow-1".to_owned(),
                    document_type: "statement_of_work".to_owned(),
                    status: "current".to_owned(),
                },
                super::RequiredRelationEndpoint {
                    source_id: "sow-2".to_owned(),
                    document_type: "statement_of_work".to_owned(),
                    status: "current".to_owned(),
                },
            ],
        };
        let slot = super::REQUIRED_RELATION_SLOTS
            .iter()
            .find(|slot| {
                slot.purpose == "commercial_compliance"
                    && slot.kind == RelationKind::RecordsExecutionOf
            })
            .unwrap();
        let mut profiles = [
            profile("audit", "AUDIT-001", vec!["MASTER-001"]),
            profile("sow-1", "SOW-001", vec!["MASTER-001"]),
            profile("sow-2", "SOW-002", vec!["MASTER-001"]),
        ];
        let index = profiles
            .iter()
            .map(|profile| (profile.source_id.as_str(), profile))
            .collect();

        assert!(
            super::required_relation_endpoint_pairs(
                &dossier,
                slot,
                &index,
                &std::collections::HashMap::new(),
            )
            .is_empty()
        );

        let mut body = evidence("audit", 1);
        body.text = "監査対象は個別契約「sow-001」に基づく履行である。".to_owned();
        let references = super::required_relation_document_references(&profiles, &[body]);
        assert_eq!(
            super::required_relation_endpoint_pairs(&dossier, slot, &index, &references),
            [("audit".to_owned(), "sow-1".to_owned())]
        );

        profiles[0].scope.contracts.push("  sow-001  ".to_owned());
        let index = profiles
            .iter()
            .map(|profile| (profile.source_id.as_str(), profile))
            .collect();
        assert_eq!(
            super::required_relation_endpoint_pairs(
                &dossier,
                slot,
                &index,
                &std::collections::HashMap::new(),
            ),
            [("audit".to_owned(), "sow-1".to_owned())]
        );
    }

    #[test]
    fn unresolved_required_slot_keeps_llm_fallback_shape_open() {
        let dossier_key = "commercial\0commercial_compliance".to_owned();
        let dossier = super::RequiredRelationDossier {
            purpose: "commercial_compliance".to_owned(),
            endpoints: vec![
                super::RequiredRelationEndpoint {
                    source_id: "audit".to_owned(),
                    document_type: "audit_record".to_owned(),
                    status: "completed".to_owned(),
                },
                super::RequiredRelationEndpoint {
                    source_id: "sow-1".to_owned(),
                    document_type: "statement_of_work".to_owned(),
                    status: "current".to_owned(),
                },
                super::RequiredRelationEndpoint {
                    source_id: "sow-2".to_owned(),
                    document_type: "statement_of_work".to_owned(),
                    status: "current".to_owned(),
                },
                super::RequiredRelationEndpoint {
                    source_id: "master".to_owned(),
                    document_type: "master_agreement".to_owned(),
                    status: "current".to_owned(),
                },
            ],
        };
        let dossiers = [(dossier_key.clone(), dossier)].into_iter().collect();
        let dossier_by_source = ["audit", "sow-1", "sow-2", "master"]
            .into_iter()
            .map(|source_id| (source_id.to_owned(), dossier_key.clone()))
            .collect();
        let relation = |target_id: &str| DocumentRelation {
            id: format!("provider-audit-{target_id}"),
            position: DocumentPosition::NonEffective,
            kind: RelationKind::RecordsExecutionOf,
            source_id: "audit".to_owned(),
            target_id: target_id.to_owned(),
            source_clauses: vec!["評価基準".to_owned()],
            target_clauses: vec!["対象".to_owned()],
            scope: ApplicabilityScope::default(),
            valid_from: None,
            valid_to: None,
            evidence: Vec::new(),
        };
        let mut allowed = std::collections::HashSet::new();

        assert!(super::required_relation_shape_allowed(
            &relation("sow-1"),
            &dossiers,
            &dossier_by_source,
            &allowed,
        ));
        assert!(!super::required_relation_shape_allowed(
            &relation("master"),
            &dossiers,
            &dossier_by_source,
            &allowed,
        ));

        allowed.insert((
            "audit".to_owned(),
            "sow-1".to_owned(),
            "records_execution_of".to_owned(),
        ));
        assert!(!super::required_relation_shape_allowed(
            &relation("sow-2"),
            &dossiers,
            &dossier_by_source,
            &allowed,
        ));
    }

    #[test]
    fn incomplete_required_dossier_is_not_suppressed_from_llm_planning() {
        let metadata = |source_id: &str, document_type: &str, status: &str| {
            let mut item = evidence(source_id, 0);
            item.text = format!(
                "---\nscenario: commercial\npurpose: commercial_compliance\ndocument_type: {document_type}\nstatus: {status}\n---"
            );
            item
        };
        let items = vec![
            metadata("master", "master_agreement", "current"),
            metadata("sow", "statement_of_work", "current"),
            metadata("audit", "audit_record", "completed"),
        ];
        let relation = |source_id: &str, target_id: &str, kind: RelationKind| DocumentRelation {
            id: format!("{source_id}-{target_id}"),
            position: DocumentPosition::NonEffective,
            kind,
            source_id: source_id.to_owned(),
            target_id: target_id.to_owned(),
            source_clauses: Vec::new(),
            target_clauses: Vec::new(),
            scope: ApplicabilityScope::default(),
            valid_from: None,
            valid_to: None,
            evidence: Vec::new(),
        };
        let mut deterministic = vec![relation("sow", "master", RelationKind::OrderOfPrecedence)];

        let diagnostics = super::unresolved_required_relation_diagnostics(&deterministic, &items);
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].target_ids, ["audit"]);
        assert_eq!(diagnostics[0].code, "FRG-REL-UNRESOLVED-REQUIRED-SLOT");
        let (dossiers, fallback_pairs) =
            super::required_relation_fallback_pairs(&items, &deterministic);
        assert_eq!(dossiers.len(), 3);
        assert_eq!(
            fallback_pairs,
            [("audit".to_owned(), "sow".to_owned())]
                .into_iter()
                .collect()
        );

        deterministic.push(relation("audit", "sow", RelationKind::RecordsExecutionOf));
        assert!(super::unresolved_required_relation_diagnostics(&deterministic, &items).is_empty());
        let (dossiers, fallback_pairs) =
            super::required_relation_fallback_pairs(&items, &deterministic);
        assert_eq!(dossiers.len(), 3);
        assert!(fallback_pairs.is_empty());
    }

    #[test]
    fn unapproved_technical_draft_links_to_unique_specification_topic() {
        let mut draft_metadata = evidence("draft", 0);
        draft_metadata.text =
            "---\ndocument_type: technical_draft\napproved: false\n---".to_owned();
        let mut draft_topic = evidence("draft", 1);
        draft_topic.heading_path = vec!["検討目的".to_owned()];
        draft_topic.text =
            "検査装置の設定変更反映期限の次期改訂を検討するための草案である。".to_owned();
        let mut draft_status = evidence("draft", 2);
        draft_status.heading_path = vec!["承認状態".to_owned()];
        draft_status.text = "第4版案は未承認であり運用へ適用してはならない。".to_owned();
        let mut matching_metadata = evidence("matching", 0);
        matching_metadata.text =
            "---\ndocument_type: technical_specification\napproved: true\n---".to_owned();
        let mut matching_fact = evidence("matching", 1);
        matching_fact.heading_path = vec!["基準値".to_owned()];
        matching_fact.text = "検査装置の設定変更反映期限の基準値は五営業日以内とする。".to_owned();
        let mut other_metadata = evidence("other", 0);
        other_metadata.text =
            "---\ndocument_type: technical_specification\napproved: true\n---".to_owned();
        let mut other_fact = evidence("other", 1);
        other_fact.heading_path = vec!["基準値".to_owned()];
        other_fact.text = "検査装置の監視データ保持期間は30日とする。".to_owned();
        let mut draft = fallback_document_profile(
            "draft",
            &[
                draft_metadata.clone(),
                draft_topic.clone(),
                draft_status.clone(),
            ],
        )
        .unwrap();
        draft.role = DocumentRole::Proposal;
        draft.force.approved = false;
        let mut matching = fallback_document_profile(
            "matching",
            &[matching_metadata.clone(), matching_fact.clone()],
        )
        .unwrap();
        matching.role = DocumentRole::Normative;
        matching.force.approved = true;
        let mut other =
            fallback_document_profile("other", &[other_metadata.clone(), other_fact.clone()])
                .unwrap();
        other.role = DocumentRole::Normative;
        other.force.approved = true;
        let mut relations = Vec::new();

        complete_relation_family_coverage(
            &mut relations,
            &[draft, matching, other],
            &[],
            &[
                draft_metadata,
                draft_topic,
                draft_status,
                matching_metadata,
                matching_fact,
                other_metadata,
                other_fact,
            ],
        );

        assert_eq!(relations.len(), 1);
        assert_eq!(relations[0].kind, RelationKind::ProposesChangeTo);
        assert_eq!(relations[0].source_id, "draft");
        assert_eq!(relations[0].target_id, "matching");
        assert_eq!(relations[0].evidence.len(), 3);
    }

    #[test]
    fn stale_faq_chooses_the_most_specific_incompatible_rule() {
        let mut faq_metadata = evidence("faq", 0);
        faq_metadata.text = "---\ndocument_type: faq\n---".to_owned();
        let mut faq_stale = evidence("faq", 1);
        faq_stale.text = "このFAQは第2版の改訂を反映していない。".to_owned();
        let mut exact_metadata = evidence("exact", 0);
        exact_metadata.text = "---\ndocument_type: policy\napproved: true\n---".to_owned();
        let mut broad_metadata = evidence("broad", 0);
        broad_metadata.text = "---\ndocument_type: policy\napproved: true\n---".to_owned();
        let mut faq =
            fallback_document_profile("faq", &[faq_metadata.clone(), faq_stale.clone()]).unwrap();
        faq.role = DocumentRole::Communication;
        let mut exact =
            fallback_document_profile("exact", std::slice::from_ref(&exact_metadata)).unwrap();
        exact.role = DocumentRole::Normative;
        exact.force.approved = true;
        let mut broad =
            fallback_document_profile("broad", std::slice::from_ref(&broad_metadata)).unwrap();
        broad.role = DocumentRole::Normative;
        broad.force.approved = true;
        let faq_claim = grounded_claim(
            "faq",
            &faq_stale.evidence_id,
            "輸出管理判定の承認",
            "requires_approval",
            serde_json::json!("営業責任者"),
        );
        let exact_claim = grounded_claim(
            "exact",
            &exact_metadata.evidence_id,
            "輸出管理判定の承認",
            "requires_approval",
            serde_json::json!(["輸出管理責任者", "営業責任者"]),
        );
        let broad_claim = grounded_claim(
            "broad",
            &broad_metadata.evidence_id,
            "輸出管理判定",
            "requires_approval",
            serde_json::json!("部門長"),
        );
        let mut relations = vec![DocumentRelation {
            id: "wrong".to_owned(),
            position: DocumentPosition::NonEffective,
            kind: RelationKind::ConflictsWith,
            source_id: "faq".to_owned(),
            target_id: "broad".to_owned(),
            source_clauses: Vec::new(),
            target_clauses: Vec::new(),
            scope: ApplicabilityScope::default(),
            valid_from: None,
            valid_to: None,
            evidence: Vec::new(),
        }];

        complete_relation_family_coverage(
            &mut relations,
            &[faq, exact, broad],
            &[faq_claim, exact_claim, broad_claim],
            &[faq_metadata, faq_stale, exact_metadata, broad_metadata],
        );

        assert_eq!(relations.len(), 1);
        assert_eq!(relations[0].source_id, "faq");
        assert_eq!(relations[0].target_id, "exact");
    }

    #[test]
    fn grounded_operations_chain_completes_three_relation_families() {
        let metadata = |source_id: &str, document_type: &str, official_record: bool| {
            let mut item = evidence(source_id, 0);
            item.text = format!(
                "---\ndocument_type: {document_type}\napproved: true\nofficial_record: {official_record}\n---"
            );
            item
        };
        let standard_metadata = metadata("standard", "operating_procedure", false);
        let local_metadata = metadata("local", "work_instruction", false);
        let deviation_metadata = metadata("deviation", "temporary_deviation", false);
        let log_metadata = metadata("log", "execution_log", true);
        let mut standard =
            fallback_document_profile("standard", std::slice::from_ref(&standard_metadata))
                .unwrap();
        let mut local =
            fallback_document_profile("local", std::slice::from_ref(&local_metadata)).unwrap();
        let mut deviation =
            fallback_document_profile("deviation", std::slice::from_ref(&deviation_metadata))
                .unwrap();
        let mut log =
            fallback_document_profile("log", std::slice::from_ref(&log_metadata)).unwrap();
        let broad_scope = ApplicabilityScope {
            entities: vec!["日和リテール".to_owned()],
            ..ApplicabilityScope::default()
        };
        let local_scope = ApplicabilityScope {
            entities: vec!["日和リテール".to_owned()],
            sites: vec!["札幌サポートセンター".to_owned()],
            ..ApplicabilityScope::default()
        };
        standard.role = DocumentRole::Instruction;
        standard.force.approved = true;
        standard.scope = broad_scope;
        local.role = DocumentRole::Instruction;
        local.force.approved = true;
        local.scope = local_scope.clone();
        deviation.role = DocumentRole::Instruction;
        deviation.force.approved = true;
        deviation.scope = local_scope.clone();
        log.role = DocumentRole::Record;
        log.force.approved = true;
        log.official_record = Some(true);
        log.scope = local_scope;
        let claims = vec![
            grounded_claim(
                "standard",
                &standard_metadata.evidence_id,
                "重要案件レビュー",
                "review_deadline",
                serde_json::json!("一営業日以内"),
            ),
            grounded_claim(
                "local",
                &local_metadata.evidence_id,
                "重要案件レビュー",
                "review_deadline",
                serde_json::json!("一営業日以内"),
            ),
            grounded_claim(
                "deviation",
                &deviation_metadata.evidence_id,
                "重要案件レビュー",
                "review_deadline",
                serde_json::json!("二時間以内"),
            ),
            grounded_claim(
                "log",
                &log_metadata.evidence_id,
                "重要案件レビュー",
                "review_deadline",
                serde_json::json!("二時間以内"),
            ),
        ];
        let mut relations = Vec::new();

        complete_relation_family_coverage(
            &mut relations,
            &[standard, local, deviation, log],
            &claims,
            &[
                standard_metadata,
                local_metadata,
                deviation_metadata,
                log_metadata,
            ],
        );

        assert_eq!(relations.len(), 3);
        assert!(relations.iter().any(|relation| {
            relation.kind == RelationKind::AppliesTo
                && relation.source_id == "local"
                && relation.target_id == "standard"
        }));
        assert!(relations.iter().any(|relation| {
            relation.kind == RelationKind::ExceptionTo
                && relation.source_id == "deviation"
                && relation.target_id == "standard"
        }));
        assert!(relations.iter().any(|relation| {
            relation.kind == RelationKind::RecordsExecutionOf
                && relation.source_id == "log"
                && relation.target_id == "deviation"
        }));
    }

    #[test]
    fn operations_document_types_map_to_instruction_roles() {
        for document_type in [
            "operating_procedure",
            "work_instruction",
            "temporary_deviation",
        ] {
            let mut item = evidence(document_type, 0);
            item.text = format!("---\ndocument_type: {document_type}\nstatus: current\n---");

            let profile = fallback_document_profile(document_type, &[item]).unwrap();

            assert_eq!(profile.role, fragarach_ir::DocumentRole::Instruction);
        }
    }

    #[test]
    fn technical_document_types_map_to_normative_and_proposal_roles() {
        for document_type in ["technical_specification", "specification_amendment"] {
            let mut item = evidence(document_type, 0);
            item.text = format!("---\ndocument_type: {document_type}\nstatus: current\n---");

            let profile = fallback_document_profile(document_type, &[item]).unwrap();

            assert_eq!(profile.role, DocumentRole::Normative);
        }

        let mut item = evidence("technical_draft", 0);
        item.text = "---\ndocument_type: technical_draft\nstatus: draft\n---".to_owned();
        let profile = fallback_document_profile("technical_draft", &[item]).unwrap();
        assert_eq!(profile.role, DocumentRole::Proposal);
    }

    #[test]
    fn commercial_document_types_map_to_contract_roles() {
        for document_type in ["master_contract", "master_agreement"] {
            let mut item = evidence(document_type, 0);
            item.text = format!("---\ndocument_type: {document_type}\nstatus: current\n---");

            let profile = fallback_document_profile(document_type, &[item]).unwrap();

            assert_eq!(profile.role, DocumentRole::Normative);
        }
        for document_type in ["sow", "statement_of_work"] {
            let mut item = evidence(document_type, 0);
            item.text = format!("---\ndocument_type: {document_type}\nstatus: current\n---");

            let profile = fallback_document_profile(document_type, &[item]).unwrap();

            assert_eq!(profile.role, DocumentRole::Instruction);
        }
    }

    #[test]
    fn unique_document_ids_normalize_relation_endpoints_but_ambiguous_ids_do_not() {
        let mut first_evidence = evidence("src-policy-v1", 0);
        first_evidence.text =
            "---\ndocument_id: POLICY-1\nrevision: 1\ndocument_type: policy\n---".to_owned();
        let mut second_evidence = evidence("src-policy-v2", 0);
        second_evidence.text =
            "---\ndocument_id: POLICY-2\nrevision: 2\ndocument_type: policy\n---".to_owned();
        let profiles = vec![
            fallback_document_profile("src-policy-v1", &[first_evidence]).unwrap(),
            fallback_document_profile("src-policy-v2", &[second_evidence]).unwrap(),
        ];
        let mut relation = DocumentRelation {
            id: "rel-version".to_owned(),
            position: DocumentPosition::Dominates,
            kind: RelationKind::Supersedes,
            source_id: "POLICY-2".to_owned(),
            target_id: "POLICY-1".to_owned(),
            source_clauses: Vec::new(),
            target_clauses: Vec::new(),
            scope: ApplicabilityScope::default(),
            valid_from: None,
            valid_to: None,
            evidence: Vec::new(),
        };

        normalize_relation_endpoints(&mut relation, &profiles);

        assert_eq!(relation.source_id, "src-policy-v2");
        assert_eq!(relation.target_id, "src-policy-v1");

        let mut ambiguous_profiles = profiles;
        let mut duplicate = ambiguous_profiles[0].clone();
        duplicate.source_id = "src-policy-v1-copy".to_owned();
        ambiguous_profiles.push(duplicate);
        relation.target_id = "POLICY-1".to_owned();
        normalize_relation_endpoints(&mut relation, &ambiguous_profiles);
        assert_eq!(relation.target_id, "POLICY-1");
    }

    #[test]
    fn stale_guidance_position_becomes_conflict_only_with_incompatible_scalar_claims() {
        let mut faq_evidence = evidence("faq", 0);
        faq_evidence.text =
            "---\ndocument_id: FAQ-1\ndocument_type: faq\nstatus: stale\n---".to_owned();
        let mut policy_evidence = evidence("policy", 0);
        policy_evidence.text =
            "---\ndocument_id: POLICY-1\ndocument_type: policy\nstatus: current\n---".to_owned();
        let profiles = vec![
            fallback_document_profile("faq", &[faq_evidence]).unwrap(),
            fallback_document_profile("policy", &[policy_evidence]).unwrap(),
        ];
        let mut relations = vec![DocumentRelation {
            id: "rel-stale".to_owned(),
            position: DocumentPosition::NonEffective,
            kind: RelationKind::OperationalPosition,
            source_id: "faq".to_owned(),
            target_id: "policy".to_owned(),
            source_clauses: Vec::new(),
            target_clauses: Vec::new(),
            scope: ApplicabilityScope::default(),
            valid_from: None,
            valid_to: None,
            evidence: Vec::new(),
        }];
        let claim = |id: &str, subject: &str, object: serde_json::Value, source_id: &str| Claim {
            id: id.to_owned(),
            subject: subject.to_owned(),
            predicate: "requires_approval".to_owned(),
            object,
            condition: None,
            valid_from: None,
            valid_to: None,
            authority: None,
            status: None,
            confidence: 1.0,
            evidence: vec![EvidenceReference {
                source_id: source_id.to_owned(),
                evidence_id: format!("ev-{source_id}"),
            }],
        };
        let claims = vec![
            claim(
                "faq-claim",
                "設計変更の承認",
                serde_json::json!("製造部長"),
                "faq",
            ),
            claim(
                "policy-claim",
                "設計変更",
                serde_json::json!(["品質保証部長", "主任技師"]),
                "policy",
            ),
        ];

        refine_stale_guidance_relations(&mut relations, &profiles, &claims);

        assert_eq!(relations[0].kind, RelationKind::ConflictsWith);

        relations[0].kind = RelationKind::OperationalPosition;
        let matching_claims = vec![
            claims[0].clone(),
            claim(
                "same-policy-claim",
                "設計変更",
                serde_json::json!("製造部長"),
                "policy",
            ),
        ];
        refine_stale_guidance_relations(&mut relations, &profiles, &matching_claims);
        assert_eq!(relations[0].kind, RelationKind::OperationalPosition);
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
    fn precedence_between_scoped_and_broader_instructions_completes_applies_to_coverage() {
        let wi_evidence = evidence("wi", 0);
        let procedure_evidence = evidence("procedure", 0);
        let mut wi = fallback_document_profile("wi", std::slice::from_ref(&wi_evidence)).unwrap();
        wi.role = DocumentRole::Instruction;
        wi.force.approved = true;
        wi.force.authority_rank = 7;
        wi.scope.entities = vec!["白峰メディカル".to_owned()];
        wi.scope.sites = vec!["神戸品質センター".to_owned()];
        let mut procedure =
            fallback_document_profile("procedure", std::slice::from_ref(&procedure_evidence))
                .unwrap();
        procedure.role = DocumentRole::Instruction;
        procedure.force.approved = true;
        procedure.force.authority_rank = 9;
        procedure.scope.entities = wi.scope.entities.clone();
        let precedence = DocumentRelation {
            id: "precedence".to_owned(),
            position: DocumentPosition::Dominates,
            kind: RelationKind::OrderOfPrecedence,
            source_id: "wi".to_owned(),
            target_id: "procedure".to_owned(),
            source_clauses: vec!["上位手順".to_owned()],
            target_clauses: Vec::new(),
            scope: ApplicabilityScope {
                sites: wi.scope.sites.clone(),
                ..ApplicabilityScope::default()
            },
            valid_from: None,
            valid_to: None,
            evidence: vec![EvidenceReference {
                source_id: "wi".to_owned(),
                evidence_id: wi_evidence.evidence_id.clone(),
            }],
        };
        let mut duplicate_precedence = precedence.clone();
        duplicate_precedence.id = "precedence-duplicate".to_owned();
        let mut relations = vec![precedence, duplicate_precedence];

        let relation_evidence = vec![wi_evidence, procedure_evidence];
        complete_relation_family_coverage(
            &mut relations,
            &[wi.clone(), procedure.clone()],
            &[],
            &relation_evidence,
        );
        complete_relation_family_coverage(
            &mut relations,
            &[wi, procedure],
            &[],
            &relation_evidence,
        );

        assert_eq!(relations.len(), 3);
        let applies_to = relations
            .iter()
            .find(|relation| relation.kind == RelationKind::AppliesTo)
            .unwrap();
        assert_eq!(applies_to.position, DocumentPosition::Conditional);
        assert_eq!(applies_to.scope.entities, vec!["白峰メディカル"]);
        assert_eq!(applies_to.scope.sites, vec!["神戸品質センター"]);
        assert_eq!(applies_to.source_clauses, vec!["上位手順"]);
        assert_eq!(applies_to.evidence.len(), 1);
    }

    #[test]
    fn unsigned_vendor_proposal_completes_change_relation_to_master_agreement() {
        let mut proposal_metadata = evidence("proposal", 0);
        proposal_metadata.text =
            "---\ndocument_type: vendor_proposal\napproved: false\n---".to_owned();
        let mut proposal_fact = evidence("proposal", 1);
        proposal_fact.heading_path = vec!["契約状態".to_owned()];
        proposal_fact.text = "この改善案は契約変更として署名されていない。".to_owned();
        let mut proposal_heading = evidence("proposal", 2);
        proposal_heading.heading_path = vec!["提案".to_owned()];
        proposal_heading.text = "## 提案".to_owned();
        let mut proposal_value = evidence("proposal", 3);
        proposal_value.heading_path = vec!["提案".to_owned()];
        proposal_value.text = "供給元は十五分以内の応答案を提示した。".to_owned();
        let mut master_metadata = evidence("master", 0);
        master_metadata.text =
            "---\ndocument_type: master_agreement\napproved: true\n---".to_owned();
        let mut proposal = fallback_document_profile(
            "proposal",
            &[
                proposal_metadata.clone(),
                proposal_fact.clone(),
                proposal_heading.clone(),
                proposal_value.clone(),
            ],
        )
        .unwrap();
        proposal.role = DocumentRole::Proposal;
        proposal.force.approved = false;
        proposal.scope.entities = vec!["瑞穂フィナンシャルサービス".to_owned()];
        proposal.scope.contracts = vec!["取引監視契約".to_owned()];
        let mut master =
            fallback_document_profile("master", std::slice::from_ref(&master_metadata)).unwrap();
        master.role = DocumentRole::Normative;
        master.force.approved = true;
        master.scope = proposal.scope.clone();
        proposal.scope.products = vec!["取引監視AML-3".to_owned()];
        let mut relations = Vec::new();

        complete_relation_family_coverage(
            &mut relations,
            &[proposal, master],
            &[],
            &[
                proposal_metadata,
                proposal_fact.clone(),
                proposal_heading,
                proposal_value.clone(),
                master_metadata,
            ],
        );

        assert_eq!(relations.len(), 1);
        let relation = &relations[0];
        assert_eq!(relation.kind, RelationKind::ProposesChangeTo);
        assert_eq!(relation.position, DocumentPosition::NonEffective);
        assert_eq!(relation.source_id, "proposal");
        assert_eq!(relation.target_id, "master");
        assert_eq!(relation.source_clauses, vec!["契約状態"]);
        assert_eq!(relation.evidence.len(), 2);
        assert!(
            relation
                .evidence
                .iter()
                .any(|reference| reference.evidence_id == proposal_fact.evidence_id)
        );
        assert!(
            relation
                .evidence
                .iter()
                .any(|reference| reference.evidence_id == proposal_value.evidence_id)
        );
    }

    #[test]
    fn approved_specification_amendment_absorbs_only_same_clause_conflict() {
        let mut amendment_metadata = evidence("amendment", 0);
        amendment_metadata.text =
            "---\ndocument_type: specification_amendment\napproved: true\n---".to_owned();
        let specification_metadata = evidence("specification", 0);
        let mut amendment =
            fallback_document_profile("amendment", std::slice::from_ref(&amendment_metadata))
                .unwrap();
        amendment.role = DocumentRole::Normative;
        amendment.force.approved = true;
        let mut specification = fallback_document_profile(
            "specification",
            std::slice::from_ref(&specification_metadata),
        )
        .unwrap();
        specification.role = DocumentRole::Normative;
        specification.force.approved = true;
        let relation = |id: &str, kind: RelationKind, clause: &str| DocumentRelation {
            id: id.to_owned(),
            position: DocumentPosition::Conditional,
            kind,
            source_id: "amendment".to_owned(),
            target_id: "specification".to_owned(),
            source_clauses: vec![clause.to_owned()],
            target_clauses: vec![clause.to_owned()],
            scope: ApplicabilityScope::default(),
            valid_from: None,
            valid_to: None,
            evidence: Vec::new(),
        };
        let mut relations = vec![
            relation("amends", RelationKind::Amends, "review deadline"),
            relation(
                "same-conflict",
                RelationKind::ConflictsWith,
                "review deadline",
            ),
            relation(
                "other-conflict",
                RelationKind::ConflictsWith,
                "retention period",
            ),
        ];

        complete_relation_family_coverage(
            &mut relations,
            &[amendment, specification],
            &[],
            &[amendment_metadata, specification_metadata],
        );

        assert_eq!(relations.len(), 2);
        assert!(relations.iter().any(|relation| relation.id == "amends"));
        assert!(
            relations
                .iter()
                .any(|relation| relation.id == "other-conflict")
        );
    }

    #[test]
    fn precedence_does_not_complete_coverage_without_a_stricter_approved_instruction() {
        let source_evidence = evidence("source", 0);
        let target_evidence = evidence("target", 0);
        let mut source =
            fallback_document_profile("source", std::slice::from_ref(&source_evidence)).unwrap();
        source.role = DocumentRole::Instruction;
        source.force.approved = false;
        source.force.authority_rank = 7;
        source.scope.entities = vec!["白峰メディカル".to_owned()];
        source.scope.sites = vec!["神戸品質センター".to_owned()];
        let mut target =
            fallback_document_profile("target", std::slice::from_ref(&target_evidence)).unwrap();
        target.role = DocumentRole::Instruction;
        target.force.approved = true;
        target.force.authority_rank = 9;
        target.scope.entities = source.scope.entities.clone();
        let mut relations = vec![DocumentRelation {
            id: "precedence".to_owned(),
            position: DocumentPosition::Conditional,
            kind: RelationKind::OrderOfPrecedence,
            source_id: "source".to_owned(),
            target_id: "target".to_owned(),
            source_clauses: Vec::new(),
            target_clauses: Vec::new(),
            scope: source.scope.clone(),
            valid_from: None,
            valid_to: None,
            evidence: vec![EvidenceReference {
                source_id: "source".to_owned(),
                evidence_id: source_evidence.evidence_id.clone(),
            }],
        }];

        complete_relation_family_coverage(
            &mut relations,
            &[source, target],
            &[],
            &[source_evidence, target_evidence],
        );

        assert_eq!(relations.len(), 1);
    }

    #[test]
    fn non_effective_execution_log_position_completes_execution_relation_coverage() {
        let mut log_metadata = evidence("log", 0);
        log_metadata.text =
            "---\ndocument_type: execution_log\nofficial_record: true\n---".to_owned();
        let mut log_fact = evidence("log", 1);
        log_fact.text = "承認済みの一時逸脱に従って作業を実施した。".to_owned();
        let mut deviation_metadata = evidence("deviation", 0);
        deviation_metadata.text =
            "---\ndocument_type: temporary_deviation\napproved: true\n---".to_owned();
        let mut log =
            fallback_document_profile("log", &[log_metadata.clone(), log_fact.clone()]).unwrap();
        log.role = DocumentRole::Record;
        log.official_record = Some(true);
        log.scope.entities = vec!["瑞穂フィナンシャルサービス".to_owned()];
        log.scope.sites = vec!["大阪管理センター".to_owned()];
        log.scope.assets = vec!["COMPLIANCE-AUD-3".to_owned()];
        let mut deviation =
            fallback_document_profile("deviation", &[deviation_metadata.clone()]).unwrap();
        deviation.role = DocumentRole::Instruction;
        deviation.force.approved = true;
        deviation.scope = log.scope.clone();
        let mut relations = vec![DocumentRelation {
            id: "position".to_owned(),
            position: DocumentPosition::NonEffective,
            kind: RelationKind::OperationalPosition,
            source_id: "log".to_owned(),
            target_id: "deviation".to_owned(),
            source_clauses: vec!["実施結果".to_owned()],
            target_clauses: vec!["例外規則".to_owned()],
            scope: log.scope.clone(),
            valid_from: Some("2026-07-01".to_owned()),
            valid_to: Some("2026-07-31".to_owned()),
            evidence: vec![EvidenceReference {
                source_id: "log".to_owned(),
                evidence_id: log_fact.evidence_id.clone(),
            }],
        }];
        let relation_evidence = vec![log_metadata, log_fact, deviation_metadata];

        complete_relation_family_coverage(
            &mut relations,
            &[log.clone(), deviation.clone()],
            &[],
            &relation_evidence,
        );

        assert_eq!(relations.len(), 2);
        let execution = relations
            .iter()
            .find(|relation| relation.kind == RelationKind::RecordsExecutionOf)
            .unwrap();
        assert_eq!(execution.position, DocumentPosition::NonEffective);
        assert_eq!(execution.source_clauses, vec!["実施結果"]);
        assert_eq!(execution.valid_from.as_deref(), Some("2026-07-01"));
        assert_eq!(execution.valid_to.as_deref(), Some("2026-07-31"));

        let mut approval_evidence = relation_evidence;
        approval_evidence[0].text =
            "---\ndocument_type: approval_record\nofficial_record: true\n---".to_owned();
        let mut approval_position = vec![
            relations
                .iter()
                .find(|relation| relation.kind == RelationKind::OperationalPosition)
                .unwrap()
                .clone(),
        ];
        complete_relation_family_coverage(
            &mut approval_position,
            &[log, deviation],
            &[],
            &approval_evidence,
        );
        assert_eq!(approval_position.len(), 1);
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
