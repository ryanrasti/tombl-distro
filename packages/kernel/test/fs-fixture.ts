// SPDX-License-Identifier: MIT

import { type FS, fileSystemDevice, type FSDeviceOptions } from "../src/virtio/fs.ts";
import { attach_devices, close_device } from "./virtio-fixture.ts";

const RING = 0;
const RING_SIZE = 64;
const REQUEST = 4096;
const REQUEST_SIZE = 256 * 1024;
const RESPONSE = REQUEST + REQUEST_SIZE;
const RESPONSE_SIZE = 1024 * 1024 + 4096;

const NEXT = 1 << 0;
const WRITE = 1 << 1;
const AVAIL = 1 << 7;
const USED = 1 << 15;

export interface FuseReply {
  error: number;
  unique: bigint;
  payload: Uint8Array;
}

/**
 * A virtio-fs device driven the way the guest's driver drives it, with no
 * guest: requests written to a packed request queue of two-descriptor chains
 * (the request, then the reply's buffer), the device kicked, the reply read
 * back once it raises the queue's interrupt.
 */
export class FuseHarness {
  readonly memory = new WebAssembly.Memory({ initial: 32, maximum: 32, shared: true });
  readonly #device;
  readonly #imports;
  #index = 0;
  #wrap = true;
  #unique = 0n;
  #done: PromiseWithResolvers<void> | undefined;

  constructor(
    filesystem: FS<object, unknown>,
    options: Partial<FSDeviceOptions> = {},
    host_work?: <T>(work: Promise<T>) => Promise<T>,
  ) {
    this.#device = fileSystemDevice(filesystem as never, { tag: "test", ...options });
    this.#imports = attach_devices({
      memory: this.memory,
      devices: [this.#device],
      trigger_irq: () => this.#done?.resolve(),
      on_error: (error) => this.#done?.reject(error),
      host_work,
    });
    this.#imports.enable_vring(0, 1, RING_SIZE, RING, 1);
  }

  /** Sends one request: its header's fields, then `body`. */
  async request(opcode: number, nodeid: bigint, body: Uint8Array = new Uint8Array()) {
    const unique = ++this.#unique;
    const request = new DataView(this.memory.buffer, REQUEST, REQUEST_SIZE);
    const length = 40 + body.byteLength;
    request.setUint32(0, length, true);
    request.setUint32(4, opcode, true);
    request.setBigUint64(8, unique, true);
    request.setBigUint64(16, nodeid, true);
    request.setUint32(24, 1000, true);
    request.setUint32(28, 1000, true);
    request.setUint32(32, 1, true);
    request.setUint32(36, 0, true);
    new Uint8Array(this.memory.buffer, REQUEST + 40, body.byteLength).set(body);
    new Uint8Array(this.memory.buffer, RESPONSE, RESPONSE_SIZE).fill(0);

    const head = this.#index;
    const flags = this.#wrap ? AVAIL : USED;
    this.#descriptor(head, REQUEST, length, flags | NEXT);
    this.#descriptor(head + 1, RESPONSE, RESPONSE_SIZE, flags | WRITE);
    this.#index += 2;
    if (this.#index >= RING_SIZE) {
      this.#index -= RING_SIZE;
      this.#wrap = !this.#wrap;
    }

    this.#done = Promise.withResolvers();
    this.#imports.notify(0, 1);
    await this.#done.promise;

    const response = new DataView(this.memory.buffer, RESPONSE, RESPONSE_SIZE);
    const reply_length = response.getUint32(0, true);
    return {
      error: response.getInt32(4, true),
      unique: response.getBigUint64(8, true),
      payload: new Uint8Array(this.memory.buffer, RESPONSE + 16, Math.max(0, reply_length - 16)).slice(),
    } satisfies FuseReply;
  }

  #descriptor(index: number, address: number, length: number, flags: number) {
    const descriptor = new DataView(this.memory.buffer, RING + 16 * index, 16);
    descriptor.setBigUint64(0, BigInt(address), true);
    descriptor.setUint32(8, length, true);
    descriptor.setUint16(12, index, true);
    descriptor.setUint16(14, flags, true);
  }

  close() {
    return close_device(this.#device);
  }
}

/** Little-endian request bodies. */
export function body(...parts: (["u32", number] | ["u64", bigint] | ["str", string])[]) {
  const encoder = new TextEncoder();
  const chunks = parts.map(([kind, value]) => {
    if (kind === "u32") {
      const chunk = new Uint8Array(4);
      new DataView(chunk.buffer).setUint32(0, value, true);
      return chunk;
    }
    if (kind === "u64") {
      const chunk = new Uint8Array(8);
      new DataView(chunk.buffer).setBigUint64(0, value, true);
      return chunk;
    }
    return encoder.encode(`${value}\0`);
  });
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
