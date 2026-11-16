export interface EngineOption {
  id: string;
  label: string;
}

/**
 * Where the engine list came from:
 *  - "core": healthy endpoints reported by Core's `/admin/plugins`.
 *  - "unreachable": Core's admin API could not be reached; `engines` is FALLBACK_ENGINES.
 *  - "no_healthy_engines": Core answered but reported no healthy endpoint; `engines` is FALLBACK_ENGINES.
 */
export type EngineListSource = "core" | "unreachable" | "no_healthy_engines";

/** Response body of the `/api/engines` route. */
export interface EngineListResponse {
  engines: EngineOption[];
  source: EngineListSource;
}

export const FALLBACK_ENGINES: EngineOption[] = [
  { id: "whisper-mlx", label: "Whisper (MLX)" },
  { id: "sherpa-onnx", label: "Sherpa-ONNX" },
];

/**
 * Validate an `/api/engines` response body.
 *
 * Returns null when the body does not have the expected shape, so the caller can
 * treat it the same as a failed request.
 */
export function parseEngineListResponse(body: unknown): EngineListResponse | null {
  if (typeof body !== "object" || body === null) return null;
  const { engines, source } = body as { engines?: unknown; source?: unknown };
  if (!Array.isArray(engines)) return null;
  if (source !== "core" && source !== "unreachable" && source !== "no_healthy_engines") return null;
  const options: EngineOption[] = [];
  for (const entry of engines) {
    if (typeof entry !== "object" || entry === null) return null;
    const { id, label } = entry as { id?: unknown; label?: unknown };
    if (typeof id !== "string" || typeof label !== "string") return null;
    options.push({ id, label });
  }
  return { engines: options, source };
}
