use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use chrono::NaiveDate;
use fragarach_ir::{
    ApplicabilityScope, DecisionReason, Disposition, DocumentProfile, DocumentRelation,
    DocumentRole, ForceLevel, RelationKind, ResolutionCandidate, ResolutionContext,
    ResolutionDecision, ResolutionOutcome,
};

mod normalization;

pub use normalization::{
    NormalizationDiagnostic, NormalizedDocumentSet, normalize_document_set,
    normalize_resolution_context, validate_document_profiles,
};

pub trait DocumentResolver {
    fn name(&self) -> &'static str;

    fn resolve(
        &self,
        context: &ResolutionContext,
        candidates: &[ResolutionCandidate],
        profiles: &[DocumentProfile],
        relations: &[DocumentRelation],
    ) -> ResolutionOutcome;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct RelevanceOnlyResolver;

#[derive(Debug, Clone, Copy, Default)]
pub struct WeightedResolver;

#[derive(Debug, Clone, Copy, Default)]
pub struct FilterFirstResolver;

#[derive(Debug, Clone, Copy, Default)]
pub struct RelationGraphResolver;

impl DocumentResolver for RelevanceOnlyResolver {
    fn name(&self) -> &'static str {
        "r0_relevance_only"
    }

    fn resolve(
        &self,
        _context: &ResolutionContext,
        candidates: &[ResolutionCandidate],
        _profiles: &[DocumentProfile],
        _relations: &[DocumentRelation],
    ) -> ResolutionOutcome {
        let winner = candidates
            .iter()
            .max_by(compare_relevance)
            .map(|item| &item.source_id);
        ResolutionOutcome {
            resolver: self.name().to_owned(),
            decisions: candidates
                .iter()
                .map(|candidate| ResolutionDecision {
                    candidate_id: candidate.source_id.clone(),
                    disposition: if winner == Some(&candidate.source_id) {
                        Disposition::Canonical
                    } else {
                        Disposition::Reference
                    },
                    reasons: vec![DecisionReason::HighestRelevance],
                    relation_path: Vec::new(),
                    missing_inputs: Vec::new(),
                    score: Some(candidate.relevance),
                })
                .collect(),
        }
    }
}

impl DocumentResolver for WeightedResolver {
    fn name(&self) -> &'static str {
        "s1_weighted_metadata"
    }

    fn resolve(
        &self,
        context: &ResolutionContext,
        candidates: &[ResolutionCandidate],
        profiles: &[DocumentProfile],
        _relations: &[DocumentRelation],
    ) -> ResolutionOutcome {
        let profiles = profile_map(profiles);
        let scored = candidates
            .iter()
            .map(|candidate| {
                let profile = profiles.get(candidate.source_id.as_str()).copied();
                (candidate, weighted_score(context, candidate, profile))
            })
            .collect::<Vec<_>>();
        let winner = scored
            .iter()
            .max_by(|left, right| left.1.total_cmp(&right.1))
            .map(|(candidate, _)| &candidate.source_id);
        ResolutionOutcome {
            resolver: self.name().to_owned(),
            decisions: scored
                .into_iter()
                .map(|(candidate, score)| ResolutionDecision {
                    candidate_id: candidate.source_id.clone(),
                    disposition: if winner == Some(&candidate.source_id) {
                        Disposition::Canonical
                    } else {
                        Disposition::Reference
                    },
                    reasons: vec![DecisionReason::WeightedMetadata],
                    relation_path: Vec::new(),
                    missing_inputs: Vec::new(),
                    score: Some(score),
                })
                .collect(),
        }
    }
}

impl DocumentResolver for FilterFirstResolver {
    fn name(&self) -> &'static str {
        "s2_filter_first"
    }

    fn resolve(
        &self,
        context: &ResolutionContext,
        candidates: &[ResolutionCandidate],
        profiles: &[DocumentProfile],
        _relations: &[DocumentRelation],
    ) -> ResolutionOutcome {
        filter_first_outcome(self.name(), context, candidates, profiles)
    }
}

