/**
 * Benchmark sweep: runs a fixed number of requests at each of a series of
 * payload sizes and collects per-step aggregate stats, so payload sizes can
 * be compared without manually re-running the single-size measurement loop.
 */
import { useCallback, useRef, useState } from "react";
import type { ZMKCustomSubsystem } from "@cormoran/zmk-studio-react-hook";
import type { SettingsResponse } from "../proto/zmk/perf/perf";
import { requestSizeMax, responseSizeMax } from "../lib/frameSize";
import { sendPerfRequest } from "../lib/perfRequest";

export const SWEEP_SIZE_PRESETS = [0, 32, 64, 128, 256, 512, 1024, 2048];
export const DEFAULT_FIXED_SIZE = 32;
export const DEFAULT_REQUESTS_PER_STEP = 20;
// Same default as usePerfTest's manual loop — see its RPC_TIMEOUT_MS comment.
const RPC_TIMEOUT_MS = 15000;

export type SweepDimension = "request" | "response" | "both";

export interface SweepStepResult {
  requestSize: number;
  responseSize: number;
  sent: number;
  received: number;
  errors: number;
  lossRate: number;
  minLatencyMs: number | null;
  maxLatencyMs: number | null;
  avgLatencyMs: number | null;
  medianLatencyMs: number | null;
  bitsPerSecond: number;
}

interface SweepStepConfig {
  requestSize: number;
  responseSize: number;
}

function buildSteps(
  sizes: number[],
  dimension: SweepDimension,
  fixedRequestSize: number,
  fixedResponseSize: number,
  settings: SettingsResponse | null,
  split: boolean,
  subsystemIndex: number | undefined
): { steps: SweepStepConfig[]; skipped: number } {
  const requested = sizes.map((size): SweepStepConfig => {
    if (dimension === "request") {
      return { requestSize: size, responseSize: fixedResponseSize };
    }
    if (dimension === "response") {
      return { requestSize: fixedRequestSize, responseSize: size };
    }
    return { requestSize: size, responseSize: size };
  });

  const clamped = requested.map(({ requestSize, responseSize }) => {
    const maxResponse = responseSizeMax(settings, split);
    const effectiveResponse = Math.min(responseSize, maxResponse);
    const maxRequest = requestSizeMax(
      settings,
      effectiveResponse,
      split,
      subsystemIndex
    );
    const effectiveRequest = Math.min(requestSize, maxRequest);
    return { requestSize: effectiveRequest, responseSize: effectiveResponse };
  });

  const steps: SweepStepConfig[] = [];
  let skipped = 0;
  for (const step of clamped) {
    const prev = steps[steps.length - 1];
    // Clamping can make several requested sizes collapse onto the same
    // effective size (e.g. everything above the device limit) — running the
    // exact same step twice in a row would just waste time.
    if (
      prev &&
      prev.requestSize === step.requestSize &&
      prev.responseSize === step.responseSize
    ) {
      skipped += 1;
      continue;
    }
    steps.push(step);
  }
  return { steps, skipped };
}

