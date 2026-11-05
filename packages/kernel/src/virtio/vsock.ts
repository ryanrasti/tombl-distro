// SPDX-License-Identifier: MIT

import { Struct, U16LE, U32LE, U64LE } from "@lowland/bytes";
import { assert } from "../util.ts";
import { type Device, public_handle, VirtioDevice } from "./device.ts";
import type { Virtqueue, VirtqueueChain } from "./queue.ts";
import { RxQueue } from "./rx.ts";

class VsockConfig extends Struct({ guest_cid: U64LE }) {}

class VsockHeader extends Struct({
  src_cid: U64LE,
  dst_cid: U64LE,
  src_port: U32LE,
  dst_port: U32LE,
  len: U32LE,
  type: U16LE,
  op: U16LE,
  flags: U32LE,
  buf_alloc: U32LE,
  fwd_cnt: U32LE,
}) {}

const VsockType = { STREAM: 1, SEQPACKET: 2 } as const;

const VsockOp = {
  REQUEST: 1,
  RESPONSE: 2,
  RST: 3,
  SHUTDOWN: 4,
  RW: 5,
  CREDIT_UPDATE: 6,
  CREDIT_REQUEST: 7,
} as const;

const VsockShutdown = {
  RCV: 1,
  SEND: 2,
} as const;

/** The last packet of a SEQPACKET message. */
const SEQ_EOM = 1;

/** VIRTIO_VSOCK_F_SEQPACKET */
const FEATURE_SEQPACKET = 1n << 1n;

const HOST_CID = 2n;
const DEFAULT_VSOCK_BUF_ALLOC = 256 * 1024;
/**
 * The most a write queues as one packet (Linux's VIRTIO_VSOCK_MAX_PKT_BUF_SIZE);
 * delivery splits it to the guest's receive buffers (4 KiB each).
 */
const MAX_VSOCK_PAYLOAD = 64 * 1024;

function concat_bytes(chunks: Uint8Array[]) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * A connection between this process and a guest, over vsock: a byte stream,
 * or for a SEQPACKET connection a sequence of messages (each `read` one
 * message, each `write` one message; a zero-length message isn't read, as
 * an empty read is the end).
 */
export interface VsockConnection {
  /** Whether it carries messages (SOCK_SEQPACKET) rather than a byte stream. */
  readonly seqpacket: boolean;
  /** Its port on the host (CID 2), and the guest's. */
  readonly local_port: number;
  readonly peer_port: number;
  /**
   * Reads the next chunk (or message); an empty chunk means the peer has
   * finished sending. Rejects once the peer has reset it, after what came
   * before.
   */
  read(): Promise<Uint8Array>;
  /** Reads `length` bytes, or fewer if the peer finishes first. */
  readExactly(length: number): Promise<Uint8Array>;
  /**
   * Writes data (one message, on a SEQPACKET connection), waiting for credit
   * when the peer's buffer is full. The connection takes the bytes: they're
   * read until they reach the guest, so they aren't changed after.
   */
  write(data: Uint8Array): Promise<void>;
  /** The peer's credit: how much more its buffer takes than what's been sent to it. */
  readonly credit: number;
  /** Finishes sending once queued writes are sent; reading continues. */
  shutdown(): void;
  /** Closes the connection. */
  close(): void;
  /** Resets the connection (RST): what's unsent or unread is dropped. */
  reset(): void;
  /** Resolves once it's gone: closed, or reset, by either end. */
  readonly closed: Promise<void>;
}

interface VsockConnectionController {
  readonly connection: VsockConnection;
  readonly local_port: number;
  readonly peer_port: number;
  readonly type: number;
  readonly bytes_read: number;
  /** Both directions have finished: the peer's sending, and ours. */
  readonly finished: boolean;
  /** What we've sent that the peer hasn't read yet (its last fwd_cnt behind it). */
  readonly unread: number;
  update_credit(buf_alloc: number, fwd_cnt: number): void;
  enqueue(data: Uint8Array, flags: number): void;
  /** The peer's SHUTDOWN flags. */
  shutdown_from_peer(flags: number): void;
  /** The connection is gone: closed, or (reset) reset by the peer. */
  close_from_peer(reset?: boolean): void;
}

