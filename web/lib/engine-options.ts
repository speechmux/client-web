export interface EngineOption {
  id: string;
  label: string;
}

export const FALLBACK_ENGINES: EngineOption[] = [
  { id: "whisper-mlx", label: "Whisper (MLX)" },
  { id: "sherpa-onnx", label: "Sherpa-ONNX" },
];
