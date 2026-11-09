// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { type FS, type FSAttributes, FSError } from "../src/virtio/fs.ts";
import { body, FuseHarness } from "./fs-fixture.ts";

const Opcode = {
  LOOKUP: 1,
  FORGET: 2,
  GETATTR: 3,
  OPEN: 14,
  INIT: 26,
  DESTROY: 38,
  OPENDIR: 27,
  READDIR: 28,
  MKNOD: 8,
  LINK: 13,
  FSYNCDIR: 30,
  FALLOCATE: 43,
  READDIRPLUS: 44,
  RENAME2: 45,
  SYNCFS: 50,
} as const;

/** The (name, nodeid, ino) of each entry in a READDIRPLUS reply. */
function direntsplus(payload: Uint8Array) {
  const result: [string, bigint, bigint][] = [];
  const data = view(payload);
  for (let at = 0; at < payload.byteLength;) {
    const nodeid = data.getBigUint64(at, true);
    const dirent = at + 128;
    const length = data.getUint32(dirent + 16, true);
    const name = new TextDecoder().decode(payload.subarray(dirent + 24, dirent + 24 + length));
    result.push([name, nodeid, data.getBigUint64(dirent, true)]);
    at = dirent + ((24 + length + 7) & ~7);
  }
  return result;
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const getattr_in = () => body(["u32", 0], ["u32", 0], ["u64", 0n]);
const open_in = (flags = 0) => body(["u32", flags], ["u32", 0]);
const read_in = (fh: bigint, offset: bigint, size: number) =>
  body(
    ["u64", fh],
    ["u64", offset],
    ["u32", size],
    ["u32", 0],
    ["u64", 0n],
    ["u32", 0],
    ["u32", 0],
  );

/** The (name, ino) of each dirent in a READDIR reply. */
function dirents(payload: Uint8Array) {
  const result: [string, bigint][] = [];
  const data = view(payload);
  for (let at = 0; at < payload.byteLength;) {
    const length = data.getUint32(at + 16, true);
    const name = new TextDecoder().decode(payload.subarray(at + 24, at + 24 + length));
    result.push([name, data.getBigUint64(at, true)]);
    at += (24 + length + 7) & ~7;
  }
  return result;
}

/** INIT's request: version, readahead, and flags (MAX_PAGES and the rest). */
const init = (major: number, minor: number, flags = 0xffff_ffff) =>
  body(["u32", major], ["u32", minor], ["u32", 1 << 20], ["u32", flags]);

const ROOT = 1n;

const directory: FSAttributes = { mode: 0o040755, size: 0n };

/** A filesystem of one directory, the root, whose operations a test supplies. */
function filesystem(methods: Partial<FS<object, unknown>> = {}): FS<object, unknown> {
  const root = {};
  return { root, lookup: () => undefined, getattr: () => directory, ...methods };
}

test("virtio-fs gives the guest a backend error's Linux errno", async () => {
  let thrown: unknown;
  const harness = new FuseHarness(
    filesystem({
      getattr: () => {
        throw thrown;
      },
    }),
  );
  const getattr = () =>
    harness.request(Opcode.GETATTR, ROOT, body(["u32", 0], ["u32", 0], ["u64", 0n]));

  thrown = new FSError("ESTALE");
  assert.equal((await getattr()).error, -116);
  // A host call's error by its code's name, whatever the host's number for it.
  thrown = Object.assign(new Error("stale"), { code: "EXDEV", errno: -9999, syscall: "rename" });
  assert.equal((await getattr()).error, -18);
  // A malformed request: its body cut short.
  assert.equal((await harness.request(Opcode.GETATTR, ROOT, body(["u32", 0]))).error, -22);
  // A node that isn't there, nodeid 0 too.
  assert.equal(
    (await harness.request(Opcode.GETATTR, 0n, body(["u32", 0], ["u32", 0], ["u64", 0n]))).error,
    -2,
  );
  // Anything else isn't the guest's: it fails the machine.
  thrown = new TypeError("unexpected");
  await assert.rejects(getattr(), /unexpected/);
  await harness.close();
});

test("virtio-fs INIT takes minors from 27 and offers 1 MiB requests", async () => {
  const harness = new FuseHarness(filesystem());
  assert.equal((await harness.request(Opcode.INIT, 0n, init(7, 26))).error, -71);
  assert.equal((await harness.request(Opcode.INIT, 0n, init(6, 40))).error, -71);

  const newer = await harness.request(Opcode.INIT, 0n, init(8, 0));
  assert.equal(newer.error, 0);
  const offered = new DataView(newer.payload.buffer);
  assert.deepEqual([offered.getUint32(0, true), offered.getUint32(4, true)], [7, 45]);

  const reply = await harness.request(Opcode.INIT, 0n, init(7, 45));
  assert.equal(reply.error, 0);
  const out = new DataView(reply.payload.buffer);
  assert.equal(out.getUint32(20, true), 1024 * 1024, "max_write");
  assert.equal(out.getUint16(28, true), 256, "max_pages");
  await harness.close();
});

test("virtio-fs INIT sizes requests by the guest's page size", async () => {
  const harness = new FuseHarness(filesystem(), { pageSize: 65536 });
  const out = new DataView((await harness.request(Opcode.INIT, 0n, init(7, 45))).payload.buffer);
  assert.equal(out.getUint32(20, true), 256 * 65536, "max_write");
  await harness.close();
});

test("virtio-fs reports a backend's inode numbers and asks it attributes once a lookup", async () => {
  const file = { name: "f" };
  let getattrs = 0;
  let forgotten: object | undefined;
  const harness = new FuseHarness(
    filesystem({
      entry: (_parent, name) =>
        name === "f"
          ? { node: file, attributes: { mode: 0o100644, size: 3n, ino: 77n } }
          : undefined,
      getattr: (node) => {
        getattrs += 1;
        return node === file ? { mode: 0o100644, size: 3n, ino: 77n } : { ...directory, ino: 5n };
      },
      opendir: () => "dir",
      readdir: () => ["f"],
      forget: (node) => {
        forgotten = node;
      },
    }),
  );

  const looked = await harness.request(Opcode.LOOKUP, ROOT, body(["str", "f"]));
  assert.equal(looked.error, 0);
  const nodeid = view(looked.payload).getBigUint64(0, true);
  assert.equal(view(looked.payload).getBigUint64(40, true), 77n, "the entry's ino");
  assert.equal(getattrs, 0, "the lookup's attributes came with its entry");

  const attr = await harness.request(Opcode.GETATTR, nodeid, getattr_in());
  assert.equal(view(attr.payload).getBigUint64(16, true), 77n, "getattr's ino");

  await harness.request(Opcode.GETATTR, ROOT, getattr_in());
  const opened = await harness.request(Opcode.OPENDIR, ROOT, open_in());
  const fh = view(opened.payload).getBigUint64(0, true);
  const listing = await harness.request(Opcode.READDIR, ROOT, read_in(fh, 0n, 4096));
  assert.deepEqual(dirents(listing.payload), [
    [".", 5n],
    ["..", 5n],
    ["f", 77n],
  ]);

  // Forgotten by the guest: the backend is told, and a new lookup's ino is the file's still.
  await harness.request(Opcode.FORGET, nodeid, body(["u64", 1n]));
  assert.equal(forgotten, file);
  const again = await harness.request(Opcode.LOOKUP, ROOT, body(["str", "f"]));
  assert.equal(view(again.payload).getBigUint64(40, true), 77n);
  await harness.close();
});

test("virtio-fs takes a backend's cache validity and keep-cache", async () => {
  const file = {};
  const harness = new FuseHarness(
    {
      ...filesystem({
        lookup: () => file,
        getattr: (node) => (node === file ? { mode: 0o100444, size: 1n } : directory),
        open: () => "handle",
      }),
      timeout: 3600,
      keepCache: true,
    },
    { cache: false },
  );
  const looked = await harness.request(Opcode.LOOKUP, ROOT, body(["str", "f"]));
  assert.equal(view(looked.payload).getBigUint64(16, true), 3600n, "entry_valid");
  assert.equal(view(looked.payload).getBigUint64(24, true), 3600n, "attr_valid");
  const nodeid = view(looked.payload).getBigUint64(0, true);
  const opened = await harness.request(Opcode.OPEN, nodeid, open_in());
  assert.equal(view(opened.payload).getUint32(8, true), 1 << 1, "FOPEN_KEEP_CACHE");
  await harness.close();
});

test("virtio-fs serves hard links, mknod, rename flags, fallocate, syncfs and fsyncdir", async () => {
  const file = { name: "f" };
  const calls: unknown[][] = [];
  const harness = new FuseHarness(
    filesystem({
      lookup: (_parent, name) => (name === "f" ? file : undefined),
      getattr: (node) => (node === file ? { mode: 0o100644, size: 0n, nlink: 2 } : directory),
      link: (node, _parent, name) => (calls.push(["link", node, name]), node),
      mknod: (_parent, name, rdev, context) => (
        calls.push(["mknod", name, rdev, context.mode]),
        file
      ),
      rename: (_from, from, _to, to, flags) => void calls.push(["rename", from, to, flags]),
      open: () => "handle",
      opendir: () => "dir",
      fallocate: (_node, handle, offset, length, mode) =>
        void calls.push(["fallocate", handle, offset, length, mode]),
      syncfs: () => void calls.push(["syncfs"]),
      fsync: () => void calls.push(["fsync"]),
      fsyncdir: (_node, handle) => void calls.push(["fsyncdir", handle]),
    }),
  );
  const looked = await harness.request(Opcode.LOOKUP, ROOT, body(["str", "f"]));
  const nodeid = view(looked.payload).getBigUint64(0, true);

  const linked = await harness.request(Opcode.LINK, ROOT, body(["u64", nodeid], ["str", "g"]));
  assert.equal(linked.error, 0);
  assert.equal(view(linked.payload).getBigUint64(0, true), nodeid, "a link is the same node");

  const made = await harness.request(
    Opcode.MKNOD,
    ROOT,
    body(["u32", 0o010644], ["u32", 0], ["u32", 0o022], ["u32", 0], ["str", "p"]),
  );
  assert.equal(made.error, 0);

  const renamed = await harness.request(
    Opcode.RENAME2,
    ROOT,
    body(["u64", ROOT], ["u32", 1], ["u32", 0], ["str", "f"], ["str", "h"]),
  );
  assert.equal(renamed.error, 0);

  const fh = view((await harness.request(Opcode.OPEN, nodeid, open_in())).payload).getBigUint64(
    0,
    true,
  );
  const allocated = await harness.request(
    Opcode.FALLOCATE,
    nodeid,
    body(["u64", fh], ["u64", 4096n], ["u64", 8192n], ["u32", 1], ["u32", 0]),
  );
  assert.equal(allocated.error, 0);
  assert.equal((await harness.request(Opcode.SYNCFS, ROOT, body(["u64", 0n]))).error, 0);
  const dir = view((await harness.request(Opcode.OPENDIR, ROOT, open_in())).payload).getBigUint64(
    0,
    true,
  );
  const synced = await harness.request(
    Opcode.FSYNCDIR,
    ROOT,
    body(["u64", dir], ["u32", 0], ["u32", 0]),
  );
  assert.equal(synced.error, 0);

  assert.deepEqual(calls, [
    ["link", file, "g"],
    ["mknod", "p", 0, 0o010644 & ~0o022],
    ["rename", "f", "h", 1],
    ["fallocate", "handle", 4096n, 8192n, 1],
    ["syncfs"],
    ["fsyncdir", "dir"],
  ]);
  await harness.close();
});

test("virtio-fs READDIRPLUS gives each entry, counts it a lookup, and keeps what it has on an error", async () => {
  const nodes = {
    a: { name: "a" },
    b: { name: "b" },
    gone: { name: "gone" },
    bad: { name: "bad" },
  };
  const forgotten: object[] = [];
  let names = ["a", "gone", "b"];
  const harness = new FuseHarness(
    filesystem({
      getattr: () => ({ ...directory, ino: 5n }),
      entry: (_parent, name) => {
        if (name === "gone") return undefined;
        if (name === "bad") throw new FSError("EACCES");
        const node = nodes[name as keyof typeof nodes];
        return { node, attributes: { mode: 0o100644, size: 0n, ino: name === "a" ? 10n : 11n } };
      },
      opendir: () => "dir",
      readdir: () => names,
      forget: (node) => void forgotten.push(node),
    }),
  );
  await harness.request(Opcode.GETATTR, ROOT, getattr_in());
  const dir = view((await harness.request(Opcode.OPENDIR, ROOT, open_in())).payload).getBigUint64(
    0,
    true,
  );

  const listing = await harness.request(Opcode.READDIRPLUS, ROOT, read_in(dir, 0n, 4096));
  assert.equal(listing.error, 0);
  const entries = direntsplus(listing.payload);
  assert.deepEqual(
    entries.map(([name, nodeid, ino]) => [name, nodeid === 0n, ino]),
    [
      [".", true, 5n],
      ["..", true, 5n],
      ["a", false, 10n],
      ["b", false, 11n],
    ],
  );
  // "gone" was never a node; each entry returned was a lookup, kept till
  // the guest forgets it.
  assert.deepEqual(forgotten, []);
  const a = entries[2]![1];
  await harness.request(Opcode.FORGET, a, body(["u64", 1n]));
  assert.deepEqual(forgotten, [nodes.a]);

  // An error after an entry: the reply keeps what it has. First, a fresh listing.
  names = ["a", "bad", "b"];
  const partial = await harness.request(Opcode.READDIRPLUS, ROOT, read_in(dir, 0n, 4096));
  assert.equal(partial.error, 0);
  assert.deepEqual(
    direntsplus(partial.payload).map(([name]) => name),
    [".", "..", "a"],
  );
  // The same error with nothing yet written fails the request.
  const failed = await harness.request(Opcode.READDIRPLUS, ROOT, read_in(dir, 3n, 4096));
  assert.equal(failed.error, -13);
  await harness.close();
});

test("virtio-fs holds a FORGET that comes while a request is in progress till it's answered", async () => {
  const file = { name: "f" };
  let gate: PromiseWithResolvers<void> | undefined;
  const forgotten: object[] = [];
  const harness = new FuseHarness(
    filesystem({
      entry: async (_parent, name) => {
        await gate?.promise;
        return name === "f" ? { node: file, attributes: { mode: 0o100644, size: 0n } } : undefined;
      },
      forget: (node) => void forgotten.push(node),
    }),
  );
  const first = await harness.request(Opcode.LOOKUP, ROOT, body(["str", "f"]));
  const nodeid = view(first.payload).getBigUint64(0, true);

  // The guest looks the name up again while it forgets its first lookup.
  gate = Promise.withResolvers();
  const again = harness.request(Opcode.LOOKUP, ROOT, body(["str", "f"]));
  await harness.forget(nodeid, 1n);
  assert.deepEqual(forgotten, [], "not while the lookup is in progress");
  gate.resolve();
  gate = undefined;
  assert.equal(
    view((await again).payload).getBigUint64(0, true),
    nodeid,
    "the same node, still known",
  );
  assert.deepEqual(forgotten, []);
  await harness.forget(nodeid, 1n);
  assert.deepEqual(forgotten, [file]);
  await harness.close();
});

test("virtio-fs keeps one listing a directory, whatever its handles", async () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  // (each listing its own names, as a backend reading the host's would give)
  const harness = new FuseHarness(
    filesystem({
      entry: () => ({ node: {}, attributes: { mode: 0o100644, size: 0n } }),
      opendir: () => "dir",
      readdir: () => Array.from({ length: 2000 }, (_, i) => `${"n".repeat(100)}-${i}`),
    }),
  );
  gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 200; i++) {
    const opened = await harness.request(Opcode.OPENDIR, ROOT, open_in());
    const fh = view(opened.payload).getBigUint64(0, true);
    assert.equal((await harness.request(Opcode.READDIR, ROOT, read_in(fh, 0n, 4096))).error, 0);
  }
  gc();
  // A listing is about 250 KB: one held, not 200 (50 MB).
  assert(process.memoryUsage().heapUsed - before < 10_000_000);
  await harness.close();
});

