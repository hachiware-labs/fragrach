use std::collections::HashSet;
use std::fmt;
use std::fmt::Write as _;
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use chrono::NaiveDate;
use fragarach_ir::{
    Claim, CompilationPolicy, Conflict, ConflictKind, ConflictStatus, Diagnostic,
    DiagnosticSeverity, ParsedDocument, UsageIntent,
};
use fragarach_llm::{ClaimCandidate, ClaimExtractionResponse, PromptEvidence};
use sha2::{Digest, Sha256};

mod pipeline;

pub use pipeline::{
    BuildReport, CompileOptions, CompileResult, RecompileOptions, compile_workspace,
    export_rag_jsonl, read_build_report, recompile_build,
};

pub const REQUIRED_BUILD_ARTIFACTS: &[(&str, &str)] = &[
    ("usage_intent", "usage-intent.yaml"),
    ("claims", "claims.jsonl"),
    ("evidence", "evidence.jsonl"),
    ("conflicts", "conflicts.jsonl"),
    ("diagnostics", "diagnostics.jsonl"),
    ("unresolved_questions", "unresolved-questions.md"),
    ("retrieval_profile", "retrieval-profile.yaml"),
    ("answer_contract", "answer-contract.yaml"),
    ("overview", "overview.md"),
    ("provenance", "provenance.json"),
];

#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedExtraction {
    pub claims: Vec<Claim>,
    pub diagnostics: Vec<Diagnostic>,
    pub rejected_claims: usize,
}

