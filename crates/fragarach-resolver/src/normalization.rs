use std::collections::{HashMap, HashSet};

use chrono::NaiveDate;
use fragarach_ir::{
    ApplicabilityScope, DiagnosticSeverity, DocumentProfile, DocumentRelation,
    NormalizationCatalog, ResolutionContext, ScopeAlias, ScopeDimension,
};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct NormalizationDiagnostic {
    pub severity: DiagnosticSeverity,
    pub code: String,
    pub source_id: String,
    pub field: String,
    pub message: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct NormalizedDocumentSet {
    pub profiles: Vec<DocumentProfile>,
    pub relations: Vec<DocumentRelation>,
    pub diagnostics: Vec<NormalizationDiagnostic>,
}

pub fn normalize_document_set(
    profiles: &[DocumentProfile],
    relations: &[DocumentRelation],
    catalog: &NormalizationCatalog,
) -> NormalizedDocumentSet {
    let aliases = AliasIndex::new(catalog);
    let mut diagnostics = Vec::new();
    let mut profiles = profiles.to_vec();
    for profile in &mut profiles {
        profile.scope = normalize_scope(
            &profile.scope,
            &profile.source_id,
            "profile.scope",
            &aliases,
            &mut diagnostics,
        );
    }
    let mut relations = relations.to_vec();
    for relation in &mut relations {
        relation.scope = normalize_scope(
            &relation.scope,
            &relation.id,
            "relation.scope",
            &aliases,
            &mut diagnostics,
        );
        relation.source_clauses = normalize_clauses(&relation.source_clauses, catalog);
        relation.target_clauses = normalize_clauses(&relation.target_clauses, catalog);
    }
    diagnostics.extend(validate_document_profiles(&profiles));
    NormalizedDocumentSet {
        profiles,
        relations,
        diagnostics,
    }
}

pub fn normalize_resolution_context(
    context: &ResolutionContext,
    catalog: &NormalizationCatalog,
) -> ResolutionContext {
    let aliases = AliasIndex::new(catalog);
    let mut context = context.clone();
    context.scope = normalize_scope(
        &context.scope,
        &context.intent_id,
        "context.scope",
        &aliases,
        &mut Vec::new(),
    );
    context.requested_clauses = normalize_clauses(&context.requested_clauses, catalog);
    context
}

pub fn validate_document_profiles(profiles: &[DocumentProfile]) -> Vec<NormalizationDiagnostic> {
    let mut diagnostics = Vec::new();
    let mut source_ids = HashSet::new();
    for profile in profiles {
        if profile.source_id.trim().is_empty() {
            diagnostics.push(issue(
                DiagnosticSeverity::Error,
                "profile.empty_source_id",
                &profile.source_id,
                "source_id",
                "Document Profileのsource_idが空です",
            ));
        } else if !source_ids.insert(profile.source_id.as_str()) {
            diagnostics.push(issue(
                DiagnosticSeverity::Error,
                "profile.duplicate_source_id",
                &profile.source_id,
                "source_id",
                "同じsource_idのDocument Profileが複数あります",
            ));
        }
        if !(0..=10).contains(&profile.force.authority_rank) {
            diagnostics.push(issue(
                DiagnosticSeverity::Error,
                "profile.invalid_authority_rank",
                &profile.source_id,
                "force.authority_rank",
                "authority_rankは0から10の範囲である必要があります",
            ));
        }
        validate_date(
            profile.time.valid_from.as_deref(),
            &profile.source_id,
            "time.valid_from",
            &mut diagnostics,
        );
        validate_date(
            profile.time.valid_to.as_deref(),
            &profile.source_id,
            "time.valid_to",
            &mut diagnostics,
        );
        validate_date(
            profile.time.observed_at.as_deref(),
            &profile.source_id,
            "time.observed_at",
            &mut diagnostics,
        );
        if let (Some(from), Some(to)) = (
            profile.time.valid_from.as_deref().and_then(parse_date),
            profile.time.valid_to.as_deref().and_then(parse_date),
        ) && from > to
        {
            diagnostics.push(issue(
                DiagnosticSeverity::Error,
                "profile.invalid_time_range",
                &profile.source_id,
                "time",
                "valid_fromがvalid_toより後です",
            ));
        }
    }
    diagnostics
}

struct AliasIndex<'a> {
    aliases: HashMap<String, &'a ScopeAlias>,
    universal: HashSet<String>,
    empty: HashSet<String>,
}

