use std::fmt::Write as _;
use std::fs;
use std::path::Path;

use anyhow::{Context, Result, bail};
use fragarach_ir::{
    EvidenceKind, EvidenceUnit, IR_SCHEMA_VERSION, ParsedDocument, ParserInfo, SourcePosition,
};
use sha2::{Digest, Sha256};

const PARSER_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DocumentFormat {
    Markdown,
    Text,
}

pub fn supports(path: &Path) -> bool {
    detect_format(path).is_some()
}

pub fn cache_key() -> String {
    format!("fragarach-parser:{PARSER_VERSION}:ir-{IR_SCHEMA_VERSION}")
}

pub fn parse(path: &Path, source_id: &str, source_path: &str) -> Result<ParsedDocument> {
    let format = detect_format(path)
        .ok_or_else(|| anyhow::anyhow!("unsupported document format: {}", path.display()))?;
    let text = fs::read_to_string(path)
        .with_context(|| format!("failed to read UTF-8 text: {}", path.display()))?;

    match format {
        DocumentFormat::Markdown => parse_markdown(&text, source_id, source_path),
        DocumentFormat::Text => parse_text(&text, source_id, source_path),
    }
}

pub fn render_markdown(document: &ParsedDocument) -> String {
    let mut output = String::new();
    output.push_str("# Parsed Document\n\n");
    output.push_str(&format!("- Source: `{}`\n", document.source_path));
    output.push_str(&format!("- Source ID: `{}`\n", document.source_id));
    output.push_str(&format!(
        "- Parser: `{}` `{}`\n\n",
        document.parser.name, document.parser.version
    ));

    for unit in &document.evidence {
        output.push_str(&format!("## Evidence `{}`\n\n", unit.id));
        output.push_str(&format!(
            "<!-- kind: {} | lines: {}-{} -->\n\n",
            evidence_kind_name(&unit.kind),
            unit.position.line_start,
            unit.position.line_end
        ));
        if !unit.position.heading_path.is_empty() {
            output.push_str(&format!(
                "**Section:** {}\n\n",
                unit.position.heading_path.join(" / ")
            ));
        }
        output.push_str(&unit.text);
        output.push_str("\n\n");
    }

    output
}

fn detect_format(path: &Path) -> Option<DocumentFormat> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "md" | "markdown" => Some(DocumentFormat::Markdown),
        "txt" => Some(DocumentFormat::Text),
        _ => None,
    }
}

fn parse_markdown(text: &str, source_id: &str, source_path: &str) -> Result<ParsedDocument> {
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        bail!("document is empty");
    }

    let mut evidence = Vec::new();
    let mut heading_path: Vec<String> = Vec::new();
    let mut title = None;
    let mut cursor = 0;

    if lines.first().is_some_and(|line| line.trim() == "---")
        && let Some(relative_end) = lines[1..].iter().position(|line| line.trim() == "---")
    {
        let end = relative_end + 1;
        push_unit(
            &mut evidence,
            source_id,
            EvidenceKind::Metadata,
            &lines[0..=end],
            1,
            end + 1,
            &[],
        );
        cursor = end + 1;
    }

    let mut block_start = None;
    let mut block_lines: Vec<&str> = Vec::new();

    while cursor < lines.len() {
        let line = lines[cursor];

        if let Some((level, heading)) = parse_heading(line) {
            flush_block(
                &mut evidence,
                source_id,
                &mut block_lines,
                &mut block_start,
                cursor,
                &heading_path,
                false,
            );

            heading_path.truncate(level.saturating_sub(1));
            while heading_path.len() < level.saturating_sub(1) {
                heading_path.push(String::new());
            }
            heading_path.push(heading.to_owned());
            if level == 1 && title.is_none() {
                title = Some(heading.to_owned());
            }
            push_unit(
                &mut evidence,
                source_id,
                EvidenceKind::Heading,
                &[line],
                cursor + 1,
                cursor + 1,
                &heading_path,
            );
        } else if line.trim().is_empty() {
            flush_block(
                &mut evidence,
                source_id,
                &mut block_lines,
                &mut block_start,
                cursor,
                &heading_path,
                false,
            );
        } else {
            if block_start.is_none() {
                block_start = Some(cursor + 1);
            }
            block_lines.push(line);
        }

        cursor += 1;
    }

    flush_block(
        &mut evidence,
        source_id,
        &mut block_lines,
        &mut block_start,
        lines.len(),
        &heading_path,
        false,
    );

    Ok(ParsedDocument {
        schema_version: IR_SCHEMA_VERSION.to_owned(),
        source_id: source_id.to_owned(),
        source_path: source_path.to_owned(),
        parser: ParserInfo {
            name: "fragarach-markdown".to_owned(),
            version: PARSER_VERSION.to_owned(),
        },
        title,
        evidence,
        warnings: Vec::new(),
    })
}

