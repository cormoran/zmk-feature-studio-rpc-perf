/**
 * CSV/JSON export for benchmark sweep results — plain Blob download, no
 * extra dependency.
 */
import type { SettingsResponse } from "../proto/zmk/perf/perf";
import type { SweepStepResult } from "../hooks/useBenchmarkSweep";

export interface SweepMetadata {
  deviceName: string;
  target: "local" | "split";
  timestamp: string;
  settings: SettingsResponse | null;
}

const COLUMNS: Array<keyof SweepStepResult> = [
  "requestSize",
  "responseSize",
  "sent",
  "received",
  "errors",
  "lossRate",
  "minLatencyMs",
  "maxLatencyMs",
  "avgLatencyMs",
  "medianLatencyMs",
  "bitsPerSecond",
];

function csvCell(value: SweepStepResult[keyof SweepStepResult]): string {
  return value === null ? "" : String(value);
}

export function buildSweepCsv(
  results: SweepStepResult[],
  metadata: SweepMetadata
): string {
  const metaLines = [
    `# device,${metadata.deviceName}`,
    `# target,${metadata.target}`,
    `# timestamp,${metadata.timestamp}`,
    `# studioRpcRxBufSize,${metadata.settings?.studioRpcRxBufSize ?? ""}`,
    `# studioRpcTxBufSize,${metadata.settings?.studioRpcTxBufSize ?? ""}`,
  ];
  const rows = results.map((r) => COLUMNS.map((c) => csvCell(r[c])).join(","));
  return [...metaLines, COLUMNS.join(","), ...rows].join("\n");
}

export function buildSweepJson(
  results: SweepStepResult[],
  metadata: SweepMetadata
): string {
  return JSON.stringify({ metadata, results }, null, 2);
}

export function downloadTextFile(
  filename: string,
  content: string,
  mimeType: string
) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