#[derive(Debug, Clone, Default)]
pub struct ConflictContext {
    pub as_of: Option<NaiveDate>,
    /// Highest authority first. An authority not listed here has no implied rank.
    pub authority_precedence: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictAnalysis {
    pub conflicts: Vec<Conflict>,
    pub diagnostics: Vec<Diagnostic>,
}

pub fn analyze_conflicts(
    claims: &[Claim],
    context: &ConflictContext,
    policy: &CompilationPolicy,
) -> ConflictAnalysis {
    let mut conflicts = Vec::new();
    let mut diagnostics = Vec::new();

    for left_index in 0..claims.len() {
        for right_index in (left_index + 1)..claims.len() {
            let left = &claims[left_index];
            let right = &claims[right_index];
            if !same_claim_slot(left, right) || left.object == right.object {
                continue;
            }

            let id = stable_conflict_id(&left.id, &right.id);
            let resolution = deterministic_resolution(left, right, context);
            let (kind, status, resolution_text, diagnostic_id) =
                if let Some((kind, text)) = resolution {
                    (kind, ConflictStatus::Resolved, Some(text), None)
                } else {
                    let diagnostic_id = format!("diag_{id}");
                    diagnostics.push(unresolved_conflict_diagnostic(
                        &diagnostic_id,
                        &id,
                        left,
                        right,
                        policy,
                    ));
                    (
                        ConflictKind::Semantic,
                        ConflictStatus::Unresolved,
                        None,
                        Some(diagnostic_id),
                    )
                };
            conflicts.push(Conflict {
                id,
                kind,
                claim_ids: vec![left.id.clone(), right.id.clone()],
                status,
                resolution: resolution_text,
                diagnostic_id,
            });
        }
    }

    ConflictAnalysis {
        conflicts,
        diagnostics,
    }
}

pub fn prompt_evidence_from_documents(documents: &[ParsedDocument]) -> Vec<PromptEvidence> {
    documents
        .iter()
        .flat_map(|document| {
            document.evidence.iter().map(|unit| PromptEvidence {
                source_id: document.source_id.clone(),
                evidence_id: unit.id.clone(),
                source_path: document.source_path.clone(),
                source_aliases: Vec::new(),
                heading_path: unit.position.heading_path.clone(),
                authority: None,
                lifecycle: None,
                valid_from: None,
                valid_to: None,
                text: unit.text.clone(),
            })
        })
        .collect()
}

pub fn validate_extraction(
    response: ClaimExtractionResponse,
    available_evidence: &[PromptEvidence],
) -> ValidatedExtraction {
    let available: HashSet<(&str, &str)> = available_evidence
        .iter()
        .map(|evidence| (evidence.source_id.as_str(), evidence.evidence_id.as_str()))
        .collect();
    let mut claims = Vec::new();
    let mut diagnostics = Vec::new();
    let mut rejected_claims = 0;

    for (index, mut candidate) in response.claims.into_iter().enumerate() {
        apply_source_metadata(&mut candidate, available_evidence);
        normalize_candidate_semantics(&mut candidate);
        let reasons = candidate_validation_errors(&candidate, &available);
        if !reasons.is_empty() {
            rejected_claims += 1;
            diagnostics.push(rejected_candidate_diagnostic(index, &candidate, reasons));
            continue;
        }

        let claim = materialize_claim(candidate);
        if let Err(reason) = claim.validate() {
            rejected_claims += 1;
            diagnostics.push(rejected_candidate_diagnostic(
                index,
                &claim_candidate_from_claim(&claim),
                vec![reason.to_owned()],
            ));
            continue;
        }
        claims.push(claim);
    }

    ValidatedExtraction {
        claims,
        diagnostics,
        rejected_claims,
    }
}

fn normalize_candidate_semantics(candidate: &mut ClaimCandidate) {
    clear_relative_duration(&mut candidate.valid_from);
    clear_relative_duration(&mut candidate.valid_to);
    match candidate.predicate.as_str() {
        "requires_review" | "allows_review_omission" => {
            if let Some(detail) = scalar_text(&candidate.object) {
                append_condition(&mut candidate.condition, &detail);
            }
            candidate.object = serde_json::Value::Bool(true);
        }
        "allows_self_approval" => {
            let text = scalar_text(&candidate.object).unwrap_or_default();
            let denied = ["なし", "不可", "禁止", "認めない", "false"]
                .iter()
                .any(|marker| text.to_lowercase().contains(marker));
            candidate.object = serde_json::Value::Bool(!denied);
        }
        _ => {}
    }
}

fn clear_relative_duration(value: &mut Option<String>) {
    if value.as_deref().is_some_and(looks_like_relative_duration) {
        *value = None;
    }
}

fn looks_like_relative_duration(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    [
        "分以内",
        "時間以内",
        "日以内",
        "営業日",
        "週間以内",
        "週以内",
        "か月以内",
        "ヶ月以内",
        "月以内",
        "年以内",
        "minutes",
        "hours",
        "business days",
        "days",
        "weeks",
        "months",
        "years",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

fn scalar_text(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text)
            if !text.trim().is_empty() && !text.eq_ignore_ascii_case("null") =>
        {
            Some(text.trim().to_owned())
        }
        _ => None,
    }
}

fn append_condition(condition: &mut Option<String>, detail: &str) {
    *condition = match condition.take() {
        Some(existing) if !existing.trim().is_empty() && existing.trim() != detail => {
            Some(format!("{}; {detail}", existing.trim()))
        }
        Some(existing) if !existing.trim().is_empty() => Some(existing),
        _ => Some(detail.to_owned()),
    };
}

fn apply_source_metadata(candidate: &mut ClaimCandidate, evidence: &[PromptEvidence]) {
    let referenced = evidence
        .iter()
        .filter(|item| {
            candidate.evidence.iter().any(|reference| {
                reference.source_id == item.source_id && reference.evidence_id == item.evidence_id
            })
        })
        .collect::<Vec<_>>();
    let authorities = referenced
        .iter()
        .filter_map(|item| item.authority.as_deref())
        .collect::<HashSet<_>>();
    candidate.authority = if authorities.len() == 1 {
        authorities.into_iter().next().map(str::to_owned)
    } else {
        None
    };
    let lifecycles = referenced
        .iter()
        .filter_map(|item| item.lifecycle.as_deref())
        .collect::<HashSet<_>>();
    if lifecycles.len() == 1 {
        candidate.status = lifecycles.into_iter().next().map(str::to_owned);
    }
    let valid_from = referenced
        .iter()
        .filter_map(|item| item.valid_from.as_deref())
        .collect::<HashSet<_>>();
    if valid_from.len() == 1 {
        candidate.valid_from = valid_from.into_iter().next().map(str::to_owned);
    }
    let valid_to = referenced
        .iter()
        .filter_map(|item| item.valid_to.as_deref())
        .collect::<HashSet<_>>();
    if valid_to.len() == 1 {
        candidate.valid_to = valid_to.into_iter().next().map(str::to_owned);
    }
}

fn candidate_validation_errors(
    candidate: &ClaimCandidate,
    available: &HashSet<(&str, &str)>,
) -> Vec<String> {
    let mut reasons = Vec::new();
    if candidate.subject.trim().is_empty()
        || candidate.predicate.trim().is_empty()
        || candidate.object.is_null()
    {
        reasons.push("subject, predicate and object are required".to_owned());
    }
    if !candidate.confidence.is_finite() || !(0.0..=1.0).contains(&candidate.confidence) {
        reasons.push("confidence must be between 0 and 1".to_owned());
    }
    if candidate.evidence.is_empty() {
        reasons.push("at least one evidence reference is required".to_owned());
    }
    for (field, value) in [
        ("valid_from", candidate.valid_from.as_deref()),
        ("valid_to", candidate.valid_to.as_deref()),
    ] {
        if let Some(value) = value
            && NaiveDate::parse_from_str(value, "%Y-%m-%d").is_err()
        {
            reasons.push(format!("{field} must be an ISO 8601 calendar date"));
        }
    }
    if let (Some(from), Some(to)) = (
        parse_date(candidate.valid_from.as_deref()),
        parse_date(candidate.valid_to.as_deref()),
    ) && from > to
    {
        reasons.push("valid_from must not be later than valid_to".to_owned());
    }
    for reference in &candidate.evidence {
        if !available.contains(&(reference.source_id.as_str(), reference.evidence_id.as_str())) {
            reasons.push(format!(
                "unknown evidence reference {}/{}",
                reference.source_id, reference.evidence_id
            ));
        }
    }
    reasons
}

fn materialize_claim(mut candidate: ClaimCandidate) -> Claim {
    candidate.subject = candidate.subject.trim().to_owned();
    candidate.predicate = candidate.predicate.trim().to_owned();
    let id = stable_claim_id(&candidate);
    Claim {
        id,
        subject: candidate.subject,
        predicate: candidate.predicate,
        object: candidate.object,
        condition: trim_option(candidate.condition),
        valid_from: trim_option(candidate.valid_from),
        valid_to: trim_option(candidate.valid_to),
        authority: trim_option(candidate.authority),
        status: trim_option(candidate.status),
        confidence: candidate.confidence,
        evidence: candidate.evidence,
    }
}

fn stable_claim_id(candidate: &ClaimCandidate) -> String {
    let canonical =
        serde_json::to_vec(candidate).expect("serializing a claim candidate cannot fail");
    let digest = Sha256::digest(canonical);
    let mut hex = String::with_capacity(32);
    for byte in &digest[..16] {
        write!(&mut hex, "{byte:02x}").expect("writing to a String cannot fail");
    }
    format!("clm_{hex}")
}

fn trim_option(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty() && !text.eq_ignore_ascii_case("null"))
}

