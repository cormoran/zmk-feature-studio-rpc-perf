/**
 * Sends a single perf RPC request and classifies the outcome. Shared by the
 * manual measurement loop (usePerfTest) and the benchmark sweep, since both
 * need identical timeout/error/sequence-number handling per request.
 */
import { ErrorCode, Request, Response } from "../proto/zmk/perf/perf";
import type { ZMKCustomSubsystem } from "@cormoran/zmk-studio-react-hook";

export type PerfRequestOutcome =
  | { kind: "success"; latencyMs: number; bytes: number }
  | { kind: "error"; code: ErrorCode; message: string }
  | { kind: "loss" };

export async function sendPerfRequest(
  service: ZMKCustomSubsystem,
  params: {
    sequenceNumber: number;
    requestSize: number;
    responseSize: number;
    split: boolean;
    timeoutMs: number;
  }
): Promise<PerfRequestOutcome> {
  const data = new Uint8Array(params.requestSize).fill(0x55);
  const payload = Request.encode(
    Request.create({
      perf: {
        sequenceNumber: params.sequenceNumber,
        responseSize: params.responseSize,
        data,
        split: params.split,
      },
    })
  ).finish();

  const sentAt = performance.now();
  try {
    // Any response that arrives after the timeout is simply left unawaited
    // (the client library matches by request id, so it cannot be mistaken
    // for a later request's response).
    const raw = await service.callRPC(payload, { timeout: params.timeoutMs });
    if (!raw) return { kind: "loss" };

    const resp = Response.decode(raw);
    if (resp.perf && resp.perf.sequenceNumber === params.sequenceNumber) {
      return {
        kind: "success",
        latencyMs: performance.now() - sentAt,
        bytes: payload.length + raw.length,
      };
    }
    if (resp.error) {
      return {
        kind: "error",
        code: resp.error.code,
        message: resp.error.message,
      };
    }
    // Wrong/missing sequence number (or a stray settings reply): don't trust
    // it as a latency sample.
    return { kind: "loss" };
  } catch {
    // Timeout or transport error.
    return { kind: "loss" };
  }
}
