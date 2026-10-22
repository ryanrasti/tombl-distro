// SPDX-License-Identifier: MIT
//
// The console and disks as direct host calls, for a kernel built with them
// (CONFIG_EXOBOX_CONSOLE, CONFIG_EXOBOX_HOSTBLK): no virtqueues. The
// kernel's side is arch/wasm/exobox/console.c and hostblk.c.
//
// A disk request comes as a list of its pieces in the kernel's memory
// (blk_submit). A disk that answers at once (bytes in memory) has it done
// before blk_submit returns; one that answers with a promise works
// meanwhile, the machine running on, and its completion raises the disks'
// interrupt, after which the kernel takes it (blk_complete).

import type { MachineExtension } from "./machine.ts";

/**
 * A disk: its bytes, read (and written, if it has `write`) at once or by a
 * promise. Each call is for all of `target` (`source`): a count short of
 * it, or a rejection, is an I/O error.
 */
export interface HostDisk {
  readonly size: number;
  read(offset: number, target: Uint8Array): DiskResult;
  write?(offset: number, source: Uint8Array): DiskResult;
  /** What's been written, made durable (fsync's flush). */
  flush?(): void | Promise<void>;
}
/** bytes done (all, if nothing), now or by a promise */
export type DiskResult = number | void | Promise<number | void>;

export interface HostDevicesOptions {
  /** hvc0's input. */
  input?: ReadableStream<Uint8Array>;
  /** hvc0's output. */
  output?: WritableStream<Uint8Array>;
  /** /dev/vda, /dev/vdb, ... */
  disks?: readonly HostDisk[];
}

const EIO = -5;
const ENXIO = -6;
const EINVAL = -22;
const EROFS = -30;
// (blk_submit's op, and struct hostblk_seg: base, len)
const BLK_READ = 0, BLK_WRITE = 1, BLK_FLUSH = 2;
const SEG_SIZE = 8;

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
      // (chunks as they came, the first read from `consumed` on: a console
      // carrying a host protocol takes megabytes, read 16 bytes at a time)
      const input_buffer: Uint8Array[] = [];
      let consumed = 0;
      const writer = output?.getWriter();
      if (input) {
        const reader = input.getReader();
        void (async () => {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value.byteLength) continue;
            input_buffer.push(value);
            if (console_irq) raise_irq(console_irq);
          }
        })();
      }
      const disk = (index: number) => disks[index >>> 0];
      let blk_irq = 0;
      /** requests completed, not yet taken: [id, 0 or errno] */
      const blk_done: [number, number][] = [];
      return {
        console_write(buf: number, len: number) {
          if (!writer) return;
          const bytes = new Uint8Array(memory.buffer, buf >>> 0, len >>> 0).slice();
          writes = writes.then(() => writer.write(bytes)).catch(() => {});
        },
        console_read(buf: number, len: number) {
          let n = 0;
          while (n < len >>> 0 && input_buffer.length) {
            const chunk = input_buffer[0]!;
            const take = Math.min((len >>> 0) - n, chunk.byteLength - consumed);
            new Uint8Array(memory.buffer).set(chunk.subarray(consumed, consumed + take), (buf >>> 0) + n);
            n += take;
            consumed += take;
            if (consumed === chunk.byteLength) {
              input_buffer.shift();
              consumed = 0;
            }
          }
          return n;
        },
        console_irq(irq: number) {
          console_irq = irq;
          if (input_buffer.length) queueMicrotask(() => raise_irq(irq));
        },
        blk_count: () => disks.length,
        blk_size: (index: number) => BigInt(disk(index)?.size ?? 0),
        blk_writable: (index: number) => (disk(index)?.write ? 1 : 0),
        blk_irq(irq: number) {
          blk_irq = irq;
        },
        blk_submit(index: number, id: number, op: number, offset: bigint, segs: number, n: number) {
          const d = disk(index);
          if (!d) return ENXIO;
          let result: number | Promise<number>;
          try {
            result = submit(d, op, Number(offset), pieces(segs >>> 0, n >>> 0));
          } catch (error) {
            console.error(error);
            return EIO;
          }
          if (typeof result === "number") return result || 1; // (done)
          void result.then((ret) => {
            blk_done.push([id, ret]);
            if (blk_irq) raise_irq(blk_irq);
          });
          return 0;
        },
        blk_complete(id_ptr: number, ret_ptr: number) {
          const done = blk_done.shift();
          if (!done) return 0;
          const view = new DataView(memory.buffer);
          view.setUint32(id_ptr >>> 0, done[0], true);
          view.setInt32(ret_ptr >>> 0, done[1], true);
          return 1;
        },
      };

      /** the pieces at `at`: views of the kernel's memory, which it keeps until the request completes */
      function pieces(at: number, n: number): Uint8Array[] {
        const view = new DataView(memory.buffer);
        const list: Uint8Array[] = [];
        for (let i = 0; i < n; i++) {
          const base = view.getUint32(at + i * SEG_SIZE, true);
          list.push(new Uint8Array(memory.buffer, base, view.getUint32(at + i * SEG_SIZE + 4, true)));
        }
        return list;
      }
    },
  };
}

/**
 * A request on d, piece by piece, at once while d answers at once: 0 or an
 * errno, or a promise of one from the first piece d answers with a promise.
 */
function submit(d: HostDisk, op: number, offset: number, pieces: Uint8Array[]): number | Promise<number> {
  if (op === BLK_FLUSH) {
    const flushed = d.flush?.();
    return flushed ? flushed.then(() => 0, failed) : 0;
  }
  if (op !== BLK_READ && op !== BLK_WRITE) return EINVAL;
  const write = d.write?.bind(d);
  if (op === BLK_WRITE && !write) return EROFS;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    const result = op === BLK_READ ? d.read(offset, piece) : write!(offset, piece);
    offset += piece.byteLength;
    if (result instanceof Promise)
      return (async () => {
        try {
          if (!whole(await result, piece)) return EIO;
          for (const rest of pieces.slice(i + 1)) {
            if (!whole(await (op === BLK_READ ? d.read(offset, rest) : write!(offset, rest)), rest)) return EIO;
            offset += rest.byteLength;
          }
          return 0;
        } catch (error) {
          return failed(error);
        }
      })();
    if (!whole(result, piece)) return EIO;
  }
  return 0;
}

/** a call's count: the whole piece (nothing said: all of it) */
const whole = (done: number | void, piece: Uint8Array) => done === undefined || done === piece.byteLength;

function failed(error: unknown): number {
  console.error(error);
  return EIO;
}
