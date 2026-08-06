use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use fragarach_ir::{DocumentProfile, DocumentRelation};
use fragarach_llm::{
    CodexAppServerClaimExtractor, DocumentProfileExtractionRequest,
    DocumentProfileExtractionResponse, DocumentProfileExtractor, OllamaClaimExtractor,
    PromptEvidence,
};
use fragarach_resolver::validate_relations;
use serde::Serialize;

#[derive(Debug, Serialize)]
struct FieldMetrics {
    gold_profiles: usize,
    predicted_profiles: usize,
    profile_coverage: f64,
    role_accuracy: f64,
    force_level_accuracy: f64,
    approval_accuracy: f64,
    authority_rank_accuracy: f64,
    authority_rank_mean_absolute_error: f64,
    scope_dimension_accuracy: f64,
    scope_value_accuracy: f64,
    temporal_accuracy: f64,
    official_record_accuracy: f64,
    gold_relations: usize,
    predicted_relations: usize,
    relation_precision: f64,
    relation_recall: f64,
    evidence_grounding_rate: f64,
    relation_validation_errors: Vec<String>,
    evaluated_fields: BTreeMap<String, usize>,
}

#[derive(Debug, serde::Deserialize)]
struct ExtractionFields {
    source_id: String,
    fields: HashSet<String>,
}

#[derive(Debug, Serialize)]
struct ExtractionReport<'a> {
    schema_version: &'static str,
    corpus: String,
    metrics: FieldMetrics,
    extraction: &'a DocumentProfileExtractionResponse,
}

#[derive(Debug)]
struct Options {
    provider: String,
    model: String,
    effort: String,
    endpoint: String,
    output: PathBuf,
    input: Option<PathBuf>,
    corpus: Option<PathBuf>,
}

#[derive(Debug, serde::Deserialize)]
struct SavedExtractionReport {
    extraction: DocumentProfileExtractionResponse,
}

fn main() -> Result<()> {
    let options = parse_options()?;
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let corpus = options
        .corpus
        .as_ref()
        .map(|path| {
            if path.is_absolute() {
                path.clone()
            } else {
                repository.join(path)
            }
        })
        .unwrap_or_else(|| repository.join("tests/corpora/aobane-industries-ja-validity"));
    let corpus_name = corpus
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("document-validity")
        .to_owned();
    let gold_profiles: Vec<DocumentProfile> = read_jsonl(&corpus.join("oracle/profiles.jsonl"))?;
    let gold_relations: Vec<DocumentRelation> = read_jsonl(&corpus.join("oracle/relations.jsonl"))?;
    let extraction_fields: Vec<ExtractionFields> =
        read_jsonl(&corpus.join("oracle/extraction-fields.jsonl"))?;
    let request = build_request(&corpus, &gold_profiles)?;
    let extraction = if let Some(input) = &options.input {
        serde_json::from_slice::<SavedExtractionReport>(
            &fs::read(input).with_context(|| format!("failed to read {}", input.display()))?,
        )
        .with_context(|| format!("failed to parse {}", input.display()))?
        .extraction
    } else {
        let extractor: Box<dyn DocumentProfileExtractor> = match options.provider.as_str() {
            "ollama" => Box::new(OllamaClaimExtractor::new(
                &options.endpoint,
                &options.model,
                Duration::from_secs(15 * 60),
                42,
            )?),
            "codex" | "codex-app-server" => Box::new(CodexAppServerClaimExtractor::new(
                "codex",
                &options.model,
                &options.effort,
                &repository,
                Duration::from_secs(15 * 60),
            )?),
            provider => bail!("unsupported provider {provider}; use ollama or codex"),
        };
        extractor.extract_profiles(&request)?
    };
    let metrics = evaluate(
        &request,
        &gold_profiles,
        &gold_relations,
        &extraction_fields,
        &extraction,
    );
    let report = ExtractionReport {
        schema_version: "document-profile-extraction-comparison-v1",
        corpus: corpus_name,
        metrics,
        extraction: &extraction,
    };
    let json = serde_json::to_string_pretty(&report)?;
    if let Some(parent) = options.output.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&options.output, format!("{json}\n"))
        .with_context(|| format!("failed to write {}", options.output.display()))?;
    println!("{json}");
    eprintln!("wrote {}", options.output.display());
    Ok(())
}

fn build_request(
    corpus: &Path,
    profiles: &[DocumentProfile],
) -> Result<DocumentProfileExtractionRequest> {
    let mut evidence = Vec::with_capacity(profiles.len());
    for (index, profile) in profiles.iter().enumerate() {
        let path = corpus.join(&profile.source_id);
        evidence.push(PromptEvidence {
            source_id: profile.source_id.clone(),
            evidence_id: format!("validity-document-{index:02}"),
            source_path: profile.source_id.clone(),
            source_aliases: Vec::new(),
            heading_path: Vec::new(),
            authority: None,
            lifecycle: None,
            valid_from: None,
            valid_to: None,
            text: fs::read_to_string(&path)
                .with_context(|| format!("failed to read {}", path.display()))?,
        });
    }
    Ok(DocumentProfileExtractionRequest { evidence })
}