impl DocumentResolver for RelationGraphResolver {
    fn name(&self) -> &'static str {
        "s3_relation_graph"
    }

    fn resolve(
        &self,
        context: &ResolutionContext,
        candidates: &[ResolutionCandidate],
        profiles: &[DocumentProfile],
        relations: &[DocumentRelation],
    ) -> ResolutionOutcome {
        let mut outcome = filter_first_outcome(self.name(), context, candidates, profiles);
        let profile_by_id = profile_map(profiles);
        apply_official_record_resolution(context, &profile_by_id, &mut outcome);
        let candidate_ids = candidates
            .iter()
            .map(|candidate| candidate.source_id.as_str())
            .collect::<HashSet<_>>();
        let mut decision_index = outcome
            .decisions
            .iter()
            .enumerate()
            .map(|(index, decision)| (decision.candidate_id.clone(), index))
            .collect::<HashMap<_, _>>();

        for relation in relations {
            if !candidate_ids.contains(relation.source_id.as_str())
                || !candidate_ids.contains(relation.target_id.as_str())
            {
                continue;
            }
            let relation_scope = scope_match(&relation.scope, &context.scope);
            let relation_time = effective(
                relation.valid_from.as_deref(),
                relation.valid_to.as_deref(),
                context.as_of.as_deref(),
            );
            if relation_scope != ScopeMatch::Match || !relation_time {
                if relation.kind == RelationKind::ExceptionTo
                    && let Some(index) = decision_index.get(&relation.source_id).copied()
                {
                    push_reason(
                        &mut outcome.decisions[index],
                        DecisionReason::ExceptionScopeMismatch,
                    );
                }
                continue;
            }
            let Some(source_profile) = profile_by_id.get(relation.source_id.as_str()).copied()
            else {
                continue;
            };
            if !source_profile.force.approved {
                if let Some(index) = decision_index.get(&relation.source_id).copied() {
                    push_reason(
                        &mut outcome.decisions[index],
                        DecisionReason::RelationInvalid,
                    );
                }
                continue;
            }
            let Some(source_index) = decision_index.get(&relation.source_id).copied() else {
                continue;
            };
            let Some(target_index) = decision_index.get(&relation.target_id).copied() else {
                continue;
            };
            let source_disposition = &outcome.decisions[source_index].disposition;
            if matches!(
                source_disposition,
                Disposition::Historical | Disposition::Unresolved
            ) || (*source_disposition == Disposition::Excluded
                && relation.kind != RelationKind::DerivedFrom)
            {
                continue;
            }
            if !relation_matches_requested_clause(relation, context) {
                match relation.kind {
                    RelationKind::Amends => {
                        outcome.decisions[source_index].disposition = Disposition::Reference;
                        let target_is_an_amendment = relations.iter().any(|candidate| {
                            candidate.kind == RelationKind::Amends
                                && candidate.source_id == relation.target_id
                                && scope_match(&candidate.scope, &context.scope)
                                    == ScopeMatch::Match
                                && effective(
                                    candidate.valid_from.as_deref(),
                                    candidate.valid_to.as_deref(),
                                    context.as_of.as_deref(),
                                )
                        });
                        outcome.decisions[target_index].disposition = if target_is_an_amendment {
                            Disposition::Reference
                        } else {
                            Disposition::Canonical
                        };
                        push_reason(
                            &mut outcome.decisions[source_index],
                            DecisionReason::ClauseAmendment,
                        );
                    }
                    RelationKind::OrderOfPrecedence => {
                        outcome.decisions[source_index].disposition = Disposition::Reference;
                        outcome.decisions[target_index].disposition = Disposition::Canonical;
                        push_reason(
                            &mut outcome.decisions[source_index],
                            DecisionReason::ContractPrecedence,
                        );
                    }
                    _ => {}
                }
                continue;
            }

            match relation.kind {
                RelationKind::OperationalPosition => match relation.position {
                    fragarach_ir::DocumentPosition::Dominates => {
                        set_decision(
                            &mut outcome.decisions[source_index],
                            Disposition::Canonical,
                            DecisionReason::ContractPrecedence,
                            relation,
                        );
                        set_decision(
                            &mut outcome.decisions[target_index],
                            Disposition::Reference,
                            DecisionReason::ContractPrecedence,
                            relation,
                        );
                    }
                    fragarach_ir::DocumentPosition::Conditional => {
                        set_decision(
                            &mut outcome.decisions[source_index],
                            Disposition::InstanceException,
                            DecisionReason::ApplicableException,
                            relation,
                        );
                        set_decision(
                            &mut outcome.decisions[target_index],
                            Disposition::Canonical,
                            DecisionReason::ApplicableException,
                            relation,
                        );
                    }
                    fragarach_ir::DocumentPosition::NonEffective => {
                        set_decision(
                            &mut outcome.decisions[source_index],
                            Disposition::Excluded,
                            DecisionReason::NotApproved,
                            relation,
                        );
                        set_decision(
                            &mut outcome.decisions[target_index],
                            Disposition::Canonical,
                            DecisionReason::Approved,
                            relation,
                        );
                    }
                    fragarach_ir::DocumentPosition::Unresolved => {
                        set_decision(
                            &mut outcome.decisions[source_index],
                            Disposition::Unresolved,
                            DecisionReason::PositionUnresolved,
                            relation,
                        );
                        set_decision(
                            &mut outcome.decisions[target_index],
                            Disposition::Unresolved,
                            DecisionReason::PositionUnresolved,
                            relation,
                        );
                    }
                },
                RelationKind::Supersedes => {
                    let source_disposition =
                        if context.requested_roles.contains(&source_profile.role) {
                            Disposition::Canonical
                        } else {
                            Disposition::Reference
                        };
                    set_decision(
                        &mut outcome.decisions[source_index],
                        source_disposition,
                        DecisionReason::Superseded,
                        relation,
                    );
                    set_decision(
                        &mut outcome.decisions[target_index],
                        Disposition::Historical,
                        DecisionReason::Superseded,
                        relation,
                    );
                }
                RelationKind::Amends => {
                    set_decision(
                        &mut outcome.decisions[source_index],
                        Disposition::Canonical,
                        DecisionReason::ClauseAmendment,
                        relation,
                    );
                    set_decision(
                        &mut outcome.decisions[target_index],
                        Disposition::Canonical,
                        DecisionReason::ClauseAmendment,
                        relation,
                    );
                }
                RelationKind::AppliesTo => {
                    if context.requested_roles.contains(&source_profile.role) {
                        set_decision(
                            &mut outcome.decisions[source_index],
                            Disposition::Canonical,
                            DecisionReason::ScopeMatched,
                            relation,
                        );
                    } else {
                        append_relation_path(&mut outcome.decisions[source_index], relation);
                    }
                }
                RelationKind::ExceptionTo => {
                    set_decision(
                        &mut outcome.decisions[source_index],
                        Disposition::InstanceException,
                        DecisionReason::ApplicableException,
                        relation,
                    );
                    set_decision(
                        &mut outcome.decisions[target_index],
                        Disposition::Canonical,
                        DecisionReason::ApplicableException,
                        relation,
                    );
                }
                RelationKind::Approves => {
                    append_relation_path(&mut outcome.decisions[source_index], relation);
                    append_relation_path(&mut outcome.decisions[target_index], relation);
                }
                RelationKind::RecordsExecutionOf => {
                    set_decision(
                        &mut outcome.decisions[source_index],
                        Disposition::ExecutionRecord,
                        DecisionReason::ExecutionEvidence,
                        relation,
                    );
                }
                RelationKind::OrderOfPrecedence => {
                    set_decision(
                        &mut outcome.decisions[source_index],
                        Disposition::Canonical,
                        DecisionReason::ContractPrecedence,
                        relation,
                    );
                    set_decision(
                        &mut outcome.decisions[target_index],
                        Disposition::Reference,
                        DecisionReason::ContractPrecedence,
                        relation,
                    );
                }
                RelationKind::DerivedFrom => {
                    let target_profile = profile_by_id.get(relation.target_id.as_str()).copied();
                    let is_official_copy_relation = source_profile.official_record == Some(false)
                        && target_profile
                            .is_some_and(|profile| profile.official_record == Some(true));
                    if is_official_copy_relation {
                        set_decision(
                            &mut outcome.decisions[source_index],
                            Disposition::Excluded,
                            DecisionReason::NonOfficialCopy,
                            relation,
                        );
                        if !matches!(
                            outcome.decisions[target_index].disposition,
                            Disposition::Historical
                                | Disposition::Excluded
                                | Disposition::Unresolved
                        ) {
                            set_decision(
                                &mut outcome.decisions[target_index],
                                Disposition::Canonical,
                                DecisionReason::OfficialRecord,
                                relation,
                            );
                        } else {
                            append_relation_path(&mut outcome.decisions[target_index], relation);
                        }
                    } else {
                        append_relation_path(&mut outcome.decisions[source_index], relation);
                        append_relation_path(&mut outcome.decisions[target_index], relation);
                    }
                }
                RelationKind::ConflictsWith => {
                    append_relation_path(&mut outcome.decisions[source_index], relation);
                    append_relation_path(&mut outcome.decisions[target_index], relation);
                }
            }
        }

        // A later amendment can amend an earlier amendment. Keep the original document as
        // canonical context, but demote the intermediate amendment after every edge has run.
        // This final pass also makes the result independent of relation input order.
        for relation in relations.iter().filter(|relation| {
            relation.kind == RelationKind::Amends
                && candidate_ids.contains(relation.source_id.as_str())
                && candidate_ids.contains(relation.target_id.as_str())
                && scope_match(&relation.scope, &context.scope) == ScopeMatch::Match
                && effective(
                    relation.valid_from.as_deref(),
                    relation.valid_to.as_deref(),
                    context.as_of.as_deref(),
                )
                && relation_matches_requested_clause(relation, context)
        }) {
            let target_is_an_amendment = relations.iter().any(|candidate| {
                candidate.kind == RelationKind::Amends
                    && candidate.source_id == relation.target_id
                    && scope_match(&candidate.scope, &context.scope) == ScopeMatch::Match
                    && effective(
                        candidate.valid_from.as_deref(),
                        candidate.valid_to.as_deref(),
                        context.as_of.as_deref(),
                    )
                    && relation_matches_requested_clause(candidate, context)
            });
            if !target_is_an_amendment {
                continue;
            }
            if let Some(target_index) = decision_index.get(&relation.target_id).copied() {
                set_decision(
                    &mut outcome.decisions[target_index],
                    Disposition::Reference,
                    DecisionReason::ClauseAmendment,
                    relation,
                );
            }
        }

        // Keep this map local to the resolution run; it is rebuilt after all base decisions exist.
        decision_index.clear();
        outcome
    }
}

