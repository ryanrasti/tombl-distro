// SPDX-License-Identifier: MIT
//
// Host directories (hostfuse, CONFIG_EXOBOX_HOSTFUSE): filesystems the host
// serves with the FUSE protocol, mounted in the machine with
// `mount -t hostfuse TAG DIR`. The kernel's side is
// arch/wasm/exobox/hostfuse.c: each request comes as a list of its pieces in
// the kernel's memory (header, arguments, then any data in the page cache's
// own folios), and the reply goes back into such a list. No virtqueues.
//
// Asynchronous: fuse_submit returns at once, the request's server works on it
// (a promise), and its completion raises the connection's interrupt, after
// which the kernel takes it (fuse_complete). A connection's requests are
// served one after another, in order: a server may then assume no other
// request of the guest's changes the filesystem while one is in progress.
//
// This is the transport only: what answers the requests is a `FuseServer`
// (decoding FUSE, calling a filesystem: the exobox product's is in its
// src/fuse/), by tag.

import type { MachineExtension } from "./machine.ts";

/** What serves a mounted filesystem: a FUSE request in, its reply out (null: none, as for FORGET). */
export interface FuseServer {
  handle(request: Uint8Array): Promise<Uint8Array | null>;
}

export interface HostFuseOptions {
  /** The filesystems, by tag: `mount -t hostfuse TAG DIR`. */
  filesystems: Readonly<Record<string, FuseServer>>;
  /** Counts what the connections did (profiling), if given. */
  stats?: HostFuseStats;
  /** A request that failed in the host (not an errno the server returned). */
  on_error?: (error: unknown) => void;
}

export interface HostFuseStats {
  requests: number;
  /** Bytes of requests and of replies, headers included. */
  request_bytes: number;
  reply_bytes: number;
  /** Time in servers' `handle`, from its call to its reply (ms). */
  serve_ms: number;
  /** Requests by opcode (FUSE's numbers). */
  by_opcode: Record<number, number>;
}

export const hostfuse_stats = (): HostFuseStats => ({
  requests: 0,
  request_bytes: 0,
  reply_bytes: 0,
  serve_ms: 0,
  by_opcode: {},
});

const ENOENT = -2;
const EIO = -5;
const EBADF = -9;
const SEG_SIZE = 8; // struct hostfuse_seg: base, len

interface Connection {
  server: FuseServer;
  irq: number;
  /** the last request's work: the next starts after it */
  queue: Promise<void>;
  /** completed, not yet taken: [id, reply length or errno] */
  done: [number, number][];
  /** submitted, not yet completed */
  pending: number;
}

export interface HostFuse extends MachineExtension {
  /** Connections (mounts) open, and their requests in progress (debugging). */
  describe(): string;
}

export function hostFuse({ filesystems, stats, on_error = console.error }: HostFuseOptions): HostFuse {
  const connections = new Map<number, Connection>();
  let next_conn = 0;
  return {
    describe: () =>
      [...connections].map(([conn, c]) => `hostfuse ${conn}: ${c.pending} in progress, ${c.done.length} done not taken`).join("\n"),
    kernel_imports({ memory, raise_irq, host_work }) {
      /** the pieces at `at`: [base, len] each */
      const pieces = (at: number, n: number): [number, number][] => {
        const view = new DataView(memory.buffer);
        const list: [number, number][] = [];
        for (let i = 0; i < n; i++)
          list.push([view.getUint32(at + i * SEG_SIZE, true), view.getUint32(at + i * SEG_SIZE + 4, true)]);
        return list;
      };
      return {
        fuse_connect(tag: number, tag_len: number, irq: number) {
          const name = new TextDecoder().decode(new Uint8Array(memory.buffer, tag >>> 0, tag_len >>> 0).slice());
          const server = Object.hasOwn(filesystems, name) ? filesystems[name] : undefined;
          if (!server) return ENOENT;
          const conn = next_conn++;
          connections.set(conn, { server, irq, queue: Promise.resolve(), done: [], pending: 0 });
          return conn;
        },
        fuse_submit(conn: number, id: number, in_segs: number, in_n: number, out_segs: number, out_n: number) {
          const c = connections.get(conn);
          if (!c) return EBADF;
          // The request, copied now (the kernel may reuse its pieces once
          // this returns); the reply's pieces, the kernel's until it completes.
          const ins = pieces(in_segs >>> 0, in_n >>> 0);
          const outs = out_n ? pieces(out_segs >>> 0, out_n >>> 0) : [];
          let length = 0;
          for (const [, len] of ins) length += len;
          const request = new Uint8Array(length);
          {
            const kernel = new Uint8Array(memory.buffer);
            let at = 0;
            for (const [base, len] of ins) {
              request.set(kernel.subarray(base, base + len), at);
              at += len;
            }
          }
          if (stats) {
            stats.requests++;
            stats.request_bytes += length;
            const opcode = new DataView(request.buffer).getUint32(4, true);
            stats.by_opcode[opcode] = (stats.by_opcode[opcode] ?? 0) + 1;
          }
          c.pending++;
          const work = c.queue.then(async () => {
            let ret: number;
            try {
              const started = stats ? performance.now() : 0;
              const reply = await c.server.handle(request);
              if (stats) stats.serve_ms += performance.now() - started;
              ret = reply ? scatter(reply, outs) : 0;
              if (stats && reply) stats.reply_bytes += reply.byteLength;
            } catch (error) {
              on_error(error);
              ret = EIO;
            }
            c.pending--;
            if (!id || connections.get(conn) !== c) return;
            c.done.push([id, ret]);
            raise_irq(c.irq);
          });
          // (the kernel's waiting for it: its turns of the loop come sooner)
          c.queue = host_work(work);
          return 0;
        },
        fuse_complete(conn: number, id_ptr: number, ret_ptr: number) {
          const done = connections.get(conn)?.done.shift();
          if (!done) return 0;
          const view = new DataView(memory.buffer);
          view.setUint32(id_ptr >>> 0, done[0], true);
          view.setInt32(ret_ptr >>> 0, done[1], true);
          return 1;
        },
        fuse_disconnect(conn: number) {
          connections.delete(conn);
        },
      };

      /** the reply across the reply's pieces: its length, or EIO if it doesn't fit */
      function scatter(reply: Uint8Array, outs: [number, number][]): number {
        let room = 0;
        for (const [, len] of outs) room += len;
        if (reply.byteLength > room) {
          on_error(new Error(`hostfuse: a reply of ${reply.byteLength} bytes for ${room}`));
          return EIO;
        }
        // (the memory may have grown meanwhile: a view of it now)
        const kernel = new Uint8Array(memory.buffer);
        let at = 0;
        for (const [base, len] of outs) {
          if (at >= reply.byteLength) break;
          const n = Math.min(len, reply.byteLength - at);
          kernel.set(reply.subarray(at, at + n), base);
          at += n;
        }
        return reply.byteLength;
      }
    },
  };
}
