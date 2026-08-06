use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Mutex, MutexGuard, TryLockError};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};

use super::{
    CLAIM_EXTRACTION_CONTRACT_VERSION, ClaimExtractionRequest, ClaimExtractionResponse,
    ClaimExtractor, DOCUMENT_PROFILE_CONTRACT_VERSION, DocumentProfileExtractionRequest,
    DocumentProfileExtractionResponse, DocumentProfileExtractor, LlmUsage, StructuredClaims,
    StructuredDocumentProfiles, claim_extraction_contract_fingerprint, claim_extraction_prompt,
    document_profile_contract_fingerprint, document_profile_extraction_prompt,
    document_profile_response_schema, response_schema,
};

const APP_SERVER_PROTOCOL_VERSION: &str = "codex-app-server-v2";
const BASE_INSTRUCTIONS: &str = "You are Fragarach's deterministic document compiler. Do not use tools, read files, run commands, browse, modify files, or ask questions. Use only the supplied input and return only JSON that matches the requested output schema.";
const STRUCTURED_GENERATION_INSTRUCTIONS: &str = "You are Fragarach's deterministic structured response engine. Do not use tools, read files, run commands, browse, modify files, or ask questions. Use only the supplied input and return only JSON that matches the requested output schema.";

#[derive(Debug, Clone)]
pub struct StructuredGenerationResponse {
    pub content: Value,
    pub provider: String,
    pub model: String,
    pub usage: LlmUsage,
}

pub struct CodexAppServerClaimExtractor {
    clients: Vec<Mutex<CodexAppServerClient>>,
    next_client: AtomicUsize,
    codex_version: String,
    model: String,
    reasoning_effort: String,
}

impl CodexAppServerClaimExtractor {
    pub fn new(
        command: impl Into<PathBuf>,
        model: impl Into<String>,
        reasoning_effort: impl Into<String>,
        cwd: impl AsRef<Path>,
        timeout: Duration,
    ) -> Result<Self> {
        Self::new_with_concurrency(command, model, reasoning_effort, cwd, timeout, 1)
    }

    pub fn new_with_concurrency(
        command: impl Into<PathBuf>,
        model: impl Into<String>,
        reasoning_effort: impl Into<String>,
        cwd: impl AsRef<Path>,
        timeout: Duration,
        concurrency: usize,
    ) -> Result<Self> {
        if concurrency == 0 {
            bail!("Codex App Server concurrency must be greater than zero");
        }
        let command = resolve_codex_command(command.into())?;
        let model = model.into();
        let reasoning_effort = reasoning_effort.into();
        if model.trim().is_empty() {
            bail!("Codex App Server model must not be empty");
        }
        if reasoning_effort.trim().is_empty() {
            bail!("Codex reasoning effort must not be empty");
        }
        let cwd = cwd.as_ref().canonicalize().with_context(|| {
            format!(
                "failed to resolve Codex working directory {}",
                cwd.as_ref().display()
            )
        })?;
        let codex_version = read_codex_version(&command, &cwd)?;
        let mut clients = Vec::with_capacity(concurrency);
        for _ in 0..concurrency {
            let mut client = CodexAppServerClient::spawn(&command, &cwd, timeout)?;
            client.initialize()?;
            client.ensure_model_available(&model, &reasoning_effort)?;
            clients.push(Mutex::new(client));
        }

        Ok(Self {
            clients,
            next_client: AtomicUsize::new(0),
            codex_version,
            model,
            reasoning_effort,
        })
    }