async function runStep(
  service: ZMKCustomSubsystem,
  config: SweepStepConfig,
  requestCount: number,
  split: boolean,
  getNextSequenceNumber: () => number,
  isAborted: () => boolean
): Promise<SweepStepResult> {
  let sent = 0;
  let received = 0;
  let errors = 0;
  let totalBytes = 0;
  let minLatencyMs: number | null = null;
  let maxLatencyMs: number | null = null;
  const latencies: number[] = [];
  const stepStart = performance.now();

  for (let i = 0; i < requestCount; i++) {
    if (isAborted()) break;
    sent += 1;
    const outcome = await sendPerfRequest(service, {
      sequenceNumber: getNextSequenceNumber(),
      requestSize: config.requestSize,
      responseSize: config.responseSize,
      split,
      timeoutMs: RPC_TIMEOUT_MS,
    });
    if (outcome.kind === "success") {
      received += 1;
      totalBytes += outcome.bytes;
      latencies.push(outcome.latencyMs);
      minLatencyMs =
        minLatencyMs === null
          ? outcome.latencyMs
          : Math.min(minLatencyMs, outcome.latencyMs);
      maxLatencyMs =
        maxLatencyMs === null
          ? outcome.latencyMs
          : Math.max(maxLatencyMs, outcome.latencyMs);
    } else if (outcome.kind === "error") {
      errors += 1;
    }
  }

  const stepDurationS = (performance.now() - stepStart) / 1000;
  const sorted = [...latencies].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const avgLatencyMs =
    latencies.length > 0
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : null;
  const medianLatencyMs =
    sorted.length === 0
      ? null
      : sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];

  return {
    requestSize: config.requestSize,
    responseSize: config.responseSize,
    sent,
    received,
    errors,
    // Same convention as usePerfTest: an error response is a successful
    // round trip, so it's excluded from the loss rate.
    lossRate: sent > 0 ? ((sent - received - errors) / sent) * 100 : 0,
    minLatencyMs,
    maxLatencyMs,
    avgLatencyMs,
    medianLatencyMs,
    bitsPerSecond: stepDurationS > 0 ? (totalBytes * 8) / stepDurationS : 0,
  };
}

export function useBenchmarkSweep({
  serviceRef,
  settings,
  subsystemIndex,
}: {
  serviceRef: React.RefObject<ZMKCustomSubsystem | null>;
  settings: SettingsResponse | null;
  subsystemIndex: number | undefined;
}) {
  const [dimension, setDimension] = useState<SweepDimension>("both");
  const [selectedSizes, setSelectedSizes] = useState<number[]>([
    ...SWEEP_SIZE_PRESETS,
  ]);
  const [requestsPerStep, setRequestsPerStep] = useState(
    DEFAULT_REQUESTS_PER_STEP
  );
  const [fixedRequestSize, setFixedRequestSize] = useState(DEFAULT_FIXED_SIZE);
  const [fixedResponseSize, setFixedResponseSize] =
    useState(DEFAULT_FIXED_SIZE);
  const [useSplit, setUseSplit] = useState(false);
  const [isSweeping, setIsSweeping] = useState(false);
  const [results, setResults] = useState<SweepStepResult[]>([]);
  const [skippedCount, setSkippedCount] = useState(0);

  const abortRef = useRef(false);
  const seqRef = useRef(0);

  const stop = useCallback(() => {
    abortRef.current = true;
    setIsSweeping(false);
  }, []);

  const start = useCallback(async () => {
    const service = serviceRef.current;
    if (!service || selectedSizes.length === 0) return;

    const sizes = [...selectedSizes].sort((a, b) => a - b);
    const { steps, skipped } = buildSteps(
      sizes,
      dimension,
      fixedRequestSize,
      fixedResponseSize,
      settings,
      useSplit,
      subsystemIndex
    );

    abortRef.current = false;
    setIsSweeping(true);
    setResults([]);
    setSkippedCount(skipped);

    for (const step of steps) {
      if (abortRef.current) break;
      const result = await runStep(
        service,
        step,
        requestsPerStep,
        useSplit,
        () => ++seqRef.current,
        () => abortRef.current
      );
      setResults((prev) => [...prev, result]);
    }

    setIsSweeping(false);
  }, [
    serviceRef,
    selectedSizes,
    dimension,
    fixedRequestSize,
    fixedResponseSize,
    settings,
    useSplit,
    subsystemIndex,
    requestsPerStep,
  ]);

  return {
    dimension,
    setDimension,
    selectedSizes,
    setSelectedSizes,
    requestsPerStep,
    setRequestsPerStep,
    fixedRequestSize,
    setFixedRequestSize,
    fixedResponseSize,
    setFixedResponseSize,
    useSplit,
    setUseSplit,
    isSweeping,
    results,
    skippedCount,
    start,
    stop,
  };
}