interface VsockConnectionOps {
  send(op: number, flags: number, payload: Uint8Array, fwd_cnt: number): void;
  close(): void;
  reset(): void;
}

/**
 * A connection's state. `opened`: what its writes (and its shutdown) wait
 * for: a guest's connection's RESPONSE, as a guest connecting resets on a
 * packet before it.
 */
function create_vsock_connection(
  ops: VsockConnectionOps,
  local_port: number,
  peer_port: number,
  type: number,
  opened: Promise<void> = Promise.resolve(),
): VsockConnectionController {
  const seqpacket = type === VsockType.SEQPACKET;
  const read_buffer: Uint8Array[] = [];
  const read_waiters: ((value: Uint8Array) => void)[] = [];
  const credit_waiters: (() => void)[] = [];
  /** A SEQPACKET message's packets so far. */
  let message: Uint8Array[] = [];
  /** The peer has finished sending (or the connection is gone). */
  let read_done = false;
  /** We have finished sending, or the peer won't receive. */
  let write_done = false;
  let closed = false;
  /** The peer reset it: reads fail once what came before is read. */
  let reset_by_peer = false;
  let bytes_read = 0;
  let bytes_written = 0;
  let last_credit_update = 0;
  let peer_buf_alloc = DEFAULT_VSOCK_BUF_ALLOC;
  let peer_fwd_cnt = 0;
  let write_tail = opened;
  const gone = Promise.withResolvers<void>();

  function wake_credit_waiters() {
    while (credit_waiters.length > 0) credit_waiters.shift()!();
  }

  function end_reads() {
    if (read_done) return;
    read_done = true;
    while (read_waiters.length > 0) {
      read_waiters.shift()!(new Uint8Array());
    }
  }

  function end_writes() {
    write_done = true;
    wake_credit_waiters();
  }

  function close_from_peer(reset = false) {
    if (closed) return;
    closed = true;
    reset_by_peer = reset;
    end_reads();
    end_writes();
    gone.resolve();
  }

  async function read_chunk(): Promise<Uint8Array> {
    const chunk = read_buffer.shift();
    if (chunk) return chunk;
    if (read_done && reset_by_peer) throw new Error("vsock connection reset");
    if (read_done) return new Uint8Array();
    const next = await new Promise<Uint8Array>((resolve) => read_waiters.push(resolve));
    if (next.byteLength === 0 && reset_by_peer) throw new Error("vsock connection reset");
    return next;
  }

  function consume(length: number) {
    bytes_read = (bytes_read + length) >>> 0;
    const consumed = (bytes_read - last_credit_update) >>> 0;
    if (consumed >= DEFAULT_VSOCK_BUF_ALLOC / 4 && !closed) {
      last_credit_update = bytes_read;
      ops.send(VsockOp.CREDIT_UPDATE, 0, new Uint8Array(), bytes_read);
    }
  }

  async function read(): Promise<Uint8Array> {
    const chunk = await read_chunk();
    consume(chunk.byteLength);
    return chunk;
  }

  async function readExactly(length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const chunk = await read_chunk();
      if (chunk.byteLength === 0) break;
      const n = Math.min(chunk.byteLength, length - offset);
      out.set(chunk.subarray(0, n), offset);
      offset += n;
      consume(n);
      if (n < chunk.byteLength) {
        read_buffer.unshift(chunk.subarray(n).slice());
      }
    }
    return out.subarray(0, offset);
  }

  async function write_serialized(data: Uint8Array) {
    if (!seqpacket && data.byteLength === 0) return;
    let offset = 0;
    do {
      if (write_done) throw new Error("vsock connection is closed");
      const used = (bytes_written - peer_fwd_cnt) >>> 0;
      const available = Math.max(0, peer_buf_alloc - used);
      if (available === 0 && data.byteLength > 0) {
        await new Promise<void>((resolve) => credit_waiters.push(resolve));
        continue;
      }
      const n = Math.min(MAX_VSOCK_PAYLOAD, available, data.byteLength - offset);
      const last = offset + n === data.byteLength;
      ops.send(
        VsockOp.RW,
        seqpacket && last ? SEQ_EOM : 0,
        data.subarray(offset, offset + n),
        bytes_read,
      );
      offset += n;
      bytes_written = (bytes_written + n) >>> 0;
    } while (offset < data.byteLength);
  }

  // (the caller's bytes, not a copy; measured: the copy was a sixth of a
  // 64 MB transfer to the guest, 85 ms -> 65 ms without it)
  function write(data: Uint8Array): Promise<void> {
    const result = write_tail.then(() => write_serialized(data));
    write_tail = result.catch(() => {});
    return result;
  }

  const connection: VsockConnection = {
    seqpacket,
    local_port,
    peer_port,
    read,
    readExactly,
    write,
    get credit() {
      return Math.max(0, peer_buf_alloc - ((bytes_written - peer_fwd_cnt) >>> 0));
    },
    shutdown() {
      write_tail = write_tail.then(() => {
        if (write_done) return;
        end_writes();
        ops.send(VsockOp.SHUTDOWN, VsockShutdown.SEND, new Uint8Array(), bytes_read);
      });
    },
    close() {
      if (closed) return;
      ops.close();
      close_from_peer();
    },
    reset() {
      if (closed) return;
      ops.reset();
      close_from_peer();
    },
    closed: gone.promise,
  };

  return {
    connection,
    local_port,
    peer_port,
    type,
    get bytes_read() {
      return bytes_read;
    },
    get finished() {
      return read_done && write_done;
    },
    get unread() {
      return (bytes_written - peer_fwd_cnt) >>> 0;
    },
    update_credit(buf_alloc, fwd_cnt) {
      peer_buf_alloc = buf_alloc;
      peer_fwd_cnt = fwd_cnt;
      wake_credit_waiters();
    },
    enqueue(payload, flags) {
      if (read_done) return;
      // (a copy: the payload is a view of the guest's buffer, which it reuses)
      let data = payload.slice();
      if (seqpacket) {
        message.push(data);
        if ((flags & SEQ_EOM) === 0) return;
        data = message.length === 1 ? data : concat_bytes(message);
        message = [];
      }
      if (data.byteLength === 0) return;
      const waiter = read_waiters.shift();
      if (waiter) waiter(data);
      else read_buffer.push(data);
    },
    shutdown_from_peer(flags) {
      if (flags & VsockShutdown.SEND) end_reads();
      if (flags & VsockShutdown.RCV) end_writes();
    },
    close_from_peer,
  };
}

