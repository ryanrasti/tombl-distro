// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { type FS, type FSAttributes, FSError } from "../src/virtio/fs.ts";
import { body, FuseHarness } from "./fs-fixture.ts";

const Opcode = {
  LOOKUP: 1,
  GETATTR: 3,
  INIT: 26,
} as const;

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