fn rejected_candidate_diagnostic(
    index: usize,
    candidate: &ClaimCandidate,
    reasons: Vec<String>,
) -> Diagnostic {
    let evidence_ids = candidate
        .evidence
        .iter()
        .map(|reference| reference.evidence_id.clone())
        .collect();
    Diagnostic {
        id: format!("diag_extraction_{index:04}"),
        code: "FRG-EXT-INVALID-CLAIM".to_owned(),
        severity: DiagnosticSeverity::Warning,
        message: "LLMが返したClaim候補を根拠検証で棄却しました".to_owned(),
        target_ids: vec![format!("candidate:{index}")],
        evidence_ids,
        reason: reasons.join("; "),
        suggestions: vec![
            "入力EvidenceとProvider設定を確認し、再コンパイルしてください".to_owned(),
        ],
        questions: Vec::new(),
    }
}

fn claim_candidate_from_claim(claim: &Claim) -> ClaimCandidate {
    ClaimCandidate {
        subject: claim.subject.clone(),
        predicate: claim.predicate.clone(),
        object: claim.object.clone(),
        condition: claim.condition.clone(),
        valid_from: claim.valid_from.clone(),
        valid_to: claim.valid_to.clone(),
        authority: claim.authority.clone(),
        status: claim.status.clone(),
        confidence: claim.confidence,
        evidence: claim.evidence.clone(),
    }
}

fn same_claim_slot(left: &Claim, right: &Claim) -> bool {
    predicate_is_single_valued(&left.predicate)
        && subjects_equivalent(&left.subject, &right.subject)
        && left
            .predicate
            .trim()
            .eq_ignore_ascii_case(right.predicate.trim())
        && (!predicate_requires_matching_condition(&left.predicate)
            || normalized_condition(left.condition.as_deref())
                == normalized_condition(right.condition.as_deref()))
}

fn subjects_equivalent(left: &str, right: &str) -> bool {
    let left = left.trim().to_lowercase();
    let right = right.trim().to_lowercase();
    left == right
        || (left.chars().count().min(right.chars().count()) >= 4
            && (left.ends_with(&right) || right.ends_with(&left)))
}