interface VsockConnectionState {
  controller: VsockConnectionController;
  connected: boolean;
  resolve(connection: VsockConnection): void;
  reject(error: Error): void;
}

/** A host listener's connections, as the guest makes them. */
/**
 * A host listener's connections, as the guest makes them: accepted at once,
 * or (a promise) once it resolves, and reset if it rejects.
 */
type VsockListener = (connection: VsockConnection) => void | PromiseLike<unknown>;

/**
 * A virtio-vsock device: stream and SEQPACKET sockets between the guest and
 * this process, addressed by port.
 */
export interface VsockDevice extends Device {
  /** Connects to a vsock listener on `port` in the guest. */
  connect(
    port: number,
    options?: {
      /** Connection timeout in milliseconds. Defaults to 5000. */
      timeoutMs?: number;
      /** A SEQPACKET connection rather than a stream. */
      seqpacket?: boolean;
    },
  ): Promise<VsockConnection>;
  /**
   * Listens on the host's `port` (CID 2) for the guest's connections, stream
   * or SEQPACKET alike. Connections to a port with no listener are reset.
   */
  listen(port: number, on_connection: VsockListener): { close(): void };
}

/**
 * A transmitted packet's header and payload, as views of the chain where it
 * allows (Linux's: the header one descriptor, the payload the next), else a
 * copy. Read before the chain is released.
 */
function read_tx_packet(chain: VirtqueueChain) {
  const readable = Array.from(chain, (desc) => {
    assert(!desc.writable, "vsock tx descriptor must be readable");
    return desc.array;
  });
  const [first, second] = readable;
  if (first && first.byteLength === VsockHeader.size && readable.length <= 2) {
    const header = new VsockHeader(first);
    const payload = (second ?? new Uint8Array()).subarray(0, header.len);
    assert(payload.byteLength === header.len, "short vsock payload");
    return { header, payload };
  }
  const bytes = concat_bytes(readable);
  assert(bytes.byteLength >= VsockHeader.size, "short vsock header");
  const header = new VsockHeader(bytes);
  const payload = bytes.subarray(VsockHeader.size, VsockHeader.size + header.len);
  return { header, payload };
}