impl<'a> AliasIndex<'a> {
    fn new(catalog: &'a NormalizationCatalog) -> Self {
        let mut aliases = HashMap::new();
        for entry in &catalog.scope_aliases {
            aliases.insert(normalized_key(&entry.canonical), entry);
            for alias in &entry.aliases {
                aliases.insert(normalized_key(alias), entry);
            }
        }
        let universal = catalog
            .universal_values
            .iter()
            .map(|value| normalized_key(value))
            .collect();
        let mut empty = [
            "null",
            "none",
            "n/a",
            "na",
            "unknown",
            "[]",
            "{}",
            "不明",
            "未指定",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect::<HashSet<_>>();
        empty.extend(
            catalog
                .empty_values
                .iter()
                .map(|value| normalized_key(value)),
        );
        Self {
            aliases,
            universal,
            empty,
        }
    }
}

fn normalize_scope(
    scope: &ApplicabilityScope,
    source_id: &str,
    field: &str,
    aliases: &AliasIndex<'_>,
    diagnostics: &mut Vec<NormalizationDiagnostic>,
) -> ApplicabilityScope {
    let mut output = ApplicabilityScope::default();
    for (dimension, values) in scope_values(scope) {
        for value in values {
            let value = value.trim();
            let key = normalized_key(value);
            if value.is_empty() || aliases.empty.contains(&key) {
                diagnostics.push(issue(
                    DiagnosticSeverity::Warning,
                    "scope.empty_sentinel_removed",
                    source_id,
                    field,
                    &format!("Scopeの空値表現 `{value}` を除去しました"),
                ));
                continue;
            }
            if aliases.universal.contains(&key) {
                diagnostics.push(issue(
                    DiagnosticSeverity::Info,
                    "scope.universal_value_normalized",
                    source_id,
                    field,
                    &format!("全称Scope `{value}` を制約なしへ正規化しました"),
                ));
                continue;
            }
            if let Some(alias) = aliases.aliases.get(&key) {
                if alias.dimension != dimension || alias.canonical != value {
                    diagnostics.push(issue(
                        DiagnosticSeverity::Info,
                        "scope.alias_normalized",
                        source_id,
                        field,
                        &format!(
                            "`{value}` を {:?}:{} へ正規化しました",
                            alias.dimension, alias.canonical
                        ),
                    ));
                }
                push_scope_value(&mut output, &alias.dimension, alias.canonical.clone());
            } else {
                push_scope_value(&mut output, &dimension, value.to_owned());
            }
        }
    }
    deduplicate_scope(&mut output);
    output
}

fn normalize_clauses(values: &[String], catalog: &NormalizationCatalog) -> Vec<String> {
    let mut output = Vec::new();
    for value in values {
        let key = normalized_key(value);
        let normalized = catalog
            .clause_aliases
            .iter()
            .find(|alias| {
                normalized_key(&alias.canonical) == key
                    || alias
                        .aliases
                        .iter()
                        .any(|candidate| key.contains(&normalized_key(candidate)))
            })
            .map(|alias| alias.canonical.clone())
            .unwrap_or_else(|| value.trim().to_owned());
        if !normalized.is_empty() && !output.contains(&normalized) {
            output.push(normalized);
        }
    }
    output
}

fn scope_values(scope: &ApplicabilityScope) -> [(ScopeDimension, &[String]); 9] {
    [
        (ScopeDimension::Jurisdiction, &scope.jurisdictions),
        (ScopeDimension::Entity, &scope.entities),
        (ScopeDimension::Site, &scope.sites),
        (ScopeDimension::Product, &scope.products),
        (ScopeDimension::Asset, &scope.assets),
        (ScopeDimension::Person, &scope.persons),
        (ScopeDimension::Project, &scope.projects),
        (ScopeDimension::Lot, &scope.lots),
        (ScopeDimension::Contract, &scope.contracts),
    ]
}

fn push_scope_value(scope: &mut ApplicabilityScope, dimension: &ScopeDimension, value: String) {
    match dimension {
        ScopeDimension::Jurisdiction => scope.jurisdictions.push(value),
        ScopeDimension::Entity => scope.entities.push(value),
        ScopeDimension::Site => scope.sites.push(value),
        ScopeDimension::Product => scope.products.push(value),
        ScopeDimension::Asset => scope.assets.push(value),
        ScopeDimension::Person => scope.persons.push(value),
        ScopeDimension::Project => scope.projects.push(value),
        ScopeDimension::Lot => scope.lots.push(value),
        ScopeDimension::Contract => scope.contracts.push(value),
    }
}

fn deduplicate_scope(scope: &mut ApplicabilityScope) {
    for (_, values) in [
        (&ScopeDimension::Jurisdiction, &mut scope.jurisdictions),
        (&ScopeDimension::Entity, &mut scope.entities),
        (&ScopeDimension::Site, &mut scope.sites),
        (&ScopeDimension::Product, &mut scope.products),
        (&ScopeDimension::Asset, &mut scope.assets),
        (&ScopeDimension::Person, &mut scope.persons),
        (&ScopeDimension::Project, &mut scope.projects),
        (&ScopeDimension::Lot, &mut scope.lots),
        (&ScopeDimension::Contract, &mut scope.contracts),
    ] {
        values.sort();
        values.dedup();
    }
}

fn normalized_key(value: &str) -> String {
    value.trim().to_lowercase()
}

fn validate_date(
    value: Option<&str>,
    source_id: &str,
    field: &str,
    diagnostics: &mut Vec<NormalizationDiagnostic>,
) {
    if value.is_some_and(|value| parse_date(value).is_none()) {
        diagnostics.push(issue(
            DiagnosticSeverity::Error,
            "profile.invalid_date",
            source_id,
            field,
            "日付はYYYY-MM-DDである必要があります",
        ));
    }
}

fn parse_date(value: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()
}

fn issue(
    severity: DiagnosticSeverity,
    code: &str,
    source_id: &str,
    field: &str,
    message: &str,
) -> NormalizationDiagnostic {
    NormalizationDiagnostic {
        severity,
        code: code.to_owned(),
        source_id: source_id.to_owned(),
        field: field.to_owned(),
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fragarach_ir::{
        ClauseAlias, DocumentRole, ForceLevel, ForceProfile, ScopeAlias, TemporalProfile,
    };

    fn catalog() -> NormalizationCatalog {
        NormalizationCatalog {
            scope_aliases: vec![ScopeAlias {
                dimension: ScopeDimension::Site,
                canonical: "osaka".to_owned(),
                aliases: vec!["大阪工場".to_owned(), "osaka factory".to_owned()],
            }],
            clause_aliases: vec![ClauseAlias {
                canonical: "clause_4".to_owned(),
                aliases: vec!["第4条".to_owned()],
            }],
            universal_values: vec!["all branches".to_owned()],
            empty_values: Vec::new(),
        }
    }

    #[test]
    fn aliases_can_reassign_a_scope_dimension_and_remove_sentinels() {
        let profile = DocumentProfile {
            source_id: "source".to_owned(),
            document_id: None,
            revision: None,
            role: DocumentRole::Instruction,
            force: ForceProfile {
                level: ForceLevel::Mandatory,
                authority_rank: 5,
                approved: true,
            },
            scope: ApplicabilityScope {
                jurisdictions: vec!["Osaka Factory".to_owned(), "all branches".to_owned()],
                contracts: vec!["null".to_owned()],
                ..Default::default()
            },
            time: TemporalProfile::default(),
            official_record: None,
            evidence: Vec::new(),
        };
        let normalized = normalize_document_set(&[profile], &[], &catalog());
        assert_eq!(normalized.profiles[0].scope.sites, vec!["osaka"]);
        assert!(normalized.profiles[0].scope.jurisdictions.is_empty());
        assert!(normalized.profiles[0].scope.contracts.is_empty());
        assert_eq!(normalized.diagnostics.len(), 3);
    }

    #[test]
    fn clause_aliases_are_applied_by_supported_excerpt() {
        assert_eq!(
            normalize_clauses(&["第4条の期限を改める".to_owned()], &catalog()),
            vec!["clause_4"]
        );
    }
}
