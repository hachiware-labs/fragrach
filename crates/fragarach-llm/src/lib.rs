use std::time::Duration;

use anyhow::{Context, Result, bail};
use fragarach_ir::{EvidenceReference, UsageIntent};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

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
    "is_alias_of",
    "has_responsibility",
    "has_owner",
    "has_status",
    "effective_from",
    "other",
];

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

    fn prompt(request: &ClaimExtractionRequest) -> Result<String> {
        let payload = serde_json::to_string_pretty(request)
            .context("failed to serialize extraction input")?;
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
             incident_commander and is_alias_of use only the canonical role name as object.\n\
             For review_deadline, use the governed review process as subject, for example emergency \
             change post-review, and put emergency-change criteria in condition.\n\
             The response must match the supplied JSON schema exactly.\n\nINPUT:\n{payload}",
            PREDICATE_CATALOG.join(", ")
        ))
    }
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
                "content": Self::prompt(request)?
            }],
            "options": {
                "temperature": 0,
                "seed": self.seed
            }
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
struct OllamaMessage {
    content: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StructuredClaims {
    claims: Vec<ClaimCandidate>,
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
                            "items": {"type": ["string", "number", "boolean"]}
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
}
