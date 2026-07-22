import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type JsonObject = Record<string, unknown>;

export interface RustTransportOptions {
  executable: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stderrLimitBytes?: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Once dispatched, await the authoritative response; only pre-abort is honored. */
  settleDefinitively?: boolean;
}

export interface StructuredRustError {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export class RustTransportError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;
  readonly stderr: string;

  constructor(error: StructuredRustError, stderr = "") {
    super(error.message);
    this.name = "RustTransportError";
    this.code = error.code;
    this.retryable = error.retryable;
    this.details = error.details;
    this.stderr = stderr;
  }
}

class TransportUnavailableError extends Error {
  constructor(message: string, readonly stderr = "") {
    super(message);
    this.name = "TransportUnavailableError";
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortListener?: () => void;
  cancellable: boolean;
  dispatched: boolean;
};

type QueuedWrite = { id: string; pending: Pending; body: string };

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_PENDING = 1024;
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const MAX_STDOUT_LINE_BYTES = 1024 * 1024;

export class RustJsonlTransport {
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private readonly writeQueue: QueuedWrite[] = [];
  private queuedBytes = 0;
  private writing = false;
  private blocked = false;
  private stdoutBuffer = Buffer.alloc(0);
  private nextId = 1;
  private unusable?: Error;
  private cleaned = false;
  private stderrChunks: Buffer[] = [];
  private stderrBytes = 0;
  private readonly stderrLimit: number;

  constructor(private readonly options: RustTransportOptions) {
    const limit = options.stderrLimitBytes ?? 16 * 1024;
    if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 0) {
      throw new Error("stderrLimitBytes must be a finite non-negative integer");
    }
    this.stderrLimit = limit;
  }

  request(method: string, params: JsonObject, options: RequestOptions = {}): Promise<unknown> {
    if (this.unusable) return Promise.reject(this.unusable);
    if (!method || typeof method !== "string") return Promise.reject(new Error("method must be a non-empty string"));
    const timeout = options.timeoutMs;
    if (timeout !== undefined && (!Number.isFinite(timeout) || !Number.isInteger(timeout) || timeout < 0 || timeout > MAX_TIMEOUT_MS)) {
      return Promise.reject(new Error("timeoutMs must be a non-negative integer no greater than 2147483647"));
    }
    if (options.signal?.aborted) {
      const error = new Error("Rust transport request was cancelled");
      if (options.settleDefinitively !== true) this.invalidate(error);
      return Promise.reject(error);
    }
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new Error("Rust transport pending request limit exceeded"));

