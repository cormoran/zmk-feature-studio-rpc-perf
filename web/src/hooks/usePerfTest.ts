/**
 * Measurement engine for the ZMK Studio RPC performance test: owns the
 * request loop, running stats, and firmware settings/limits.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorCode, Request, Response } from "../proto/zmk/perf/perf";
import type { SettingsResponse } from "../proto/zmk/perf/perf";
import { ZMKCustomSubsystem } from "@cormoran/zmk-studio-react-hook";
import { requestSizeMax, responseSizeMax } from "../lib/frameSize";
import { describeErrorCode } from "../lib/errorCode";
import { sendPerfRequest } from "../lib/perfRequest";
import type { LatencyPoint } from "../components/LatencyGraph";

const THROUGHPUT_WINDOW_MS = 3000;
const LATENCY_HISTORY_MS = 60_000;
// While running, flush the ref-based stats into React state on this cadence
// instead of after every request — at interval 0 the loop can fire hundreds
// of times per second, which would otherwise re-render the chart that often.
const STATS_FLUSH_INTERVAL_MS = 150;
// ZMKCustomSubsystem.callRPC() defaults to a 5000ms timeout, which is shorter
// than the firmware's own split relay timeout
// (CONFIG_ZMK_STUDIO_RPC_PERF_SPLIT_TIMEOUT_MS, default 10000ms — see
// Kconfig). Ask for a longer timeout so the firmware gets a chance to time
// out a split relay request and answer with its own error first, instead of
// the UI giving up on the round trip prematurely.
const RPC_TIMEOUT_MS = 15000;

export interface PerfStats {
  sent: number;
  received: number;
  errors: number;
  latencyMs: number | null;
  minLatencyMs: number | null;
  maxLatencyMs: number | null;
  avgLatencyMs: number | null;
  medianLatencyMs: number | null;
  bitsPerSecond: number;
  rps: number;
  lossRate: number;
  lastErrorMessage: string | null;
}

export const INITIAL_STATS: PerfStats = {
  sent: 0,
  received: 0,
  errors: 0,
  latencyMs: null,
  minLatencyMs: null,
  maxLatencyMs: null,
  avgLatencyMs: null,
  medianLatencyMs: null,
  bitsPerSecond: 0,
  rps: 0,
  lossRate: 0,
  lastErrorMessage: null,
};

type Connection = ConstructorParameters<typeof ZMKCustomSubsystem>[0];

export function usePerfTest({
  connection,
  subsystemIndex,
}: {
  connection: Connection | null;
  subsystemIndex: number | undefined;
}) {
  const [requestSize, setRequestSize] = useState(1);
  const [responseSize, setResponseSize] = useState(1);
  const [intervalMs, setIntervalMs] = useState(100);
  const [useSplit, setUseSplit] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [stats, setStats] = useState<PerfStats>(INITIAL_STATS);
  const [latencyHistory, setLatencyHistory] = useState<LatencyPoint[]>([]);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const seqRef = useRef(0);
  const statsRef = useRef({ ...INITIAL_STATS });
  const bytesWindowRef = useRef<Array<{ ts: number; bytes: number }>>([]);
  const latencyHistoryRef = useRef<LatencyPoint[]>([]);
  const testStartRef = useRef(0);
  const isRunningRef = useRef(false);
  const serviceRef = useRef<ZMKCustomSubsystem | null>(null);
  const flushTimerRef = useRef<number | undefined>(undefined);

  const maxResponseSize = responseSizeMax(settings, useSplit);
  const effectiveResponseSize = Math.min(responseSize, maxResponseSize);
  const maxRequestSize = requestSizeMax(
    settings,
    effectiveResponseSize,
    useSplit,
    subsystemIndex
  );
  const effectiveRequestSize = Math.min(requestSize, maxRequestSize);

  const flushStats = useCallback(() => {
    setStats({ ...statsRef.current });
    setLatencyHistory([...latencyHistoryRef.current]);
  }, []);

  const stop = useCallback(() => {
    isRunningRef.current = false;
    setIsRunning(false);
    if (flushTimerRef.current !== undefined) {
      window.clearInterval(flushTimerRef.current);
      flushTimerRef.current = undefined;
    }
    flushStats();
  }, [flushStats]);

  const loadSettings = useCallback(async (service: ZMKCustomSubsystem) => {
    try {
      const payload = Request.encode(Request.create({ settings: {} })).finish();
      const raw = await service.callRPC(payload);
      if (!raw) {
        setSettingsError("No settings response");
        return;
      }

      const resp = Response.decode(raw);
      if (resp.settings) {
        setSettings(resp.settings);
      } else if (resp.error) {
        setSettingsError(resp.error.message || "Settings request failed");
      } else {
        setSettingsError("Unexpected settings response");
      }
    } catch (err) {
      setSettingsError(
        err instanceof Error ? err.message : "Settings request failed"
      );
    }
  }, []);

  const start = useCallback(() => {
    if (!serviceRef.current) return;
    const service = serviceRef.current;

    seqRef.current = 0;
    bytesWindowRef.current = [];
    latencyHistoryRef.current = [];
    statsRef.current = { ...INITIAL_STATS };
    setStats({ ...INITIAL_STATS });
    setLatencyHistory([]);
    testStartRef.current = performance.now();
    isRunningRef.current = true;
    setIsRunning(true);

    flushTimerRef.current = window.setInterval(
      flushStats,
      STATS_FLUSH_INTERVAL_MS
    );

    const runLoop = async () => {
      while (isRunningRef.current) {
        const seq = ++seqRef.current;
        const sentAt = performance.now();

        statsRef.current.sent += 1;

        const recordLoss = () => {
          statsRef.current.lossRate =
            statsRef.current.sent > 0
              ? ((statsRef.current.sent -
                  statsRef.current.received -
                  statsRef.current.errors) /
                  statsRef.current.sent) *
                100
              : 0;
        };

        // An error response means the transport round-trip succeeded — the
        // firmware explicitly rejected the request — so it should not count
        // toward the packet-loss rate the way a timeout/exception does.
        const recordError = (code: ErrorCode, message: string) => {
          statsRef.current.errors += 1;
          statsRef.current.lastErrorMessage = describeErrorCode(code, message);
          recordLoss();
        };

        const recordSuccess = (latency: number, transferredBytes: number) => {
          const now = sentAt + latency;
          statsRef.current.received += 1;

          statsRef.current.latencyMs = latency;
          statsRef.current.minLatencyMs =
            statsRef.current.minLatencyMs === null
              ? latency
              : Math.min(statsRef.current.minLatencyMs, latency);
          statsRef.current.maxLatencyMs =
            statsRef.current.maxLatencyMs === null
              ? latency
              : Math.max(statsRef.current.maxLatencyMs, latency);

          // Latency history (1 min sliding window)
          const elapsedS = (now - testStartRef.current) / 1000;
          latencyHistoryRef.current.push({ elapsedS, latencyMs: latency });
          const historyCutoffS = elapsedS - LATENCY_HISTORY_MS / 1000;
          latencyHistoryRef.current = latencyHistoryRef.current.filter(
            (e) => e.elapsedS >= historyCutoffS
          );

          // Avg and median from history window
          const windowLatencies = latencyHistoryRef.current.map(
            (e) => e.latencyMs
          );
          const sum = windowLatencies.reduce((a, b) => a + b, 0);
          statsRef.current.avgLatencyMs = sum / windowLatencies.length;
          const sorted = [...windowLatencies].sort((a, b) => a - b);
          const mid = Math.floor(sorted.length / 2);
          statsRef.current.medianLatencyMs =
            sorted.length % 2 === 0
              ? (sorted[mid - 1] + sorted[mid]) / 2
              : sorted[mid];

          // RPS from history window
          const hist = latencyHistoryRef.current;
          const histDuration =
            hist.length > 1
              ? hist[hist.length - 1].elapsedS - hist[0].elapsedS
              : 0;
          statsRef.current.rps =
            histDuration > 0 ? (hist.length - 1) / histDuration : 0;

          // Throughput: 3s sliding window
          bytesWindowRef.current.push({ ts: now, bytes: transferredBytes });
          const cutoff = now - THROUGHPUT_WINDOW_MS;
          bytesWindowRef.current = bytesWindowRef.current.filter(
            (e) => e.ts >= cutoff
          );
          const windowBytes = bytesWindowRef.current.reduce(
            (acc, e) => acc + e.bytes,
            0
          );
          const windowDuration =
            bytesWindowRef.current.length > 1
              ? (bytesWindowRef.current[bytesWindowRef.current.length - 1].ts -
                  bytesWindowRef.current[0].ts) /
                1000
              : 0;
          statsRef.current.bitsPerSecond =
            windowDuration > 0 ? (windowBytes * 8) / windowDuration : 0;

          recordLoss();
        };

        // Await the outcome before sending next request — avoids firmware
        // mutex contention. See lib/perfRequest.ts for timeout/error/seq
        // handling shared with the benchmark sweep.
        const outcome = await sendPerfRequest(service, {
          sequenceNumber: seq,
          requestSize: effectiveRequestSize,
          responseSize: effectiveResponseSize,
          split: useSplit,
          timeoutMs: RPC_TIMEOUT_MS,
        });
        switch (outcome.kind) {
          case "success":
            recordSuccess(outcome.latencyMs, outcome.bytes);
            break;
          case "error":
            recordError(outcome.code, outcome.message);
            break;
          case "loss":
            recordLoss();
            break;
        }

        const elapsed = performance.now() - sentAt;
        const remaining = intervalMs - elapsed;
        if (isRunningRef.current && remaining > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, remaining));
        }
      }
    };

    runLoop();
  }, [
    effectiveRequestSize,
    effectiveResponseSize,
    intervalMs,
    useSplit,
    flushStats,
  ]);

  const reset = useCallback(() => {
    statsRef.current = { ...INITIAL_STATS };
    bytesWindowRef.current = [];
    latencyHistoryRef.current = [];
    setStats({ ...INITIAL_STATS });
    setLatencyHistory([]);
  }, []);

  // Keep serviceRef in sync when the connection changes
  useEffect(() => {
    if (!connection || subsystemIndex === undefined) {
      serviceRef.current = null;
      return;
    }
    const service = new ZMKCustomSubsystem(connection, subsystemIndex);
    serviceRef.current = service;
    const timeoutId = window.setTimeout(() => {
      loadSettings(service);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [connection, subsystemIndex, loadSettings]);

  // Stop the flush timer and running loop on unmount.
  useEffect(
    () => () => {
      isRunningRef.current = false;
      if (flushTimerRef.current !== undefined) {
        window.clearInterval(flushTimerRef.current);
      }
    },
    []
  );

  return {
    requestSize,
    setRequestSize,
    responseSize,
    setResponseSize,
    intervalMs,
    setIntervalMs,
    useSplit,
    setUseSplit,
    isRunning,
    stats,
    latencyHistory,
    settings,
    settingsError,
    maxRequestSize,
    maxResponseSize,
    effectiveRequestSize,
    effectiveResponseSize,
    start,
    stop,
    reset,
    loadSettings,
    serviceRef,
  };
}
