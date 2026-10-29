// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { type FS, type FSAttributes, FSError } from "../src/virtio/fs.ts";
import { body, FuseHarness } from "./fs-fixture.ts";

const Opcode = {
  LOOKUP: 1,
  FORGET: 2,
  GETATTR: 3,
  OPEN: 14,
  INIT: 26,
  OPENDIR: 27,
  READDIR: 28,
} as const;

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const getattr_in = () => body(["u32", 0], ["u32", 0], ["u64", 0n]);
const open_in = (flags = 0) => body(["u32", flags], ["u32", 0]);
const read_in = (fh: bigint, offset: bigint, size: number) =>
  body(["u64", fh], ["u64", offset], ["u32", size], ["u32", 0], ["u64", 0n], ["u32", 0], ["u32", 0]);

/** The (name, ino) of each dirent in a READDIR reply. */
function dirents(payload: Uint8Array) {
  const result: [string, bigint][] = [];
  const data = view(payload);
  for (let at = 0; at < payload.byteLength; ) {
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
  const getattr = () => harness.request(Opcode.GETATTR, ROOT, body(["u32", 0], ["u32", 0], ["u64", 0n]));

  thrown = new FSError("ESTALE");
  assert.equal((await getattr()).error, -116);
  // A host error by its code, whatever the host's number for it.
  thrown = Object.assign(new Error("stale"), { code: "EXDEV", errno: -9999 });
  assert.equal((await getattr()).error, -18);
  // A malformed request.
  thrown = new RangeError("out of bounds");
  assert.equal((await getattr()).error, -22);
  // Anything else.
  thrown = new Error("unexpected");
  assert.equal((await getattr()).error, -5);
  if (process.platform === "linux") {
    // On a Linux host, a code Linux doesn't name still has the guest's number.
    thrown = Object.assign(new Error("odd"), { code: "EWHATEVER", errno: -72 });
    assert.equal((await getattr()).error, -72);
  }
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
        name === "f" ? { node: file, attributes: { mode: 0o100644, size: 3n, ino: 77n } } : undefined,
      getattr: (node) => {
        getattrs += 1;
        return node === file ? { mode: 0o100644, size: 3n, ino: 77n } : { ...directory, ino: 5n };
      },
      opendir: () => "dir",
      readdir: () => [{ name: "f", node: file, attributes: { mode: 0o100644, size: 3n, ino: 77n } }],
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