test("virtio-fs ends each session at its DESTROY: a mount again starts afresh", async () => {
  const file = { name: "f" };
  let destroyed = 0;
  const harness = new FuseHarness(
    filesystem({
      entry: (_parent, name) =>
        name === "f" ? { node: file, attributes: { mode: 0o100644, size: 0n } } : undefined,
      destroy: () => void (destroyed += 1),
    }),
  );
  const nodeid = async () => {
    const reply = await harness.request(Opcode.LOOKUP, ROOT, body(["str", "f"]));
    return view(reply.payload).getBigUint64(0, true);
  };
  await harness.request(Opcode.INIT, 0n, init(7, 45));
  const first = await nodeid();
  await harness.request(Opcode.DESTROY, 0n);
  assert.equal(destroyed, 1);
  // (the guest sends no FORGETs as it unmounts: the session's nodes go with it)
  assert.equal((await harness.request(Opcode.GETATTR, first, getattr_in())).error, -2);

  await harness.request(Opcode.INIT, 0n, init(7, 45));
  assert.notEqual(await nodeid(), first);
  await harness.request(Opcode.DESTROY, 0n);
  assert.equal(destroyed, 2, "the second session's DESTROY too");
  await harness.close();
  assert.equal(destroyed, 2, "nothing left to end at close");
});

