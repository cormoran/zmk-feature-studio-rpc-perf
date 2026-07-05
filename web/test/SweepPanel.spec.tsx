/**
 * Tests for the benchmark sweep mode (issue #8).
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  createConnectedMockZMKApp,
  ZMKAppProvider,
} from "@cormoran/zmk-studio-react-hook/testing";
import { PerfSection, SUBSYSTEM_IDENTIFIER } from "../src/App";
import { Request, Response } from "../src/proto/zmk/perf/perf";

jest.mock("@zmkfirmware/zmk-studio-ts-client", () => ({
  call_rpc: jest.fn(),
}));

const settingsPayload = Response.encode(
  Response.create({
    settings: {
      studioRpcRxBufSize: 512,
      studioRpcTxBufSize: 1024,
      customSubsystemRequestPayloadMaxBytes: 512,
      splitRelayEnabled: true,
      splitRelayEventDataLen: 128,
      perfRequestDataMaxBytes: 2048,
      perfResponseDataMaxBytes: 2048,
      splitRelayRequestDataMaxBytes: 119,
      splitRelayResponseDataMaxBytes: 121,
    },
  })
).finish();

// Echoes back whatever sequence number the caller sent, regardless of call
// order — the sweep issues far more requests than the manual-mode tests do.
function echoingCallRpc() {
  return jest.fn().mockImplementation(async (_conn, message) => {
    const raw = message?.custom?.call?.payload as Uint8Array | undefined;
    if (!raw) return { custom: { call: { payload: settingsPayload } } };
    const req = Request.decode(raw);
    if (req.perf) {
      const payload = Response.encode(
        Response.create({
          perf: {
            sequenceNumber: req.perf.sequenceNumber,
            data: new Uint8Array(req.perf.responseSize),
            split: false,
          },
        })
      ).finish();
      return { custom: { call: { payload } } };
    }
    return { custom: { call: { payload: settingsPayload } } };
  });
}

async function renderInSweepMode() {
  const mockZMKApp = createConnectedMockZMKApp({
    deviceName: "Test Device",
    subsystems: [SUBSYSTEM_IDENTIFIER],
  });

  render(
    <ZMKAppProvider value={mockZMKApp}>
      <PerfSection />
    </ZMKAppProvider>
  );

  await waitFor(() => {
    expect(screen.getByText(/Device Limits/i)).toBeInTheDocument();
  });

  fireEvent.click(screen.getByRole("button", { name: "Sweep" }));

  // Only keep two sizes selected so the sweep finishes quickly.
  for (const size of [64, 128, 256, 512, 1024, 2048]) {
    fireEvent.click(screen.getByRole("checkbox", { name: String(size) }));
  }
  fireEvent.change(screen.getByLabelText(/Requests per size/i), {
    target: { value: "3" },
  });
}

describe("Benchmark sweep mode", () => {
  beforeEach(() => {
    const { call_rpc } = jest.requireMock("@zmkfirmware/zmk-studio-ts-client");
    (call_rpc as jest.Mock).mockReset();
  });

  it("runs a sweep over the selected sizes and produces a results table", async () => {
    const { call_rpc } = jest.requireMock("@zmkfirmware/zmk-studio-ts-client");
    (call_rpc as jest.Mock).mockImplementation(echoingCallRpc());

    await renderInSweepMode();

    fireEvent.click(screen.getByRole("button", { name: /Start sweep/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Start sweep/i })
      ).toBeInTheDocument();
    });

    // Two size steps (0 and 32 stayed checked) each ran to completion.
    const rows = screen.getAllByRole("row");
    // 1 header row + 2 data rows.
    expect(rows.length).toBe(3);
    expect(
      screen.getByRole("button", { name: /Download CSV/i })
    ).not.toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Download JSON/i })
    ).not.toBeDisabled();
  });

  it("stops a running sweep without hanging", async () => {
    const { call_rpc } = jest.requireMock("@zmkfirmware/zmk-studio-ts-client");
    (call_rpc as jest.Mock).mockImplementation(async (_conn, message) => {
      const raw = message?.custom?.call?.payload as Uint8Array | undefined;
      const req = raw && Request.decode(raw);
      if (req?.perf) return new Promise(() => {}); // never resolves
      return { custom: { call: { payload: settingsPayload } } };
    });

    await renderInSweepMode();

    fireEvent.click(screen.getByRole("button", { name: /Start sweep/i }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Stop sweep/i })
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Stop sweep/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Start sweep/i })
      ).toBeInTheDocument();
    });
  });
});
