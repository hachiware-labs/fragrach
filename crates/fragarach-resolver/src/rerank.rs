use std::error::Error;
use std::fmt;

pub use fragarach_ir::PacketMaterialRole as RerankRole;

/// Public algorithm identifier for the v1 default reranker.
pub const STANDARD_RERANKER_NAME: &str = "fragrach-soft-rerank-v1";
pub const STANDARD_RERANK_CANDIDATE_LIMIT: usize = 20;

pub const GOVERNING_OFFSET: i32 = -4;
pub const VERIFIER_OFFSET: i32 = -2;
pub const UNCLASSIFIED_OFFSET: i32 = 0;
pub const CONTENDER_OFFSET: i32 = 2;
pub const EXCLUDED_OFFSET: i32 = 6;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StandardReranker;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RerankError {
    CandidateLimitExceeded { count: usize, limit: usize },
}

impl fmt::Display for RerankError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CandidateLimitExceeded { count, limit } => write!(
                formatter,
                "{STANDARD_RERANKER_NAME} accepts at most {limit} candidates, got {count}"
            ),
        }
    }
}

impl Error for RerankError {}

impl StandardReranker {
    pub const NAME: &'static str = STANDARD_RERANKER_NAME;
    pub const CANDIDATE_LIMIT: usize = STANDARD_RERANK_CANDIDATE_LIMIT;

    /// Rerank a relevance-ordered candidate list with the v1 standard algorithm.
    ///
    /// The input must contain at most 20 candidates. The result contains exactly
    /// the same candidates; only their order changes. Equal adjusted ranks retain
    /// their original relevance order.
    pub fn rerank<T, F>(self, candidates: Vec<T>, role_for: F) -> Result<Vec<T>, RerankError>
    where
        F: Fn(&T) -> Option<RerankRole>,
    {
        soft_rerank_v1(candidates, role_for)
    }
}

/// Apply the library's standard reranker.
///
/// `rerank` intentionally aliases [`soft_rerank_v1`]. A future algorithm must
/// use a new versioned function before the library default is changed.
pub fn rerank<T, F>(candidates: Vec<T>, role_for: F) -> Result<Vec<T>, RerankError>
where
    F: Fn(&T) -> Option<RerankRole>,
{
    StandardReranker.rerank(candidates, role_for)
}

/// Apply Fragrach Soft Rerank v1.
///
/// The adjusted rank is `original_rank + role_offset`, using one-based input
/// rank. Lower values sort first. No candidate is added, removed, or replaced.
pub fn soft_rerank_v1<T, F>(candidates: Vec<T>, role_for: F) -> Result<Vec<T>, RerankError>
where
    F: Fn(&T) -> Option<RerankRole>,
{
    if candidates.len() > STANDARD_RERANK_CANDIDATE_LIMIT {
        return Err(RerankError::CandidateLimitExceeded {
            count: candidates.len(),
            limit: STANDARD_RERANK_CANDIDATE_LIMIT,
        });
    }

    let mut ranked = candidates
        .into_iter()
        .enumerate()
        .map(|(original_index, candidate)| {
            let adjusted_rank = original_index as i32 + 1 + role_offset(role_for(&candidate));
            (adjusted_rank, original_index, candidate)
        })
        .collect::<Vec<_>>();
    ranked.sort_by_key(|(adjusted_rank, original_index, _)| (*adjusted_rank, *original_index));
    Ok(ranked
        .into_iter()
        .map(|(_, _, candidate)| candidate)
        .collect())
}

pub const fn role_offset(role: Option<RerankRole>) -> i32 {
    match role {
        Some(RerankRole::Governing) => GOVERNING_OFFSET,
        Some(RerankRole::Verifier) => VERIFIER_OFFSET,
        Some(RerankRole::Contender) => CONTENDER_OFFSET,
        Some(RerankRole::Excluded) => EXCLUDED_OFFSET,
        None => UNCLASSIFIED_OFFSET,
    }
}

/// Select the v1 role when one source appears with several packet roles.
pub fn primary_role(roles: impl IntoIterator<Item = RerankRole>) -> Option<RerankRole> {
    let mut governing = false;
    let mut verifier = false;
    let mut contender = false;
    for role in roles {
        match role {
            RerankRole::Excluded => return Some(RerankRole::Excluded),
            RerankRole::Contender => contender = true,
            RerankRole::Verifier => verifier = true,
            RerankRole::Governing => governing = true,
        }
    }
    if contender {
        Some(RerankRole::Contender)
    } else if verifier {
        Some(RerankRole::Verifier)
    } else if governing {
        Some(RerankRole::Governing)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[derive(Debug, PartialEq, Eq)]
    struct Candidate {
        id: &'static str,
        role: Option<RerankRole>,
    }

    fn candidate(id: &'static str, role: Option<RerankRole>) -> Candidate {
        Candidate { id, role }
    }

    #[test]
    fn standard_entry_point_is_soft_rerank_v1() {
        assert_eq!(StandardReranker::NAME, "fragrach-soft-rerank-v1");
        assert_eq!(StandardReranker::CANDIDATE_LIMIT, 20);

        let input = vec![
            candidate("excluded", Some(RerankRole::Excluded)),
            candidate("plain", None),
            candidate("governing", Some(RerankRole::Governing)),
        ];
        let output = rerank(input, |item| item.role.clone()).unwrap();
        assert_eq!(
            output.into_iter().map(|item| item.id).collect::<Vec<_>>(),
            vec!["governing", "plain", "excluded"]
        );
    }

    #[test]
    fn v1_keeps_the_candidate_set_and_uses_the_frozen_offsets() {
        let input = vec![
            candidate("a", None),
            candidate("b", Some(RerankRole::Excluded)),
            candidate("c", Some(RerankRole::Contender)),
            candidate("d", None),
            candidate("e", Some(RerankRole::Verifier)),
            candidate("f", Some(RerankRole::Governing)),
            candidate("g", None),
            candidate("h", None),
        ];
        let original = input.iter().map(|item| item.id).collect::<HashSet<_>>();
        let output = soft_rerank_v1(input, |item| item.role.clone()).unwrap();
        let reranked = output.iter().map(|item| item.id).collect::<HashSet<_>>();
        assert_eq!(original, reranked);
        assert_eq!(
            output.into_iter().map(|item| item.id).collect::<Vec<_>>(),
            vec!["a", "f", "e", "d", "c", "g", "b", "h"]
        );
        assert_eq!(role_offset(Some(RerankRole::Governing)), -4);
        assert_eq!(role_offset(Some(RerankRole::Verifier)), -2);
        assert_eq!(role_offset(None), 0);
        assert_eq!(role_offset(Some(RerankRole::Contender)), 2);
        assert_eq!(role_offset(Some(RerankRole::Excluded)), 6);
    }

    #[test]
    fn v1_rejects_more_than_twenty_instead_of_dropping_candidates() {
        let input = (0..21)
            .map(|_| candidate("candidate", None))
            .collect::<Vec<_>>();
        assert_eq!(
            rerank(input, |item| item.role.clone()),
            Err(RerankError::CandidateLimitExceeded {
                count: 21,
                limit: 20,
            })
        );
    }

    #[test]
    fn primary_role_uses_the_frozen_precedence() {
        assert_eq!(
            primary_role([
                RerankRole::Governing,
                RerankRole::Verifier,
                RerankRole::Contender,
            ]),
            Some(RerankRole::Contender)
        );
        assert_eq!(
            primary_role([
                RerankRole::Governing,
                RerankRole::Excluded,
                RerankRole::Contender,
            ]),
            Some(RerankRole::Excluded)
        );
    }
}
