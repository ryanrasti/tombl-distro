// SPDX-License-Identifier: MIT

import type { DeviceTreeNode } from "../devicetree.ts";
import { assert } from "../util.ts";
import type { Imports } from "../wasm.ts";
import { type BusDevice, type ConnectedVirtioDevice, type Device, device_of } from "./device.ts";

/** A machine's virtio devices, in device-tree order. */
export class VirtioBus {
  readonly #devices: readonly BusDevice[];

  constructor(devices: readonly Device[]) {
    this.#devices = devices.map(device_of);
  }

  /** The `virtio{i}` device-tree nodes, keyed by node name. */
  describe(): Record<string, DeviceTreeNode> {
    return Object.fromEntries(
      this.#devices.map((device, i) => [
        `virtio${i}`,
        {
          compatible: "virtio,wasm",
          "host-id": i,
          "virtio-device-id": device.id,
          features: device.features,
          config: device.config,
          "queue-size": device.queue_size,
        },
      ]),
    );
  }

  /** Connects every device to the kernel. Returns the `virtio` import table. */
  attach({
    memory,
    trigger_irq,
    on_error,
    host_work,
  }: {
    memory: WebAssembly.Memory;
    trigger_irq: (irq: number) => void;
    on_error: (error: unknown) => void;
    host_work?: <T>(work: Promise<T>) => Promise<T>;
  }): Imports["virtio"] {
    const connected = this.#devices.map((device) =>
      device.attach({ memory, trigger_irq, on_error, host_work }),
    );
    // each device's config irq (its setup's): a reset finished is told by it
    const config_irqs = new Map<number, number>();
    const at = (dev: number): ConnectedVirtioDevice => {
      const device = connected[dev];
      assert(device, `no virtio device ${dev}`);
      return device;
    };

    return {
      set_features: (dev, features) => at(dev).set_features(features),
      setup: (dev, config_irq, config_addr, config_len) => {
        config_irqs.set(dev, config_irq);
        at(dev).setup(config_irq, config_addr >>> 0, config_len >>> 0);
      },
      enable_vring: (dev, vq, size, desc_addr, irq) =>
        at(dev).enable_queue(vq, size, desc_addr >>> 0, irq),
      disable_vring: (dev, vq) => at(dev).disable_queue(vq),
      notify: (dev, vq) => at(dev).notify(vq),
      reset: (dev, done) => {
        // The guest sleeps until `done` is set before it reuses the memory
        // it gave this device.
        void at(dev)
          .reset()
          .catch(on_error)
          .finally(() => {
            if (!done) return;
            const word = new Int32Array(memory.buffer, done >>> 0, 1);
            Atomics.store(word, 0, 1);
            // (the guest sleeps till its config irq, then sees the word)
            const irq = config_irqs.get(dev);
            if (irq !== undefined) trigger_irq(irq);
          });
      },
    };
  }

  /** Shuts every device down, rejecting with the first failure. */
  async close(): Promise<void> {
    const results = await Promise.allSettled(this.#devices.map((device) => device.shutdown()));
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }
}
