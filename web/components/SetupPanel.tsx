"use client";

import { useCallback, useRef, useState } from "react";
import {
  ChevronRight,
  FileAudio,
  Layers,
  Mic,
  SlidersHorizontal,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { MAX_FILE_BYTES } from "@/lib/audio-utils";
import type { EngineOption } from "@/lib/engine-options";
import { formatBytes } from "@/lib/format";
import {
  DEFAULT_SETTINGS,
  LANGUAGE_OPTIONS,
  VAD_SILENCE_RANGE,
  VAD_THRESHOLD_RANGE,
  type DecodeProfileSetting,
  type InputModeSetting,
  type PersistedSettings,
} from "@/lib/settings";

const MODE_OPTIONS: ReadonlyArray<{ id: InputModeSetting; label: string; Icon: LucideIcon }> = [
  { id: "mic", label: "Microphone", Icon: Mic },
  { id: "file", label: "Audio file", Icon: FileAudio },
  { id: "batch", label: "Batch", Icon: Layers },
];

/** What the page keeps about the chosen file for display; the File itself stays in a ref. */
export interface SelectedFileInfo {
  name: string;
  size: number;
}

interface SetupPanelProps {
  settings: PersistedSettings;
  onSettingsChange: (patch: Partial<PersistedSettings>) => void;
  /** Show the one-line summary instead of the form. */
  collapsed: boolean;
  /** A session or batch run is in flight: the summary cannot be reopened. */
  locked: boolean;
  onOpen: () => void;
  /** When given, the form ends with a "Hide settings" link that calls it. */
  onHide?: () => void;
  /** Why the microphone cannot be used on this page, if it cannot; shown in Microphone mode. */
  micNotice: string | null;
  /** Engines to offer besides Auto. */
  engineOptions: EngineOption[];
  engineListLoading: boolean;
  /** Set when the engine list is not Core's own. */
  engineListHint?: string;
  selectedFile: SelectedFileInfo | null;
  /** Why the selected file cannot be sent, if it cannot. */
  fileError: string | null;
  onSelectFile: (file: File) => void;
  wsUrl: string;
  /** URL derived from the page address; null until it is known (before hydration). */
  defaultWsUrl: string | null;
  onWsUrlChange: (url: string) => void;
}

/**
 * The setup card: input-mode switch, session settings and — once a session has
 * started — the one-line summary the form folds into so the transcript keeps the room.
 */
export function SetupPanel({
  settings,
  onSettingsChange,
  collapsed,
  locked,
  onOpen,
  onHide,
  micNotice,
  engineOptions,
  engineListLoading,
  engineListHint,
  selectedFile,
  fileError,
  onSelectFile,
  wsUrl,
  defaultWsUrl,
  onWsUrlChange,
}: SetupPanelProps): React.JSX.Element {
  const { inputMode, languageCode, engineHint, decodeProfile, vadThreshold, vadSilence, realtimePacing } = settings;
  const isFileMode = inputMode === "file";
  const isBatchMode = inputMode === "batch";
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isFileDragging, setIsFileDragging] = useState(false);

  const handleFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) onSelectFile(file);
    // Reset so choosing the same file again still fires a change event.
    event.target.value = "";
  }, [onSelectFile]);

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setIsFileDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) onSelectFile(file);
  }, [onSelectFile]);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setIsFileDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    // Ignore moves between the row's own children.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsFileDragging(false);
  }, []);

  const activeMode = MODE_OPTIONS.find((option) => option.id === inputMode) ?? MODE_OPTIONS[0]!;
  const languageLabel =
    LANGUAGE_OPTIONS.find((option) => option.code === languageCode)?.label ?? languageCode;
  const engineLabel = engineHint
    ? (engineOptions.find((option) => option.id === engineHint)?.label ?? engineHint)
    : "Auto engine";
  const vadIsDefault =
    vadThreshold === DEFAULT_SETTINGS.vadThreshold && vadSilence === DEFAULT_SETTINGS.vadSilence;

  return (
    <section className="card setup" aria-label="Session setup">
      <div className={`collapsible${collapsed ? " is-collapsed" : ""}`}>
        <div className="collapsible-inner">
          <div className="setup-form" id="setup-form">
            <fieldset className="segmented-field">
              <legend className="sr-only">Input</legend>
              <div className="segmented">
                {MODE_OPTIONS.map(({ id, label, Icon }) => (
                  <label key={id} className="segment">
                    <input
                      type="radio"
                      name="input-mode"
                      value={id}
                      checked={inputMode === id}
                      onChange={() => onSettingsChange({ inputMode: id })}
                    />
                    <span>
                      <Icon size={16} aria-hidden="true" />
                      {label}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {inputMode === "mic" && micNotice && (
              <p className="notice is-warn">
                <TriangleAlert size={16} aria-hidden="true" />
                <span>{micNotice}</span>
              </p>
            )}

            <div className="field-grid">
              <label className="field">
                <span>Language</span>
                <select
                  value={languageCode}
                  onChange={(event) => onSettingsChange({ languageCode: event.target.value })}
                >
                  {LANGUAGE_OPTIONS.map((option) => (
                    <option key={option.code} value={option.code}>{option.label}</option>
                  ))}
                </select>
              </label>
              <div className="field">
                <label htmlFor="engine-select">Engine</label>
                <select
                  id="engine-select"
                  value={engineHint}
                  onChange={(event) => onSettingsChange({ engineHint: event.target.value })}
                  disabled={engineListLoading}
                  aria-describedby={engineListHint ? "engine-hint" : undefined}
                >
                  <option value="">Auto — let Core choose</option>
                  {engineOptions.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
                {engineListHint && (
                  <small id="engine-hint" className="hint is-warn">{engineListHint}</small>
                )}
              </div>
            </div>

            {/* File picker */}
            {isFileMode && (
              <>
                <div
                  className={`file-row${isFileDragging ? " is-dragging" : ""}${fileError ? " is-invalid" : ""}`}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                >
                  <FileAudio size={22} className="file-row-icon" aria-hidden="true" />
                  <div className="file-row-text">
                    <strong id="file-name">{selectedFile ? selectedFile.name : "No file selected"}</strong>
                    <small id="file-hint" className={fileError ? "is-error" : undefined}>
                      {fileError ??
                        (selectedFile
                          ? formatBytes(selectedFile.size)
                          : `Drop an audio file here or choose one — up to ${MAX_FILE_BYTES / 1024 / 1024} MB`)}
                    </small>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="audio/*"
                    onChange={handleFileChange}
                    className="visually-hidden-file"
                    tabIndex={-1}
                    aria-hidden="true"
                  />
                  <button
                    type="button"
                    className="btn-small"
                    onClick={() => fileInputRef.current?.click()}
                    aria-describedby="file-name file-hint"
                  >
                    {selectedFile ? "Change file" : "Choose file"}
                  </button>
                </div>
                <label className="field checkbox">
                  <input
                    type="checkbox"
                    checked={realtimePacing}
                    onChange={(event) => onSettingsChange({ realtimePacing: event.target.checked })}
                    aria-describedby="pacing-hint"
                  />
                  <span>Realtime pacing</span>
                  <small id="pacing-hint" className="hint">
                    Send at 1× speed like live speech. Turn off to send as fast as possible.
                  </small>
                </label>
              </>
            )}

            <details className="advanced">
              <summary>
                <ChevronRight size={16} className="disclosure-icon" aria-hidden="true" />
                <span className="summary-title">Advanced</span>
                <span className="advanced-values">
                  VAD {vadThreshold.toFixed(2)} · silence {vadSilence.toFixed(1)} s
                </span>
              </summary>
              <div className="advanced-body">
                <div className="field-grid">
                  <div className="field">
                    <div className="field-head">
                      <label htmlFor="vad-threshold">VAD threshold</label>
                      <output htmlFor="vad-threshold">{vadThreshold.toFixed(2)}</output>
                    </div>
                    <input
                      id="vad-threshold"
                      type="range"
                      min={VAD_THRESHOLD_RANGE.min}
                      max={VAD_THRESHOLD_RANGE.max}
                      step={VAD_THRESHOLD_RANGE.step}
                      value={vadThreshold}
                      onChange={(event) => onSettingsChange({ vadThreshold: Number(event.target.value) })}
                      aria-describedby="vad-threshold-hint"
                    />
                    <small id="vad-threshold-hint" className="hint">
                      How sure the detector must be that it hears speech. Lower picks up quieter voices.
                    </small>
                  </div>
                  <div className="field">
                    <div className="field-head">
                      <label htmlFor="vad-silence">VAD silence</label>
                      <output htmlFor="vad-silence">{vadSilence.toFixed(1)} s</output>
                    </div>
                    <input
                      id="vad-silence"
                      type="range"
                      min={VAD_SILENCE_RANGE.min}
                      max={VAD_SILENCE_RANGE.max}
                      step={VAD_SILENCE_RANGE.step}
                      value={vadSilence}
                      onChange={(event) => onSettingsChange({ vadSilence: Number(event.target.value) })}
                      aria-describedby="vad-silence-hint"
                    />
                    <small id="vad-silence-hint" className="hint">
                      Length of the pause that ends an utterance. Longer keeps slow speech together.
                    </small>
                  </div>
                </div>

                <button
                  type="button"
                  className="link-btn"
                  onClick={() =>
                    onSettingsChange({
                      vadThreshold: DEFAULT_SETTINGS.vadThreshold,
                      vadSilence: DEFAULT_SETTINGS.vadSilence,
                    })
                  }
                  disabled={vadIsDefault}
                >
                  Reset VAD to defaults
                </button>

                {!isBatchMode && (
                  <div className="field">
                    <label htmlFor="decode-profile">Decode profile</label>
                    <select
                      id="decode-profile"
                      value={decodeProfile}
                      onChange={(event) =>
                        onSettingsChange({ decodeProfile: event.target.value as DecodeProfileSetting })
                      }
                      aria-describedby="decode-profile-hint"
                    >
                      <option value="realtime">Realtime — fastest</option>
                      <option value="accurate">Accurate — slower</option>
                    </select>
                    <small id="decode-profile-hint" className="hint">
                      Sent as <code>decode_profile</code>. Core accepts it but does not apply it to
                      decoding yet, so both options currently give the same result.
                    </small>
                  </div>
                )}

                <div className="field">
                  <div className="field-head">
                    <label htmlFor="ws-url">WebSocket URL</label>
                    {defaultWsUrl !== null && wsUrl !== defaultWsUrl && (
                      <button type="button" className="link-btn" onClick={() => onWsUrlChange(defaultWsUrl)}>
                        Reset
                      </button>
                    )}
                  </div>
                  <input
                    id="ws-url"
                    type="text"
                    inputMode="url"
                    value={wsUrl}
                    onChange={(event) => onWsUrlChange(event.target.value)}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                  />
                </div>
              </div>
            </details>

            {onHide && (
              <button type="button" className="link-btn setup-hide" onClick={onHide}>
                Hide settings
              </button>
            )}
          </div>
        </div>
      </div>

      {collapsed && (
        <div className="setup-summary">
          <p className="setup-chips">
            <span className="sr-only">Session settings:</span>
            <span className="chip">
              <activeMode.Icon size={14} aria-hidden="true" />
              {activeMode.label}
            </span>
            {isFileMode && selectedFile && <span className="chip is-file">{selectedFile.name}</span>}
            <span className="chip">{languageLabel}</span>
            <span className="chip">{engineLabel}</span>
          </p>
          {!locked && (
            <button
              type="button"
              className="ghost"
              onClick={onOpen}
              aria-expanded={false}
              aria-controls="setup-form"
            >
              <SlidersHorizontal size={14} aria-hidden="true" />
              Settings
            </button>
          )}
        </div>
      )}
    </section>
  );
}