    fn lock_client(&self) -> Result<MutexGuard<'_, CodexAppServerClient>> {
        let start = self.next_client.fetch_add(1, Ordering::Relaxed);
        for offset in 0..self.clients.len() {
            let index = (start + offset) % self.clients.len();
            match self.clients[index].try_lock() {
                Ok(client) => return Ok(client),
                Err(TryLockError::WouldBlock) => {}
                Err(TryLockError::Poisoned(_)) => {
                    return Err(anyhow!("Codex App Server client lock was poisoned"));
                }
            }
        }
        self.clients[start % self.clients.len()]
            .lock()
            .map_err(|_| anyhow!("Codex App Server client lock was poisoned"))
    }

    pub fn generate_structured(
        &self,
        prompt: &str,
        output_schema: Value,
    ) -> Result<StructuredGenerationResponse> {
        if prompt.trim().is_empty() {
            bail!("structured generation prompt must not be empty");
        }
        let started = Instant::now();
        let mut client = self.lock_client()?;
        let outcome = client.extract_claims(
            &self.model,
            &self.reasoning_effort,
            prompt,
            output_schema,
            STRUCTURED_GENERATION_INSTRUCTIONS,
        )?;
        let content = serde_json::from_str(&outcome.message)
            .context("Codex App Server structured response was not valid JSON")?;
        Ok(StructuredGenerationResponse {
            content,
            provider: "codex-app-server".to_owned(),
            model: self.model.clone(),
            usage: LlmUsage {
                prompt_tokens: outcome.prompt_tokens,
                completion_tokens: outcome.completion_tokens,
                duration_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
            },
        })
    }
}

impl ClaimExtractor for CodexAppServerClaimExtractor {
    fn extract(&self, request: &ClaimExtractionRequest) -> Result<ClaimExtractionResponse> {
        if request.evidence.is_empty() {
            bail!("claim extraction requires at least one evidence unit");
        }

        let prompt = claim_extraction_prompt(request)?;
        let started = Instant::now();
        let mut client = self.lock_client()?;
        let outcome = client.extract_claims(
            &self.model,
            &self.reasoning_effort,
            &prompt,
            response_schema(),
            BASE_INSTRUCTIONS,
        )?;
        let parsed: StructuredClaims = serde_json::from_str(&outcome.message)
            .context("Codex App Server response did not match the claim schema")?;

        Ok(ClaimExtractionResponse {
            claims: parsed.claims,
            provider: "codex-app-server".to_owned(),
            model: self.model.clone(),
            usage: LlmUsage {
                prompt_tokens: outcome.prompt_tokens,
                completion_tokens: outcome.completion_tokens,
                duration_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
            },
        })
    }

    fn cache_identity(&self) -> Result<Option<String>> {
        Ok(Some(format!(
            "provider=codex-app-server;codex_version={};protocol={};model={};effort={};contract={};fingerprint={}",
            self.codex_version,
            APP_SERVER_PROTOCOL_VERSION,
            self.model,
            self.reasoning_effort,
            CLAIM_EXTRACTION_CONTRACT_VERSION,
            claim_extraction_contract_fingerprint()
        )))
    }
}

impl DocumentProfileExtractor for CodexAppServerClaimExtractor {
    fn extract_profiles(
        &self,
        request: &DocumentProfileExtractionRequest,
    ) -> Result<DocumentProfileExtractionResponse> {
        if request.evidence.is_empty() {
            bail!("document profile extraction requires at least one evidence unit");
        }
        let prompt = document_profile_extraction_prompt(request)?;
        let started = Instant::now();
        let mut client = self.lock_client()?;
        let outcome = client.extract_claims(
            &self.model,
            &self.reasoning_effort,
            &prompt,
            document_profile_response_schema(),
            BASE_INSTRUCTIONS,
        )?;
        let parsed: StructuredDocumentProfiles = serde_json::from_str(&outcome.message)
            .context("Codex App Server response did not match the document profile schema")?;
        Ok(DocumentProfileExtractionResponse {
            profiles: parsed.profiles,
            relations: parsed.relations,
            provider: "codex-app-server".to_owned(),
            model: self.model.clone(),
            usage: LlmUsage {
                prompt_tokens: outcome.prompt_tokens,
                completion_tokens: outcome.completion_tokens,
                duration_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
            },
        })
    }

    fn profile_cache_identity(&self) -> Result<Option<String>> {
        Ok(Some(format!(
            "provider=codex-app-server;codex_version={};protocol={};model={};effort={};contract={};fingerprint={}",
            self.codex_version,
            APP_SERVER_PROTOCOL_VERSION,
            self.model,
            self.reasoning_effort,
            DOCUMENT_PROFILE_CONTRACT_VERSION,
            document_profile_contract_fingerprint()
        )))
    }
}