test("FSError.from gives a backend the errno the device would give the guest", () => {
  const system = (code: string) => Object.assign(new Error("x"), { code, syscall: "open" });
  assert.equal(FSError.from(system("EMFILE"))?.errno, 24);
  assert.equal(
    FSError.from(system("EUNHEARD"))?.errno,
    5,
    "a host call's failure Linux has no name for",
  );
  assert.equal(FSError.from(new FSError("EBUSY"))?.errno, 16);
  assert.equal(FSError.from(new TypeError("a bug")), undefined, "no filesystem's failure");
  const coded = (code: string) => Object.assign(new Error("x"), { code });
  assert.equal(FSError.from(coded("EIO"))?.errno, 5, "a backend's own error, by its code's name");
  assert.equal(FSError.from(coded("ERR_INVALID_ARG_TYPE")), undefined, "Node's, a bug's");
  assert.equal(new FSError(72).errno, 72);
});

test("virtio-fs passes each request's work through the host's host_work, until its reply is written", async () => {
  const works: Promise<unknown>[] = [];
  let replied = false;
  const harness = new FuseHarness(filesystem(), {}, (work) => {
    works.push(work);
    return work.then((value) => {
      assert.equal(replied, false);
      return value;
    });
  });
  const getattr = () =>
    harness.request(Opcode.GETATTR, ROOT, body(["u32", 0], ["u32", 0], ["u64", 0n]));
  assert.equal((await getattr()).error, 0);
  replied = true;
  assert.equal(works.length, 1);
  replied = false;
  await getattr();
  assert.equal(works.length, 2);
  await harness.close();
});

test("virtio-fs's shutdown waits for a request in flight, then lets the filesystem go", async () => {
  const order: string[] = [];
  const gate = Promise.withResolvers<void>();
  const harness = new FuseHarness(
    filesystem({
      getattr: async () => {
        order.push("getattr");
        await gate.promise;
        order.push("getattr done");
        return directory;
      },
      destroy: () => {
        order.push("destroy");
      },
    }),
  );
  const reply = harness.request(Opcode.GETATTR, ROOT, body(["u32", 0], ["u32", 0], ["u64", 0n]));
  await new Promise((resolve) => setImmediate(resolve));
  const closed = harness.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["getattr"]);
  gate.resolve();
  await closed;
  await reply;
  assert.deepEqual(order, ["getattr", "getattr done", "destroy"]);
});
