// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { type FS, type FSAttributes, FSError } from "../src/virtio/fs.ts";
import { body, FuseHarness } from "./fs-fixture.ts";

const Opcode = {
  LOOKUP: 1,
  GETATTR: 3,
} as const;

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
