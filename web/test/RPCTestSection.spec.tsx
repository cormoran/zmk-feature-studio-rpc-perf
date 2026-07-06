/**
 * Tests for PerfSection component
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createConnectedMockZMKApp,
  ZMKAppProvider,
} from "@cormoran/zmk-studio-react-hook/testing";
import { PerfSection, SUBSYSTEM_IDENTIFIER } from "../src/App";
import { ErrorCode, Response } from "../src/proto/zmk/perf/perf";

jest.mock("@zmkfirmware/zmk-studio-ts-client", () => ({
  call_rpc: jest.fn(),
}));

// Mirrors the constants in src/hooks/usePerfTest.ts.
const RPC_TIMEOUT_MS = 15000;
const STATS_FLUSH_INTERVAL_MS = 150;

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

function perfResponsePayload(sequenceNumber: number) {
  return Response.encode(
    Response.create({
      perf: { sequenceNumber, data: new Uint8Array(0), split: false },
    })
  ).finish();
}

function errorResponsePayload(code: ErrorCode, message: string) {
  return Response.encode(
    Response.create({ error: { code, message } })
  ).finish();
}

describe("PerfSection Component", () => {
  beforeEach(async () => {
    const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
    (call_rpc as jest.Mock).mockReset();
    (call_rpc as jest.Mock).mockResolvedValue({
      custom: { call: { payload: settingsPayload } },
    });
  });

  describe("With Subsystem", () => {
    it("should render performance controls when subsystem is found", async () => {
      const mockZMKApp = createConnectedMockZMKApp({
        deviceName: "Test Device",
        subsystems: [SUBSYSTEM_IDENTIFIER],
      });

      render(
        <ZMKAppProvider value={mockZMKApp}>
          <PerfSection />
        </ZMKAppProvider>
      );

      expect(screen.getByText(/Performance Test/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Request size/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Response size/i)).toBeInTheDocument();
      expect(
        screen.getByLabelText(/Interval between requests/i)
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Start/i })
      ).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByText(/Device Limits/i)).toBeInTheDocument();
      });
    });

    it("should show default input values", async () => {
      const mockZMKApp = createConnectedMockZMKApp({
        subsystems: [SUBSYSTEM_IDENTIFIER],
      });

      render(
        <ZMKAppProvider value={mockZMKApp}>
          <PerfSection />
        </ZMKAppProvider>
      );

      const reqInput = screen.getByLabelText(
        /Request size/i
      ) as HTMLInputElement;
      const respInput = screen.getByLabelText(
        /Response size/i
      ) as HTMLInputElement;
      const intInput = screen.getByLabelText(
        /Interval between requests/i
      ) as HTMLInputElement;
      expect(reqInput.value).toBe("1");
      expect(respInput.value).toBe("1");
      expect(intInput.value).toBe("100");
      await waitFor(() => {
        expect(screen.getByText(/Device Limits/i)).toBeInTheDocument();
      });
    });

    it("should display initial stat placeholders", async () => {
      const mockZMKApp = createConnectedMockZMKApp({
        subsystems: [SUBSYSTEM_IDENTIFIER],
      });

      render(
        <ZMKAppProvider value={mockZMKApp}>
          <PerfSection />
        </ZMKAppProvider>
      );

      expect(screen.getByText(/Last latency/i)).toBeInTheDocument();
      expect(screen.getByText(/Throughput/i)).toBeInTheDocument();
      expect(screen.getByText(/Packet loss/i)).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByText(/Device Limits/i)).toBeInTheDocument();
      });
    });

    it("should display firmware RPC limits", async () => {
      const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
      const mockZMKApp = createConnectedMockZMKApp({
        subsystems: [SUBSYSTEM_IDENTIFIER],
      });

      render(
        <ZMKAppProvider value={mockZMKApp}>
          <PerfSection />
        </ZMKAppProvider>
      );

      await waitFor(() => {
        expect(screen.getByText(/RPC RX buffer/i)).toBeInTheDocument();
        expect(screen.getAllByText("512 B").length).toBeGreaterThan(0);
        expect(screen.getByText(/Split relay payload/i)).toBeInTheDocument();
        expect(screen.getByText("128 B")).toBeInTheDocument();
      });
      expect(call_rpc).toHaveBeenCalledTimes(1);
    });
  });

  describe("Without Subsystem", () => {
    it("should show warning when subsystem is not found", () => {
      const mockZMKApp = createConnectedMockZMKApp({
        deviceName: "Test Device",
        subsystems: [],
      });

      render(
        <ZMKAppProvider value={mockZMKApp}>
          <PerfSection />
        </ZMKAppProvider>
      );

      expect(
        screen.getByText(/Subsystem "zmk__perf" not found/i)
      ).toBeInTheDocument();
    });
  });

  describe("Run loop robustness", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    async function renderAndStart(options: { intervalMs?: number } = {}) {
      const mockZMKApp = createConnectedMockZMKApp({
        subsystems: [SUBSYSTEM_IDENTIFIER],
      });

      render(
        <ZMKAppProvider value={mockZMKApp}>
          <PerfSection />
        </ZMKAppProvider>
      );

      // Flush the loadSettings() setTimeout(0) scheduled on mount.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
      });

      if (options.intervalMs !== undefined) {
        // Keep the next iteration from starting inside the assertion window,
        // so sent/received counts from a single request stay observable.
        fireEvent.change(screen.getByLabelText(/Interval between requests/i), {
          target: { value: String(options.intervalMs) },
        });
      }

      fireEvent.click(screen.getByRole("button", { name: /Start/i }));
    }

    it("counts a request that never responds as a loss without stalling the loop", async () => {
      const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
      (call_rpc as jest.Mock).mockReset();
      (call_rpc as jest.Mock)
        .mockResolvedValueOnce({
          custom: { call: { payload: settingsPayload } },
        })
        .mockImplementation(() => new Promise(() => {}));

      await renderAndStart();

      await act(async () => {
        await jest.advanceTimersByTimeAsync(
          RPC_TIMEOUT_MS + STATS_FLUSH_INTERVAL_MS
        );
      });

      expect(screen.getByText("100.0 %")).toBeInTheDocument();
      // sent advanced to 2: the loop moved on to a second request after the
      // first timed out, instead of hanging forever.
      expect(screen.getByText("0 / 2 packets")).toBeInTheDocument();
      expect(call_rpc).toHaveBeenCalledTimes(3);

      expect(screen.getByRole("button", { name: /Stop/i })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /Stop/i }));
    });

    it("updates the packet-loss stat immediately when a request fails", async () => {
      const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
      (call_rpc as jest.Mock).mockReset();
      (call_rpc as jest.Mock)
        .mockResolvedValueOnce({
          custom: { call: { payload: settingsPayload } },
        })
        .mockRejectedValueOnce(new Error("transport error"))
        .mockImplementation(() => new Promise(() => {}));

      await renderAndStart({ intervalMs: 9999 });

      // Only a flush tick is needed — no need to wait out the RPC timeout.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(STATS_FLUSH_INTERVAL_MS);
      });

      expect(screen.getByText("100.0 %")).toBeInTheDocument();
      expect(screen.getByText("0 / 1 packets")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /Stop/i }));
    });

    it("does not record a latency sample when the response sequence number is wrong", async () => {
      const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
      (call_rpc as jest.Mock).mockReset();
      (call_rpc as jest.Mock)
        .mockResolvedValueOnce({
          custom: { call: { payload: settingsPayload } },
        })
        .mockResolvedValueOnce({
          custom: { call: { payload: perfResponsePayload(999) } },
        })
        .mockImplementation(() => new Promise(() => {}));

      await renderAndStart({ intervalMs: 9999 });

      await act(async () => {
        await jest.advanceTimersByTimeAsync(STATS_FLUSH_INTERVAL_MS);
      });

      expect(screen.getByText("0 / 1 packets")).toBeInTheDocument();
      expect(screen.getByText("100.0 %")).toBeInTheDocument();
      // "Last latency" stat card still shows the empty placeholder.
      const lastLatencyCard = screen
        .getByText(/Last latency/i)
        .closest(".stat-card") as HTMLElement;
      expect(lastLatencyCard).toHaveTextContent("—");

      fireEvent.click(screen.getByRole("button", { name: /Stop/i }));
    });

    it("surfaces a structured error response instead of counting it as plain packet loss", async () => {
      const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
      (call_rpc as jest.Mock).mockReset();
      (call_rpc as jest.Mock)
        .mockResolvedValueOnce({
          custom: { call: { payload: settingsPayload } },
        })
        .mockResolvedValueOnce({
          custom: {
            call: {
              payload: errorResponsePayload(
                ErrorCode.ERROR_SPLIT_NOT_SUPPORTED,
                "Failed to process request: -93"
              ),
            },
          },
        })
        .mockImplementation(() => new Promise(() => {}));

      await renderAndStart({ intervalMs: 9999 });

      await act(async () => {
        await jest.advanceTimersByTimeAsync(STATS_FLUSH_INTERVAL_MS);
      });

      expect(
        screen.getByText(/Split relay not supported by this firmware build/i)
      ).toBeInTheDocument();
      // Error responses are received, not lost: 0% loss with 1 error noted.
      expect(screen.getByText("0.0 %")).toBeInTheDocument();
      expect(screen.getByText("0 / 1 packets, errors 1")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /Stop/i }));
    });
  });

  describe("Without ZMKAppContext", () => {
    it("should not render when ZMKAppContext is not provided", () => {
      const { container } = render(<PerfSection />);

      expect(container.firstChild).toBeNull();
    });
  });
});
