# zmk-feature-studio-rpc-perf - Web Frontend

Web UI for measuring the performance of the ZMK Studio custom RPC protocol.

## Features

- **Device Connection**: Connect to ZMK devices via USB (serial) or Bluetooth (GATT)
- **Performance Controls**: Adjust request size, response size, and send interval
- **Live Stats**: Displays ping latency, throughput (bps), and packet-loss rate

## Quick Start

```bash
# Install dependencies
npm install

# Generate TypeScript types from proto
npm run generate

# Run development server
npm run dev

# Build for production
npm run build

# Run tests
npm test
```

## Project Structure

```
src/
├── main.tsx              # React entry point
├── App.tsx               # Main application with connection and perf UI
├── App.css               # Styles
└── proto/                # Generated protobuf TypeScript types
    └── zmk/perf/
        └── perf.ts

test/
├── App.spec.tsx              # Tests for App component
└── RPCTestSection.spec.tsx   # Tests for PerfSection component
```

## How It Works

### 1. Protocol Definition

The protobuf schema is defined in `../proto/zmk/perf/perf.proto`:

```proto
message PerfRequest {
    uint32 sequence_number = 1;
    uint32 response_size = 2;
    bytes data = 3;
}

message PerfResponse {
    uint32 sequence_number = 1;
    bytes data = 2;
}
```

### 2. Code Generation

TypeScript types are generated using `ts-proto`:

```bash
npm run generate
```

This runs `buf generate` which uses the configuration in `buf.gen.yaml`.

### 3. Using react-zmk-studio

The app uses the `@cormoran/zmk-studio-react-hook` library:

```typescript
import { ZMKCustomSubsystem } from "@cormoran/zmk-studio-react-hook";

// Find the perf subsystem
const subsystem = zmkApp.findSubsystem("zmk__perf");

// Create service and make RPC calls
const service = new ZMKCustomSubsystem(state.connection, subsystem.index);
const response = await service.callRPC(payload);
```

## Testing

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

### Test Structure

- **App.spec.tsx**: Basic rendering and connection flow tests
- **RPCTestSection.spec.tsx**: Tests for the PerfSection component

## Dependencies

- **@cormoran/zmk-studio-react-hook**: React hooks for ZMK Studio (includes
  connection management and RPC utilities)
- **@zmkfirmware/zmk-studio-ts-client**: Patched ZMK Studio TypeScript client
  with custom RPC support
- **ts-proto**: Protocol buffers code generator for TypeScript
- **React 19**: Modern React with hooks
- **Vite**: Fast build tool and dev server