fn parse_text(text: &str, source_id: &str, source_path: &str) -> Result<ParsedDocument> {
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        bail!("document is empty");
    }

    let mut evidence = Vec::new();
    let mut block_start = None;
    let mut block_lines = Vec::new();

    for (index, line) in lines.iter().enumerate() {
        if line.trim().is_empty() {
            flush_block(
                &mut evidence,
                source_id,
                &mut block_lines,
                &mut block_start,
                index,
                &[],
                true,
            );
        } else {
            if block_start.is_none() {
                block_start = Some(index + 1);
            }
            block_lines.push(*line);
        }
    }

    flush_block(
        &mut evidence,
        source_id,
        &mut block_lines,
        &mut block_start,
        lines.len(),
        &[],
        true,
    );

    let title = evidence
        .first()
        .and_then(|unit| unit.text.lines().next())
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned);

    Ok(ParsedDocument {
        schema_version: IR_SCHEMA_VERSION.to_owned(),
        source_id: source_id.to_owned(),
        source_path: source_path.to_owned(),
        parser: ParserInfo {
            name: "fragarach-text".to_owned(),
            version: PARSER_VERSION.to_owned(),
        },
        title,
        evidence,
        warnings: Vec::new(),
    })
}

fn flush_block(
    evidence: &mut Vec<EvidenceUnit>,
    source_id: &str,
    block_lines: &mut Vec<&str>,
    block_start: &mut Option<usize>,
    end_cursor: usize,
    heading_path: &[String],
    plain_text: bool,
) {
    let Some(start) = block_start.take() else {
        return;
    };
    if block_lines.is_empty() {
        return;
    }

    let kind = if plain_text {
        EvidenceKind::Text
    } else if is_list_block(block_lines) {
        EvidenceKind::List
    } else {
        EvidenceKind::Paragraph
    };
    let end = end_cursor.max(start);
    push_unit(
        evidence,
        source_id,
        kind,
        block_lines,
        start,
        end,
        heading_path,
    );
    block_lines.clear();
}

fn push_unit(
    evidence: &mut Vec<EvidenceUnit>,
    source_id: &str,
    kind: EvidenceKind,
    lines: &[&str],
    line_start: usize,
    line_end: usize,
    heading_path: &[String],
) {
    let text = lines.join("\n");
    let content_hash = sha256_hex(text.as_bytes());
    let id_input = format!("{source_id}:{line_start}:{line_end}:{content_hash}");
    let id_hash = sha256_hex(id_input.as_bytes());
    evidence.push(EvidenceUnit {
        id: format!("ev_{}", &id_hash[..16]),
        kind,
        text,
        position: SourcePosition {
            line_start,
            line_end,
            heading_path: heading_path
                .iter()
                .filter(|heading| !heading.is_empty())
                .cloned()
                .collect(),
        },
        content_hash,
        confidence: 1.0,
    });
}

fn parse_heading(line: &str) -> Option<(usize, &str)> {
    let trimmed = line.trim_start();
    let level = trimmed
        .chars()
        .take_while(|character| *character == '#')
        .count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let remainder = trimmed.get(level..)?;
    if !remainder.starts_with(' ') {
        return None;
    }
    let heading = remainder.trim();
    (!heading.is_empty()).then_some((level, heading))
}

fn is_list_block(lines: &[&str]) -> bool {
    let first = lines.first().map(|line| line.trim_start()).unwrap_or("");
    first.starts_with("- ")
        || first.starts_with("* ")
        || first.starts_with("+ ")
        || first
            .split_once(". ")
            .is_some_and(|(prefix, _)| prefix.chars().all(|character| character.is_ascii_digit()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    bytes_to_hex(&Sha256::digest(bytes))
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut output, "{byte:02x}").expect("writing to a String cannot fail");
    }
    output
}

fn evidence_kind_name(kind: &EvidenceKind) -> &'static str {
    match kind {
        EvidenceKind::Metadata => "metadata",
        EvidenceKind::Heading => "heading",
        EvidenceKind::Paragraph => "paragraph",
        EvidenceKind::List => "list",
        EvidenceKind::Text => "text",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_parser_preserves_front_matter_headings_and_lines() {
        let input =
            "---\ntitle: Example\n---\n\n# 規程\n\n導入文です。\n\n## 条件\n\n- 条件A\n- 条件B\n";
        let document = parse_markdown(input, "src_1", "example.md").unwrap();

        assert_eq!(document.title.as_deref(), Some("規程"));
        assert_eq!(document.evidence[0].kind, EvidenceKind::Metadata);
        assert_eq!(document.evidence[0].position.line_start, 1);
        assert_eq!(document.evidence[0].position.line_end, 3);

        let list = document
            .evidence
            .iter()
            .find(|unit| unit.kind == EvidenceKind::List)
            .unwrap();
        assert_eq!(list.position.heading_path, ["規程", "条件"]);
        assert_eq!(list.position.line_start, 11);
        assert_eq!(list.position.line_end, 12);
    }

    #[test]
    fn text_parser_splits_paragraphs() {
        let input = "会議メモ\n日時: 2026-01-01\n\n決定事項\n変更しない。\n";
        let document = parse_text(input, "src_2", "memo.txt").unwrap();

        assert_eq!(document.title.as_deref(), Some("会議メモ"));
        assert_eq!(document.evidence.len(), 2);
        assert_eq!(document.evidence[1].position.line_start, 4);
        assert_eq!(document.evidence[1].position.line_end, 5);
    }
}