fn predicate_requires_matching_condition(predicate: &str) -> bool {
    matches!(
        predicate.trim().to_ascii_lowercase().as_str(),
        "requires_review"
            | "allows_review_omission"
            | "requires_approval"
            | "allows_self_approval"
            | "has_status"
            | "incident_commander"
            | "access_duration"
            | "access_approver"
            | "notification_approver"
    )
}

fn predicate_is_single_valued(predicate: &str) -> bool {
    let predicate = predicate.trim().to_ascii_lowercase();
    [
        "deadline", "duration", "limit", "status", "version", "interval", "window", "within",
        "required", "allowed", "enabled", "minimum", "maximum",
    ]
    .iter()
    .any(|marker| predicate == *marker || predicate.contains(&format!("_{marker}")))
        || matches!(
            predicate.as_str(),
            "requires_review"
                | "allows_self_approval"
                | "access_approver"
                | "incident_commander"
                | "notification_approver"
                | "retention_period"
        )
}

fn normalized_condition(condition: Option<&str>) -> Option<String> {
    condition
        .map(str::trim)
        .filter(|condition| !condition.is_empty())
        .map(str::to_lowercase)
}

fn deterministic_resolution(
    left: &Claim,
    right: &Claim,
    context: &ConflictContext,
) -> Option<(ConflictKind, String)> {
    if validity_ranges_do_not_overlap(left, right) {
        return Some((
            ConflictKind::Temporal,
            "適用期間が重ならない版系列として保持します".to_owned(),
        ));
    }

    if let Some(as_of) = context.as_of {
        match (is_active_at(left, as_of), is_active_at(right, as_of)) {
            (true, false) => {
                return Some((
                    ConflictKind::Temporal,
                    format!("{}時点では{}のみが有効です", as_of, left.id),
                ));
            }
            (false, true) => {
                return Some((
                    ConflictKind::Temporal,
                    format!("{}時点では{}のみが有効です", as_of, right.id),
                ));
            }
            _ => {}
        }
    }

    if let Some(winner) = state_winner(left, right) {
        return Some((
            ConflictKind::State,
            format!("状態が確定している{}を優先します", winner.id),
        ));
    }

    let left_rank = authority_rank(left.authority.as_deref(), context);
    let right_rank = authority_rank(right.authority.as_deref(), context);
    match (left_rank, right_rank) {
        (Some(left_rank), Some(right_rank)) if left_rank < right_rank => Some((
            ConflictKind::Authority,
            format!("宣言済み権威順により{}を優先します", left.id),
        )),
        (Some(left_rank), Some(right_rank)) if right_rank < left_rank => Some((
            ConflictKind::Authority,
            format!("宣言済み権威順により{}を優先します", right.id),
        )),
        _ => None,
    }
}

fn validity_ranges_do_not_overlap(left: &Claim, right: &Claim) -> bool {
    let left_from = parse_date(left.valid_from.as_deref());
    let left_to = parse_date(left.valid_to.as_deref());
    let right_from = parse_date(right.valid_from.as_deref());
    let right_to = parse_date(right.valid_to.as_deref());
    left_to.zip(right_from).is_some_and(|(to, from)| to < from)
        || right_to.zip(left_from).is_some_and(|(to, from)| to < from)
}

fn is_active_at(claim: &Claim, as_of: NaiveDate) -> bool {
    let starts_before = parse_date(claim.valid_from.as_deref()).is_none_or(|from| from <= as_of);
    let ends_after = parse_date(claim.valid_to.as_deref()).is_none_or(|to| as_of <= to);
    starts_before && ends_after
}

fn parse_date(value: Option<&str>) -> Option<NaiveDate> {
    value.and_then(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok())
}

fn state_winner<'a>(left: &'a Claim, right: &'a Claim) -> Option<&'a Claim> {
    match (
        is_terminal_state(left.status.as_deref()),
        is_terminal_state(right.status.as_deref()),
    ) {
        (true, false) => return Some(right),
        (false, true) => return Some(left),
        _ => {}
    }
    let left_rank = state_rank(left.status.as_deref())?;
    let right_rank = state_rank(right.status.as_deref())?;
    (left_rank != right_rank).then_some(if left_rank < right_rank { left } else { right })
}

fn is_terminal_state(status: Option<&str>) -> bool {
    matches!(
        status
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("rejected" | "superseded" | "retired")
    )
}

