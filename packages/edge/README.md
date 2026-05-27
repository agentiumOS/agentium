# @agentium/edge

Edge deployment for Agentium — IoT toolkits (GPIO, sensors, camera, BLE, servo, system) plus an edge runtime with resource monitoring, presets, and Ollama helpers. Designed for Raspberry Pi but works on any Linux SBC.

## Install

```bash
npm install @agentium/edge
```

Hardware toolkits load their native bindings on demand. Install only what you use, e.g.:

```bash
npm install onoff           # GPIO
npm install i2c-bus         # sensors
npm install @abandonware/noble  # BLE
```

## Quick Start — Ollama-backed local agent on a Pi

```typescript
import { Agent } from "@agentium/core";
import { EdgeRuntime, edgePreset, ollama } from "@agentium/edge";

const runtime = new EdgeRuntime(edgePreset("pi-5-balanced"));
await runtime.start();

const agent = new Agent({
  name: "edge-bot",
  model: ollama(runtime.recommendedModel),
  instructions: "You are an edge AI assistant running on-device.",
});

console.log(await agent.run("hello"));
```

## IoT Toolkits

Each toolkit exposes typed tools (with Zod schemas) the agent can call:

| Toolkit | Example tools |
|---------|---------------|
| `GpioToolkit` | `gpio.write`, `gpio.read`, `gpio.toggle` |
| `SensorToolkit` | `sensor.read_temperature`, `sensor.read_humidity` (I²C / 1-Wire) |
| `CameraToolkit` | `camera.snapshot`, `camera.start_stream` |
| `BleToolkit` | `ble.scan`, `ble.connect`, `ble.read_characteristic` |
| `ServoToolkit` | `servo.move_to`, `servo.center` |
| `SystemToolkit` | `system.cpu_temp`, `system.uptime`, `system.shutdown` |

```typescript
import { Agent } from "@agentium/core";
import { GpioToolkit, SensorToolkit } from "@agentium/edge";

const agent = new Agent({
  name: "garden-bot",
  model: ollama("llama3.2:3b"),
  toolkits: [
    new GpioToolkit({ pumpPin: 17 }),
    new SensorToolkit({ moistureBus: 1 }),
  ],
});

await agent.run("Water the plants if soil moisture is below 30%.");
```

## Edge Runtime

`EdgeRuntime` continuously monitors CPU, RAM, temperature, and storage so you can react to resource pressure (downsize the model, defer non-critical tools, sync to cloud, etc.).

```typescript
const runtime = new EdgeRuntime(edgePreset("pi-zero-2-low-power"));
runtime.on("threshold:cpu", (s) => console.warn("CPU pressure", s));
await runtime.start();
```

## Cloud Sync

`EdgeCloudSync` ships local agent runs / sensor logs to a central endpoint with offline queueing — useful for fleets of Pis with intermittent connectivity.

## Documentation

Full docs at [docs.agentium.in](https://docs.agentium.in)

## Community

Join the conversation on [Discord](https://discord.gg/T86SJshP).

## License

MIT
