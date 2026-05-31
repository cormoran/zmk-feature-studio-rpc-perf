/**
 * Tests for PerfSection component
 */

import { render, screen, waitFor } from "@testing-library/react";
import {
  createConnectedMockZMKApp,
  ZMKAppProvider,
} from "@cormoran/zmk-studio-react-hook/testing";
import { PerfSection, SUBSYSTEM_IDENTIFIER } from "../src/App";
import { Response } from "../src/proto/zmk/perf/perf";

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

  describe("Without ZMKAppContext", () => {
    it("should not render when ZMKAppContext is not provided", () => {
      const { container } = render(<PerfSection />);

      expect(container.firstChild).toBeNull();
    });
  });
});
