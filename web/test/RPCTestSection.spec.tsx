/**
 * Tests for PerfSection component
 */

import { render, screen } from "@testing-library/react";
import {
  createConnectedMockZMKApp,
  ZMKAppProvider,
} from "@cormoran/zmk-studio-react-hook/testing";
import { PerfSection, SUBSYSTEM_IDENTIFIER } from "../src/App";

describe("PerfSection Component", () => {
  describe("With Subsystem", () => {
    it("should render performance controls when subsystem is found", () => {
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
      expect(screen.getByLabelText(/Send interval/i)).toBeInTheDocument();
      expect(screen.getByText(/Start/i)).toBeInTheDocument();
    });

    it("should show default input values", () => {
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
        /Send interval/i
      ) as HTMLInputElement;
      expect(reqInput.value).toBe("64");
      expect(respInput.value).toBe("64");
      expect(intInput.value).toBe("500");
    });

    it("should display initial stat placeholders", () => {
      const mockZMKApp = createConnectedMockZMKApp({
        subsystems: [SUBSYSTEM_IDENTIFIER],
      });

      render(
        <ZMKAppProvider value={mockZMKApp}>
          <PerfSection />
        </ZMKAppProvider>
      );

      expect(screen.getByText(/Ping latency/i)).toBeInTheDocument();
      expect(screen.getByText(/Throughput/i)).toBeInTheDocument();
      expect(screen.getByText(/Packet loss/i)).toBeInTheDocument();
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