fn apply_official_record_resolution(
    context: &ResolutionContext,
    profiles: &HashMap<&str, &DocumentProfile>,
    outcome: &mut ResolutionOutcome,
) {
    if !context.requested_roles.contains(&DocumentRole::Record) {
        return;
    }
    let official = outcome
        .decisions
        .iter()
        .enumerate()
        .filter(|(_, decision)| decision.disposition == Disposition::ExecutionRecord)
        .filter(|(_, decision)| {
            profiles
                .get(decision.candidate_id.as_str())
                .is_some_and(|profile| profile.official_record == Some(true))
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let copies = outcome
        .decisions
        .iter()
        .enumerate()
        .filter(|(_, decision)| decision.disposition == Disposition::ExecutionRecord)
        .filter(|(_, decision)| {
            profiles
                .get(decision.candidate_id.as_str())
                .is_some_and(|profile| profile.official_record == Some(false))
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if official.is_empty() || copies.is_empty() {
        return;
    }
    let winner = official.into_iter().max_by(|left, right| {
        let left_profile = profiles[outcome.decisions[*left].candidate_id.as_str()];
        let right_profile = profiles[outcome.decisions[*right].candidate_id.as_str()];
        left_profile
            .force
            .authority_rank
            .cmp(&right_profile.force.authority_rank)
            .then_with(|| {
                outcome.decisions[*left]
                    .score
                    .unwrap_or_default()
                    .total_cmp(&outcome.decisions[*right].score.unwrap_or_default())
            })
    });
    if let Some(winner) = winner {
        outcome.decisions[winner].disposition = Disposition::Canonical;
        push_reason(
            &mut outcome.decisions[winner],
            DecisionReason::OfficialRecord,
        );
    }
    for copy in copies {
        outcome.decisions[copy].disposition = Disposition::Excluded;
        push_reason(
            &mut outcome.decisions[copy],
            DecisionReason::NonOfficialCopy,
        );
    }
}

pub fn validate_relations(
    profiles: &[DocumentProfile],
    relations: &[DocumentRelation],
) -> Vec<String> {
    let profile_ids = profiles
        .iter()
        .map(|profile| profile.source_id.as_str())
        .collect::<HashSet<_>>();
    let mut errors = Vec::new();
    let mut relation_ids = HashSet::new();
    for relation in relations {
        if relation.id.trim().is_empty() {
            errors.push("relation id must not be empty".to_owned());
        } else if !relation_ids.insert(relation.id.as_str()) {
            errors.push(format!("duplicate relation id: {}", relation.id));
        }
        if relation.source_id == relation.target_id {
            errors.push(format!("relation {} refers to itself", relation.id));
        }
        if !profile_ids.contains(relation.source_id.as_str()) {
            errors.push(format!(
                "relation {} has unknown source {}",
                relation.id, relation.source_id
            ));
        }
        if !profile_ids.contains(relation.target_id.as_str()) {
            errors.push(format!(
                "relation {} has unknown target {}",
                relation.id, relation.target_id
            ));
        }
        if relation.kind == RelationKind::Amends
            && (relation.source_clauses.is_empty() || relation.target_clauses.is_empty())
        {
            errors.push(format!(
                "amendment relation {} requires source and target clauses",
                relation.id
            ));
        }
    }
    errors
}

fn filter_first_outcome(
    resolver: &str,
    context: &ResolutionContext,
    candidates: &[ResolutionCandidate],
    profiles: &[DocumentProfile],
) -> ResolutionOutcome {
    let profiles = profile_map(profiles);
    let mut decisions = Vec::with_capacity(candidates.len());
    let mut eligible_by_role: HashMap<DocumentRole, Vec<usize>> = HashMap::new();

    for candidate in candidates {
        let Some(profile) = profiles.get(candidate.source_id.as_str()).copied() else {
            decisions.push(ResolutionDecision {
                candidate_id: candidate.source_id.clone(),
                disposition: Disposition::Unresolved,
                reasons: vec![DecisionReason::RelationInvalid],
                relation_path: Vec::new(),
                missing_inputs: vec!["document_profile".to_owned()],
                score: Some(candidate.relevance),
            });
            continue;
        };
        let mut reasons = Vec::new();
        let mut missing_inputs = Vec::new();
        match scope_match(&profile.scope, &context.scope) {
            ScopeMatch::Mismatch => {
                decisions.push(decision(
                    candidate,
                    Disposition::Excluded,
                    vec![DecisionReason::ScopeMismatch],
                ));
                continue;
            }
            ScopeMatch::Missing => {
                collect_missing_scope(&profile.scope, &context.scope, &mut missing_inputs);
                decisions.push(ResolutionDecision {
                    candidate_id: candidate.source_id.clone(),
                    disposition: Disposition::Unresolved,
                    reasons: vec![DecisionReason::ScopeInputMissing],
                    relation_path: Vec::new(),
                    missing_inputs,
                    score: Some(candidate.relevance),
                });
                continue;
            }
            ScopeMatch::Match => reasons.push(DecisionReason::ScopeMatched),
        }
        if !profile.force.approved {
            reasons.push(DecisionReason::NotApproved);
            decisions.push(ResolutionDecision {
                candidate_id: candidate.source_id.clone(),
                disposition: Disposition::Excluded,
                reasons,
                relation_path: Vec::new(),
                missing_inputs,
                score: Some(candidate.relevance),
            });
            continue;
        }
        reasons.push(DecisionReason::Approved);
        if context.as_of.is_none()
            && (profile.time.valid_from.is_some() || profile.time.valid_to.is_some())
        {
            reasons.push(DecisionReason::ScopeInputMissing);
            missing_inputs.push("as_of".to_owned());
            decisions.push(ResolutionDecision {
                candidate_id: candidate.source_id.clone(),
                disposition: Disposition::Unresolved,
                reasons,
                relation_path: Vec::new(),
                missing_inputs,
                score: Some(candidate.relevance),
            });
            continue;
        }
        if !effective(
            profile.time.valid_from.as_deref(),
            profile.time.valid_to.as_deref(),
            context.as_of.as_deref(),
        ) {
            reasons.push(DecisionReason::NotEffectiveAtRequestedTime);
            decisions.push(ResolutionDecision {
                candidate_id: candidate.source_id.clone(),
                disposition: Disposition::Historical,
                reasons,
                relation_path: Vec::new(),
                missing_inputs,
                score: Some(candidate.relevance),
            });
            continue;
        }
        reasons.push(DecisionReason::EffectiveAtRequestedTime);
        if profile.role == DocumentRole::Record {
            reasons.push(if context.requested_roles.contains(&profile.role) {
                DecisionReason::RoleMatched
            } else {
                DecisionReason::RoleSeparated
            });
            decisions.push(ResolutionDecision {
                candidate_id: candidate.source_id.clone(),
                disposition: Disposition::ExecutionRecord,
                reasons,
                relation_path: Vec::new(),
                missing_inputs,
                score: Some(candidate.relevance),
            });
            continue;
        }
        if !context.requested_roles.contains(&profile.role) {
            reasons.push(DecisionReason::RoleSeparated);
            decisions.push(ResolutionDecision {
                candidate_id: candidate.source_id.clone(),
                disposition: Disposition::Reference,
                reasons,
                relation_path: Vec::new(),
                missing_inputs,
                score: Some(candidate.relevance),
            });
            continue;
        }
        reasons.push(DecisionReason::RoleMatched);
        let index = decisions.len();
        decisions.push(ResolutionDecision {
            candidate_id: candidate.source_id.clone(),
            disposition: Disposition::Reference,
            reasons,
            relation_path: Vec::new(),
            missing_inputs,
            score: Some(candidate.relevance),
        });
        eligible_by_role
            .entry(profile.role.clone())
            .or_default()
            .push(index);
    }

    for indices in eligible_by_role.values() {
        let winner = indices.iter().copied().max_by(|left, right| {
            let left_profile = profiles[decisions[*left].candidate_id.as_str()];
            let right_profile = profiles[decisions[*right].candidate_id.as_str()];
            left_profile
                .force
                .authority_rank
                .cmp(&right_profile.force.authority_rank)
                .then_with(|| {
                    decisions[*left]
                        .score
                        .unwrap_or_default()
                        .total_cmp(&decisions[*right].score.unwrap_or_default())
                })
        });
        if let Some(winner) = winner {
            decisions[winner].disposition = Disposition::Canonical;
            push_reason(&mut decisions[winner], DecisionReason::HigherAuthority);
        }
    }

    ResolutionOutcome {
        resolver: resolver.to_owned(),
        decisions,
    }
}

fn profile_map(profiles: &[DocumentProfile]) -> HashMap<&str, &DocumentProfile> {
    profiles
        .iter()
        .map(|profile| (profile.source_id.as_str(), profile))
        .collect()
}

fn weighted_score(
    context: &ResolutionContext,
    candidate: &ResolutionCandidate,
    profile: Option<&DocumentProfile>,
) -> f64 {
    let Some(profile) = profile else {
        return candidate.relevance;
    };
    let mut score = candidate.relevance + f64::from(profile.force.authority_rank) * 0.05;
    score += if profile.force.approved { 0.25 } else { -0.60 };
    if profile.force.level == ForceLevel::Mandatory {
        score += 0.15;
    }
    score += match scope_match(&profile.scope, &context.scope) {
        ScopeMatch::Match => 0.30,
        ScopeMatch::Missing => -0.10,
        ScopeMatch::Mismatch => -0.50,
    };
    if effective(
        profile.time.valid_from.as_deref(),
        profile.time.valid_to.as_deref(),
        context.as_of.as_deref(),
    ) {
        score += 0.20;
    } else {
        score -= 0.40;
    }
    score
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScopeMatch {
    Match,
    Missing,
    Mismatch,
}

fn scope_match(required: &ApplicabilityScope, actual: &ApplicabilityScope) -> ScopeMatch {
    let pairs = [
        (&required.jurisdictions, &actual.jurisdictions),
        (&required.entities, &actual.entities),
        (&required.sites, &actual.sites),
        (&required.products, &actual.products),
        (&required.assets, &actual.assets),
        (&required.persons, &actual.persons),
        (&required.projects, &actual.projects),
        (&required.lots, &actual.lots),
        (&required.contracts, &actual.contracts),
    ];
    let mut missing = false;
    for (required, actual) in pairs {
        if required.is_empty() {
            continue;
        }
        if actual.is_empty() {
            missing = true;
            continue;
        }
        if !required.iter().any(|value| actual.contains(value)) {
            return ScopeMatch::Mismatch;
        }
    }
    if missing {
        ScopeMatch::Missing
    } else {
        ScopeMatch::Match
    }
}

fn collect_missing_scope(
    required: &ApplicabilityScope,
    actual: &ApplicabilityScope,
    missing: &mut Vec<String>,
) {
    let pairs = [
        (
            "jurisdiction",
            &required.jurisdictions,
            &actual.jurisdictions,
        ),
        ("entity", &required.entities, &actual.entities),
        ("site", &required.sites, &actual.sites),
        ("product", &required.products, &actual.products),
        ("asset", &required.assets, &actual.assets),
        ("person", &required.persons, &actual.persons),
        ("project", &required.projects, &actual.projects),
        ("lot", &required.lots, &actual.lots),
        ("contract", &required.contracts, &actual.contracts),
    ];
    for (name, required, actual) in pairs {
        if !required.is_empty() && actual.is_empty() {
            missing.push(name.to_owned());
        }
    }
}

fn effective(from: Option<&str>, to: Option<&str>, as_of: Option<&str>) -> bool {
    let Some(as_of) = as_of.and_then(parse_date) else {
        return from.is_none() && to.is_none();
    };
    if let Some(from) = from.and_then(parse_date)
        && as_of < from
    {
        return false;
    }
    if let Some(to) = to.and_then(parse_date)
        && as_of > to
    {
        return false;
    }
    true
}

fn parse_date(value: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()
}

fn compare_relevance(left: &&ResolutionCandidate, right: &&ResolutionCandidate) -> Ordering {
    left.relevance.total_cmp(&right.relevance)
}

fn decision(
    candidate: &ResolutionCandidate,
    disposition: Disposition,
    reasons: Vec<DecisionReason>,
) -> ResolutionDecision {
    ResolutionDecision {
        candidate_id: candidate.source_id.clone(),
        disposition,
        reasons,
        relation_path: Vec::new(),
        missing_inputs: Vec::new(),
        score: Some(candidate.relevance),
    }
}

fn set_decision(
    decision: &mut ResolutionDecision,
    disposition: Disposition,
    reason: DecisionReason,
    relation: &DocumentRelation,
) {
    decision.disposition = disposition;
    push_reason(decision, reason);
    append_relation_path(decision, relation);
}

fn append_relation_path(decision: &mut ResolutionDecision, relation: &DocumentRelation) {
    if !decision.relation_path.contains(&relation.id) {
        decision.relation_path.push(relation.id.clone());
    }
}

fn push_reason(decision: &mut ResolutionDecision, reason: DecisionReason) {
    if !decision.reasons.contains(&reason) {
        decision.reasons.push(reason);
    }
}

fn relation_matches_requested_clause(
    relation: &DocumentRelation,
    context: &ResolutionContext,
) -> bool {
    if context.requested_clauses.is_empty() {
        return true;
    }
    if !matches!(
        relation.kind,
        RelationKind::Amends | RelationKind::OrderOfPrecedence
    ) {
        return true;
    }
    relation
        .source_clauses
        .iter()
        .chain(&relation.target_clauses)
        .any(|clause| context.requested_clauses.contains(clause))
}

#[cfg(test)]
mod tests {
    use super::*;
    use fragarach_ir::{ForceProfile, TemporalProfile};

    fn profile(id: &str, role: DocumentRole, rank: i32) -> DocumentProfile {
        DocumentProfile {
            source_id: id.to_owned(),
            document_id: None,
            revision: None,
            role,
            force: ForceProfile {
                level: ForceLevel::Mandatory,
                authority_rank: rank,
                approved: true,
            },
            scope: ApplicabilityScope::default(),
            time: TemporalProfile::default(),
            official_record: None,
            evidence: Vec::new(),
        }
    }

    #[test]
    fn filter_first_separates_records_from_norms() {
        let candidates = vec![
            ResolutionCandidate {
                source_id: "record".to_owned(),
                relevance: 0.95,
            },
            ResolutionCandidate {
                source_id: "policy".to_owned(),
                relevance: 0.80,
            },
        ];
        let profiles = vec![
            profile("record", DocumentRole::Record, 8),
            profile("policy", DocumentRole::Normative, 5),
        ];
        let context = ResolutionContext {
            intent_id: "current_action".to_owned(),
            as_of: Some("2026-08-01".to_owned()),
            requested_roles: vec![DocumentRole::Normative],
            requested_clauses: Vec::new(),
            scope: ApplicabilityScope::default(),
        };
        let outcome = FilterFirstResolver.resolve(&context, &candidates, &profiles, &[]);
        assert_eq!(
            outcome.decisions[0].disposition,
            Disposition::ExecutionRecord
        );
        assert_eq!(outcome.decisions[1].disposition, Disposition::Canonical);
    }

    #[test]
    fn approval_relation_links_the_record_without_claiming_execution() {
        let profiles = vec![
            profile("approval", DocumentRole::Record, 8),
            profile("policy", DocumentRole::Normative, 7),
        ];
        let candidates = vec![
            ResolutionCandidate {
                source_id: "approval".to_owned(),
                relevance: 0.90,
            },
            ResolutionCandidate {
                source_id: "policy".to_owned(),
                relevance: 0.85,
            },
        ];
        let relation = DocumentRelation {
            id: "rel-approval".to_owned(),
            position: fragarach_ir::DocumentPosition::NonEffective,
            kind: RelationKind::Approves,
            source_id: "approval".to_owned(),
            target_id: "policy".to_owned(),
            source_clauses: Vec::new(),
            target_clauses: Vec::new(),
            scope: ApplicabilityScope::default(),
            valid_from: None,
            valid_to: None,
            evidence: Vec::new(),
        };
        let context = ResolutionContext {
            intent_id: "governance".to_owned(),
            as_of: Some("2026-08-01".to_owned()),
            requested_roles: vec![DocumentRole::Normative],
            requested_clauses: Vec::new(),
            scope: ApplicabilityScope::default(),
        };

        let outcome = RelationGraphResolver.resolve(&context, &candidates, &profiles, &[relation]);

        assert_eq!(
            outcome.decisions[0].disposition,
            Disposition::ExecutionRecord
        );
        assert_eq!(outcome.decisions[1].disposition, Disposition::Canonical);
        assert_eq!(outcome.decisions[0].relation_path, vec!["rel-approval"]);
        assert_eq!(outcome.decisions[1].relation_path, vec!["rel-approval"]);
        assert!(
            !outcome.decisions[0]
                .reasons
                .contains(&DecisionReason::ExecutionEvidence)
        );
    }

    #[test]
    fn relation_graph_keeps_a_scoped_exception_separate() {
        let mut exception = profile("exception", DocumentRole::Instruction, 3);
        exception.scope.lots = vec!["LOT-42".to_owned()];
        let profiles = vec![profile("standard", DocumentRole::Normative, 9), exception];
        let candidates = vec![
            ResolutionCandidate {
                source_id: "standard".to_owned(),
                relevance: 0.80,
            },
            ResolutionCandidate {
                source_id: "exception".to_owned(),
                relevance: 0.90,
            },
        ];
        let relation = DocumentRelation {
            id: "rel-exception".to_owned(),
            position: fragarach_ir::DocumentPosition::Conditional,
            kind: RelationKind::ExceptionTo,
            source_id: "exception".to_owned(),
            target_id: "standard".to_owned(),
            source_clauses: Vec::new(),
            target_clauses: Vec::new(),
            scope: ApplicabilityScope {
                lots: vec!["LOT-42".to_owned()],
                ..Default::default()
            },
            valid_from: None,
            valid_to: Some("2026-12-31".to_owned()),
            evidence: Vec::new(),
        };
        let context = ResolutionContext {
            intent_id: "lot_action".to_owned(),
            as_of: Some("2026-08-01".to_owned()),
            requested_roles: vec![DocumentRole::Normative, DocumentRole::Instruction],
            requested_clauses: Vec::new(),
            scope: ApplicabilityScope {
                lots: vec!["LOT-42".to_owned()],
                ..Default::default()
            },
        };
        let outcome = RelationGraphResolver.resolve(&context, &candidates, &profiles, &[relation]);
        assert_eq!(
            outcome.decisions[1].disposition,
            Disposition::InstanceException
        );
        assert_eq!(outcome.decisions[0].disposition, Disposition::Canonical);
    }

    #[test]
    fn amendment_does_not_replace_unmodified_clauses() {
        let profiles = vec![
            profile("standard", DocumentRole::Normative, 8),
            profile("amendment", DocumentRole::Normative, 8),
        ];
        let candidates = vec![
            ResolutionCandidate {
                source_id: "amendment".to_owned(),
                relevance: 0.95,
            },
            ResolutionCandidate {
                source_id: "standard".to_owned(),
                relevance: 0.70,
            },
        ];
        let relation = DocumentRelation {
            id: "rel-amend".to_owned(),
            position: fragarach_ir::DocumentPosition::Dominates,
            kind: RelationKind::Amends,
            source_id: "amendment".to_owned(),
            target_id: "standard".to_owned(),
            source_clauses: vec!["clause_4".to_owned()],
            target_clauses: vec!["clause_4".to_owned()],
            scope: ApplicabilityScope::default(),
            valid_from: None,
            valid_to: None,
            evidence: Vec::new(),
        };
        let context = ResolutionContext {
            intent_id: "clause".to_owned(),
            as_of: Some("2026-08-01".to_owned()),
            requested_roles: vec![DocumentRole::Normative],
            requested_clauses: vec!["clause_7".to_owned()],
            scope: ApplicabilityScope::default(),
        };
        let outcome = RelationGraphResolver.resolve(&context, &candidates, &profiles, &[relation]);
        assert_eq!(outcome.decisions[0].disposition, Disposition::Reference);
        assert_eq!(outcome.decisions[1].disposition, Disposition::Canonical);
    }

    #[test]
    fn explicit_official_record_metadata_can_reject_a_copy_without_an_edge() {
        let mut official = profile("official", DocumentRole::Record, 5);
        official.official_record = Some(true);
        let mut copy = profile("copy", DocumentRole::Record, 5);
        copy.official_record = Some(false);
        let candidates = vec![
            ResolutionCandidate {
                source_id: "copy".to_owned(),
                relevance: 0.95,
            },
            ResolutionCandidate {
                source_id: "official".to_owned(),
                relevance: 0.70,
            },
        ];
        let context = ResolutionContext {
            intent_id: "record".to_owned(),
            as_of: Some("2026-08-01".to_owned()),
            requested_roles: vec![DocumentRole::Record],
            requested_clauses: Vec::new(),
            scope: ApplicabilityScope::default(),
        };
        let outcome = RelationGraphResolver.resolve(&context, &candidates, &[official, copy], &[]);
        assert_eq!(outcome.decisions[0].disposition, Disposition::Excluded);
        assert_eq!(outcome.decisions[1].disposition, Disposition::Canonical);
    }

    #[test]
    fn supersedes_does_not_promote_a_role_the_question_did_not_request() {
        let mut draft = profile("draft", DocumentRole::Proposal, 1);
        draft.force.approved = false;
        let profiles = vec![
            profile("approved-v2", DocumentRole::Normative, 8),
            profile("approved-v1", DocumentRole::Normative, 8),
            draft,
        ];
        let candidates = vec![
            ResolutionCandidate {
                source_id: "approved-v2".to_owned(),
                relevance: 0.95,
            },
            ResolutionCandidate {
                source_id: "approved-v1".to_owned(),
                relevance: 0.80,
            },
            ResolutionCandidate {
                source_id: "draft".to_owned(),
                relevance: 0.70,
            },
        ];
        let relation = DocumentRelation {
            id: "rel-version".to_owned(),
            position: fragarach_ir::DocumentPosition::Dominates,
            kind: RelationKind::Supersedes,
            source_id: "approved-v2".to_owned(),
            target_id: "approved-v1".to_owned(),
            source_clauses: Vec::new(),
            target_clauses: Vec::new(),
            scope: ApplicabilityScope::default(),
            valid_from: None,
            valid_to: None,
            evidence: Vec::new(),
        };
        let context = ResolutionContext {
            intent_id: "draft_status".to_owned(),
            as_of: Some("2026-08-01".to_owned()),
            requested_roles: vec![DocumentRole::Proposal],
            requested_clauses: Vec::new(),
            scope: ApplicabilityScope::default(),
        };
        let outcome = RelationGraphResolver.resolve(&context, &candidates, &profiles, &[relation]);
        assert_eq!(outcome.decisions[0].disposition, Disposition::Reference);
        assert_eq!(outcome.decisions[1].disposition, Disposition::Historical);
        assert_eq!(outcome.decisions[2].disposition, Disposition::Excluded);
    }

    #[test]
    fn derived_from_path_is_kept_after_metadata_excludes_the_copy() {
        let mut official = profile("official", DocumentRole::Record, 5);
        official.official_record = Some(true);
        let mut copy = profile("copy", DocumentRole::Record, 5);
        copy.official_record = Some(false);
        let candidates = vec![
            ResolutionCandidate {
                source_id: "copy".to_owned(),
                relevance: 0.95,
            },
            ResolutionCandidate {
                source_id: "official".to_owned(),
                relevance: 0.70,
            },
        ];
        let relation = DocumentRelation {
            id: "rel-copy-origin".to_owned(),
            position: fragarach_ir::DocumentPosition::NonEffective,
            kind: RelationKind::DerivedFrom,
            source_id: "copy".to_owned(),
            target_id: "official".to_owned(),
            source_clauses: Vec::new(),
            target_clauses: Vec::new(),
            scope: ApplicabilityScope::default(),
            valid_from: None,
            valid_to: None,
            evidence: Vec::new(),
        };
        let context = ResolutionContext {
            intent_id: "record".to_owned(),
            as_of: Some("2026-08-01".to_owned()),
            requested_roles: vec![DocumentRole::Record],
            requested_clauses: Vec::new(),
            scope: ApplicabilityScope::default(),
        };
        let outcome =
            RelationGraphResolver.resolve(&context, &candidates, &[official, copy], &[relation]);
        assert_eq!(outcome.decisions[0].disposition, Disposition::Excluded);
        assert_eq!(outcome.decisions[1].disposition, Disposition::Canonical);
        assert_eq!(outcome.decisions[0].relation_path, vec!["rel-copy-origin"]);
        assert_eq!(outcome.decisions[1].relation_path, vec!["rel-copy-origin"]);
    }

    #[test]
    fn applies_to_composes_a_lower_ranked_scoped_requirement() {
        let mut local = profile("local", DocumentRole::Normative, 7);
        local.scope.entities = vec!["jp".to_owned()];
        let profiles = vec![profile("global", DocumentRole::Normative, 9), local];
        let candidates = vec![
            ResolutionCandidate {
                source_id: "local".to_owned(),
                relevance: 0.90,
            },
            ResolutionCandidate {
                source_id: "global".to_owned(),
                relevance: 0.80,
            },
        ];
        let relation = DocumentRelation {
            id: "rel-local".to_owned(),
            position: fragarach_ir::DocumentPosition::Conditional,
            kind: RelationKind::AppliesTo,
            source_id: "local".to_owned(),
            target_id: "global".to_owned(),
            source_clauses: Vec::new(),
            target_clauses: Vec::new(),
            scope: ApplicabilityScope {
                entities: vec!["jp".to_owned()],
                ..Default::default()
            },
            valid_from: None,
            valid_to: None,
            evidence: Vec::new(),
        };
        let context = ResolutionContext {
            intent_id: "local_requirement".to_owned(),
            as_of: Some("2026-08-01".to_owned()),
            requested_roles: vec![DocumentRole::Normative],
            requested_clauses: Vec::new(),
            scope: ApplicabilityScope {
                entities: vec!["jp".to_owned()],
                ..Default::default()
            },
        };
        let outcome = RelationGraphResolver.resolve(&context, &candidates, &profiles, &[relation]);
        assert_eq!(outcome.decisions[0].disposition, Disposition::Canonical);
        assert_eq!(outcome.decisions[1].disposition, Disposition::Canonical);
        assert_eq!(outcome.decisions[0].relation_path, vec!["rel-local"]);
    }

    #[test]
    fn analytical_lineage_does_not_apply_non_official_copy_semantics() {
        let analysis = profile("analysis", DocumentRole::Analysis, 5);
        let mut record = profile("record", DocumentRole::Record, 8);
        record.official_record = Some(true);
        let candidates = vec![
            ResolutionCandidate {
                source_id: "record".to_owned(),
                relevance: 0.95,
            },
            ResolutionCandidate {
                source_id: "analysis".to_owned(),
                relevance: 0.80,
            },
        ];
        let relation = DocumentRelation {
            id: "rel-analysis-source".to_owned(),
            position: fragarach_ir::DocumentPosition::NonEffective,
            kind: RelationKind::DerivedFrom,
            source_id: "analysis".to_owned(),
            target_id: "record".to_owned(),
            source_clauses: Vec::new(),
            target_clauses: Vec::new(),
            scope: ApplicabilityScope::default(),
            valid_from: None,
            valid_to: None,
            evidence: Vec::new(),
        };
        let context = ResolutionContext {
            intent_id: "analysis".to_owned(),
            as_of: Some("2026-08-01".to_owned()),
            requested_roles: vec![DocumentRole::Analysis],
            requested_clauses: Vec::new(),
            scope: ApplicabilityScope::default(),
        };
        let outcome =
            RelationGraphResolver.resolve(&context, &candidates, &[analysis, record], &[relation]);
        assert_eq!(
            outcome.decisions[0].disposition,
            Disposition::ExecutionRecord
        );
        assert_eq!(outcome.decisions[1].disposition, Disposition::Canonical);
    }

    #[test]
    fn amendment_chain_demotes_the_intermediate_version_regardless_of_edge_order() {
        let profiles = vec![
            profile("base", DocumentRole::Normative, 9),
            profile("amend-a", DocumentRole::Normative, 7),
            profile("amend-b", DocumentRole::Normative, 7),
        ];
        let candidates = vec![
            ResolutionCandidate {
                source_id: "amend-b".to_owned(),
                relevance: 0.99,
            },
            ResolutionCandidate {
                source_id: "amend-a".to_owned(),
                relevance: 0.95,
            },
            ResolutionCandidate {
                source_id: "base".to_owned(),
                relevance: 0.80,
            },
        ];
        let amendment = |id: &str, source: &str, target: &str| DocumentRelation {
            id: id.to_owned(),
            position: fragarach_ir::DocumentPosition::Dominates,
            kind: RelationKind::Amends,
            source_id: source.to_owned(),
            target_id: target.to_owned(),
            source_clauses: vec!["deadline".to_owned()],
            target_clauses: vec!["deadline".to_owned()],
            scope: ApplicabilityScope::default(),
            valid_from: None,
            valid_to: None,
            evidence: Vec::new(),
        };
        let relations = vec![
            amendment("rel-b", "amend-b", "amend-a"),
            amendment("rel-a", "amend-a", "base"),
        ];
        let context = ResolutionContext {
            intent_id: "deadline".to_owned(),
            as_of: Some("2026-08-01".to_owned()),
            requested_roles: vec![DocumentRole::Normative],
            requested_clauses: vec!["deadline".to_owned()],
            scope: ApplicabilityScope::default(),
        };
        let outcome = RelationGraphResolver.resolve(&context, &candidates, &profiles, &relations);
        assert_eq!(outcome.decisions[0].disposition, Disposition::Canonical);
        assert_eq!(outcome.decisions[1].disposition, Disposition::Reference);
        assert_eq!(outcome.decisions[2].disposition, Disposition::Canonical);

        let unaffected_context = ResolutionContext {
            requested_clauses: vec!["retention".to_owned()],
            ..context
        };
        let unaffected =
            RelationGraphResolver.resolve(&unaffected_context, &candidates, &profiles, &relations);
        assert_eq!(unaffected.decisions[0].disposition, Disposition::Reference);
        assert_eq!(unaffected.decisions[1].disposition, Disposition::Reference);
        assert_eq!(unaffected.decisions[2].disposition, Disposition::Canonical);
    }
}