/** A packet for the guest: its header's fields, and its payload (what's left of it to deliver). */
interface PendingPacket {
  local_port: number;
  peer_port: number;
  type: number;
  op: number;
  /** Its flags; a SEQPACKET message's end (SEQ_EOM) goes on its last piece only. */
  flags: number;
  fwd_cnt: number;
  payload: Uint8Array;
}

/** A connection's key: its two ports. */
const key_of = (local_port: number, peer_port: number) => `${local_port}:${peer_port}`;

class VirtioVsock extends VirtioDevice {
  readonly #guest_cid: bigint;
  readonly #rx = new RxQueue();
  // Packets are small and bounded by the peer's credit, so they queue here
  // until the guest posts buffers for them.
  readonly #pending: PendingPacket[] = [];
  readonly #connections = new Map<string, VsockConnectionState>();
  readonly #listeners = new Map<number, VsockListener>();
  #next_port = 49152;

  constructor(guest_cid: bigint) {
    const config = new Uint8Array(VsockConfig.size);
    new VsockConfig(config).guest_cid = guest_cid;
    // (views: packets are read and written in the guest's buffers, not copies of them;
    // 64 of the guest's 16 KiB receive buffers, 1 MiB, as 256 of 4 KiB; measured:
    // a 64 MB transfer to the guest, 120 ms with 4 KiB buffers, 85 ms with 16 KiB)
    super({
      id: 19,
      queues: 3,
      queue_size: 64,
      config,
      features: FEATURE_SEQPACKET,
      views: true,
    });
    this.#guest_cid = guest_cid;
  }

  #allocate_port() {
    for (let attempts = 0; attempts < 65536 - 49152; attempts++) {
      const port = this.#next_port;
      this.#next_port = port === 65535 ? 49152 : port + 1;
      if (!this.#listeners.has(port)) return port;
    }
    throw new Error("no local vsock ports available");
  }

