/**
 * Tests for App component
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setupZMKMocks } from "@cormoran/zmk-studio-react-hook/testing";
import App from "../src/App";
import { Response } from "../src/proto/zmk/perf/perf";

// Mock the ZMK client
jest.mock("@zmkfirmware/zmk-studio-ts-client", () => ({
  create_rpc_connection: jest.fn(),
  call_rpc: jest.fn(),
}));

jest.mock("@zmkfirmware/zmk-studio-ts-client/transport/serial", () => ({
  connect: jest.fn(),
}));

jest.mock("@zmkfirmware/zmk-studio-ts-client/transport/gatt", () => ({
  connect: jest.fn(),
}));

describe("App Component", () => {
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

  describe("Basic Rendering", () => {
    it("should render the application header", () => {
      render(<App />);

      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        /ZMK Studio RPC Performance/i
      );
    });

    it("should render USB and BLE connection buttons when disconnected", () => {
      render(<App />);

      expect(screen.getByText(/Connect USB/i)).toBeInTheDocument();
      expect(screen.getByText(/Connect BLE/i)).toBeInTheDocument();
    });

    it("should render footer", () => {
      render(<App />);

      expect(screen.getByRole("contentinfo")).toHaveTextContent(
        /ZMK Studio RPC Performance/i
      );
    });
  });

  describe("Connection Flow", () => {
    let mocks: ReturnType<typeof setupZMKMocks>;

    beforeEach(() => {
      mocks = setupZMKMocks();
    });

    it("should connect to device when USB connect button is clicked", async () => {
      mocks.mockSuccessfulConnection({
        deviceName: "Test Keyboard",
        subsystems: ["zmk__perf"],
      });
      mocks.call_rpc.mockResolvedValue({
        custom: { call: { payload: settingsPayload } },
      });

      const { connect: serial_connect } =
        await import("@zmkfirmware/zmk-studio-ts-client/transport/serial");
      (serial_connect as jest.Mock).mockResolvedValue(mocks.mockTransport);

      render(<App />);

      expect(screen.getByText(/Connect USB/i)).toBeInTheDocument();

      const user = userEvent.setup();
      await user.click(screen.getByText(/Connect USB/i));

      await waitFor(() => {
        expect(
          screen.getByText(/Connected to: Test Keyboard/i)
        ).toBeInTheDocument();
      });

      expect(screen.getByText(/Disconnect/i)).toBeInTheDocument();
      expect(screen.getByText(/Performance Test/i)).toBeInTheDocument();
    });
  });
});
