use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use fragarach_llm::CodexAppServerClaimExtractor;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Deserialize)]
struct BridgeRequest {
    id: u64,
    prompt: String,
    schema: Value,
}

fn main() -> Result<()> {
    let options = Options::parse(std::env::args().skip(1))?;
    let generator = CodexAppServerClaimExtractor::new(
        options.codex_command,
        options.model.clone(),
        options.reasoning_effort.clone(),
        options.cwd,
        Duration::from_secs(options.timeout_seconds),
    )?;
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    write_json_line(
        &mut stdout,
        &json!({
            "type": "ready",
            "provider": "codex-app-server",
            "model": options.model,
            "reasoning_effort": options.reasoning_effort,
        }),
    )?;

    for line in stdin.lock().lines() {
        let line = line.context("failed to read bridge request")?;
        if line.trim().is_empty() {
            continue;
        }
        let request: BridgeRequest = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                write_json_line(
                    &mut stdout,
                    &json!({"id": null, "error": format!("invalid request: {error}")}),
                )?;
                continue;
            }
        };
        let mut schema = request.schema;
        make_schema_strict(&mut schema);
        match generator.generate_structured(&request.prompt, schema) {
            Ok(response) => write_json_line(
                &mut stdout,
                &json!({
                    "id": request.id,
                    "content": response.content,
                    "usage": {
                        "promptTokens": response.usage.prompt_tokens,
                        "outputTokens": response.usage.completion_tokens,
                        "durationMs": response.usage.duration_ms,
                    }
                }),
            )?,
            Err(error) => write_json_line(
                &mut stdout,
                &json!({"id": request.id, "error": format!("{error:#}")}),
            )?,
        }
    }
    Ok(())
}

fn make_schema_strict(schema: &mut Value) {
    match schema {
        Value::Object(object) => {
            if object.get("type").and_then(Value::as_str) == Some("object") {
                object.insert("additionalProperties".to_owned(), Value::Bool(false));
                if let Some(Value::Object(properties)) = object.get("properties") {
                    let required = properties
                        .keys()
                        .cloned()
                        .map(Value::String)
                        .collect::<Vec<_>>();
                    object.insert("required".to_owned(), Value::Array(required));
                }
            }
            for value in object.values_mut() {
                make_schema_strict(value);
            }
        }
        Value::Array(values) => {
            for value in values {
                make_schema_strict(value);
            }
        }
        _ => {}
    }
}

fn write_json_line(writer: &mut impl Write, value: &Value) -> Result<()> {
    serde_json::to_writer(&mut *writer, value).context("failed to write bridge response")?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

struct Options {
    codex_command: PathBuf,
    model: String,
    reasoning_effort: String,
    cwd: PathBuf,
    timeout_seconds: u64,
}

impl Options {
    fn parse(arguments: impl Iterator<Item = String>) -> Result<Self> {
        let mut options = Self {
            codex_command: PathBuf::from("codex"),
            model: "gpt-5.6-luna".to_owned(),
            reasoning_effort: "low".to_owned(),
            cwd: std::env::current_dir()?,
            timeout_seconds: 900,
        };
        let mut arguments = arguments;
        while let Some(argument) = arguments.next() {
            let value = arguments
                .next()
                .with_context(|| format!("missing value for {argument}"))?;
            match argument.as_str() {
                "--codex-command" => options.codex_command = value.into(),
                "--model" => options.model = value,
                "--reasoning-effort" => options.reasoning_effort = value,
                "--cwd" => options.cwd = value.into(),
                "--timeout-seconds" => {
                    options.timeout_seconds = value
                        .parse()
                        .with_context(|| format!("invalid --timeout-seconds value: {value}"))?;
                }
                _ => bail!("unknown argument: {argument}"),
            }
        }
        Ok(options)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn makes_nested_object_schemas_strict() {
        let mut schema = json!({
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {"value": {"type": "string"}},
                        "required": ["value"]
                    }
                }
            },
            "required": ["items"]
        });
        make_schema_strict(&mut schema);
        assert_eq!(schema["additionalProperties"], Value::Bool(false));
        assert_eq!(schema["required"], json!(["items"]));
        assert_eq!(
            schema["properties"]["items"]["items"]["additionalProperties"],
            Value::Bool(false)
        );
        assert_eq!(
            schema["properties"]["items"]["items"]["required"],
            json!(["value"])
        );
    }

    #[test]
    fn requires_every_property_for_codex_strict_output() {
        let mut schema = json!({
            "type": "object",
            "properties": {
                "required_value": {"type": "string"},
                "optional_value": {
                    "anyOf": [{"type": "string"}, {"type": "null"}],
                    "default": null
                }
            },
            "required": ["required_value"]
        });
        make_schema_strict(&mut schema);
        assert_eq!(
            schema["required"],
            json!(["optional_value", "required_value"])
        );
    }
}