fn read_codex_version(command: &Path, cwd: &Path) -> Result<String> {
    let output = Command::new(command)
        .arg("--version")
        .current_dir(cwd)
        .output()
        .with_context(|| format!("failed to run {} --version", command.display()))?;
    if !output.status.success() {
        bail!(
            "{} --version failed with status {}: {}",
            command.display(),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let version = String::from_utf8(output.stdout)
        .context("Codex version output was not valid UTF-8")?
        .trim()
        .to_owned();
    if version.is_empty() {
        bail!("Codex version output was empty");
    }
    Ok(version)
}

#[cfg(windows)]
fn resolve_codex_command(command: PathBuf) -> Result<PathBuf> {
    if command.extension().is_some() {
        return Ok(command);
    }
    for extension in ["cmd", "exe"] {
        let candidate = command.with_extension(extension);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    let output = Command::new("where.exe")
        .arg(&command)
        .output()
        .with_context(|| format!("failed to resolve Codex command {}", command.display()))?;
    if output.status.success() {
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let candidate = PathBuf::from(line.trim());
            let extension = candidate
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("exe") {
                return Ok(candidate);
            }
        }
    }
    Ok(command)
}

#[cfg(not(windows))]
fn resolve_codex_command(command: PathBuf) -> Result<PathBuf> {
    Ok(command)
}

struct CodexAppServerClient {
    child: Child,
    stdin: ChildStdin,
    messages: Receiver<std::result::Result<Value, String>>,
    timeout: Duration,
    next_request_id: u64,
    pending_notifications: VecDeque<Value>,
}

impl CodexAppServerClient {
    fn spawn(command: &Path, cwd: &Path, timeout: Duration) -> Result<Self> {
        let mut child = Command::new(command)
            .args([
                "app-server",
                "--stdio",
                "-c",
                "project_doc_max_bytes=0",
                "-c",
                "history.persistence=\"none\"",
                "-c",
                "web_search=\"disabled\"",
            ])
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .with_context(|| format!("failed to start {} app-server", command.display()))?;
        let stdin = child
            .stdin
            .take()
            .context("Codex App Server stdin was unavailable")?;
        let stdout = child
            .stdout
            .take()
            .context("Codex App Server stdout was unavailable")?;
        let (sender, messages) = mpsc::channel();
        thread::Builder::new()
            .name("fragarach-codex-app-server-reader".to_owned())
            .spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    let message = match line {
                        Ok(line) => serde_json::from_str(&line).map_err(|error| {
                            format!("invalid JSON from Codex App Server: {error}")
                        }),
                        Err(error) => {
                            Err(format!("failed to read Codex App Server output: {error}"))
                        }
                    };
                    let is_error = message.is_err();
                    if sender.send(message).is_err() || is_error {
                        break;
                    }
                }
            })
            .context("failed to start Codex App Server reader")?;

        Ok(Self {
            child,
            stdin,
            messages,
            timeout,
            next_request_id: 1,
            pending_notifications: VecDeque::new(),
        })
    }

    fn initialize(&mut self) -> Result<()> {
        self.request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "fragarach",
                    "title": "Fragarach",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
        )?;
        self.send(&json!({"method": "initialized", "params": {}}))
            .context("failed to acknowledge Codex App Server initialization")
    }

    fn ensure_model_available(&mut self, model: &str, reasoning_effort: &str) -> Result<()> {
        let response = self.request("model/list", json!({"limit": 100, "includeHidden": true}))?;
        let models = response
            .pointer("/result/data")
            .and_then(Value::as_array)
            .context("Codex App Server model/list response did not contain result.data")?;
        let selected = models
            .iter()
            .find(|candidate| {
                candidate.get("id").and_then(Value::as_str) == Some(model)
                    || candidate.get("model").and_then(Value::as_str) == Some(model)
            })
            .with_context(|| {
                format!("Codex model {model} is not available for the current account")
            })?;
        if let Some(efforts) = selected
            .get("supportedReasoningEfforts")
            .and_then(Value::as_array)
        {
            let supported = efforts.iter().any(|entry| {
                entry.get("reasoningEffort").and_then(Value::as_str) == Some(reasoning_effort)
            });
            if !supported {
                bail!("Codex model {model} does not advertise reasoning effort {reasoning_effort}");
            }
        }
        Ok(())
    }

    fn extract_claims(
        &mut self,
        model: &str,
        reasoning_effort: &str,
        prompt: &str,
        output_schema: Value,
        base_instructions: &str,
    ) -> Result<TurnOutcome> {
        let thread_response = self.request(
            "thread/start",
            json!({
                "model": model,
                "approvalPolicy": "never",
                "sandbox": "read-only",
                "baseInstructions": base_instructions,
                "developerInstructions": base_instructions,
                "serviceName": "fragarach",
                "ephemeral": true
            }),
        )?;
        let thread_id = thread_response
            .pointer("/result/thread/id")
            .and_then(Value::as_str)
            .context("Codex thread/start response did not contain a thread id")?
            .to_owned();

        let result = self.run_turn(&thread_id, model, reasoning_effort, prompt, output_schema);
        let _ = self.request("thread/unsubscribe", json!({"threadId": thread_id}));
        result
    }

    fn run_turn(
        &mut self,
        thread_id: &str,
        model: &str,
        reasoning_effort: &str,
        prompt: &str,
        output_schema: Value,
    ) -> Result<TurnOutcome> {
        let turn_response = self.request(
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [{"type": "text", "text": prompt}],
                "model": model,
                "effort": reasoning_effort,
                "approvalPolicy": "never",
                "sandboxPolicy": {"type": "readOnly", "networkAccess": false},
                "summary": "none",
                "outputSchema": output_schema
            }),
        )?;
        let turn_id = turn_response
            .pointer("/result/turn/id")
            .and_then(Value::as_str)
            .context("Codex turn/start response did not contain a turn id")?
            .to_owned();
        let mut outcome = TurnOutcome::default();

        loop {
            let message = self.receive()?;
            if message.get("id").is_some() && message.get("method").is_some() {
                self.reject_server_request(&message)?;
                continue;
            }
            match observe_turn_message(&message, thread_id, &turn_id, &mut outcome)? {
                TurnObservation::Continue => {}
                TurnObservation::Completed => return Ok(outcome),
            }
        }
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_request_id;
        self.next_request_id += 1;
        self.send(&json!({"method": method, "id": id, "params": params}))?;

        loop {
            let message = self.receive_raw()?;
            if message.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(error) = message.get("error") {
                    bail!("Codex App Server {method} failed: {error}");
                }
                return Ok(message);
            }
            if message.get("id").is_some() && message.get("method").is_some() {
                self.reject_server_request(&message)?;
            } else {
                self.pending_notifications.push_back(message);
            }
        }
    }

    fn reject_server_request(&mut self, message: &Value) -> Result<()> {
        let id = message
            .get("id")
            .context("Codex server request did not contain an id")?;
        self.send(&json!({
            "id": id,
            "error": {
                "code": -32000,
                "message": "Fragarach's compiler provider does not allow tools or approvals"
            }
        }))
    }

    fn send(&mut self, message: &Value) -> Result<()> {
        serde_json::to_writer(&mut self.stdin, message)
            .context("failed to serialize Codex App Server request")?;
        self.stdin
            .write_all(b"\n")
            .context("failed to write Codex App Server request")?;
        self.stdin
            .flush()
            .context("failed to flush Codex App Server request")
    }

    fn receive(&mut self) -> Result<Value> {
        if let Some(message) = self.pending_notifications.pop_front() {
            return Ok(message);
        }
        self.receive_raw()
    }

    fn receive_raw(&self) -> Result<Value> {
        match self.messages.recv_timeout(self.timeout) {
            Ok(Ok(message)) => Ok(message),
            Ok(Err(error)) => bail!("{error}"),
            Err(RecvTimeoutError::Timeout) => {
                bail!("Codex App Server did not respond within {:?}", self.timeout)
            }
            Err(RecvTimeoutError::Disconnected) => {
                bail!("Codex App Server output stream closed unexpectedly")
            }
        }
    }
}

