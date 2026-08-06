use std::fmt::Write as _;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use fragarach_ir::{
    DocumentProfile, DocumentRelation, EvidenceReference, IntentRequirements, UsageIntent,
};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

mod codex_app_server;

pub use codex_app_server::{CodexAppServerClaimExtractor, StructuredGenerationResponse};

const PREDICATE_CATALOG: &[&str] = &[
    "requires_review",
    "allows_review_omission",
    "requires_approval",
    "allows_self_approval",
    "review_deadline",
    "access_duration",
    "access_approver",
    "incident_reporting_threshold",
    "notification_deadline",
    "incident_commander",
    "notification_approver",
    "retention_period",
    "incident_cause",
    "temporary_remediation",
    "permanent_remediation",
    "is_alias_of",
    "has_responsibility",
    "has_owner",
    "has_formal_owner",
    "is_approved_as",
    "has_status",
    "effective_from",
    "other",
];

const OLLAMA_CONTEXT_LENGTH: u64 = 32 * 1024;
pub const CLAIM_EXTRACTION_CONTRACT_VERSION: &str = "claim-extraction-v1";
pub const DOCUMENT_PROFILE_CONTRACT_VERSION: &str = "document-position-extraction-v3";

pub fn claim_extraction_contract_fingerprint() -> String {
    let sentinel = ClaimExtractionRequest {
        intent: UsageIntent {
            id: "__contract_fingerprint__".to_owned(),
            goal: "__goal__".to_owned(),
            users: vec!["__user__".to_owned()],
            tasks: vec!["__task__".to_owned()],
            questions: vec!["__question__".to_owned()],
            requirements: IntentRequirements {
                evidence_required: true,
                temporal_scope_required: true,
                unresolved_conflicts_allowed: false,
            },
        },
        evidence: vec![PromptEvidence {
            source_id: "__source__".to_owned(),
            evidence_id: "__evidence__".to_owned(),
            source_path: "__source_path__".to_owned(),
            source_aliases: vec!["__alias__".to_owned()],
            heading_path: vec!["__heading__".to_owned()],
            authority: Some("__authority__".to_owned()),
            lifecycle: Some("__lifecycle__".to_owned()),
            valid_from: Some("2000-01-01".to_owned()),
            valid_to: Some("2000-12-31".to_owned()),
            text: "__text__".to_owned(),
        }],
    };
    let prompt = claim_extraction_prompt(&sentinel)
        .expect("the fixed contract fingerprint request must serialize");
    let mut hasher = Sha256::new();
    hasher.update(CLAIM_EXTRACTION_CONTRACT_VERSION.as_bytes());
    hasher.update(b"\0");
    hasher.update(prompt.as_bytes());
    hasher.update(b"\0");
    hasher.update(
        serde_json::to_vec(&response_schema())
            .expect("the fixed extraction response schema must serialize"),
    );
    let digest = hasher.finalize();
    let mut fingerprint = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut fingerprint, "{byte:02x}").unwrap();
    }
    fingerprint
}