fn state_rank(status: Option<&str>) -> Option<usize> {
    match status?.trim().to_ascii_lowercase().as_str() {
        "active" | "approved" | "implemented" | "current" => Some(0),
        "proposed" | "draft" => Some(1),
        "rejected" | "superseded" | "retired" => Some(2),
        _ => None,
    }
}

fn authority_rank(authority: Option<&str>, context: &ConflictContext) -> Option<usize> {
    let authority = authority?;
    context
        .authority_precedence
        .iter()
        .position(|candidate| candidate == authority)
}

fn stable_conflict_id(left_id: &str, right_id: &str) -> String {
    let mut ids = [left_id, right_id];
    ids.sort_unstable();
    let digest = Sha256::digest(format!("{}:{}", ids[0], ids[1]));
    let mut hex = String::with_capacity(24);
    for byte in &digest[..12] {
        write!(&mut hex, "{byte:02x}").expect("writing to a String cannot fail");
    }
    format!("cfl_{hex}")
}

fn unresolved_conflict_diagnostic(
    diagnostic_id: &str,
    conflict_id: &str,
    left: &Claim,
    right: &Claim,
    policy: &CompilationPolicy,
) -> Diagnostic {
    Diagnostic {
        id: diagnostic_id.to_owned(),
        code: "FRG-CST-UNRESOLVED-CONFLICT".to_owned(),
        severity: policy.unresolved_conflict_severity(),
        message: format!(
            "{}の{}について、AとBが矛盾しており判断できません",
            left.subject, left.predicate
        ),
        target_ids: vec![conflict_id.to_owned(), left.id.clone(), right.id.clone()],
        evidence_ids: left
            .evidence
            .iter()
            .chain(&right.evidence)
            .map(|reference| reference.evidence_id.clone())
            .collect(),
        reason: "適用時期、状態、または宣言済み権威順から一意に決定できません".to_owned(),
        suggestions: vec![
            "適用日とauthorityを確認するか、Evidence付きoverrideを登録してください".to_owned(),
        ],
        questions: vec!["どちらを現行の判断として扱いますか".to_owned()],
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntentValidationIssue {
    pub field: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntentValidationErrors {
    pub issues: Vec<IntentValidationIssue>,
}

impl fmt::Display for IntentValidationErrors {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(
            formatter,
            "usage intent validation failed with {} issue(s):",
            self.issues.len()
        )?;
        for issue in &self.issues {
            writeln!(formatter, "  {}: {}", issue.field, issue.message)?;
        }
        Ok(())
    }
}

impl std::error::Error for IntentValidationErrors {}

pub fn load_usage_intent(path: &Path) -> Result<UsageIntent> {
    let yaml = fs::read_to_string(path)
        .with_context(|| format!("failed to read usage intent: {}", path.display()))?;
    let intent = serde_yaml_ng::from_str(&yaml)
        .with_context(|| format!("failed to parse usage intent YAML: {}", path.display()))?;
    validate_usage_intent(&intent)?;
    Ok(intent)
}

pub fn validate_usage_intent(
    intent: &UsageIntent,
) -> std::result::Result<(), IntentValidationErrors> {
    let mut issues = Vec::new();

    required(&mut issues, "id", &intent.id);
    if !intent.id.is_empty()
        && (!intent
            .id
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_lowercase())
            || !intent.id.chars().all(|character| {
                character.is_ascii_lowercase()
                    || character.is_ascii_digit()
                    || matches!(character, '-' | '_')
            }))
    {
        issue(
            &mut issues,
            "id",
            "must start with a lowercase ASCII letter and contain only lowercase letters, digits, '-' or '_'",
        );
    }
    required(&mut issues, "goal", &intent.goal);
    non_empty_list(&mut issues, "users", &intent.users);
    non_empty_list(&mut issues, "tasks", &intent.tasks);
    non_empty_list(&mut issues, "questions", &intent.questions);

    if issues.is_empty() {
        Ok(())
    } else {
        Err(IntentValidationErrors { issues })
    }
}

fn required(issues: &mut Vec<IntentValidationIssue>, field: &str, value: &str) {
    if value.trim().is_empty() {
        issue(issues, field, "must not be empty");
    }
}

fn non_empty_list(issues: &mut Vec<IntentValidationIssue>, field: &str, values: &[String]) {
    if values.is_empty() {
        issue(issues, field, "must contain at least one item");
        return;
    }

    let mut seen = HashSet::new();
    for (index, value) in values.iter().enumerate() {
        if value.trim().is_empty() {
            issue(issues, &format!("{field}[{index}]"), "must not be empty");
        } else if !seen.insert(value.trim()) {
            issue(
                issues,
                &format!("{field}[{index}]"),
                "duplicates an earlier item",
            );
        }
    }
}

fn issue(issues: &mut Vec<IntentValidationIssue>, field: &str, message: &str) {
    issues.push(IntentValidationIssue {
        field: field.to_owned(),
        message: message.to_owned(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use fragarach_ir::{EvidenceReference, IntentRequirements, SourcePosition};
    use fragarach_llm::ClaimExtractionResponse;
    use serde_json::json;

    fn valid_intent() -> UsageIntent {
        UsageIntent {
            id: "design-review".to_owned(),
            goal: "設計レビュー要否を判断する".to_owned(),
            users: vec!["developer".to_owned()],
            tasks: vec!["レビュー要否を判断する".to_owned()],
            questions: vec!["レビューは必要か".to_owned()],
            requirements: IntentRequirements {
                evidence_required: true,
                temporal_scope_required: true,
                unresolved_conflicts_allowed: false,
            },
        }
    }

    #[test]
    fn accepts_valid_intent() {
        assert!(validate_usage_intent(&valid_intent()).is_ok());
    }

    #[test]
    fn reports_all_empty_and_duplicate_fields() {
        let mut intent = valid_intent();
        intent.id = "Invalid ID".to_owned();
        intent.goal.clear();
        intent.questions = vec!["同じ質問".to_owned(), "同じ質問".to_owned()];

        let error = validate_usage_intent(&intent).unwrap_err();
        assert_eq!(error.issues.len(), 3);
        assert!(error.to_string().contains("goal: must not be empty"));
        assert!(error.to_string().contains("questions[1]"));
    }

    fn prompt_evidence() -> PromptEvidence {
        PromptEvidence {
            source_id: "src_1".to_owned(),
            evidence_id: "ev_1".to_owned(),
            source_path: "policy.md".to_owned(),
            source_aliases: Vec::new(),
            heading_path: vec!["承認".to_owned()],
            authority: None,
            lifecycle: None,
            valid_from: None,
            valid_to: None,
            text: "本番変更には承認が必要です。".to_owned(),
        }
    }

    fn candidate(reference: EvidenceReference) -> ClaimCandidate {
        ClaimCandidate {
            subject: "本番変更".to_owned(),
            predicate: "requires".to_owned(),
            object: json!("承認"),
            condition: None,
            valid_from: None,
            valid_to: None,
            authority: Some("規程".to_owned()),
            status: Some("active".to_owned()),
            confidence: 0.95,
            evidence: vec![reference],
        }
    }

    #[test]
    fn accepts_only_claims_backed_by_existing_evidence() {
        let evidence = prompt_evidence();
        let response = ClaimExtractionResponse {
            claims: vec![candidate(EvidenceReference {
                source_id: evidence.source_id.clone(),
                evidence_id: evidence.evidence_id.clone(),
            })],
            provider: "mock".to_owned(),
            model: "fixed".to_owned(),
            usage: fragarach_llm::LlmUsage::default(),
        };

        let validated = validate_extraction(response, &[evidence]);

        assert_eq!(validated.claims.len(), 1);
        assert_eq!(validated.rejected_claims, 0);
        assert!(validated.claims[0].id.starts_with("clm_"));
    }

    #[test]
    fn rejects_hallucinated_evidence_references() {
        let response = ClaimExtractionResponse {
            claims: vec![candidate(EvidenceReference {
                source_id: "invented_source".to_owned(),
                evidence_id: "invented_evidence".to_owned(),
            })],
            provider: "mock".to_owned(),
            model: "fixed".to_owned(),
            usage: fragarach_llm::LlmUsage::default(),
        };

        let validated = validate_extraction(response, &[prompt_evidence()]);

        assert!(validated.claims.is_empty());
        assert_eq!(validated.rejected_claims, 1);
        assert_eq!(validated.diagnostics[0].code, "FRG-EXT-INVALID-CLAIM");
        assert!(
            validated.diagnostics[0]
                .reason
                .contains("unknown evidence reference")
        );
    }

    #[test]
    fn converts_parsed_documents_to_prompt_evidence() {
        let documents = vec![ParsedDocument {
            schema_version: "0.1".to_owned(),
            source_id: "src_1".to_owned(),
            source_path: "policy.md".to_owned(),
            parser: fragarach_ir::ParserInfo {
                name: "test".to_owned(),
                version: "1".to_owned(),
            },
            title: None,
            evidence: vec![fragarach_ir::EvidenceUnit {
                id: "ev_1".to_owned(),
                kind: fragarach_ir::EvidenceKind::Paragraph,
                text: "fact".to_owned(),
                position: SourcePosition {
                    line_start: 1,
                    line_end: 1,
                    heading_path: vec!["section".to_owned()],
                },
                content_hash: "hash".to_owned(),
                confidence: 1.0,
            }],
            warnings: Vec::new(),
        }];

        let evidence = prompt_evidence_from_documents(&documents);

        assert_eq!(evidence.len(), 1);
        assert_eq!(evidence[0].heading_path, ["section"]);
    }

    fn conflicting_claim(id: &str, object: &str) -> Claim {
        Claim {
            id: id.to_owned(),
            subject: "緊急変更".to_owned(),
            predicate: "review_deadline".to_owned(),
            object: json!(object),
            condition: None,
            valid_from: None,
            valid_to: None,
            authority: None,
            status: None,
            confidence: 1.0,
            evidence: vec![EvidenceReference {
                source_id: format!("src_{id}"),
                evidence_id: format!("ev_{id}"),
            }],
        }
    }

    #[test]
    fn unresolved_semantic_conflicts_emit_policy_controlled_diagnostics() {
        let claims = vec![
            conflicting_claim("a", "5営業日"),
            conflicting_claim("b", "2営業日"),
        ];
        let analysis = analyze_conflicts(
            &claims,
            &ConflictContext::default(),
            &CompilationPolicy::default(),
        );

        assert_eq!(analysis.conflicts.len(), 1);
        assert_eq!(analysis.conflicts[0].status, ConflictStatus::Unresolved);
        assert_eq!(
            analysis.diagnostics[0].severity,
            DiagnosticSeverity::Warning
        );
        assert!(analysis.diagnostics[0].message.contains("判断できません"));
    }

    #[test]
    fn non_overlapping_versions_are_resolved_temporally() {
        let mut old = conflicting_claim("old", "5営業日");
        old.valid_to = Some("2026-03-31".to_owned());
        let mut current = conflicting_claim("current", "2営業日");
        current.valid_from = Some("2026-04-01".to_owned());

        let analysis = analyze_conflicts(
            &[old, current],
            &ConflictContext::default(),
            &CompilationPolicy::default(),
        );

        assert_eq!(analysis.conflicts[0].kind, ConflictKind::Temporal);
        assert_eq!(analysis.conflicts[0].status, ConflictStatus::Resolved);
        assert!(analysis.diagnostics.is_empty());
    }

    #[test]
    fn declared_authority_resolves_only_when_both_authorities_are_ranked() {
        let mut standard = conflicting_claim("standard", "2営業日");
        standard.authority = Some("corporate_standard".to_owned());
        let mut guide = conflicting_claim("guide", "5営業日");
        guide.authority = Some("guidance".to_owned());
        let context = ConflictContext {
            as_of: None,
            authority_precedence: vec!["corporate_standard".to_owned(), "guidance".to_owned()],
        };

        let analysis =
            analyze_conflicts(&[standard, guide], &context, &CompilationPolicy::default());

        assert_eq!(analysis.conflicts[0].kind, ConflictKind::Authority);
        assert_eq!(analysis.conflicts[0].status, ConflictStatus::Resolved);
        assert!(
            analysis.conflicts[0]
                .resolution
                .as_deref()
                .unwrap()
                .contains("standard")
        );
    }

    #[test]
    fn invalid_claim_dates_are_rejected_before_conflict_analysis() {
        let mut invalid = candidate(EvidenceReference {
            source_id: "src_1".to_owned(),
            evidence_id: "ev_1".to_owned(),
        });
        invalid.valid_from = Some("next Monday".to_owned());
        let validated = validate_extraction(
            ClaimExtractionResponse {
                claims: vec![invalid],
                provider: "mock".to_owned(),
                model: "fixed".to_owned(),
                usage: fragarach_llm::LlmUsage::default(),
            },
            &[prompt_evidence()],
        );

        assert_eq!(validated.rejected_claims, 1);
        assert!(validated.diagnostics[0].reason.contains("ISO 8601"));
    }

    #[test]
    fn multi_valued_relations_are_not_assumed_to_be_conflicts() {
        let mut first = conflicting_claim("first", "製品責任者");
        first.predicate = "has_responsibility_for".to_owned();
        let mut second = conflicting_claim("second", "主任技師");
        second.predicate = "has_responsibility_for".to_owned();

        let analysis = analyze_conflicts(
            &[first, second],
            &ConflictContext::default(),
            &CompilationPolicy::default(),
        );

        assert!(analysis.conflicts.is_empty());
    }

    #[test]
    fn boolean_rule_details_become_conditions_instead_of_conflicting_values() {
        let mut first = ClaimCandidate {
            subject: "製品変更".to_owned(),
            predicate: "requires_review".to_owned(),
            object: json!("公開APIを変更する"),
            condition: None,
            valid_from: None,
            valid_to: None,
            authority: None,
            status: None,
            confidence: 1.0,
            evidence: Vec::new(),
        };
        let mut second = first.clone();
        second.object = json!("認証を変更する");

        normalize_candidate_semantics(&mut first);
        normalize_candidate_semantics(&mut second);

        assert_eq!(first.object, json!(true));
        assert_eq!(first.condition.as_deref(), Some("公開APIを変更する"));
        assert_eq!(second.object, json!(true));
    }

    #[test]
    fn relative_deadlines_are_not_treated_as_calendar_validity() {
        let mut candidate = ClaimCandidate {
            subject: "顧客向け通知".to_owned(),
            predicate: "notification_deadline".to_owned(),
            object: json!("30分以内"),
            condition: None,
            valid_from: None,
            valid_to: Some("30分以内".to_owned()),
            authority: None,
            status: None,
            confidence: 1.0,
            evidence: Vec::new(),
        };

        normalize_candidate_semantics(&mut candidate);

        assert_eq!(candidate.object, json!("30分以内"));
        assert_eq!(candidate.valid_to, None);
    }

    #[test]
    fn deadline_subject_suffixes_are_compared_as_the_same_process() {
        let mut current = conflicting_claim("current", "2営業日");
        current.subject = "緊急変更の事後レビュー".to_owned();
        let mut guide = conflicting_claim("guide", "5営業日");
        guide.subject = "事後レビュー".to_owned();

        let analysis = analyze_conflicts(
            &[current, guide],
            &ConflictContext::default(),
            &CompilationPolicy::default(),
        );

        assert_eq!(analysis.conflicts.len(), 1);
    }

    #[test]
    fn conditional_status_classifications_are_not_conflicts() {
        let mut p1 = conflicting_claim("p1", "P1");
        p1.predicate = "has_status".to_owned();
        p1.condition = Some("広範な停止または漏えいの疑い".to_owned());
        let mut p2 = conflicting_claim("p2", "P2");
        p2.predicate = "has_status".to_owned();
        p2.condition = Some("一部顧客への制限で回避策あり".to_owned());

        let analysis = analyze_conflicts(
            &[p1, p2],
            &ConflictContext::default(),
            &CompilationPolicy::default(),
        );

        assert!(analysis.conflicts.is_empty());
    }

    #[test]
    fn conditional_incident_commander_is_a_fallback_not_a_conflict() {
        let mut primary = conflicting_claim("primary", "運用マネージャー");
        primary.predicate = "incident_commander".to_owned();
        let mut fallback = conflicting_claim("fallback", "当日の運用当番");
        fallback.predicate = "incident_commander".to_owned();
        fallback.condition = Some("運用マネージャーが不在の場合".to_owned());

        let analysis = analyze_conflicts(
            &[primary, fallback],
            &ConflictContext::default(),
            &CompilationPolicy::default(),
        );

        assert!(analysis.conflicts.is_empty());
    }

    #[test]
    fn conditional_emergency_access_duration_is_not_a_conflict() {
        let mut standard = conflicting_claim("standard", "8時間");
        standard.predicate = "access_duration".to_owned();
        let mut emergency = conflicting_claim("emergency", "2時間");
        emergency.predicate = "access_duration".to_owned();
        emergency.condition = Some("P1障害の復旧に必要な場合".to_owned());

        let analysis = analyze_conflicts(
            &[standard, emergency],
            &ConflictContext::default(),
            &CompilationPolicy::default(),
        );

        assert!(analysis.conflicts.is_empty());
    }

    #[test]
    fn explicitly_superseded_claim_loses_to_an_unknown_current_state() {
        let mut old = conflicting_claim("old", "5営業日");
        old.status = Some("superseded".to_owned());
        let current = conflicting_claim("current", "2営業日");

        let analysis = analyze_conflicts(
            &[old, current],
            &ConflictContext::default(),
            &CompilationPolicy::default(),
        );

        assert_eq!(analysis.conflicts[0].kind, ConflictKind::State);
        assert_eq!(analysis.conflicts[0].status, ConflictStatus::Resolved);
    }
}