    const id = String(this.nextId++);
    let body: string;
    try {
      body = `${JSON.stringify({ protocol: 1, id, method, params })}\n`;
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    if (Buffer.byteLength(body) > MAX_QUEUED_BYTES) return Promise.reject(new Error("Rust transport request exceeds queue limit"));
    if (this.queuedBytes + Buffer.byteLength(body) > MAX_QUEUED_BYTES) return Promise.reject(new Error("Rust transport write queue limit exceeded"));

    this.ensureStarted();
    return new Promise((resolve, reject) => {
      const cancellable = options.settleDefinitively !== true;
      const pending: Pending = { resolve, reject, signal: options.signal, cancellable, dispatched: false };
      this.pending.set(id, pending);
      if (cancellable && timeout !== undefined) pending.timer = setTimeout(() => this.abortRequest(id, new Error("Rust transport request timed out")), timeout);
      if (options.signal) {
        const onAbort = () => {
          if (!pending.cancellable && !pending.dispatched) this.cancelQueued(id, new Error("Rust transport request was cancelled"));
          else if (pending.cancellable) this.abortRequest(id, new Error("Rust transport request was cancelled"));
        };
        pending.abortListener = onAbort;
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.writeQueue.push({ id, pending, body });
      this.queuedBytes += Buffer.byteLength(body);
      this.flushWrites();
    });
  }

  close(): void {
    this.invalidate(new Error("Rust transport closed"));
  }

  get stderrDiagnostics(): string {
    return Buffer.concat(this.stderrChunks).toString("utf8");
  }

  private ensureStarted(): void {
    if (this.child) return;
    const child = spawn(this.options.executable, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    this.child = child;
    child.stderr.on("data", (chunk: Buffer | string) => this.collectStderr(Buffer.from(chunk)));
    child.stdin.on("error", (error) => this.invalidate(error));
    child.on("error", (error) => this.invalidate(error));
    child.on("close", (code, signal) => {
      if (this.child !== child) return;
      if (!this.unusable) this.invalidate(new Error(`Rust transport child exited (${signal ?? code ?? "unknown"})`), false);
    });
    child.stdin.on("drain", () => { this.blocked = false; this.flushWrites(); });
    child.stdout.on("data", (chunk: Buffer | string) => this.handleStdout(Buffer.from(chunk)));
    child.stdout.on("error", (error) => this.invalidate(error));
  }

  private flushWrites(): void {
    if (this.cleaned || this.writing || this.blocked || !this.child) return;
    const item = this.writeQueue.shift();
    if (!item) return;
    this.queuedBytes -= Buffer.byteLength(item.body);
    item.pending.dispatched = true;
    this.writing = true;
    let accepted: boolean;
    try {
      accepted = this.child.stdin.write(item.body, (error?: Error | null) => {
        this.writing = false;
        if (error) this.invalidate(error);
        else this.flushWrites();
      });
    } catch (error) {
      this.writing = false;
      this.invalidate(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (!accepted) this.blocked = true;
  }

  private collectStderr(chunk: Buffer): void {
    if (this.stderrBytes >= this.stderrLimit) return;
    const allowed = chunk.subarray(0, this.stderrLimit - this.stderrBytes);
    this.stderrChunks.push(allowed);
    this.stderrBytes += allowed.length;
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    if (this.stdoutBuffer.length > MAX_STDOUT_LINE_BYTES && !this.stdoutBuffer.includes(10)) {
      this.invalidate(new Error("Rust transport output line exceeds maximum size"));
      return;
    }
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf(10)) >= 0) {
      const line = this.stdoutBuffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (Buffer.byteLength(line) > MAX_STDOUT_LINE_BYTES) { this.invalidate(new Error("Rust transport output line exceeds maximum size")); return; }
      this.handleLine(line);
      if (this.cleaned) return;
    }
    if (this.stdoutBuffer.length > MAX_STDOUT_LINE_BYTES) this.invalidate(new Error("Rust transport output line exceeds maximum size"));
  }

  private handleLine(line: string): void {
    let message: unknown;
    try { message = JSON.parse(line); } catch { this.invalidate(new Error("Rust transport received malformed JSON output")); return; }
    if (!message || typeof message !== "object" || Array.isArray(message)) { this.invalidate(new Error("Rust transport received an invalid response envelope")); return; }
    const envelope = message as JsonObject;
    if (envelope.protocol !== 1 || typeof envelope.id !== "string") { this.invalidate(new Error("Rust transport received an invalid protocol envelope")); return; }
    const id = envelope.id;
    const pending = this.pending.get(id);
    if (!pending) { this.invalidate(new Error(`Rust transport received unknown or duplicate response id: ${id}`)); return; }
    const hasError = Object.hasOwn(envelope, "error");
    const hasResult = Object.hasOwn(envelope, "result");
    if (hasError === hasResult) { this.rejectMatched(id, pending, new Error("Rust transport response must contain exactly one of result or error")); this.invalidate(new Error("Rust transport response must contain exactly one of result or error")); return; }
    if (hasError) {
      const error = envelope.error;
      if (!error || typeof error !== "object" || Array.isArray(error)) { this.rejectMatched(id, pending, new Error("Rust transport received an invalid structured error")); this.invalidate(new Error("Rust transport received an invalid structured error")); return; }
      const structured = error as JsonObject;
      if (typeof structured.code !== "string" || typeof structured.message !== "string" || typeof structured.retryable !== "boolean") { this.rejectMatched(id, pending, new Error("Rust transport received an invalid structured error")); this.invalidate(new Error("Rust transport received an invalid structured error")); return; }
      this.pending.delete(id); this.clearPending(pending);
      pending.reject(new RustTransportError({ code: structured.code, message: structured.message, retryable: structured.retryable, details: structured.details }, this.stderrDiagnostics));
      return;
    }
    this.pending.delete(id); this.clearPending(pending); pending.resolve(envelope.result);
  }

  private rejectMatched(id: string, pending: Pending, error: Error): void { this.pending.delete(id); this.clearPending(pending); pending.reject(error); }

  private cancelQueued(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending || pending.dispatched) return;
    const index = this.writeQueue.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [item] = this.writeQueue.splice(index, 1);
    this.queuedBytes -= Buffer.byteLength(item.body);
    this.pending.delete(id);
    this.clearPending(pending);
    pending.reject(error);
    this.flushWrites();
  }

  private abortRequest(id: string, error: Error): void { if (this.pending.has(id)) this.invalidate(error); }

  private clearPending(pending: Pending): void {
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.signal && pending.abortListener) pending.signal.removeEventListener("abort", pending.abortListener);
  }

  private invalidate(error: Error, kill = true): void {
    if (this.cleaned) return;
    this.cleaned = true; this.unusable = error;
    const child = this.child;
    if (child) {
      child.stdout.removeAllListeners(); child.stderr.removeAllListeners(); child.stdin.removeAllListeners(); child.removeAllListeners();
      if (kill && !child.killed) child.kill();
    }
    this.writeQueue.length = 0; this.queuedBytes = 0; this.writing = false; this.blocked = false;
    for (const pending of this.pending.values()) { this.clearPending(pending); pending.reject(error); }
    this.pending.clear();
  }
}