fn evaluate(
    request: &DocumentProfileExtractionRequest,
    gold_profiles: &[DocumentProfile],
    gold_relations: &[DocumentRelation],
    extraction_fields: &[ExtractionFields],
    extraction: &DocumentProfileExtractionResponse,
) -> FieldMetrics {
    let predicted = extraction
        .profiles
        .iter()
        .map(|profile| (profile.source_id.as_str(), profile))
        .collect::<HashMap<_, _>>();
    let mut covered = 0;
    let mut role = 0;
    let mut force = 0;
    let mut approval = 0;
    let mut rank = 0;
    let mut rank_error = 0_u64;
    let mut scope = 0;
    let mut temporal = 0;
    let mut official = 0;
    let mut scope_dimensions = 0;
    let evaluable = extraction_fields
        .iter()
        .map(|item| (item.source_id.as_str(), &item.fields))
        .collect::<HashMap<_, _>>();
    let mut denominators: BTreeMap<String, usize> = BTreeMap::new();
    for gold in gold_profiles {
        let Some(actual) = predicted.get(gold.source_id.as_str()) else {
            continue;
        };
        covered += 1;
        let fields = evaluable
            .get(gold.source_id.as_str())
            .copied()
            .cloned()
            .unwrap_or_default();
        if fields.contains("role") {
            *denominators.entry("role".to_owned()).or_default() += 1;
            role += usize::from(actual.role == gold.role);
        }
        if fields.contains("force_level") {
            *denominators.entry("force_level".to_owned()).or_default() += 1;
            force += usize::from(actual.force.level == gold.force.level);
        }
        if fields.contains("approval") {
            *denominators.entry("approval".to_owned()).or_default() += 1;
            approval += usize::from(actual.force.approved == gold.force.approved);
        }
        if fields.contains("authority_rank") {
            *denominators.entry("authority_rank".to_owned()).or_default() += 1;
            rank += usize::from(actual.force.authority_rank == gold.force.authority_rank);
            rank_error += u64::from(
                actual
                    .force
                    .authority_rank
                    .abs_diff(gold.force.authority_rank),
            );
        }
        if fields.contains("scope") {
            *denominators.entry("scope".to_owned()).or_default() += 1;
            scope += usize::from(normalized_scope(&actual.scope) == normalized_scope(&gold.scope));
            scope_dimensions +=
                usize::from(scope_dimensions_of(&actual.scope) == scope_dimensions_of(&gold.scope));
        }
        if fields.contains("temporal") {
            *denominators.entry("temporal".to_owned()).or_default() += 1;
            temporal += usize::from(actual.time == gold.time);
        }
        if fields.contains("official_record") {
            *denominators
                .entry("official_record".to_owned())
                .or_default() += 1;
            official += usize::from(actual.official_record == gold.official_record);
        }
    }
    let gold_relation_keys = gold_relations
        .iter()
        .map(relation_key)
        .collect::<HashSet<_>>();
    let predicted_relation_keys = extraction
        .relations
        .iter()
        .map(relation_key)
        .collect::<HashSet<_>>();
    let correct_relations = predicted_relation_keys
        .intersection(&gold_relation_keys)
        .count();
    let available_evidence = request
        .evidence
        .iter()
        .map(|item| (item.source_id.as_str(), item.evidence_id.as_str()))
        .collect::<HashSet<_>>();
    let references = extraction
        .profiles
        .iter()
        .flat_map(|profile| &profile.evidence)
        .chain(
            extraction
                .relations
                .iter()
                .flat_map(|relation| &relation.evidence),
        )
        .collect::<Vec<_>>();
    let grounded = references
        .iter()
        .filter(|reference| {
            available_evidence
                .contains(&(reference.source_id.as_str(), reference.evidence_id.as_str()))
        })
        .count();
    FieldMetrics {
        gold_profiles: gold_profiles.len(),
        predicted_profiles: extraction.profiles.len(),
        profile_coverage: ratio(covered, gold_profiles.len()),
        role_accuracy: ratio(role, field_count(&denominators, "role")),
        force_level_accuracy: ratio(force, field_count(&denominators, "force_level")),
        approval_accuracy: ratio(approval, field_count(&denominators, "approval")),
        authority_rank_accuracy: ratio(rank, field_count(&denominators, "authority_rank")),
        authority_rank_mean_absolute_error: if field_count(&denominators, "authority_rank") == 0 {
            0.0
        } else {
            rank_error as f64 / field_count(&denominators, "authority_rank") as f64
        },
        scope_dimension_accuracy: ratio(scope_dimensions, field_count(&denominators, "scope")),
        scope_value_accuracy: ratio(scope, field_count(&denominators, "scope")),
        temporal_accuracy: ratio(temporal, field_count(&denominators, "temporal")),
        official_record_accuracy: ratio(official, field_count(&denominators, "official_record")),
        gold_relations: gold_relations.len(),
        predicted_relations: extraction.relations.len(),
        relation_precision: ratio(correct_relations, predicted_relation_keys.len()),
        relation_recall: ratio(correct_relations, gold_relation_keys.len()),
        evidence_grounding_rate: ratio(grounded, references.len()),
        relation_validation_errors: validate_relations(&extraction.profiles, &extraction.relations),
        evaluated_fields: denominators,
    }
}

