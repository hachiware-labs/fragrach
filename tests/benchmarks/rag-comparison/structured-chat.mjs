import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";
import { performance } from "node:perf_hooks";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export async function createStructuredChat(options) {
  if (options.provider === "ollama") {
    return new OllamaStructuredChat(options);
  }
  if (options.provider === "codex-app-server") {
    const client = new CodexBridgeStructuredChat(options);
    await client.initialize();
    return client;
  }
  throw new Error(`unknown structured chat provider: ${options.provider}`);
}

export class OllamaStructuredChat {
  constructor({ endpoint, model, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.endpoint = endpoint.replace(/\/$/, "");
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.label = `ollama:${model}`;
  }

  async chat(prompt, schema, seed) {
    const startedAt = performance.now();
    const response = await fetch(`${this.endpoint}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        think: false,
        format: schema,
        options: {
          temperature: 0,
          seed,
          num_ctx: 65536,
          num_predict: 4096,
        },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Ollama ${response.status}: ${await response.text()}`);
    }
    const body = await response.json();
    let content;
    try {
      content = JSON.parse(body.message.content);
    } catch (error) {
      throw new Error(`Ollama returned invalid JSON: ${error.message}`);
    }
    return {
      content,
      usage: {
        promptTokens: body.prompt_eval_count ?? null,
        outputTokens: body.eval_count ?? null,
        durationMs: performance.now() - startedAt,
      },
    };
  }

  async close() {}
}

export class CodexBridgeStructuredChat {
  constructor({
    command = "codex",
    cwd = process.cwd(),
    model,
    reasoningEffort = "low",
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }) {
    this.codexCommand = resolveCodexCommand(command);
    this.cwd = cwd;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.timeoutMs = timeoutMs;
    this.label = `codex-app-server:${model}:${reasoningEffort}`;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  async initialize() {
    const executable = buildBridge(this.cwd);
    if (process.env.FRAGARACH_CHAT_DEBUG === "1") {
      console.error(`Codex bridge executable: ${executable}`);
    }
    const readyPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Codex bridge initialization timed out")),
        this.timeoutMs,
      );
      this.ready = {
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      };
    });
    this.child = spawn(
      executable,
      [
        "--codex-command",
        this.codexCommand,
        "--model",
        this.model,
        "--reasoning-effort",
        this.reasoningEffort,
        "--cwd",
        this.cwd,
        "--timeout-seconds",
        String(Math.ceil(this.timeoutMs / 1000)),
      ],
      {
        cwd: this.cwd,
        stdio: ["pipe", "pipe", "inherit"],
        windowsHide: true,
      },
    );
    this.child.once("error", (error) => this.failAll(error));
    this.child.once("exit", (code, signal) => {
      if (!this.closed) {
        this.failAll(
          new Error(`Codex bridge exited unexpectedly: code=${code}, signal=${signal}`),
        );
      }
    });
    this.reader = readline.createInterface({ input: this.child.stdout });
    this.reader.on("line", (line) => this.receiveLine(line));
    this.exitHandler = () => this.child?.kill();
    process.once("exit", this.exitHandler);
    await readyPromise;
  }

  chat(prompt, schema) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex structured request ${id} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.child.stdin.write(`${JSON.stringify({ id, prompt, schema })}\n`);
    });
  }

  receiveLine(line) {
    if (process.env.FRAGARACH_CHAT_DEBUG === "1") {
      console.error(`Codex bridge stdout: ${line}`);
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.failAll(new Error(`Invalid JSON from Codex bridge: ${error.message}`));
      return;
    }
    if (message.type === "ready") {
      this.ready?.resolve();
      this.ready = null;
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve({ content: message.content, usage: message.usage });
    }
  }

  failAll(error) {
    this.ready?.reject(error);
    this.ready = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    process.removeListener("exit", this.exitHandler);
    this.reader?.close();
    this.child?.stdin?.end();
    this.child?.kill();
  }
}

function buildBridge(repositoryRoot) {
  const build = spawnSync(
    "cargo",
    ["build", "--quiet", "-p", "fragarach-llm", "--example", "codex_structured_chat_bridge"],
    { cwd: repositoryRoot, encoding: "utf8", windowsHide: true },
  );
  if (build.status !== 0) {
    throw new Error(`failed to build Codex bridge: ${build.stderr || build.stdout}`);
  }
  const executable = path.join(
    repositoryRoot,
    "target",
    "debug",
    "examples",
    process.platform === "win32"
      ? "codex_structured_chat_bridge.exe"
      : "codex_structured_chat_bridge",
  );
  if (!fs.existsSync(executable)) {
    throw new Error(`Codex bridge executable not found: ${executable}`);
  }
  return executable;
}

function resolveCodexCommand(command) {
  if (fs.existsSync(command)) return command;
  if (process.platform !== "win32") return command;
  const result = spawnSync("where.exe", [command], { encoding: "utf8" });
  if (result.status !== 0) return command;
  return (
    result.stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .find((value) => value.toLowerCase().endsWith(".cmd")) ?? command
  );
}
