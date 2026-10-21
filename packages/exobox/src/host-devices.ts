// SPDX-License-Identifier: MIT
//
// The console and disks as direct host calls, for a kernel built with them
// (hvc_wasm, hostblk): no virtqueues. The kernel's side is in
// arch/wasm/drivers/.

import type { MachineExtension } from "./machine.ts";

/** A disk: its bytes, read (and written, if it has `write`) synchronously. */
export interface HostDisk {
  readonly size: number;
  read(offset: number, target: Uint8Array): number;
  write?(offset: number, source: Uint8Array): number;
}

export interface HostDevicesOptions {
  /** hvc0's input. */
  input?: ReadableStream<Uint8Array>;
  /** hvc0's output. */
  output?: WritableStream<Uint8Array>;
  /** /dev/vda, /dev/vdb, ... */
  disks?: readonly HostDisk[];
}

const EIO = -5;
const EROFS = -30;

export interface HostDevices extends MachineExtension {
  /** Settles once what the console has written so far has reached `output`. */
  flushed(): Promise<void>;
}

export function hostDevices({ input, output, disks = [] }: HostDevicesOptions): HostDevices {
  let writes: Promise<void> = Promise.resolve();
  return {
    flushed: () => writes,
    kernel_imports({ memory, raise_irq }) {
      let console_irq = 0;
      const input_buffer: number[] = [];
      const writer = output?.getWriter();
      if (input) {
        const reader = input.getReader();
        void (async () => {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            input_buffer.push(...value);
            if (console_irq) raise_irq(console_irq);
          }
        })();
      }
      const disk = (index: number) => disks[index >>> 0];
      return {
        console_write(buf: number, len: number) {
          if (!writer) return;
          const bytes = new Uint8Array(memory.buffer, buf >>> 0, len >>> 0).slice();
          writes = writes.then(() => writer.write(bytes)).catch(() => {});
        },
        console_read(buf: number, len: number) {
          const n = Math.min(len >>> 0, input_buffer.length);
          new Uint8Array(memory.buffer).set(input_buffer.splice(0, n), buf >>> 0);
          return n;
        },
        console_irq(irq: number) {
          console_irq = irq;
          if (input_buffer.length) queueMicrotask(() => raise_irq(irq));
        },
        blk_count: () => disks.length,
        blk_size: (index: number) => BigInt(disk(index)?.size ?? 0),
        blk_writable: (index: number) => (disk(index)?.write ? 1 : 0),
        blk_read(index: number, offset: bigint, buf: number, len: number) {
          const target = new Uint8Array(memory.buffer, buf >>> 0, len >>> 0);
          return disk(index)?.read(Number(offset), target) === target.byteLength ? 0 : EIO;
        },
        blk_write(index: number, offset: bigint, buf: number, len: number) {
          const d = disk(index);
          if (!d?.write) return EROFS;
          const source = new Uint8Array(memory.buffer, buf >>> 0, len >>> 0);
          return d.write(Number(offset), source) === source.byteLength ? 0 : EIO;
        },
      };
    },
  };
}
