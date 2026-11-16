import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SpeechMuxWsClient,
  type ConnectionState,
  type RecognitionResult,
  type SessionConfig,
} from "./speechmux-ws";

type Listener = (event: { data?: unknown }) => void;

/** Scriptable stand-in for the browser WebSocket: the test plays the server. */
class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = 0;
  binaryType = "blob";
  readonly sent: Array<string | ArrayBuffer> = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  /** Client-initiated close; like a browser, the close event is delivered later. */
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit("close"));
  }

  // ── Server side ──

  accept(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  serverSend(message: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  serverClose(): void {
    this.readyState = 3;
    this.emit("close");
  }

  sentJson(): Array<Record<string, unknown>> {
    return this.sent
      .filter((frame): frame is string => typeof frame === "string")
      .map((frame) => JSON.parse(frame) as Record<string, unknown>);
  }

  private emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const CONFIG: SessionConfig = {
  languageCode: "ko",
  task: "transcribe",
  decodeProfile: "realtime",
  vadSilence: 0.8,
  vadThreshold: 0.5,
  engineHint: "sherpa-onnx",
};

interface Harness {
  client: SpeechMuxWsClient;
  states: ConnectionState[];
  results: RecognitionResult[];
  errors: Array<[string, string]>;
  reconnects: Array<[number, number]>;
  onDone: ReturnType<typeof vi.fn>;
}

function createClient(): Harness {
  const states: ConnectionState[] = [];
  const results: RecognitionResult[] = [];
  const errors: Array<[string, string]> = [];
  const reconnects: Array<[number, number]> = [];
  const onDone = vi.fn();
  const client = new SpeechMuxWsClient("ws://test/ws/stream", CONFIG, {
    onResult: (result) => results.push(result),
    onStateChange: (state) => states.push(state),
    onError: (code, message) => errors.push([code, message]),
    onDone,
    onReconnecting: (attempt, maxAttempts) => reconnects.push([attempt, maxAttempts]),
  });
  return { client, states, results, errors, reconnects, onDone };
}

function socketAt(index: number): FakeWebSocket {
  const socket = FakeWebSocket.instances[index];
  if (!socket) throw new Error(`no socket #${index}; ${FakeWebSocket.instances.length} were opened`);
  return socket;
}

/** Let queued microtasks (late close events, promise continuations) run. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** Open a session: the server accepts the socket and confirms the start message. */
async function connect(harness: Harness): Promise<FakeWebSocket> {
  const connecting = harness.client.connect();
  const socket = socketAt(FakeWebSocket.instances.length - 1);
  socket.accept();
  socket.serverSend({ type: "session" });
  await connecting;
  return socket;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  // No jitter: reconnect delays are exactly 500 ms, 1 s, 2 s.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("session lifecycle", () => {
  it("sends the start message on open and becomes ready on the session confirmation", async () => {
    const harness = createClient();
    const socket = await connect(harness);

    expect(socket.url).toBe("ws://test/ws/stream");
    expect(socket.sentJson()[0]).toMatchObject({
      type: "start",
      sample_rate: 16000,
      task: "transcribe",
      language_code: "ko",
      decode_profile: "realtime",
      vad_silence: 0.8,
      vad_threshold: 0.5,
      engine_hint: "sherpa-onnx",
    });
    expect(harness.states).toEqual(["connecting", "ready"]);
    expect(harness.client.connectionState).toBe("ready");
  });

  it("rejects connect() when the server refuses the session", async () => {
    const harness = createClient();
    const connecting = harness.client.connect();
    const socket = socketAt(0);
    socket.accept();
    socket.serverSend({ type: "error", code: "ERR1011", message: "server busy" });

    await expect(connecting).rejects.toThrow("server busy");
  });

  it("maps a result message onto RecognitionResult", async () => {
    const harness = createClient();
    const socket = await connect(harness);
    socket.serverSend({
      type: "result",
      is_final: true,
      text: "안녕하세요",
      committed_text: "안녕하세요",
      unstable_text: "",
      language_code: "ko",
      engine_name: "faster_whisper",
      start_sec: 0.5,
      end_sec: 1.75,
    });

    expect(harness.results).toEqual([
      {
        isFinal: true,
        text: "안녕하세요",
        committedText: "안녕하세요",
        unstableText: "",
        languageCode: "ko",
        engineName: "faster_whisper",
        startSec: 0.5,
        endSec: 1.75,
      },
    ]);
  });

  it("only forwards audio once the session is confirmed", async () => {
    const harness = createClient();
    const connecting = harness.client.connect();
    const socket = socketAt(0);
    socket.accept();
    harness.client.sendAudio(new Int16Array([1, 2, 3]));
    expect(socket.sent.filter((frame) => typeof frame !== "string")).toHaveLength(0);

    socket.serverSend({ type: "session" });
    await connecting;
    harness.client.sendAudio(new Int16Array([4, 5, 6]));
    const binaryFrames = socket.sent.filter((frame): frame is ArrayBuffer => typeof frame !== "string");
    expect(binaryFrames).toHaveLength(1);
    expect(Array.from(new Int16Array(binaryFrames[0]!))).toEqual([4, 5, 6]);
  });

  it("reports done once and does not reconnect when the server then closes", async () => {
    const harness = createClient();
    const socket = await connect(harness);
    harness.client.end();
    socket.serverSend({ type: "done" });
    socket.serverClose();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(socket.sentJson().at(-1)).toEqual({ type: "end" });
    expect(harness.onDone).toHaveBeenCalledTimes(1);
    expect(harness.states).toEqual(["connecting", "ready", "done"]);
    expect(harness.reconnects).toEqual([]);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("finishes the session when the connection drops after end() without a done message", async () => {
    const harness = createClient();
    const socket = await connect(harness);
    harness.client.end();
    socket.serverClose();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(harness.onDone).toHaveBeenCalledTimes(1);
    expect(harness.client.connectionState).toBe("done");
    expect(harness.errors).toEqual([]);
    expect(harness.reconnects).toEqual([]);
  });

  it("stays quiet after close(), even when the socket's close event arrives late", async () => {
    const harness = createClient();
    await connect(harness);
    harness.client.close();
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(harness.states).toEqual(["connecting", "ready", "idle"]);
    expect(harness.onDone).not.toHaveBeenCalled();
    expect(harness.errors).toEqual([]);
    expect(harness.reconnects).toEqual([]);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("closes the socket and reports a terminal server error", async () => {
    const harness = createClient();
    const socket = await connect(harness);
    socket.serverSend({ type: "error", code: "ERR2001", message: "decode timeout" });
    await flush();

    expect(harness.errors).toEqual([["ERR2001", "decode timeout"]]);
    expect(harness.client.connectionState).toBe("error");
    expect(socket.readyState).toBe(3);
    expect(harness.reconnects).toEqual([]);
  });
});

describe("silent reconnect", () => {
  it("starts exactly one reconnect chain for ERR3004, ignoring the old socket's late close", async () => {
    const harness = createClient();
    const first = await connect(harness);
    first.serverSend({ type: "error", code: "ERR3004", message: "vad stream failed" });
    await flush(); // the dropped socket's close event lands here

    expect(harness.reconnects).toEqual([[1, 3]]);
    expect(harness.client.connectionState).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("replays the buffered audio and returns to ready once the new session is confirmed", async () => {
    const harness = createClient();
    const first = await connect(harness);
    harness.client.sendAudio(new Int16Array([7, 8, 9]));
    first.serverClose();
    expect(harness.reconnects).toEqual([[1, 3]]);

    await vi.advanceTimersByTimeAsync(500);
    const second = socketAt(1);
    second.accept();
    second.serverSend({ type: "session" });
    await flush();

    expect(harness.client.connectionState).toBe("ready");
    const replayed = second.sent.filter((frame): frame is ArrayBuffer => typeof frame !== "string");
    expect(replayed).toHaveLength(1);
    expect(Array.from(new Int16Array(replayed[0]!))).toEqual([7, 8, 9]);
    expect(harness.errors).toEqual([]);
  });

  it("replays the overlap in frames small enough for Core's 32 KiB message limit", async () => {
    const harness = createClient();
    const first = await connect(harness);
    // 32 chunks of 80 ms (2.56 s); only the last 2 s fit the overlap buffer.
    const total = 32 * 1_280;
    for (let offset = 0; offset < total; offset += 1_280) {
      harness.client.sendAudio(Int16Array.from({ length: 1_280 }, (_, i) => (offset + i) % 30_000));
    }
    first.serverClose();
    await vi.advanceTimersByTimeAsync(500);
    const second = socketAt(1);
    second.accept();
    second.serverSend({ type: "session" });
    await flush();

    const frames = second.sent.filter((frame): frame is ArrayBuffer => typeof frame !== "string");
    expect(frames).toHaveLength(25);
    expect(Math.max(...frames.map((frame) => frame.byteLength))).toBeLessThanOrEqual(32_768);
    const replayed = frames.flatMap((frame) => Array.from(new Int16Array(frame)));
    expect(replayed).toHaveLength(32_000);
    expect(replayed[0]).toBe((total - 32_000) % 30_000);
    expect(replayed.at(-1)).toBe((total - 1) % 30_000);
  });

  it("keeps counting when a reconnected session drops again before it has proved stable", async () => {
    const harness = createClient();
    let socket = await connect(harness);

    for (const [index, delayMs] of [500, 1_000, 2_000].entries()) {
      socket.serverClose();
      await vi.advanceTimersByTimeAsync(delayMs);
      socket = socketAt(index + 1);
      socket.accept();
      socket.serverSend({ type: "session" }); // reconnects fine …
      await flush();
      expect(harness.client.connectionState).toBe("ready");
    }
    socket.serverClose(); // … but never survives

    expect(harness.reconnects).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(harness.errors[0]?.[0]).toBe("RECONNECT_FAILED");
    expect(harness.client.connectionState).toBe("error");
  });

  it("starts counting from 1 again once a reconnected session has stayed up", async () => {
    const harness = createClient();
    const first = await connect(harness);
    first.serverClose();
    await vi.advanceTimersByTimeAsync(500);
    const second = socketAt(1);
    second.accept();
    second.serverSend({ type: "session" });
    await vi.advanceTimersByTimeAsync(5_000); // stable
    second.serverClose();

    expect(harness.reconnects).toEqual([
      [1, 3],
      [1, 3],
    ]);
    expect(harness.errors).toEqual([]);
  });

  it("counts attempts 1 to 3 and then reports RECONNECT_FAILED", async () => {
    const harness = createClient();
    const first = await connect(harness);
    first.serverClose();

    for (const [index, delayMs] of [500, 1_000, 2_000].entries()) {
      await vi.advanceTimersByTimeAsync(delayMs);
      socketAt(index + 1).serverClose(); // refused before the session is confirmed
      await flush();
    }

    expect(harness.reconnects).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0]?.[0]).toBe("RECONNECT_FAILED");
    expect(harness.client.connectionState).toBe("error");
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it("finishes instead of hanging when end() is called while the connection is down", async () => {
    const harness = createClient();
    const first = await connect(harness);
    first.serverClose();
    harness.client.end();
    await vi.advanceTimersByTimeAsync(500);

    expect(harness.onDone).toHaveBeenCalledTimes(1);
    expect(harness.client.connectionState).toBe("done");
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("does not report done after close() during a reconnect wait", async () => {
    const harness = createClient();
    const first = await connect(harness);
    first.serverClose();
    harness.client.close();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(harness.onDone).not.toHaveBeenCalled();
    expect(harness.client.connectionState).toBe("idle");
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