  /**
   * Pending packets into the guest's receive buffers, written in place: a
   * payload larger than a buffer split across buffers, a packet each.
   */
  #flush() {
    while (
      this.#pending.length > 0 &&
      this.#rx.deliver((chain) => {
        const packet = this.#pending[0]!;
        const [desc, next_desc] = chain;
        assert(desc && desc.writable, "vsock rx buffer must be writable");
        assert(!next_desc, "vsock rx buffer should be a single descriptor");
        const room = desc.array.byteLength - VsockHeader.size;
        assert(room > 0 || packet.payload.byteLength === 0, "vsock rx buffer too small");
        const n = Math.min(room, packet.payload.byteLength);
        const last = n === packet.payload.byteLength;
        // (the header's fields by offset, VsockHeader's layout: a packet each
        // 4 KiB of a transfer, where its accessors cost)
        const hdr = new DataView(desc.array.buffer, desc.array.byteOffset, VsockHeader.size);
        hdr.setBigUint64(0, HOST_CID, true);
        hdr.setBigUint64(8, this.#guest_cid, true);
        hdr.setUint32(16, packet.local_port, true);
        hdr.setUint32(20, packet.peer_port, true);
        hdr.setUint32(24, n, true);
        hdr.setUint16(28, packet.type, true);
        hdr.setUint16(30, packet.op, true);
        hdr.setUint32(32, last ? packet.flags : packet.flags & ~SEQ_EOM, true);
        hdr.setUint32(36, DEFAULT_VSOCK_BUF_ALLOC, true);
        hdr.setUint32(40, packet.fwd_cnt, true);
        desc.array.set(packet.payload.subarray(0, n), VsockHeader.size);
        if (last) this.#pending.shift();
        else packet.payload = packet.payload.subarray(n);
        return VsockHeader.size + n;
      })
    );
  }

  #send_packet(
    local_port: number,
    peer_port: number,
    type: number,
    op: number,
    flags: number,
    payload: Uint8Array,
    fwd_cnt: number,
  ) {
    this.#pending.push({ local_port, peer_port, type, op, flags, fwd_cnt, payload });
    this.#flush();
  }

  #send(
    connection: VsockConnectionController,
    op: number,
    flags: number,
    payload: Uint8Array,
    fwd_cnt = connection.bytes_read,
  ) {
    this.#send_packet(
      connection.local_port,
      connection.peer_port,
      connection.type,
      op,
      flags,
      payload,
      fwd_cnt,
    );
  }

  /** A connection's ops: its packets sent while it's still ours. */
  #ops(key: string): VsockConnectionOps {
    return {
      send: (op, flags, payload, fwd_cnt) => {
        if (this.stopped) return;
        const connection = this.#connections.get(key)?.controller;
        if (!connection) return;
        this.#send(connection, op, flags, payload, fwd_cnt);
      },
      close: () => {
        const connection = this.#connections.get(key)?.controller;
        if (!connection) return;
        this.#send(
          connection,
          VsockOp.SHUTDOWN,
          VsockShutdown.RCV | VsockShutdown.SEND,
          new Uint8Array(),
        );
      },
      reset: () => {
        const connection = this.#connections.get(key)?.controller;
        if (!connection) return;
        this.#send(connection, VsockOp.RST, 0, new Uint8Array());
        this.#connections.delete(key);
      },
    };
  }

  /** The guest's connection request to a host port: accepted if it's listened on, else reset. */
  #handle_request(header: VsockHeader) {
    const listener = this.#listeners.get(header.dst_port);
    const supported = header.type === VsockType.STREAM || header.type === VsockType.SEQPACKET;
    if (!listener || !supported) {
      this.#send_packet(
        header.dst_port,
        header.src_port,
        header.type,
        VsockOp.RST,
        0,
        new Uint8Array(),
        0,
      );
      return;
    }
    const key = key_of(header.dst_port, header.src_port);
    // (its writes held till its RESPONSE: sent, or never)
    const opened = Promise.withResolvers<void>();
    const controller = create_vsock_connection(
      this.#ops(key),
      header.dst_port,
      header.src_port,
      header.type,
      opened.promise,
    );
    controller.update_credit(header.buf_alloc, header.fwd_cnt);
    this.#connections.set(key, {
      controller,
      connected: true,
      resolve() {},
      reject() {},
    });
    const accepted = listener(controller.connection);
    if (!accepted) {
      this.#send(controller, VsockOp.RESPONSE, 0, new Uint8Array());
      opened.resolve();
      return;
    }
    // (answered once the listener says: its connection made, or not)
    Promise.resolve(accepted).then(
      () => {
        if (this.#connections.get(key)?.controller === controller) {
          this.#send(controller, VsockOp.RESPONSE, 0, new Uint8Array());
        }
        opened.resolve();
      },
      () => {
        controller.connection.reset();
        opened.resolve();
      },
    );
  }

  #handle_tx_packet(header: VsockHeader, payload: Uint8Array) {
    const key = key_of(header.dst_port, header.src_port);
    const state = this.#connections.get(key);
    // A guest's connection anew on a port pair we still hold: it has let go
    // of the old one (a connect it gave up, a RST still on its way), so the
    // old one's reset and the new one taken, as Linux's transport does.
    if (state && header.op === VsockOp.REQUEST) {
      if (!state.connected) {
        state.reject(new Error("guest connected again on its port"));
      }
      state.controller.close_from_peer(true);
      this.#connections.delete(key);
      this.#handle_request(header);
      return;
    }
    if (!state) {
      if (header.op === VsockOp.REQUEST) this.#handle_request(header);
      else if (header.op !== VsockOp.RST) {
        this.#send_packet(
          header.dst_port,
          header.src_port,
          header.type,
          VsockOp.RST,
          0,
          new Uint8Array(),
          0,
        );
      }
      return;
    }

    const connection = state.controller;
    connection.update_credit(header.buf_alloc, header.fwd_cnt);

    switch (header.op) {
      case VsockOp.RESPONSE:
        state.connected = true;
        state.resolve(connection.connection);
        break;
      case VsockOp.RW:
        connection.enqueue(payload, header.flags);
        break;
      case VsockOp.CREDIT_UPDATE:
        break;
      case VsockOp.CREDIT_REQUEST:
        this.#send(connection, VsockOp.CREDIT_UPDATE, 0, new Uint8Array());
        break;
      case VsockOp.SHUTDOWN:
        connection.shutdown_from_peer(header.flags);
        // Both directions done: the connection ends, as Linux ends its side
        // of one, with a reset. Ended with what we sent unread (its fwd_cnt
        // behind it: a close with data unread, which vsock sends as a
        // shutdown), it's a reset for us too, as TCP's RST.
        if (connection.finished || header.flags === (VsockShutdown.RCV | VsockShutdown.SEND)) {
          this.#send(connection, VsockOp.RST, 0, new Uint8Array());
          if (!state.connected) {
            state.reject(new Error("guest shut down vsock connection"));
          }
          connection.close_from_peer(
            (header.flags & VsockShutdown.RCV) !== 0 && connection.unread > 0,
          );
          this.#connections.delete(key);
        }
        break;
      case VsockOp.RST:
        if (!state.connected) {
          state.reject(new Error("guest reset vsock connection"));
        }
        connection.close_from_peer(true);
        this.#connections.delete(key);
        break;
      default:
        console.warn("unknown vsock op", header.op);
    }
  }

  protected kick(vq: number, queue: Virtqueue) {
    switch (vq) {
      case 0:
        this.#rx.post(queue);
        this.#flush();
        break;
      case 1:
        for (const chain of queue) {
          const { header, payload } = read_tx_packet(chain);
          this.#handle_tx_packet(header, payload);
          chain.release(0);
        }
        break;
      // Event buffers (queue 2) are only needed for host transport reset,
      // which is not supported yet.
    }
  }

  protected reset() {
    this.#rx.reset();
    this.#pending.length = 0;
    for (const state of this.#connections.values()) {
      if (!state.connected) {
        state.reject(new Error("vsock device reset while connecting"));
      }
      state.controller.close_from_peer();
    }
    this.#connections.clear();
  }

  protected close() {
    for (const state of this.#connections.values()) {
      this.#send(state.controller, VsockOp.RST, 0, new Uint8Array());
      if (!state.connected) {
        state.reject(new Error("vsock device closed while connecting"));
      }
      state.controller.close_from_peer();
    }
    this.#connections.clear();
    this.#listeners.clear();
    this.#rx.close();
  }

  listen(port: number, on_connection: VsockListener) {
    assert(!this.#listeners.has(port), `vsock port ${port} is already listened on`);
    this.#listeners.set(port, on_connection);
    return {
      close: () => {
        if (this.#listeners.get(port) === on_connection) this.#listeners.delete(port);
      },
    };
  }

  connect(
    port: number,
    { timeoutMs = 5000, seqpacket = false }: { timeoutMs?: number; seqpacket?: boolean } = {},
  ) {
    if (this.stopped) {
      return Promise.reject(new Error("vsock device is closed"));
    }
    const local_port = this.#allocate_port();
    const key = key_of(local_port, port);
    const connection = create_vsock_connection(
      this.#ops(key),
      local_port,
      port,
      seqpacket ? VsockType.SEQPACKET : VsockType.STREAM,
    );

    const promise = new Promise<VsockConnection>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#send(connection, VsockOp.RST, 0, new Uint8Array());
        this.#connections.delete(key);
        connection.close_from_peer();
        reject(new Error(`timed out connecting to guest vsock port ${port}`));
      }, timeoutMs);

      this.#connections.set(key, {
        controller: connection,
        connected: false,
        resolve(value) {
          clearTimeout(timeout);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });

    this.#send(connection, VsockOp.REQUEST, 0, new Uint8Array());
    return promise;
  }
}

/**
 * A virtio-vsock device. `guestCid` is the context ID assigned to the
 * guest, defaulting to 3.
 */
export function vsockDevice({ guestCid = 3n }: { guestCid?: bigint } = {}): VsockDevice {
  const device = new VirtioVsock(guestCid);
  return public_handle(device, {
    connect: (port: number, options?: { timeoutMs?: number; seqpacket?: boolean }) =>
      device.connect(port, options),
    listen: (port: number, on_connection: VsockListener) => device.listen(port, on_connection),
  });
}
