use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub const IR_SCHEMA_VERSION: &str = "0.2";
pub const IR_SCHEMA_COMPATIBILITY_POLICY: &str =
    "before 1.0, readers require an exact schema-version match";

pub fn is_compatible_schema(version: &str) -> bool {
    version == IR_SCHEMA_VERSION
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceState {
    Parsed,
    Duplicate,
    Unsupported,
    Error,
    Removed,
}

impl SourceState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Parsed => "parsed",
            Self::Duplicate => "duplicate",
            Self::Unsupported => "unsupported",
            Self::Error => "error",
            Self::Removed => "removed",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceDocument {
    pub id: String,
    pub path: String,
    pub content_hash: String,
    pub size_bytes: u64,
    pub modified_at: Option<DateTime<Utc>>,
    pub format: String,
    pub state: SourceState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicate_of: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parsed_artifact: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScanSummary {
    pub total_current: usize,
    pub added: usize,
    pub changed: usize,
    pub unchanged: usize,
    pub removed: usize,
    pub parsed_documents: usize,
    pub duplicates: usize,
    pub unsupported: usize,
    pub errors: usize,
    pub parsed_now: usize,
    pub parse_cache_hits: usize,
    pub duration_ms: u64,
    pub bytes_scanned: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceManifest {
    pub schema_version: String,
    pub source_root: String,
    pub generated_at: DateTime<Utc>,
    pub summary: ScanSummary,
    pub documents: Vec<SourceDocument>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removed_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKind {
    Metadata,
    Heading,
    Paragraph,
    List,
    Text,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourcePosition {
    pub line_start: usize,
    pub line_end: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub heading_path: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EvidenceUnit {
    pub id: String,
    pub kind: EvidenceKind,
    pub text: String,
    pub position: SourcePosition,
    pub content_hash: String,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ParserInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParsedDocument {
    pub schema_version: String,
    pub source_id: String,
    pub source_path: String,
    pub parser: ParserInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub evidence: Vec<EvidenceUnit>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct UsageIntent {
    pub id: String,
    pub goal: String,
    pub users: Vec<String>,
    pub tasks: Vec<String>,
    pub questions: Vec<String>,
    pub requirements: IntentRequirements,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct IntentRequirements {
    pub evidence_required: bool,
    pub temporal_scope_required: bool,
    pub unresolved_conflicts_allowed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EvidenceReference {
    pub source_id: String,
    pub evidence_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum DocumentRole {
    Normative,
    Instruction,
    Record,
    Analysis,
    Proposal,
    Communication,
    Reference,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ForceLevel {
    Mandatory,
    Recommended,
    Informational,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ForceProfile {
    pub level: ForceLevel,
    #[serde(default)]
    pub authority_rank: i32,
    #[serde(default)]
    pub approved: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApplicabilityScope {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub jurisdictions: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entities: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sites: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub products: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub assets: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub persons: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub projects: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lots: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub contracts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ScopeDimension {
    Jurisdiction,
    Entity,
    Site,
    Product,
    Asset,
    Person,
    Project,
    Lot,
    Contract,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScopeAlias {
    pub dimension: ScopeDimension,
    pub canonical: String,
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClauseAlias {
    pub canonical: String,
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct NormalizationCatalog {
    #[serde(default)]
    pub scope_aliases: Vec<ScopeAlias>,
    #[serde(default)]
    pub clause_aliases: Vec<ClauseAlias>,
    #[serde(default)]
    pub universal_values: Vec<String>,
    #[serde(default)]
    pub empty_values: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct TemporalProfile {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DocumentProfile {
    pub source_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    pub role: DocumentRole,
    pub force: ForceProfile,
    #[serde(default)]
    pub scope: ApplicabilityScope,
    #[serde(default)]
    pub time: TemporalProfile,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub official_record: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<EvidenceReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RelationKind {
    OperationalPosition,
    Supersedes,
    Amends,
    ProposesChangeTo,
    AppliesTo,
    ExceptionTo,
    ConflictsWith,
    Evaluates,
    Approves,
    ImplementsDecision,
    RecordsExecutionOf,
    OrderOfPrecedence,
    DerivedFrom,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DocumentPosition {
    Dominates,
    Conditional,
    NonEffective,
    #[default]
    Unresolved,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DocumentRelation {
    pub id: String,
    #[serde(default)]
    pub position: DocumentPosition,
    pub kind: RelationKind,
    pub source_id: String,
    pub target_id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source_clauses: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub target_clauses: Vec<String>,
    #[serde(default)]
    pub scope: ApplicabilityScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_to: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<EvidenceReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DecisionPacket {
    pub id: String,
    pub intent_id: String,
    pub purpose: PacketPurpose,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub materials: Vec<PacketMaterial>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PacketPurpose {
    Decision { relation_ids: Vec<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PacketMaterial {
    pub source_id: String,
    pub role: PacketMaterialRole,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PacketMaterialRole {
    Governing,
    Excluded,
    Contender,
    Verifier,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolutionCandidate {
    pub source_id: String,
    pub relevance: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolutionContext {
    pub intent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub as_of: Option<String>,
    pub requested_roles: Vec<DocumentRole>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requested_clauses: Vec<String>,
    #[serde(default)]
    pub scope: ApplicabilityScope,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Disposition {
    Canonical,
    InstanceException,
    ExecutionRecord,
    Historical,
    Reference,
    Excluded,
    Unresolved,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum DecisionReason {
    HighestRelevance,
    WeightedMetadata,
    ScopeMatched,
    ScopeMismatch,
    ScopeInputMissing,
    RoleMatched,
    RoleSeparated,
    EffectiveAtRequestedTime,
    NotEffectiveAtRequestedTime,
    Approved,
    NotApproved,
    HigherAuthority,
    Superseded,
    ClauseAmendment,
    ApplicableException,
    ExceptionScopeMismatch,
    ExecutionEvidence,
    ContractPrecedence,
    OfficialRecord,
    NonOfficialCopy,
    PositionUnresolved,
    RelationInvalid,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolutionDecision {
    pub candidate_id: String,
    pub disposition: Disposition,
    pub reasons: Vec<DecisionReason>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub relation_path: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing_inputs: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolutionOutcome {
    pub resolver: String,
    pub decisions: Vec<ResolutionDecision>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Claim {
    pub id: String,
    pub subject: String,
    pub predicate: String,
    pub object: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authority: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub confidence: f32,
    pub evidence: Vec<EvidenceReference>,
}

impl Claim {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.id.trim().is_empty() {
            return Err("claim id must not be empty");
        }
        if self.subject.trim().is_empty()
            || self.predicate.trim().is_empty()
            || value_is_empty(&self.object)
        {
            return Err("claim subject, predicate, and object are required");
        }
        if self.evidence.is_empty() {
            return Err("claim must reference at least one evidence unit");
        }
        if self.evidence.iter().any(|reference| {
            reference.source_id.trim().is_empty() || reference.evidence_id.trim().is_empty()
        }) {
            return Err("claim evidence references must contain source and evidence ids");
        }
        Ok(())
    }
}

fn value_is_empty(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => true,
        serde_json::Value::String(value) => value.trim().is_empty(),
        serde_json::Value::Array(values) => values.is_empty() || values.iter().all(value_is_empty),
        serde_json::Value::Object(values) => {
            values.is_empty() || values.values().all(value_is_empty)
        }
        serde_json::Value::Bool(_) | serde_json::Value::Number(_) => false,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Diagnostic {
    pub id: String,
    pub code: String,
    pub severity: DiagnosticSeverity,
    pub message: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub target_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence_ids: Vec<String>,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub suggestions: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub questions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictKind {
    Semantic,
    Temporal,
    Authority,
    State,
    ExplicitOverride,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictStatus {
    Unresolved,
    Resolved,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Conflict {
    pub id: String,
    pub kind: ConflictKind,
    pub claim_ids: Vec<String>,
    pub status: ConflictStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UnresolvedConflictAction {
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResolutionStrategy {
    TemporalValidity,
    DeclaredAuthority,
    ExplicitOverride,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CompilationPolicy {
    pub unresolved_conflict: UnresolvedConflictAction,
    pub warnings_as_errors: bool,
    pub resolution_order: Vec<ResolutionStrategy>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeBuildStatus {
    Completed,
    CompletedWithWarnings,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BuildArtifact {
    pub kind: String,
    pub path: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiagnosticCounts {
    pub info: usize,
    pub warnings: usize,
    pub errors: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct BuildMetrics {
    pub source_documents: usize,
    pub evidence_units: usize,
    pub claim_candidates: usize,
    pub claims: usize,
    pub rejected_claims: usize,
    pub conflicts: usize,
    pub unresolved_conflicts: usize,
    #[serde(default)]
    pub extraction_cache_hits: usize,
    #[serde(default)]
    pub extraction_cache_misses: usize,
    #[serde(default)]
    pub profile_cache_hits: usize,
    #[serde(default)]
    pub profile_cache_misses: usize,
    #[serde(default)]
    pub profile_llm_calls: usize,
    #[serde(default)]
    pub profile_prompt_tokens: u64,
    #[serde(default)]
    pub profile_completion_tokens: u64,
    #[serde(default)]
    pub profile_duration_ms: u64,
    #[serde(default)]
    pub profile_wall_duration_ms: u64,
    #[serde(default)]
    pub profile_batches: usize,
    #[serde(default)]
    pub relation_candidate_edges: usize,
    #[serde(default)]
    pub relation_batches: usize,
    #[serde(default)]
    pub relation_cache_hits: usize,
    #[serde(default)]
    pub relation_cache_misses: usize,
    #[serde(default)]
    pub relation_llm_calls: usize,
    #[serde(default)]
    pub relation_prompt_tokens: u64,
    #[serde(default)]
    pub relation_completion_tokens: u64,
    #[serde(default)]
    pub relation_duration_ms: u64,
    #[serde(default)]
    pub relation_wall_duration_ms: u64,
    #[serde(default)]
    pub document_profiles: usize,
    #[serde(default)]
    pub document_relations: usize,
    #[serde(default)]
    #[serde(alias = "relation_dossiers")]
    pub decision_packets: usize,
    #[serde(default)]
    pub llm_concurrency: usize,
    pub llm_calls: usize,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KnowledgeBuildManifest {
    pub schema_version: String,
    pub build_id: String,
    pub generated_at: DateTime<Utc>,
    pub status: KnowledgeBuildStatus,
    pub intent_id: String,
    #[serde(default = "default_compile_strategy")]
    pub compile_strategy: String,
    pub source_manifest_hash: String,
    pub provider: String,
    pub model: String,
    pub artifacts: Vec<BuildArtifact>,
    pub diagnostics: DiagnosticCounts,
    pub metrics: BuildMetrics,
}

fn default_compile_strategy() -> String {
    "global-v1".to_owned()
}

impl Default for CompilationPolicy {
    fn default() -> Self {
        Self {
            unresolved_conflict: UnresolvedConflictAction::Warn,
            warnings_as_errors: false,
            resolution_order: vec![
                ResolutionStrategy::TemporalValidity,
                ResolutionStrategy::DeclaredAuthority,
                ResolutionStrategy::ExplicitOverride,
            ],
        }
    }
}

impl CompilationPolicy {
    pub fn unresolved_conflict_severity(&self) -> DiagnosticSeverity {
        match self.unresolved_conflict {
            UnresolvedConflictAction::Warn => DiagnosticSeverity::Warning,
            UnresolvedConflictAction::Error => DiagnosticSeverity::Error,
        }
    }

    pub fn fails_build(&self, diagnostic: &Diagnostic) -> bool {
        diagnostic.severity == DiagnosticSeverity::Error
            || (self.warnings_as_errors && diagnostic.severity == DiagnosticSeverity::Warning)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn warning() -> Diagnostic {
        Diagnostic {
            id: "diagnostic-1".to_owned(),
            code: "FRG-CST-UNRESOLVED-CONFLICT".to_owned(),
            severity: DiagnosticSeverity::Warning,
            message: "AとBが矛盾しており、現在の根拠では判断できません".to_owned(),
            target_ids: vec!["conflict-1".to_owned()],
            evidence_ids: vec!["evidence-a".to_owned(), "evidence-b".to_owned()],
            reason: "権威性と適用時期が同一です".to_owned(),
            suggestions: vec!["優先する文書を明示してください".to_owned()],
            questions: vec!["どちらを現行規則として扱いますか".to_owned()],
        }
    }

    fn claim(evidence: Vec<EvidenceReference>) -> Claim {
        Claim {
            id: "claim-1".to_owned(),
            subject: "緊急変更".to_owned(),
            predicate: "requires_post_review_within".to_owned(),
            object: serde_json::Value::String("二営業日以内".to_owned()),
            condition: None,
            valid_from: Some("2026-04-01".to_owned()),
            valid_to: None,
            authority: Some("corporate_standard".to_owned()),
            status: Some("approved".to_owned()),
            confidence: 1.0,
            evidence,
        }
    }

    #[test]
    fn unresolved_conflicts_warn_without_failing_by_default() {
        let policy = CompilationPolicy::default();

        assert_eq!(
            policy.unresolved_conflict_severity(),
            DiagnosticSeverity::Warning
        );
        assert!(!policy.fails_build(&warning()));
    }

    #[test]
    fn warnings_can_fail_ci_builds() {
        let policy = CompilationPolicy {
            warnings_as_errors: true,
            ..CompilationPolicy::default()
        };

        assert!(policy.fails_build(&warning()));
    }

    #[test]
    fn claims_require_evidence() {
        assert_eq!(
            claim(Vec::new()).validate(),
            Err("claim must reference at least one evidence unit")
        );
        assert!(
            claim(vec![EvidenceReference {
                source_id: "source-1".to_owned(),
                evidence_id: "evidence-1".to_owned(),
            }])
            .validate()
            .is_ok()
        );
    }

    #[test]
    fn claims_reject_semantically_empty_objects() {
        for object in [
            serde_json::json!(""),
            serde_json::json!("   "),
            serde_json::json!([]),
            serde_json::json!({}),
            serde_json::json!(["", " "]),
            serde_json::json!({"value": "", "alternatives": []}),
        ] {
            let claim = Claim {
                id: "claim-empty".to_owned(),
                subject: "subject".to_owned(),
                predicate: "predicate".to_owned(),
                object,
                condition: None,
                valid_from: None,
                valid_to: None,
                authority: None,
                status: None,
                confidence: 1.0,
                evidence: vec![EvidenceReference {
                    source_id: "source".to_owned(),
                    evidence_id: "evidence".to_owned(),
                }],
            };

            assert_eq!(
                claim.validate(),
                Err("claim subject, predicate, and object are required")
            );
        }
    }

    #[test]
    fn knowledge_build_manifest_round_trips_as_json() {
        let manifest = KnowledgeBuildManifest {
            schema_version: IR_SCHEMA_VERSION.to_owned(),
            build_id: "build-1".to_owned(),
            generated_at: Utc::now(),
            status: KnowledgeBuildStatus::CompletedWithWarnings,
            intent_id: "design-review".to_owned(),
            compile_strategy: "global-v1".to_owned(),
            source_manifest_hash: "sha256:abc".to_owned(),
            provider: "mock".to_owned(),
            model: "fixed".to_owned(),
            artifacts: vec![BuildArtifact {
                kind: "claims".to_owned(),
                path: "claims.jsonl".to_owned(),
                content_hash: "sha256:def".to_owned(),
            }],
            diagnostics: DiagnosticCounts {
                info: 0,
                warnings: 1,
                errors: 0,
            },
            metrics: BuildMetrics {
                claims: 1,
                ..BuildMetrics::default()
            },
        };

        let json = serde_json::to_string(&manifest).unwrap();
        let restored: KnowledgeBuildManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, manifest);
    }

    #[test]
    fn pre_one_schema_versions_require_an_exact_match() {
        assert!(is_compatible_schema("0.2"));
        assert!(!is_compatible_schema("0.1"));
        assert!(!is_compatible_schema("1.0"));
    }

    #[test]
    fn decision_packet_keeps_a_small_top_level_contract() {
        let packet = DecisionPacket {
            id: "packet:review:relation".to_owned(),
            intent_id: "review".to_owned(),
            purpose: PacketPurpose::Decision {
                relation_ids: vec!["relation".to_owned()],
            },
            materials: vec![PacketMaterial {
                source_id: "source".to_owned(),
                role: PacketMaterialRole::Governing,
                evidence_ids: vec!["evidence".to_owned()],
            }],
        };
        let value = serde_json::to_value(packet).unwrap();
        let object = value.as_object().unwrap();
        assert_eq!(object.len(), 4);
        assert!(object.contains_key("id"));
        assert!(object.contains_key("intent_id"));
        assert!(object.contains_key("purpose"));
        assert!(object.contains_key("materials"));
        assert_eq!(value["purpose"]["kind"], "decision");
        assert!(value.get("text").is_none());
        assert!(value.get("position").is_none());
        assert!(value.get("operative_source_ids").is_none());
    }
}
