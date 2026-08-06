use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand, ValueEnum};
use fragarach_ir::{CompilationPolicy, KnowledgeBuildStatus, UnresolvedConflictAction};
use fragarach_llm::{
    CodexAppServerClaimExtractor, KnowledgeExtractor, MetadataOnlyExtractor, OllamaClaimExtractor,
};
use serde_json::json;

#[derive(Debug, Parser)]
#[command(
    name = "fragarach",
    version,
    about = "Compile source documents into evidence-preserving knowledge artifacts"
)]
struct Cli {
    #[arg(long, global = true, help = "Emit machine-readable JSON")]
    json: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    #[command(about = "Initialize a Fragrach workspace")]
    Init {
        #[arg(default_value = ".")]
        path: PathBuf,
    },
    #[command(about = "Scan source files and produce Parsed Documents")]
    Scan {
        #[arg(long)]
        source: PathBuf,

        #[arg(long, default_value = ".")]
        workspace: PathBuf,

        #[arg(long, value_delimiter = ',')]
        include: Vec<String>,

        #[arg(long, value_delimiter = ',')]
        exclude: Vec<String>,

        #[arg(long)]
        max_file_size: Option<u64>,

        #[arg(long)]
        max_errors: Option<usize>,

        #[arg(long)]
        max_warnings: Option<usize>,
    },
    #[command(about = "Manage Usage Intent definitions")]
    Intent {
        #[command(subcommand)]
        command: IntentCommand,
    },
    #[command(about = "Inspect persistent Claim extraction cache entries")]
    Cache {
        #[command(subcommand)]
        command: CacheCommand,
    },
    #[command(about = "Compile parsed evidence into a Knowledge Build")]
    Compile {
        #[arg(long)]
        intent: PathBuf,
        #[arg(long, default_value = ".")]
        workspace: PathBuf,
        #[arg(long, default_value = "knowledge-build")]
        output: PathBuf,
        #[arg(long, value_enum, default_value_t = CompilerProvider::Ollama)]
        provider: CompilerProvider,
        #[arg(long)]
        model: String,
        #[arg(long, default_value = "http://127.0.0.1:11434")]
        ollama_endpoint: String,
        #[arg(long, default_value = "codex")]
        codex_command: PathBuf,
        #[arg(long, default_value = "low")]
        reasoning_effort: String,
        #[arg(long, default_value_t = 12)]
        batch_size: usize,
        #[arg(
            long,
            help = "Maximum concurrent LLM requests (default: Codex 8, Ollama 1)"
        )]
        llm_concurrency: Option<usize>,
        #[arg(long, help = "Disable the persistent source extraction cache")]
        no_cache: bool,
        #[arg(long)]
        as_of: Option<String>,
        #[arg(long, value_delimiter = ',')]
        authority_precedence: Vec<String>,
        #[arg(long, value_enum, default_value_t = ConflictAction::Warn)]
        on_unresolved_conflict: ConflictAction,
        #[arg(long)]
        warnings_as_errors: bool,
    },
    #[command(about = "Reapply deterministic metadata and validation without calling the LLM")]
    Recompile {
        #[arg(long)]
        build: PathBuf,
        #[arg(long, default_value = ".")]
        workspace: PathBuf,
        #[arg(long, default_value = "knowledge-build-recompiled")]
        output: PathBuf,
        #[arg(long)]
        as_of: Option<String>,
        #[arg(long, value_delimiter = ',')]
        authority_precedence: Vec<String>,
        #[arg(long, value_enum, default_value_t = ConflictAction::Warn)]
        on_unresolved_conflict: ConflictAction,
        #[arg(long)]
        warnings_as_errors: bool,
    },
    #[command(about = "Show a Knowledge Build summary and diagnostics")]
    Report {
        #[arg(long, default_value = "knowledge-build")]
        build: PathBuf,
    },
    #[command(about = "Export a Knowledge Build for downstream RAG ingestion")]
    Export {
        #[arg(long, default_value = "knowledge-build")]
        build: PathBuf,
        #[arg(
            long,
            help = "Export only upsert/delete operations relative to this Build"
        )]
        base_build: Option<PathBuf>,
        #[arg(long, value_enum, default_value_t = ExportFormat::Jsonl)]
        format: ExportFormat,
        #[arg(long, default_value = "rag-export.jsonl")]
        output: PathBuf,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum ConflictAction {
    Warn,
    Error,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum ExportFormat {
    Jsonl,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum CompilerProvider {
    Ollama,
    CodexAppServer,
    Metadata,
}

#[derive(Debug, Subcommand)]
enum IntentCommand {
    #[command(about = "Validate a Usage Intent YAML file")]
    Validate {
        #[arg(long)]
        file: PathBuf,
    },
}

#[derive(Debug, Subcommand)]
enum CacheCommand {
    #[command(about = "Show extraction cache entries without changing them")]
    Report {
        #[arg(long, default_value = ".")]
        workspace: PathBuf,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Command::Init { path } => {
            let paths = fragarach_core::init_workspace(&path)?;
            if cli.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&json!({
                        "status": "initialized",
                        "workspace": paths.root,
                        "control_directory": paths.control,
                        "database": paths.database
                    }))?
                );
            } else {
                println!("Initialized Fragrach workspace: {}", paths.root.display());
                println!("Control directory: {}", paths.control.display());
            }
        }
        Command::Scan {
            source,
            workspace,
            include,
            exclude,
            max_file_size,
            max_errors,
            max_warnings,
        } => {
            let manifest = fragarach_core::scan_with_options(
                &source,
                &workspace,
                &fragarach_core::ScanOptions {
                    include,
                    exclude,
                    max_file_size,
                },
            )?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&manifest)?);
            } else {
                let summary = &manifest.summary;
                println!("Scanned: {}", manifest.source_root);
                println!(
                    "Documents: {} (parsed {}, duplicates {}, unsupported {}, errors {})",
                    summary.total_current,
                    summary.parsed_documents,
                    summary.duplicates,
                    summary.unsupported,
                    summary.errors
                );
                println!(
                    "Changes: +{} ~{} ={} -{}",
                    summary.added, summary.changed, summary.unchanged, summary.removed
                );
                println!(
                    "Parse: {} new, {} cache hits",
                    summary.parsed_now, summary.parse_cache_hits
                );
                let reusable = summary.parsed_now + summary.parse_cache_hits;
                let cache_rate = if reusable == 0 {
                    0.0
                } else {
                    summary.parse_cache_hits as f64 / reusable as f64 * 100.0
                };
                println!(
                    "Metrics: {} bytes, {} ms, cache hit rate {:.1}%",
                    summary.bytes_scanned, summary.duration_ms, cache_rate
                );
                println!(
                    "Manifest: {}",
                    workspace.join(".fragarach").join("manifest.json").display()
                );
            }
            let warning_count = manifest
                .documents
                .iter()
                .map(|document| document.warnings.len())
                .sum::<usize>();
            if max_errors.is_some_and(|limit| manifest.summary.errors > limit) {
                bail!(
                    "scan error count {} exceeds CI limit {}",
                    manifest.summary.errors,
                    max_errors.unwrap_or_default()
                );
            }
            if max_warnings.is_some_and(|limit| warning_count > limit) {
                bail!(
                    "scan warning count {} exceeds CI limit {}",
                    warning_count,
                    max_warnings.unwrap_or_default()
                );
            }
        }
        Command::Intent {
            command: IntentCommand::Validate { file },
        } => {
            let intent = fragarach_build::load_usage_intent(&file)?;
            if cli.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&json!({
                        "status": "valid",
                        "file": file,
                        "intent": intent
                    }))?
                );
            } else {
                println!("Valid Usage Intent: {}", intent.id);
                println!("Goal: {}", intent.goal);
                println!(
                    "Users: {}, tasks: {}, questions: {}",
                    intent.users.len(),
                    intent.tasks.len(),
                    intent.questions.len()
                );
            }
        }
        Command::Cache {
            command: CacheCommand::Report { workspace },
        } => {
            let report = fragarach_build::read_extraction_cache_report(&workspace)?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                println!("Extraction cache: {}", report.root.display());
                println!(
                    "Entries: {}; Evidence: {}; Claims: {}",
                    report.entries.len(),
                    report.evidence_units,
                    report.claims
                );
                for entry in report.entries {
                    println!(
                        "- {} | intent={} | sources={} | evidence={} | claims={} | model={}",
                        entry.path.display(),
                        if entry.intent_id.is_empty() {
                            "unknown"
                        } else {
                            &entry.intent_id
                        },
                        entry.source_ids.len(),
                        entry.evidence_units,
                        entry.claims,
                        entry.model
                    );
                }
            }
        }
        Command::Compile {
            intent,
            workspace,
            output,
            provider,
            model,
            ollama_endpoint,
            codex_command,
            reasoning_effort,
            batch_size,
            llm_concurrency,
            no_cache,
            as_of,
            authority_precedence,
            on_unresolved_conflict,
            warnings_as_errors,
        } => {
            let as_of = as_of
                .as_deref()
                .map(|date| chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d"))
                .transpose()
                .context("--as-of must be an ISO 8601 date (YYYY-MM-DD)")?;
            let policy = CompilationPolicy {
                unresolved_conflict: match on_unresolved_conflict {
                    ConflictAction::Warn => UnresolvedConflictAction::Warn,
                    ConflictAction::Error => UnresolvedConflictAction::Error,
                },
                warnings_as_errors,
                ..CompilationPolicy::default()
            };
            let llm_concurrency = llm_concurrency.unwrap_or(match provider {
                CompilerProvider::CodexAppServer => 8,
                CompilerProvider::Ollama | CompilerProvider::Metadata => 1,
            });
            if llm_concurrency == 0 {
                bail!("--llm-concurrency must be greater than zero");
            }
            let extractor: Box<dyn KnowledgeExtractor> = match provider {
                CompilerProvider::Ollama => Box::new(OllamaClaimExtractor::new(
                    ollama_endpoint,
                    model,
                    Duration::from_secs(180),
                    42,
                )?),
                CompilerProvider::CodexAppServer => {
                    Box::new(CodexAppServerClaimExtractor::new_with_concurrency(
                        codex_command,
                        model,
                        reasoning_effort,
                        &workspace,
                        Duration::from_secs(180),
                        llm_concurrency,
                    )?)
                }
                CompilerProvider::Metadata => Box::new(MetadataOnlyExtractor::new(model)?),
            };
            let result = fragarach_build::compile_workspace(
                &fragarach_build::CompileOptions {
                    workspace,
                    intent_file: intent,
                    output,
                    batch_size,
                    llm_concurrency,
                    use_extraction_cache: !no_cache,
                    conflict_context: fragarach_build::ConflictContext {
                        as_of,
                        authority_precedence,
                    },
                    policy,
                },
                extractor.as_ref(),
            )?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&result.manifest)?);
            } else {
                println!("Knowledge Build: {}", result.output.display());
                println!(
                    "Status: {:?}; diagnostics: {} warning(s), {} error(s)",
                    result.manifest.status,
                    result.manifest.diagnostics.warnings,
                    result.manifest.diagnostics.errors
                );
                println!(
                    "Extraction cache: {} hit(s), {} miss(es); LLM calls: {}",
                    result.manifest.metrics.extraction_cache_hits,
                    result.manifest.metrics.extraction_cache_misses,
                    result.manifest.metrics.llm_calls
                );
                println!(
                    "Profile cache: {} hit(s), {} miss(es); profile LLM calls: {}; profiles: {}; relations: {}; decision packets: {}",
                    result.manifest.metrics.profile_cache_hits,
                    result.manifest.metrics.profile_cache_misses,
                    result.manifest.metrics.profile_llm_calls,
                    result.manifest.metrics.document_profiles,
                    result.manifest.metrics.document_relations,
                    result.manifest.metrics.decision_packets
                );
            }
            if result.manifest.status == KnowledgeBuildStatus::Failed {
                bail!(
                    "Knowledge Build failed its publication policy; diagnostics were preserved in {}",
                    result.output.display()
                );
            }
        }
        Command::Recompile {
            build,
            workspace,
            output,
            as_of,
            authority_precedence,
            on_unresolved_conflict,
            warnings_as_errors,
        } => {
            let as_of = as_of
                .as_deref()
                .map(|date| chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d"))
                .transpose()
                .context("--as-of must be an ISO 8601 date (YYYY-MM-DD)")?;
            let result = fragarach_build::recompile_build(&fragarach_build::RecompileOptions {
                workspace,
                input: build,
                output,
                conflict_context: fragarach_build::ConflictContext {
                    as_of,
                    authority_precedence,
                },
                policy: CompilationPolicy {
                    unresolved_conflict: match on_unresolved_conflict {
                        ConflictAction::Warn => UnresolvedConflictAction::Warn,
                        ConflictAction::Error => UnresolvedConflictAction::Error,
                    },
                    warnings_as_errors,
                    ..CompilationPolicy::default()
                },
            })?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&result.manifest)?);
            } else {
                println!("Knowledge Build: {}", result.output.display());
                println!(
                    "Status: {:?}; diagnostics: {} warning(s), {} error(s); LLM calls: 0",
                    result.manifest.status,
                    result.manifest.diagnostics.warnings,
                    result.manifest.diagnostics.errors
                );
            }
            if result.manifest.status == KnowledgeBuildStatus::Failed {
                bail!(
                    "Knowledge Build failed its publication policy; diagnostics were preserved in {}",
                    result.output.display()
                );
            }
        }
        Command::Report { build } => {
            let report = fragarach_build::read_build_report(&build)?;
            if cli.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&json!({
                        "manifest": report.manifest,
                        "diagnostics": report.diagnostics
                    }))?
                );
            } else {
                println!("Build: {}", report.manifest.build_id);
                println!("Status: {:?}", report.manifest.status);
                println!("Intent: {}", report.manifest.intent_id);
                println!(
                    "Diagnostics: {} info, {} warning(s), {} error(s)",
                    report.manifest.diagnostics.info,
                    report.manifest.diagnostics.warnings,
                    report.manifest.diagnostics.errors
                );
                println!(
                    "Metrics: {} source(s), {} evidence, {} claim(s) ({} rejected), {} LLM call(s), {} ms",
                    report.manifest.metrics.source_documents,
                    report.manifest.metrics.evidence_units,
                    report.manifest.metrics.claims,
                    report.manifest.metrics.rejected_claims,
                    report.manifest.metrics.llm_calls,
                    report.manifest.metrics.duration_ms
                );
                for diagnostic in report.diagnostics {
                    println!(
                        "{:?}[{}]: {}",
                        diagnostic.severity, diagnostic.code, diagnostic.message
                    );
                    println!("  reason: {}", diagnostic.reason);
                }
            }
        }
        Command::Export {
            build,
            base_build,
            format: ExportFormat::Jsonl,
            output,
        } => {
            if let Some(base_build) = base_build {
                let summary =
                    fragarach_build::export_rag_delta_jsonl(&base_build, &build, &output)?;
                if cli.json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&json!({
                            "format": "jsonl-delta",
                            "summary": summary,
                            "output": output
                        }))?
                    );
                } else {
                    println!(
                        "Exported RAG delta: {} upsert(s), {} delete(s), {} unchanged: {}",
                        summary.upserts,
                        summary.deletes,
                        summary.unchanged,
                        output.display()
                    );
                }
            } else {
                let count = fragarach_build::export_rag_jsonl(&build, &output)?;
                if cli.json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&json!({
                            "format": "jsonl",
                            "records": count,
                            "output": output
                        }))?
                    );
                } else {
                    println!("Exported {count} RAG record(s): {}", output.display());
                }
            }
        }
    }

    Ok(())
}
