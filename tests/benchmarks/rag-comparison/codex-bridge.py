"""Small persistent client for the Fragrach Codex App Server bridge.

External P1 adapters use this module so every LLM-backed index is built with
the same Codex App Server model and records comparable call/token counts.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any


class CodexBridge:
    def __init__(
        self,
        bridge: Path,
        cwd: Path,
        model: str = "gpt-5.6-luna",
        reasoning_effort: str = "low",
        codex_command: str = "codex",
        timeout_seconds: int = 900,
    ) -> None:
        if not bridge.is_file():
            raise FileNotFoundError(f"Codex structured chat bridge not found: {bridge}")
        creation_flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        self.process = subprocess.Popen(
            [
                str(bridge),
                "--codex-command",
                codex_command,
                "--model",
                model,
                "--reasoning-effort",
                reasoning_effort,
                "--cwd",
                str(cwd),
                "--timeout-seconds",
                str(timeout_seconds),
            ],
            cwd=cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
            creationflags=creation_flags,
        )
        self._lock = threading.Lock()
        self._next_id = 1
        self.call_count = 0
        self.prompt_tokens = 0
        self.output_tokens = 0
        self.duration_ms = 0
        ready_line = self.process.stdout.readline() if self.process.stdout else ""
        ready = json.loads(ready_line) if ready_line else {}
        if ready.get("type") != "ready":
            self.close()
            raise RuntimeError(f"Codex bridge did not become ready: {ready_line!r}")

    def request(self, prompt: str, schema: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            if self.process.poll() is not None:
                raise RuntimeError(f"Codex bridge exited with code {self.process.returncode}")
            request_id = self._next_id
            self._next_id += 1
            if self.process.stdin is None or self.process.stdout is None:
                raise RuntimeError("Codex bridge pipes are unavailable")
            self.process.stdin.write(
                json.dumps(
                    {"id": request_id, "prompt": prompt, "schema": schema},
                    ensure_ascii=False,
                )
                + "\n"
            )
            self.process.stdin.flush()
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError("Codex bridge closed stdout before returning a response")
            response = json.loads(line)
            if response.get("id") != request_id:
                raise RuntimeError(
                    f"Codex bridge response id mismatch: expected {request_id}, "
                    f"got {response.get('id')}"
                )
            if response.get("error"):
                raise RuntimeError(str(response["error"]))
            usage = response.get("usage") or {}
            self.call_count += 1
            self.prompt_tokens += int(usage.get("promptTokens") or 0)
            self.output_tokens += int(usage.get("outputTokens") or 0)
            self.duration_ms += int(usage.get("durationMs") or 0)
            return response

    async def request_async(self, prompt: str, schema: dict[str, Any]) -> dict[str, Any]:
        return await asyncio.to_thread(self.request, prompt, schema)

    async def complete_text(
        self,
        prompt: str,
        system_prompt: str | None = None,
        history_messages: list[dict[str, str]] | None = None,
    ) -> str:
        messages: list[str] = []
        if system_prompt:
            messages.append(f"<system>\n{system_prompt}\n</system>")
        for message in history_messages or []:
            role = message.get("role", "user")
            messages.append(f"<{role}>\n{message.get('content', '')}\n</{role}>")
        messages.append(f"<user>\n{prompt}\n</user>")
        messages.append(
            "<output-contract>上記タスクが要求する出力を一切要約せず、response文字列へそのまま格納する。"
            "区切り記号、JSON、引用符、改行を要求された場合はresponse内で正確に保持する。</output-contract>"
        )
        response = await self.request_async(
            "\n\n".join(messages),
            {
                "type": "object",
                "properties": {"response": {"type": "string"}},
                "required": ["response"],
                "additionalProperties": False,
            },
        )
        content = response.get("content") or {}
        result = content.get("response")
        if not isinstance(result, str):
            raise ValueError("Codex bridge returned no response string")
        return result

    def usage(self) -> dict[str, int]:
        return {
            "calls": self.call_count,
            "prompt_tokens": self.prompt_tokens,
            "output_tokens": self.output_tokens,
            "total_tokens": self.prompt_tokens + self.output_tokens,
            "duration_ms": self.duration_ms,
        }

    def close(self) -> None:
        process = getattr(self, "process", None)
        if process is None or process.poll() is not None:
            return
        if process.stdin is not None:
            process.stdin.close()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=10)