pub fn document_profile_contract_fingerprint() -> String {
    let request = DocumentProfileExtractionRequest {
        evidence: vec![PromptEvidence {
            source_id: "__source__".to_owned(),
            evidence_id: "__evidence__".to_owned(),
            source_path: "__source_path__".to_owned(),
            source_aliases: Vec::new(),
            heading_path: Vec::new(),
            authority: None,
            lifecycle: None,
            valid_from: None,
            valid_to: None,
            text: "__text__".to_owned(),
        }],
    };
    let prompt = document_profile_extraction_prompt(&request)
        .expect("the fixed document profile request must serialize");
    let mut hasher = Sha256::new();
    hasher.update(DOCUMENT_PROFILE_CONTRACT_VERSION.as_bytes());
    hasher.update(b"\0");
    hasher.update(prompt.as_bytes());
    hasher.update(b"\0");
    hasher.update(
        serde_json::to_vec(&document_profile_response_schema())
            .expect("the fixed document profile schema must serialize"),
    );
    let digest = hasher.finalize();
    let mut fingerprint = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut fingerprint, "{byte:02x}").unwrap();
    }
    fingerprint
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PromptEvidence {
    pub source_id: String,
    pub evidence_id: String,
    pub source_path: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source_aliases: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub heading_path: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authority: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_to: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClaimExtractionRequest {
    pub intent: UsageIntent,
    pub evidence: Vec<PromptEvidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClaimCandidate {
    pub subject: String,
    pub predicate: String,
    pub object: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authority: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub confidence: f32,
    pub evidence: Vec<EvidenceReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClaimExtractionResponse {
    pub claims: Vec<ClaimCandidate>,
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub usage: LlmUsage,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct LlmUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub duration_ms: u64,
}

pub trait ClaimExtractor: Send + Sync {
    fn extract(&self, request: &ClaimExtractionRequest) -> Result<ClaimExtractionResponse>;

    fn cache_identity(&self) -> Result<Option<String>> {
        Ok(None)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DocumentProfileExtractionRequest {
    pub evidence: Vec<PromptEvidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DocumentProfileExtractionResponse {
    pub profiles: Vec<DocumentProfile>,
    pub relations: Vec<DocumentRelation>,
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub usage: LlmUsage,
}

pub trait DocumentProfileExtractor: Send + Sync {
    fn extract_profiles(
        &self,
        request: &DocumentProfileExtractionRequest,
    ) -> Result<DocumentProfileExtractionResponse>;

    fn profile_cache_identity(&self) -> Result<Option<String>> {
        Ok(None)
    }
}

pub trait KnowledgeExtractor: ClaimExtractor + DocumentProfileExtractor {}

impl<T> KnowledgeExtractor for T where T: ClaimExtractor + DocumentProfileExtractor {}

#[derive(Debug, Clone)]
pub struct MetadataOnlyExtractor {
    model: String,
}

impl MetadataOnlyExtractor {
    pub fn new(model: impl Into<String>) -> Result<Self> {
        let model = model.into();
        if model.trim().is_empty() {
            bail!("metadata extractor model must not be empty");
        }
        Ok(Self { model })
    }

    fn identity(&self) -> String {
        format!(
            "provider=metadata;model={};contract=front-matter-v1",
            self.model
        )
    }
}

impl ClaimExtractor for MetadataOnlyExtractor {
    fn extract(&self, _request: &ClaimExtractionRequest) -> Result<ClaimExtractionResponse> {
        Ok(ClaimExtractionResponse {
            claims: Vec::new(),
            provider: "metadata".to_owned(),
            model: self.model.clone(),
            usage: LlmUsage::default(),
        })
    }

    fn cache_identity(&self) -> Result<Option<String>> {
        Ok(Some(self.identity()))
    }
}

impl DocumentProfileExtractor for MetadataOnlyExtractor {
    fn extract_profiles(
        &self,
        _request: &DocumentProfileExtractionRequest,
    ) -> Result<DocumentProfileExtractionResponse> {
        Ok(DocumentProfileExtractionResponse {
            profiles: Vec::new(),
            relations: Vec::new(),
            provider: "metadata".to_owned(),
            model: self.model.clone(),
            usage: LlmUsage::default(),
        })
    }

    fn profile_cache_identity(&self) -> Result<Option<String>> {
        Ok(Some(self.identity()))
    }
}

#[derive(Debug, Clone)]
pub struct MockClaimExtractor {
    pub response: ClaimExtractionResponse,
}

impl ClaimExtractor for MockClaimExtractor {
    fn extract(&self, _request: &ClaimExtractionRequest) -> Result<ClaimExtractionResponse> {
        Ok(self.response.clone())
    }
}

#[derive(Debug, Clone)]
pub struct OllamaClaimExtractor {
    client: Client,
    endpoint: String,
    model: String,
    seed: u64,
}

impl OllamaClaimExtractor {
    pub fn new(
        endpoint: impl Into<String>,
        model: impl Into<String>,
        timeout: Duration,
        seed: u64,
    ) -> Result<Self> {
        let client = Client::builder()
            .timeout(timeout)
            .build()
            .context("failed to construct Ollama HTTP client")?;
        Ok(Self {
            client,
            endpoint: endpoint.into().trim_end_matches('/').to_owned(),
            model: model.into(),
            seed,
        })
    }
}

fn claim_extraction_prompt(request: &ClaimExtractionRequest) -> Result<String> {
    let payload =
        serde_json::to_string_pretty(request).context("failed to serialize extraction input")?;
    Ok(format!(
        "You compile source evidence into atomic claims for a retrieval knowledge base.\n\
             Use only facts explicitly supported by the supplied evidence.\n\
             Extract only claims useful for the stated usage intent and questions.\n\
             Use the exact entity described by the evidence as subject; do not replace a role or \
             person with a vague category such as product, policy or organization.\n\
             Subject is the governed entity, role or process, not the document title. For example, \
             a standard's deadline for emergency-change review has subject emergency change, not standard.\n\
             Each claim must express one atomic fact. Use a scalar or flat scalar array as object; \
             never put subject or predicate inside object. Different roles or list members are additive, \
             not alternative values of one claim.\n\
             Every claim must cite one or more exact source_id/evidence_id pairs from the input.\n\
             Never invent identifiers. Preserve uncertainty, conditions, dates, authority and status.\n\
             Explicit absence, prohibition, non-approval and unresolved ownership are useful facts; \
             extract them when they answer the intent instead of omitting them as negative statements.\n\
             Copy authority only from the supplied Evidence authority field; otherwise use null.\n\
             Copy status from an explicit lifecycle/state in Evidence and never from a file name.\n\
             valid_from and valid_to are calendar dates only. Use YYYY-MM-DD when the source gives \
             a precise calendar date; otherwise use null. Never put a duration such as 30 minutes, \
             two business days or three months in valid_from or valid_to.\n\
             confidence must be between 0 and 1. Return an empty claims array if there is no supported claim.\n\
             Predicate must be exactly one value from this catalog: {}.\n\
             Put domain-specific detail in subject, object or condition, not in predicate.\n\
             Predicate contracts: requires_review and allows_review_omission use a boolean object and \
             put change criteria in condition; *_deadline, *_duration and retention_period use only \
             the duration as object; *_approver and requires_approval use only role name(s) as object; \
             incident_commander uses only the canonical role name as object. is_alias_of uses the \
             canonical entity or role name as object; never leave the object empty.\n\
             incident_cause uses the incident as subject and the confirmed cause as object. \
             temporary_remediation and permanent_remediation use the incident as subject and the \
             concrete action as object; do not merge temporary recovery with a permanent measure.\n\
             has_formal_owner uses the governed system or role as subject and the formal owner as \
             object. If the source explicitly says no formal owner is defined, use the literal string \
             \"unspecified\" as object and preserve the original negative evidence citation. \
             is_approved_as uses the candidate person or role as subject, a boolean object, and puts \
             the proposed formal capacity in condition.\n\
             Negative examples are binding contracts: \"Atlasの正式な問い合わせ責任者は文書に定められていない\" \
             becomes subject \"Atlas\", predicate has_formal_owner, object \"unspecified\". \
             \"担当経験者は正式な問い合わせ責任者として承認されていない\" becomes subject \"担当経験者\", \
             predicate is_approved_as, object false, condition \"正式な問い合わせ責任者\". \
             Never encode role ownership with review predicates. Never emit an empty subject or object.\n\
             For review_deadline, use the governed review process as subject, for example emergency \
             change post-review, and put emergency-change criteria in condition.\n\
             The response must match the supplied JSON schema exactly.\n\nINPUT:\n{payload}",
        PREDICATE_CATALOG.join(", ")
    ))
}

impl ClaimExtractor for OllamaClaimExtractor {
    fn extract(&self, request: &ClaimExtractionRequest) -> Result<ClaimExtractionResponse> {
        if request.evidence.is_empty() {
            bail!("claim extraction requires at least one evidence unit");
        }

        let request_body = json!({
            "model": self.model,
            "stream": false,
            "think": false,
            "format": response_schema(),
            "messages": [{
                "role": "user",
                "content": claim_extraction_prompt(request)?
            }],
            "options": ollama_request_options(self.seed)
        });

        let response = self
            .client
            .post(format!("{}/api/chat", self.endpoint))
            .json(&request_body)
            .send()
            .context("failed to call Ollama /api/chat")?
            .error_for_status()
            .context("Ollama returned an unsuccessful status")?;
        let envelope: OllamaChatResponse = response
            .json()
            .context("failed to parse Ollama chat response")?;
        let parsed: StructuredClaims = serde_json::from_str(&envelope.message.content)
            .context("Ollama response did not match the claim schema")?;

        Ok(ClaimExtractionResponse {
            claims: parsed.claims,
            provider: "ollama".to_owned(),
            model: self.model.clone(),
            usage: LlmUsage {
                prompt_tokens: envelope.prompt_eval_count.unwrap_or_default(),
                completion_tokens: envelope.eval_count.unwrap_or_default(),
                duration_ms: envelope.total_duration.unwrap_or_default() / 1_000_000,
            },
        })
    }

    fn cache_identity(&self) -> Result<Option<String>> {
        let response = self
            .client
            .get(format!("{}/api/tags", self.endpoint))
            .send()
            .context("failed to call Ollama /api/tags for cache identity")?
            .error_for_status()
            .context("Ollama returned an unsuccessful status for /api/tags")?;
        let envelope: OllamaTagsResponse = response
            .json()
            .context("failed to parse Ollama /api/tags response")?;
        let latest_name = (!self.model.contains(':')).then(|| format!("{}:latest", self.model));
        let model = envelope
            .models
            .into_iter()
            .find(|item| {
                item.name == self.model
                    || item.model == self.model
                    || latest_name
                        .as_ref()
                        .is_some_and(|latest| item.name == *latest || item.model == *latest)
            })
            .with_context(|| {
                format!(
                    "Ollama model {} is not present in /api/tags; cannot create a safe cache identity",
                    self.model
                )
            })?;
        Ok(Some(format!(
            "provider=ollama;model={};digest={};seed={};num_ctx={};contract={};fingerprint={}",
            model.name,
            model.digest,
            self.seed,
            OLLAMA_CONTEXT_LENGTH,
            CLAIM_EXTRACTION_CONTRACT_VERSION,
            claim_extraction_contract_fingerprint()
        )))
    }
}

impl DocumentProfileExtractor for OllamaClaimExtractor {
    fn extract_profiles(
        &self,
        request: &DocumentProfileExtractionRequest,
    ) -> Result<DocumentProfileExtractionResponse> {
        if request.evidence.is_empty() {
            bail!("document profile extraction requires at least one evidence unit");
        }
        let request_body = json!({
            "model": self.model,
            "stream": false,
            "think": false,
            "format": document_profile_response_schema(),
            "messages": [{
                "role": "user",
                "content": document_profile_extraction_prompt(request)?
            }],
            "options": ollama_request_options(self.seed)
        });
        let response = self
            .client
            .post(format!("{}/api/chat", self.endpoint))
            .json(&request_body)
            .send()
            .context("failed to call Ollama /api/chat for document profiles")?
            .error_for_status()
            .context("Ollama returned an unsuccessful document profile response")?;
        let envelope: OllamaChatResponse = response
            .json()
            .context("failed to parse Ollama document profile response")?;
        let parsed: StructuredDocumentProfiles = serde_json::from_str(&envelope.message.content)
            .context("Ollama response did not match the document profile schema")?;
        Ok(DocumentProfileExtractionResponse {
            profiles: parsed.profiles,
            relations: parsed.relations,
            provider: "ollama".to_owned(),
            model: self.model.clone(),
            usage: LlmUsage {
                prompt_tokens: envelope.prompt_eval_count.unwrap_or_default(),
                completion_tokens: envelope.eval_count.unwrap_or_default(),
                duration_ms: envelope.total_duration.unwrap_or_default() / 1_000_000,
            },
        })
    }

    fn profile_cache_identity(&self) -> Result<Option<String>> {
        let base = ClaimExtractor::cache_identity(self)?.unwrap_or_default();
        Ok(Some(format!(
            "{base};profile_contract={DOCUMENT_PROFILE_CONTRACT_VERSION};profile_fingerprint={}",
            document_profile_contract_fingerprint()
        )))
    }
}

fn ollama_request_options(seed: u64) -> Value {
    json!({
        "temperature": 0,
        "seed": seed,
        "num_ctx": OLLAMA_CONTEXT_LENGTH
    })
}

#[derive(Debug, Deserialize)]
struct OllamaChatResponse {
    message: OllamaMessage,
    #[serde(default)]
    prompt_eval_count: Option<u64>,
    #[serde(default)]
    eval_count: Option<u64>,
    #[serde(default)]
    total_duration: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct OllamaTagsResponse {
    #[serde(default)]
    models: Vec<OllamaModelTag>,
}

#[derive(Debug, Deserialize)]
struct OllamaModelTag {
    name: String,
    model: String,
    digest: String,
}

#[derive(Debug, Deserialize)]
struct OllamaMessage {
    content: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StructuredClaims {
    claims: Vec<ClaimCandidate>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StructuredDocumentProfiles {
    profiles: Vec<DocumentProfile>,
    relations: Vec<DocumentRelation>,
}

fn document_profile_extraction_prompt(
    request: &DocumentProfileExtractionRequest,
) -> Result<String> {
    let payload = serde_json::to_string_pretty(request)
        .context("failed to serialize document profile extraction input")?;
    Ok(format!(
        "Compile enterprise documents into document identities and operational positions.\n\
         Use only the supplied evidence. Produce exactly one profile for every distinct source_id.\n\
         document_id is the controlled document number printed in the document or supplied in metadata.\n\
         revision is its explicit revision or version. Use null when either value is not evidenced; never\n\
         substitute source_id, a path, a filename, or a generated identifier.\n\
         Roles are normative, instruction, record, analysis, proposal, communication, or reference.\n\
         Normative documents establish requirements, rights, limits, policies, standards, regulations,\n\
         or contract terms. A company-wide 規程 or 標準 is normative even if its filename says instruction.\n\
         Instructions operationalize a normative source for a particular workflow or limited exception.\n\
         An approved deviation or waiver is an instruction linked with exception_to, not a new general norm.\n\
         Records are primary evidence of an event or state. A report that compares, interprets, or analyzes\n\
         records is analysis rather than a primary record. A record never changes a rule.\n\
         Proposals remain proposals even when they describe a concrete desired rule.\n\
         force.level is mandatory, recommended, or informational. authority_rank is an ordinal 0-10\n\
         within this input only; do not let specificity, recency, or relevance change authority.\n\
         approved is true only when the evidence supports approval or an issued/current document;\n\
         drafts and proposals are false. Empty scope means explicitly general applicability.\n\
         Use scope values exactly as written. A named customer or contract in a title, such as an ACME向け\n\
         proposal, is contract scope; do not silently generalize it. Use [] for an absent dimension and never\n\
         emit strings such as null, none, all contracts, all lots, or all branches as scope identifiers.\n\
         valid_from, valid_to, and observed_at are YYYY-MM-DD or null. Do not convert durations to dates.\n\
         YAML front matter is authoritative source evidence for dates and lifecycle fields.\n\
         official_record is true only for an identified system of record or controlled original, false\n\
         for an identified copy, and null when the evidence does not decide it.\n\
         The primary relation output is position: dominates, conditional, non_effective, or unresolved.\n\
         dominates means the source is the operative successor or otherwise wins over the target.\n\
         conditional means it changes the decision only for the stated scope or time. non_effective means\n\
         the source does not itself change the governing conclusion, for example a draft, rejected change,\n\
         expired material, analysis, or supporting record. unresolved means an incompatibility is evidenced\n\
         but the governing side is not. Never treat a larger value or newer-looking filename as improvement.\n\
         Relation kind is supporting detail retained with the source chunks. Use operational_position when\n\
         the evidence decides a position but does not require a more specific relation kind. This is the\n\
         normal kind for non_effective documents. Other kinds are limited to supersedes,\n\
         amends, applies_to, exception_to, conflicts_with,\n\
         records_execution_of, order_of_precedence, and derived_from. Emit a relation only when the evidence\n\
         explicitly supports it. conflicts_with means that two documents state incompatible values or rules;\n\
         emit it even when authority, time, or lifecycle metadata later allows deterministic resolution.\n\
         Relations are not mutually exclusive. When stale guidance states a value incompatible with a formal\n\
         policy and the policy also has precedence, emit both conflicts_with and order_of_precedence for that\n\
         document pair, each with its own exact evidence.\n\
         For amends and order_of_precedence, preserve the affected clauses. Never infer a whole-document\n\
         replacement from a clause amendment. If one document explicitly says it is an uncontrolled copy\n\
         and another document is the controlled system-of-record entry for the same asset, emit derived_from\n\
         from the copy to the controlled source. If a document says its force depends on a register, ledger,\n\
         or approval record, a dominates, conditional, or non_effective position must cite that third-party\n\
         evidence; the document's own metadata is not sufficient. Every profile and relation must cite exact\n\
         input IDs.\n\
         Return only JSON matching the supplied schema.\n\nINPUT:\n{payload}"
    ))
}

fn document_profile_response_schema() -> Value {
    let evidence_schema = json!({
        "type": "array",
        "minItems": 1,
        "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["source_id", "evidence_id"],
            "properties": {
                "source_id": {"type": "string", "minLength": 1},
                "evidence_id": {"type": "string", "minLength": 1}
            }
        }
    });
    let scope_schema = || {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": [
                "jurisdictions", "entities", "sites", "products", "assets", "persons",
                "projects", "lots", "contracts"
            ],
            "properties": {
                "jurisdictions": {"type": "array", "items": {"type": "string"}},
                "entities": {"type": "array", "items": {"type": "string"}},
                "sites": {"type": "array", "items": {"type": "string"}},
                "products": {"type": "array", "items": {"type": "string"}},
                "assets": {"type": "array", "items": {"type": "string"}},
                "persons": {"type": "array", "items": {"type": "string"}},
                "projects": {"type": "array", "items": {"type": "string"}},
                "lots": {"type": "array", "items": {"type": "string"}},
                "contracts": {"type": "array", "items": {"type": "string"}}
            }
        })
    };
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["profiles", "relations"],
        "properties": {
            "profiles": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["source_id", "document_id", "revision", "role", "force", "scope", "time", "official_record", "evidence"],
                    "properties": {
                        "source_id": {"type": "string", "minLength": 1},
                        "document_id": {"type": ["string", "null"]},
                        "revision": {"type": ["string", "null"]},
                        "role": {"type": "string", "enum": ["normative", "instruction", "record", "analysis", "proposal", "communication", "reference"]},
                        "force": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["level", "authority_rank", "approved"],
                            "properties": {
                                "level": {"type": "string", "enum": ["mandatory", "recommended", "informational"]},
                                "authority_rank": {"type": "integer", "minimum": 0, "maximum": 10},
                                "approved": {"type": "boolean"}
                            }
                        },
                        "scope": scope_schema(),
                        "time": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["valid_from", "valid_to", "observed_at"],
                            "properties": {
                                "valid_from": {"type": ["string", "null"]},
                                "valid_to": {"type": ["string", "null"]},
                                "observed_at": {"type": ["string", "null"]}
                            }
                        },
                        "official_record": {"type": ["boolean", "null"]},
                        "evidence": evidence_schema.clone()
                    }
                }
            },
            "relations": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "id", "position", "kind", "source_id", "target_id", "source_clauses",
                        "target_clauses", "scope", "valid_from", "valid_to", "evidence"
                    ],
                    "properties": {
                        "id": {"type": "string", "minLength": 1},
                        "position": {"type": "string", "enum": ["dominates", "conditional", "non_effective", "unresolved"]},
                        "kind": {"type": "string", "enum": ["operational_position", "supersedes", "amends", "applies_to", "exception_to", "conflicts_with", "records_execution_of", "order_of_precedence", "derived_from"]},
                        "source_id": {"type": "string", "minLength": 1},
                        "target_id": {"type": "string", "minLength": 1},
                        "source_clauses": {"type": "array", "items": {"type": "string"}},
                        "target_clauses": {"type": "array", "items": {"type": "string"}},
                        "scope": scope_schema(),
                        "valid_from": {"type": ["string", "null"]},
                        "valid_to": {"type": ["string", "null"]},
                        "evidence": evidence_schema
                    }
                }
            }
        }
    })
}