fn field_count(counts: &BTreeMap<String, usize>, field: &str) -> usize {
    counts.get(field).copied().unwrap_or_default()
}

fn scope_dimensions_of(scope: &fragarach_ir::ApplicabilityScope) -> Vec<&'static str> {
    let mut dimensions = Vec::new();
    for (name, values) in [
        ("jurisdictions", &scope.jurisdictions),
        ("entities", &scope.entities),
        ("sites", &scope.sites),
        ("products", &scope.products),
        ("assets", &scope.assets),
        ("persons", &scope.persons),
        ("projects", &scope.projects),
        ("lots", &scope.lots),
        ("contracts", &scope.contracts),
    ] {
        if !normalized_values(values).is_empty() {
            dimensions.push(name);
        }
    }
    dimensions
}

fn normalized_scope(scope: &fragarach_ir::ApplicabilityScope) -> Vec<(&'static str, Vec<String>)> {
    [
        ("jurisdictions", &scope.jurisdictions),
        ("entities", &scope.entities),
        ("sites", &scope.sites),
        ("products", &scope.products),
        ("assets", &scope.assets),
        ("persons", &scope.persons),
        ("projects", &scope.projects),
        ("lots", &scope.lots),
        ("contracts", &scope.contracts),
    ]
    .into_iter()
    .filter_map(|(name, values)| {
        let values = normalized_values(values);
        (!values.is_empty()).then_some((name, values))
    })
    .collect()
}

fn normalized_values(values: &[String]) -> Vec<String> {
    let mut values = values
        .iter()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty() && value != "null" && value != "all")
        .collect::<Vec<_>>();
    values.sort();
    values.dedup();
    values
}

fn relation_key(relation: &DocumentRelation) -> String {
    format!(
        "{:?}|{}|{}",
        relation.kind, relation.source_id, relation.target_id
    )
}

fn ratio(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 {
        0.0
    } else {
        numerator as f64 / denominator as f64
    }
}

fn read_jsonl<T: for<'de> serde::Deserialize<'de>>(path: &Path) -> Result<Vec<T>> {
    fs::read_to_string(path)
        .with_context(|| format!("failed to read {}", path.display()))?
        .lines()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
        .map(|(index, line)| {
            serde_json::from_str(line).with_context(|| format!("{}:{}", path.display(), index + 1))
        })
        .collect()
}

fn parse_options() -> Result<Options> {
    let mut provider = "ollama".to_owned();
    let mut model = "gemma4:latest".to_owned();
    let mut effort = "low".to_owned();
    let mut endpoint = "http://127.0.0.1:11434".to_owned();
    let mut output = None;
    let mut input = None;
    let mut corpus = None;
    let mut arguments = std::env::args().skip(1);
    while let Some(argument) = arguments.next() {
        let value = match argument.as_str() {
            "--provider" | "--model" | "--effort" | "--endpoint" | "--output" | "--input"
            | "--corpus" => arguments
                .next()
                .with_context(|| format!("{argument} requires a value"))?,
            _ => bail!("unknown argument: {argument}"),
        };
        match argument.as_str() {
            "--provider" => provider = value,
            "--model" => model = value,
            "--effort" => effort = value,
            "--endpoint" => endpoint = value,
            "--output" => output = Some(PathBuf::from(value)),
            "--input" => input = Some(PathBuf::from(value)),
            "--corpus" => corpus = Some(PathBuf::from(value)),
            _ => unreachable!(),
        }
    }
    let output = output.unwrap_or_else(|| {
        PathBuf::from(format!(
            "target/benchmarks/document-validity/profile-extraction-{}-{}.json",
            provider,
            model.replace(['/', ':'], "-")
        ))
    });
    Ok(Options {
        provider,
        model,
        effort,
        endpoint,
        output,
        input,
        corpus,
    })
}