impl Drop for CodexAppServerClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
struct TurnOutcome {
    message: String,
    prompt_tokens: u64,
    completion_tokens: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TurnObservation {
    Continue,
    Completed,
}

fn observe_turn_message(
    message: &Value,
    thread_id: &str,
    turn_id: &str,
    outcome: &mut TurnOutcome,
) -> Result<TurnObservation> {
    let method = message.get("method").and_then(Value::as_str);
    let params = message.get("params").unwrap_or(&Value::Null);
    if params
        .get("threadId")
        .and_then(Value::as_str)
        .is_some_and(|id| id != thread_id)
        || params
            .get("turnId")
            .and_then(Value::as_str)
            .is_some_and(|id| id != turn_id)
    {
        return Ok(TurnObservation::Continue);
    }

    match method {
        Some("item/completed") => {
            if params.pointer("/item/type").and_then(Value::as_str) == Some("agentMessage") {
                outcome.message = params
                    .pointer("/item/text")
                    .and_then(Value::as_str)
                    .context("completed Codex agent message did not contain text")?
                    .to_owned();
            }
        }
        Some("thread/tokenUsage/updated") => {
            let last = params
                .pointer("/tokenUsage/last")
                .context("Codex token usage notification did not contain tokenUsage.last")?;
            outcome.prompt_tokens = nonnegative_u64(last.get("inputTokens"));
            outcome.completion_tokens = nonnegative_u64(last.get("outputTokens"));
        }
        Some("turn/completed") => {
            if params.pointer("/turn/id").and_then(Value::as_str) != Some(turn_id) {
                return Ok(TurnObservation::Continue);
            }
            let status = params
                .pointer("/turn/status")
                .and_then(Value::as_str)
                .context("Codex turn/completed notification did not contain a status")?;
            if status != "completed" {
                let error = params.pointer("/turn/error").unwrap_or(&Value::Null);
                bail!("Codex turn ended with status {status}: {error}");
            }
            if outcome.message.is_empty() {
                bail!("Codex turn completed without a final agent message");
            }
            return Ok(TurnObservation::Completed);
        }
        _ => {}
    }
    Ok(TurnObservation::Continue)
}

fn nonnegative_u64(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_i64).unwrap_or_default().max(0) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_structured_message_and_last_turn_usage() {
        let mut outcome = TurnOutcome::default();
        let message = json!({
            "method": "item/completed",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {"type": "agentMessage", "text": "{\"claims\":[]}"}
            }
        });
        assert_eq!(
            observe_turn_message(&message, "thread-1", "turn-1", &mut outcome).unwrap(),
            TurnObservation::Continue
        );
        observe_turn_message(
            &json!({
                "method": "thread/tokenUsage/updated",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "tokenUsage": {"last": {"inputTokens": 120, "outputTokens": 30}}
                }
            }),
            "thread-1",
            "turn-1",
            &mut outcome,
        )
        .unwrap();
        assert_eq!(outcome.prompt_tokens, 120);
        assert_eq!(outcome.completion_tokens, 30);
        assert_eq!(outcome.message, "{\"claims\":[]}");
    }

    #[test]
    fn completes_only_the_matching_turn() {
        let mut outcome = TurnOutcome {
            message: "{\"claims\":[]}".to_owned(),
            ..TurnOutcome::default()
        };
        let other = json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turnId": "other-turn",
                "turn": {"id": "other-turn", "status": "completed"}
            }
        });
        assert_eq!(
            observe_turn_message(&other, "thread-1", "turn-1", &mut outcome).unwrap(),
            TurnObservation::Continue
        );
        let matching = json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "turn": {"id": "turn-1", "status": "completed"}
            }
        });
        assert_eq!(
            observe_turn_message(&matching, "thread-1", "turn-1", &mut outcome).unwrap(),
            TurnObservation::Completed
        );
    }
}
