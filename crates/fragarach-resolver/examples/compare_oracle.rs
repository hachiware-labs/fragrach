use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use fragarach_ir::{
    DecisionReason, Disposition, DocumentProfile, DocumentRelation, NormalizationCatalog,
    ResolutionCandidate, ResolutionContext, ResolutionOutcome,
};
use fragarach_resolver::{
    DocumentResolver, FilterFirstResolver, RelationGraphResolver, RelevanceOnlyResolver,
    WeightedResolver, normalize_document_set, normalize_resolution_context, validate_relations,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct OracleCase {
    id: String,
    category: String,
    context: ResolutionContext,
    candidates: Vec<ResolutionCandidate>,
    expected: Vec<ExpectedDecision>,
}

#[derive(Debug, Deserialize)]
struct ExpectedDecision {
    source_id: String,
    disposition: Disposition,
    #[serde(default)]
    reasons: Vec<DecisionReason>,
    #[serde(default)]
    relation_path: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
struct Counts {
    cases: usize,
    strict_cases: usize,
    decisions: usize,
    correct_decisions: usize,
    reasons: usize,
    correct_reasons: usize,
    relation_paths: usize,
    correct_relation_paths: usize,
    abstentions: usize,
    correct_abstentions: usize,
}

#[derive(Debug, Serialize)]
struct Metrics {
    strict_case_accuracy: f64,
    decision_accuracy: f64,
    reason_recall: f64,
    relation_path_recall: f64,
    abstention_accuracy: f64,
}

#[derive(Debug, Serialize)]
struct ResolverReport {
    resolver: String,
    metrics: Metrics,
    by_category: BTreeMap<String, Metrics>,
    failed_cases: Vec<String>,
    failed_decisions: Vec<FailedDecision>,
}

#[derive(Debug, Serialize)]
struct FailedDecision {
    case_id: String,
    source_id: String,
    expected: Disposition,
    actual: Option<Disposition>,
    missing_reasons: Vec<DecisionReason>,
    missing_relation_paths: Vec<String>,
}

#[derive(Debug, Serialize)]
struct ComparisonReport {
    schema_version: String,
    corpus: String,
    cases: usize,
    candidate_snapshot: String,
    document_input: String,
    normalization_diagnostics: BTreeMap<String, usize>,
    reports: Vec<ResolverReport>,
}

#[derive(Debug, Deserialize)]
struct SavedExtractionReport {
    extraction: SavedExtraction,
}

#[derive(Debug, Deserialize)]
struct SavedExtraction {
    profiles: Vec<DocumentProfile>,
    relations: Vec<DocumentRelation>,
    provider: String,
    model: String,
}

#[derive(Debug, Default)]
struct Options {
    output: Option<PathBuf>,
    extraction: Option<PathBuf>,
    catalog: Option<PathBuf>,
    corpus: Option<PathBuf>,
}

fn main() -> Result<()> {
    let options = parse_options()?;
    let json = build_report_json_with_options(&options)?;
    if let Some(output) = options.output {
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&output, format!("{json}\n"))
            .with_context(|| format!("failed to write {}", output.display()))?;
        eprintln!("wrote {}", output.display());
    }
    println!("{json}");
    Ok(())
}

pub fn build_report_json() -> Result<String> {
    build_report_json_with_options(&Options::default())
}

pub fn build_report_json_for_corpus(corpus: impl Into<PathBuf>) -> Result<String> {
    build_report_json_with_options(&Options {
        corpus: Some(corpus.into()),
        ..Default::default()
    })
}

fn build_report_json_with_options(options: &Options) -> Result<String> {
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
    let cases: Vec<OracleCase> = read_jsonl(&corpus.join("evaluation/cases.jsonl"))?;
    let catalog_path = options
        .catalog
        .clone()
        .unwrap_or_else(|| corpus.join("world/normalization-catalog.json"));
    let catalog: NormalizationCatalog = serde_json::from_slice(&fs::read(&catalog_path)?)
        .with_context(|| format!("failed to parse {}", catalog_path.display()))?;
    let (profiles, relations, document_input) = if let Some(path) = &options.extraction {
        let saved: SavedExtractionReport = serde_json::from_slice(&fs::read(path)?)
            .with_context(|| format!("failed to parse {}", path.display()))?;
        let label = format!("{}:{}", saved.extraction.provider, saved.extraction.model);
        (saved.extraction.profiles, saved.extraction.relations, label)
    } else {
        (
            gold_profiles.clone(),
            gold_relations.clone(),
            "oracle".to_owned(),
        )
    };
    let normalized = normalize_document_set(&profiles, &relations, &catalog);
    let profiles = normalized.profiles;
    let relations = normalized.relations;
    let relation_errors = validate_relations(&profiles, &relations);
    if !relation_errors.is_empty() {
        bail!("invalid document relations: {}", relation_errors.join("; "));
    }
    if cases.is_empty() {
        bail!("oracle cases must not be empty");
    }
    validate_oracle(&corpus, &gold_profiles, &cases)?;

    let cases = cases
        .into_iter()
        .map(|mut case| {
            case.context = normalize_resolution_context(&case.context, &catalog);
            case
        })
        .collect::<Vec<_>>();

    let resolvers: Vec<Box<dyn DocumentResolver>> = vec![
        Box::new(RelevanceOnlyResolver),
        Box::new(WeightedResolver),
        Box::new(FilterFirstResolver),
        Box::new(RelationGraphResolver),
    ];
    let reports = resolvers
        .iter()
        .map(|resolver| {
            evaluate(
                resolver.as_ref(),
                &cases,
                &profiles,
                &relations,
                &gold_relations,
            )
        })
        .collect();
    let mut normalization_diagnostics = BTreeMap::new();
    for diagnostic in normalized.diagnostics {
        *normalization_diagnostics
            .entry(diagnostic.code)
            .or_default() += 1;
    }
    let report = ComparisonReport {
        schema_version: "document-validity-comparison-v1".to_owned(),
        corpus: corpus_name,
        cases: cases.len(),
        candidate_snapshot: format!("oracle-fixed-{}-v1", cases.len()),
        document_input,
        normalization_diagnostics,
        reports,
    };
    Ok(serde_json::to_string_pretty(&report)?)
}

fn validate_oracle(
    corpus: &Path,
    profiles: &[DocumentProfile],
    cases: &[OracleCase],
) -> Result<()> {
    let mut profile_ids = HashSet::new();
    for profile in profiles {
        if !profile_ids.insert(profile.source_id.as_str()) {
            bail!("duplicate profile source_id: {}", profile.source_id);
        }
        if !corpus.join(&profile.source_id).is_file() {
            bail!("profile source does not exist: {}", profile.source_id);
        }
    }
    let mut case_ids = HashSet::new();
    for case in cases {
        if !case_ids.insert(case.id.as_str()) {
            bail!("duplicate case id: {}", case.id);
        }
        let candidate_ids = case
            .candidates
            .iter()
            .map(|candidate| candidate.source_id.as_str())
            .collect::<HashSet<_>>();
        if candidate_ids.len() != case.candidates.len() {
            bail!("case {} contains duplicate candidates", case.id);
        }
        for candidate in &case.candidates {
            if !profile_ids.contains(candidate.source_id.as_str()) {
                bail!(
                    "case {} candidate has no profile: {}",
                    case.id,
                    candidate.source_id
                );
            }
        }
        for expected in &case.expected {
            if !candidate_ids.contains(expected.source_id.as_str()) {
                bail!(
                    "case {} expected source is not a candidate: {}",
                    case.id,
                    expected.source_id
                );
            }
        }
    }
    Ok(())
}

fn evaluate(
    resolver: &dyn DocumentResolver,
    cases: &[OracleCase],
    profiles: &[DocumentProfile],
    relations: &[DocumentRelation],
    gold_relations: &[DocumentRelation],
) -> ResolverReport {
    let mut total = Counts::default();
    let mut categories: BTreeMap<String, Counts> = BTreeMap::new();
    let mut failed_cases = Vec::new();
    let mut failed_decisions = Vec::new();
    for case in cases {
        let outcome = resolver.resolve(&case.context, &case.candidates, profiles, relations);
        let category = categories.entry(case.category.clone()).or_default();
        let strict = score_case(case, &outcome, &mut total, gold_relations, relations);
        score_case(case, &outcome, category, gold_relations, relations);
        if !strict {
            failed_cases.push(case.id.clone());
            failed_decisions.extend(collect_failures(case, &outcome, gold_relations, relations));
        }
    }
    ResolverReport {
        resolver: resolver.name().to_owned(),
        metrics: metrics(&total),
        by_category: categories
            .into_iter()
            .map(|(category, counts)| (category, metrics(&counts)))
            .collect(),
        failed_cases,
        failed_decisions,
    }
}

fn collect_failures(
    case: &OracleCase,
    outcome: &ResolutionOutcome,
    expected_relations: &[DocumentRelation],
    actual_relations: &[DocumentRelation],
) -> Vec<FailedDecision> {
    let mut failures = Vec::new();
    for expected in &case.expected {
        let actual = outcome
            .decisions
            .iter()
            .find(|decision| decision.candidate_id == expected.source_id);
        let missing_reasons = expected
            .reasons
            .iter()
            .filter(|reason| actual.is_none_or(|decision| !decision.reasons.contains(reason)))
            .cloned()
            .collect::<Vec<_>>();
        let actual_relation_keys = actual
            .into_iter()
            .flat_map(|decision| &decision.relation_path)
            .filter_map(|id| relation_key_by_id(actual_relations, id))
            .collect::<HashSet<_>>();
        let missing_relation_paths = expected
            .relation_path
            .iter()
            .filter(|id| {
                relation_key_by_id(expected_relations, id)
                    .is_none_or(|key| !actual_relation_keys.contains(&key))
            })
            .cloned()
            .collect::<Vec<_>>();
        if actual.map(|decision| &decision.disposition) != Some(&expected.disposition)
            || !missing_reasons.is_empty()
            || !missing_relation_paths.is_empty()
        {
            failures.push(FailedDecision {
                case_id: case.id.clone(),
                source_id: expected.source_id.clone(),
                expected: expected.disposition.clone(),
                actual: actual.map(|decision| decision.disposition.clone()),
                missing_reasons,
                missing_relation_paths,
            });
        }
    }
    failures
}

fn score_case(
    case: &OracleCase,
    outcome: &ResolutionOutcome,
    counts: &mut Counts,
    expected_relations: &[DocumentRelation],
    actual_relations: &[DocumentRelation],
) -> bool {
    counts.cases += 1;
    let mut strict = true;
    for expected in &case.expected {
        counts.decisions += 1;
        let actual = outcome
            .decisions
            .iter()
            .find(|decision| decision.candidate_id == expected.source_id);
        let disposition_correct = actual
            .map(|decision| decision.disposition == expected.disposition)
            .unwrap_or(false);
        if disposition_correct {
            counts.correct_decisions += 1;
        } else {
            strict = false;
        }
        for reason in &expected.reasons {
            counts.reasons += 1;
            if actual
                .map(|decision| decision.reasons.contains(reason))
                .unwrap_or(false)
            {
                counts.correct_reasons += 1;
            } else {
                strict = false;
            }
        }
        for relation in &expected.relation_path {
            counts.relation_paths += 1;
            let expected_key = relation_key_by_id(expected_relations, relation);
            let actual_keys = actual
                .into_iter()
                .flat_map(|decision| &decision.relation_path)
                .filter_map(|id| relation_key_by_id(actual_relations, id))
                .collect::<HashSet<_>>();
            if expected_key.is_some_and(|key| actual_keys.contains(&key)) {
                counts.correct_relation_paths += 1;
            } else {
                strict = false;
            }
        }
        if expected.disposition == Disposition::Unresolved {
            counts.abstentions += 1;
            if disposition_correct {
                counts.correct_abstentions += 1;
            }
        }
    }
    if strict {
        counts.strict_cases += 1;
    }
    strict
}

fn relation_key_by_id(relations: &[DocumentRelation], id: &str) -> Option<String> {
    relations
        .iter()
        .find(|relation| relation.id == id)
        .map(|relation| {
            format!(
                "{:?}|{}|{}",
                relation.kind, relation.source_id, relation.target_id
            )
        })
}

fn metrics(counts: &Counts) -> Metrics {
    Metrics {
        strict_case_accuracy: ratio(counts.strict_cases, counts.cases),
        decision_accuracy: ratio(counts.correct_decisions, counts.decisions),
        reason_recall: ratio(counts.correct_reasons, counts.reasons),
        relation_path_recall: ratio(counts.correct_relation_paths, counts.relation_paths),
        abstention_accuracy: ratio(counts.correct_abstentions, counts.abstentions),
    }
}

fn ratio(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 {
        1.0
    } else {
        numerator as f64 / denominator as f64
    }
}

fn read_jsonl<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Vec<T>> {
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
    let mut options = Options::default();
    let mut arguments = std::env::args().skip(1);
    while let Some(argument) = arguments.next() {
        let value = arguments
            .next()
            .with_context(|| format!("{argument} requires a value"))?;
        match argument.as_str() {
            "--output" => options.output = Some(PathBuf::from(value)),
            "--extraction" => options.extraction = Some(PathBuf::from(value)),
            "--catalog" => options.catalog = Some(PathBuf::from(value)),
            "--corpus" => options.corpus = Some(PathBuf::from(value)),
            _ => bail!("unknown argument: {argument}"),
        }
    }
    Ok(options)
}