fn response_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["claims"],
        "properties": {
            "claims": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "subject", "predicate", "object", "condition", "valid_from",
                        "valid_to", "authority", "status", "confidence", "evidence"
                    ],
                    "properties": {
                        "subject": {"type": "string", "minLength": 1},
                        "predicate": {"type": "string", "enum": PREDICATE_CATALOG},
                        "object": {
                            "type": ["string", "number", "boolean", "array"],
                            "minLength": 1,
                            "minItems": 1,
                            "items": {
                                "type": ["string", "number", "boolean"],
                                "minLength": 1
                            }
                        },
                        "condition": {"type": ["string", "null"]},
                        "valid_from": {"type": ["string", "null"]},
                        "valid_to": {"type": ["string", "null"]},
                        "authority": {
                            "type": ["string", "null"],
                            "enum": [
                                "corporate_policy", "corporate_standard",
                                "approved_review_record", "change_record",
                                "corporate_reference", "record", "guidance", null
                            ]
                        },
                        "status": {
                            "type": ["string", "null"],
                            "enum": [
                                "active", "approved", "implemented", "current",
                                "proposed", "draft", "rejected", "superseded",
                                "retired", null
                            ]
                        },
                        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                        "evidence": {
                            "type": "array",
                            "minItems": 1,
                            "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": ["source_id", "evidence_id"],
                                "properties": {
                                    "source_id": {"type": "string"},
                                    "evidence_id": {"type": "string"}
                                }
                            }
                        }
                    }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use fragarach_ir::IntentRequirements;

    #[test]
    fn schema_requires_evidence_references() {
        let schema = response_schema();
        assert_eq!(
            schema["properties"]["claims"]["items"]["properties"]["evidence"]["minItems"],
            1
        );
    }

    #[test]
    fn document_profile_schema_requires_grounded_profiles_and_relations() {
        let schema = document_profile_response_schema();
        assert!(
            schema["properties"]["profiles"]["items"]["required"]
                .as_array()
                .unwrap()
                .iter()
                .any(|field| field == "document_id")
        );
        assert_eq!(
            schema["properties"]["profiles"]["items"]["properties"]["evidence"]["minItems"],
            1
        );
        assert_eq!(
            schema["properties"]["relations"]["items"]["properties"]["evidence"]["minItems"],
            1
        );
        assert!(
            schema["properties"]["relations"]["items"]["properties"]["kind"]["enum"]
                .as_array()
                .unwrap()
                .iter()
                .any(|kind| kind == "exception_to")
        );
        assert!(
            schema["properties"]["relations"]["items"]["properties"]["kind"]["enum"]
                .as_array()
                .unwrap()
                .iter()
                .any(|kind| kind == "conflicts_with")
        );
        assert_eq!(
            schema["properties"]["relations"]["items"]["properties"]["position"]["enum"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
    }

    #[test]
    fn ollama_context_length_is_limited_to_32k() {
        let options = ollama_request_options(42);
        assert_eq!(options["num_ctx"], 32_768);
    }

    #[test]
    fn extraction_contract_fingerprint_is_stable_and_sha256_sized() {
        let first = claim_extraction_contract_fingerprint();
        let second = claim_extraction_contract_fingerprint();

        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn document_profile_contract_fingerprint_is_stable_and_separate() {
        let first = document_profile_contract_fingerprint();
        let second = document_profile_contract_fingerprint();
        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
        assert_ne!(first, claim_extraction_contract_fingerprint());
    }

    #[test]
    fn schema_supports_incident_history_and_explicit_owner_absence() {
        let schema = response_schema();
        let predicates = schema["properties"]["claims"]["items"]["properties"]["predicate"]["enum"]
            .as_array()
            .unwrap();
        for expected in [
            "incident_cause",
            "temporary_remediation",
            "permanent_remediation",
            "has_formal_owner",
            "is_approved_as",
        ] {
            assert!(predicates.iter().any(|value| value == expected));
        }
    }

    #[test]
    fn mock_is_an_exchangeable_provider() {
        let extractor = MockClaimExtractor {
            response: ClaimExtractionResponse {
                claims: Vec::new(),
                provider: "mock".to_owned(),
                model: "fixed".to_owned(),
                usage: LlmUsage::default(),
            },
        };
        let response = extractor
            .extract(&ClaimExtractionRequest {
                intent: UsageIntent {
                    id: "test".to_owned(),
                    goal: "test".to_owned(),
                    users: vec!["tester".to_owned()],
                    tasks: vec!["test".to_owned()],
                    questions: vec!["what".to_owned()],
                    requirements: IntentRequirements {
                        evidence_required: true,
                        temporal_scope_required: false,
                        unresolved_conflicts_allowed: true,
                    },
                },
                evidence: vec![PromptEvidence {
                    source_id: "src".to_owned(),
                    evidence_id: "ev".to_owned(),
                    source_path: "source.md".to_owned(),
                    source_aliases: Vec::new(),
                    heading_path: Vec::new(),
                    authority: None,
                    lifecycle: None,
                    valid_from: None,
                    valid_to: None,
                    text: "fact".to_owned(),
                }],
            })
            .unwrap();

        assert_eq!(response.provider, "mock");
    }

    #[test]
    fn metadata_provider_returns_empty_extraction_without_llm_usage() {
        let extractor = MetadataOnlyExtractor::new("front-matter-v1").unwrap();
        let response = extractor
            .extract_profiles(&DocumentProfileExtractionRequest {
                evidence: Vec::new(),
            })
            .unwrap();

        assert_eq!(response.provider, "metadata");
        assert_eq!(response.model, "front-matter-v1");
        assert!(response.profiles.is_empty());
        assert!(response.relations.is_empty());
        assert_eq!(response.usage, LlmUsage::default());
        assert!(extractor.profile_cache_identity().unwrap().is_some());
    }
}
