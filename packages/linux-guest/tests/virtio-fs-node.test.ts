import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  chmod,
  link as hard_link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { FSError } from "@lowland/kernel";
import { NodeFS } from "../src/node.ts";

// Virtio-fs carries Linux ABI flags even when this test runs on another host.
const linux_open = {
  readonly: 0,
  writeonly: 1,
  readwrite: 2,
  create: 0x40,
  exclusive: 0x80,
  truncate: 0x200,
  closeOnExec: 0x80000,
  path: 0x200000,
} as const;

const temporary = await mkdtemp(path.join(tmpdir(), "linux-guest-virtio-fs-"));
const shared = path.join(temporary, "shared");
const outside = path.join(temporary, "outside");
await mkdir(shared);
await mkdir(outside);
after(() => rm(temporary, { recursive: true, force: true }));

test("node virtio-fs adapter reads and writes beneath its root", async () => {
  const filesystem = new NodeFS(shared);
  const created = await filesystem.create!(
    filesystem.root,
    "hello",
    linux_open.readwrite | linux_open.create | linux_open.exclusive,
    { mode: 0o100640, uid: process.getuid!(), gid: process.getgid!() },
  );
  assert.equal(
    await filesystem.write!(created.node, created.handle, 0n, new TextEncoder().encode("hello")),
    5,
  );
  assert.equal(
    new TextDecoder().decode(await filesystem.read!(created.node, created.handle, 0n, 5)),
    "hello",
  );
  await filesystem.release!(created.node, created.handle);
  assert.equal(await readFile(path.join(shared, "hello"), "utf8"), "hello");
  assert.equal((await filesystem.getattr(created.node)).mode & 0o777, 0o640);
});

test("node virtio-fs adapter rejects adversarial path components", async () => {
  const filesystem = new NodeFS(shared);
  for (const name of ["", ".", "..", "../outside", "/absolute", "nul\0byte"]) {
    await assert.rejects(
      async () => filesystem.lookup(filesystem.root, name),
      (error) => error instanceof FSError && [13, 22].includes(error.errno),
      name,
    );
  }
});

test("node virtio-fs adapter exposes a final symlink without following it", async () => {
  await writeFile(path.join(outside, "secret"), "outside");
  await symlink(path.join(outside, "secret"), path.join(shared, "escape"));
  const filesystem = new NodeFS(shared);
  const escaped = await filesystem.lookup(filesystem.root, "escape");
  assert(escaped);
  assert.equal((await filesystem.getattr(escaped)).mode & constants.S_IFMT, constants.S_IFLNK);
  assert.equal(await filesystem.readlink!(escaped), path.join(outside, "secret"));
});

test("node virtio-fs adapter never follows a final symlink for metadata operations", async () => {
  const target = path.join(outside, "metadata-target");
  const link = path.join(shared, "metadata-escape");
  await writeFile(target, "outside", { mode: 0o640 });
  await symlink(target, link);
  const before = await stat(target);
  const filesystem = new NodeFS(shared);
  const escaped = await filesystem.lookup(filesystem.root, "metadata-escape");
  assert(escaped);

  await assert.rejects(
    filesystem.setattr!(escaped, { mode: 0o600 }),
    (error) => error instanceof FSError && error.errno === 95,
  );
  await filesystem.setattr!(escaped, {
    atime: { seconds: 1n },
    mtime: { seconds: 1n },
  });
  await assert.rejects(
    filesystem.access!(escaped, constants.R_OK),
    (error) => error instanceof FSError && error.errno === 40,
  );

  const after = await stat(target);
  assert.equal(after.mode, before.mode);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal((await lstat(link)).mtimeMs, 1000);
});

test("node virtio-fs adapter keeps open files distinct across unlink and recreate", async () => {
  const filesystem = new NodeFS(shared);
  const old = await filesystem.create!(filesystem.root, "recreated", linux_open.readwrite, {
    mode: constants.S_IFREG | 0o600,
    uid: process.getuid!(),
    gid: process.getgid!(),
  });
  await filesystem.write!(old.node, old.handle, 0n, new TextEncoder().encode("old"));
  await filesystem.unlink!(filesystem.root, "recreated");
  const replacement = await filesystem.create!(filesystem.root, "recreated", linux_open.readwrite, {
    mode: constants.S_IFREG | 0o600,
    uid: process.getuid!(),
    gid: process.getgid!(),
  });
  await filesystem.write!(
    replacement.node,
    replacement.handle,
    0n,
    new TextEncoder().encode("new"),
  );

  assert.equal((await filesystem.getattr(old.node, old.handle)).size, 3n);
  assert.equal(
    new TextDecoder().decode(await filesystem.read!(old.node, old.handle, 0n, 3)),
    "old",
  );
  // The unlinked file's node is stale: its handle still works, but no path holds it.
  await assert.rejects(
    filesystem.getattr(old.node),
    (error) => error instanceof FSError && error.errno === 116,
  );
  await assert.rejects(
    filesystem.open!(old.node, linux_open.readonly),
    (error) => error instanceof FSError && error.errno === 116,
  );
  await filesystem.setattr!(old.node, { size: 2n }, old.handle);
  assert.equal(new TextDecoder().decode(await filesystem.read!(old.node, old.handle, 0n, 3)), "ol");
  assert.equal(await readFile(path.join(shared, "recreated"), "utf8"), "new");
  await filesystem.release!(old.node, old.handle);
  await filesystem.release!(replacement.node, replacement.handle);
});

test("node virtio-fs adapter preserves inode generations across replacement rename", async () => {
  const filesystem = new NodeFS(shared);
  const source = await filesystem.create!(filesystem.root, "rename-source", linux_open.readwrite, {
    mode: constants.S_IFREG | 0o600,
    uid: process.getuid!(),
    gid: process.getgid!(),
  });
  const destination = await filesystem.create!(
    filesystem.root,
    "rename-destination",
    linux_open.readwrite,
    {
      mode: constants.S_IFREG | 0o600,
      uid: process.getuid!(),
      gid: process.getgid!(),
    },
  );
  await filesystem.write!(source.node, source.handle, 0n, new TextEncoder().encode("source"));
  await filesystem.release!(source.node, source.handle);
  await filesystem.release!(destination.node, destination.handle);

  await filesystem.rename!(filesystem.root, "rename-source", filesystem.root, "rename-destination");

  assert.equal(await filesystem.lookup(filesystem.root, "rename-destination"), source.node);
  assert.equal((await filesystem.getattr(source.node)).size, 6n);
  await assert.rejects(
    filesystem.getattr(destination.node),
    (error) => error instanceof FSError && error.errno === 116,
  );
});

test("node virtio-fs adapter enforces read-only shares in the backend", async () => {
  const name = "read-only-source";
  await writeFile(path.join(shared, name), "readable");
  const filesystem = new NodeFS(shared, { readOnly: true });
  const node = await filesystem.lookup(filesystem.root, name);
  assert(node);
  const handle = await filesystem.open!(node, linux_open.readonly | linux_open.closeOnExec);
  assert.equal(new TextDecoder().decode(await filesystem.read!(node, handle, 0n, 8)), "readable");

  for (const operation of [
    () => filesystem.open!(node, linux_open.writeonly),
    () => filesystem.open!(node, linux_open.readonly | linux_open.truncate),
    () => filesystem.write!(node, handle, 0n, new Uint8Array([1])),
    () => filesystem.setattr!(node, { mode: 0o600 }),
    () =>
      filesystem.create!(filesystem.root, "read-only-created", linux_open.readwrite, {
        mode: constants.S_IFREG | 0o600,
        uid: process.getuid!(),
        gid: process.getgid!(),
      }),
    () =>
      filesystem.mkdir!(filesystem.root, "read-only-directory", {
        mode: constants.S_IFDIR | 0o700,
        uid: process.getuid!(),
        gid: process.getgid!(),
      }),
    () => filesystem.unlink!(filesystem.root, name),
  ]) {
    await assert.rejects(operation, (error) => error instanceof FSError && error.errno === 30);
  }
  await filesystem.release!(node, handle);
  assert.equal(await readFile(path.join(shared, name), "utf8"), "readable");
});

test("node virtio-fs adapter rejects Linux open modes it cannot implement", async () => {
  const filesystem = new NodeFS(shared);
  const node = await filesystem.lookup(filesystem.root, "hello");
  assert(node);
  await assert.rejects(
    filesystem.open!(node, linux_open.readonly | linux_open.path),
    (error) => error instanceof FSError && error.errno === 95,
  );
});

test("node virtio-fs adapter creates symbolic links", async () => {
  const filesystem = new NodeFS(shared);
  const linked = await filesystem.symlink!(filesystem.root, "hello-link", "hello", {
    mode: constants.S_IFLNK | 0o777,
    uid: process.getuid!(),
    gid: process.getgid!(),
  });
  assert.equal(await filesystem.readlink!(linked), "hello");
});

test("node virtio-fs adapter detects an ancestor replaced by a symlink", async () => {
  await mkdir(path.join(shared, "safe"));
  const filesystem = new NodeFS(shared);
  const safe = await filesystem.lookup(filesystem.root, "safe");
  assert(safe);

  await rename(path.join(shared, "safe"), path.join(shared, "moved"));
  await symlink(outside, path.join(shared, "safe"));
  // The node was the directory; the name now holds a symlink, another file: stale.
  await assert.rejects(
    async () => filesystem.lookup(safe, "secret"),
    (error) => error instanceof FSError && error.errno === 116,
  );
});

// A fresh share per test below: "file" in it, "secret" outside it.
async function fresh() {
  const directory = await mkdtemp(path.join(temporary, "case-"));
  const share = path.join(directory, "share");
  const beyond = path.join(directory, "outside");
  await mkdir(share);
  await mkdir(beyond);
  await writeFile(path.join(beyond, "secret"), "outside\n");
  await writeFile(path.join(share, "file"), "inside\n");
  return { directory, share, beyond };
}

const context = (mode: number) => ({ mode, uid: process.getuid!(), gid: process.getgid!() });

const errno = (code: number) => (error: unknown) => error instanceof FSError && error.errno === code;

async function read_all(filesystem: NodeFS, node: object) {
  const handle = await filesystem.open!(node as never, linux_open.readonly);
  const data = await filesystem.read!(node as never, handle, 0n, 100);
  await filesystem.release!(node as never, handle);
  return new TextDecoder().decode(data);
}

async function node_at(filesystem: NodeFS, ...names: string[]) {
  let node = filesystem.root;
  for (const name of names) {
    const found = await filesystem.lookup(node, name);
    assert(found, name);
    node = found;
  }
  return node;
}

test("node virtio-fs adapter never follows a symlink on the host", async () => {
  const { share, beyond } = await fresh();
  await symlink(path.join(beyond, "secret"), path.join(share, "link"));
  const filesystem = new NodeFS(share);
  const link = await node_at(filesystem, "link");
  await assert.rejects(filesystem.open!(link, linux_open.readonly), errno(40));
  await assert.rejects(filesystem.setattr!(link, { size: 0n }), errno(40));
  assert.equal((await stat(path.join(beyond, "secret"))).size, 8);
});

test("node virtio-fs adapter serves a share that is itself a symlink, as its directory", async () => {
  const { directory, share } = await fresh();
  await symlink(share, path.join(directory, "via-link"));
  const filesystem = new NodeFS(path.join(directory, "via-link"));
  assert.equal(filesystem.rootPath, share);
  assert.equal(await read_all(filesystem, await node_at(filesystem, "file")), "inside\n");
});

test("node virtio-fs adapter keeps a file by any of its names", async () => {
  const { share } = await fresh();
  const filesystem = new NodeFS(share);
  const file = await node_at(filesystem, "file");
  assert.equal(await filesystem.link!(file, filesystem.root, "other"), file, "a link is the same node");
  await filesystem.unlink!(filesystem.root, "file");
  assert.equal(await read_all(filesystem, file), "inside\n");
  // The host renamed it: no name known to hold it, until it's looked up again.
  await rename(path.join(share, "other"), path.join(share, "moved"));
  await assert.rejects(filesystem.getattr(file), errno(116));
  assert.equal(await filesystem.lookup(filesystem.root, "moved"), file);
  assert.equal(await read_all(filesystem, file), "inside\n");
});

test("node virtio-fs adapter follows its own renames of a directory and what's below it", async () => {
  const { share } = await fresh();
  await mkdir(path.join(share, "a", "b"), { recursive: true });
  await writeFile(path.join(share, "a", "b", "f"), "deep\n");
  const filesystem = new NodeFS(share);
  const b = await node_at(filesystem, "a", "b");
  const f = await node_at(filesystem, "a", "b", "f");
  await filesystem.rename!(filesystem.root, "a", filesystem.root, "z", 0);
  assert.equal(await read_all(filesystem, f), "deep\n");
  assert.equal(await filesystem.lookup(b, "f"), f);
});

test("node virtio-fs adapter shows the owner given, and ignores changes of owner", async () => {
  const { share } = await fresh();
  const filesystem = new NodeFS(share, { owner: { uid: 0, gid: 0 } });
  const file = await node_at(filesystem, "file");
  const attributes = await filesystem.getattr(file);
  assert.deepEqual([attributes.uid, attributes.gid], [0, 0]);
  const changed = await filesystem.setattr!(file, { uid: 1234, gid: 1234 });
  assert.deepEqual([changed.uid, changed.gid], [0, 0]);
  assert.equal((await stat(path.join(share, "file"))).uid, process.getuid!());
});

test("node virtio-fs adapter lists entries with their attributes, the host's inode numbers", async () => {
  const { share } = await fresh();
  await mkdir(path.join(share, "d"));
  const filesystem = new NodeFS(share);
  const handle = await filesystem.opendir!(filesystem.root, 0);
  const entries = [...(await filesystem.readdir!(filesystem.root, handle))];
  await filesystem.releasedir!(filesystem.root, handle);
  assert.deepEqual(entries.map((entry) => entry.name).sort(), ["d", "file"]);
  const file = entries.find((entry) => entry.name === "file")!;
  assert.equal(file.attributes?.ino, (await stat(path.join(share, "file"), { bigint: true })).ino);
  assert.equal(file.attributes!.mode & constants.S_IFMT, constants.S_IFREG);
  // A lookup's attributes come with its node, the inode the host's.
  const entry = await filesystem.entry!(filesystem.root, "file");
  assert.equal(entry?.node, file.node);
  assert.equal(entry?.attributes.ino, file.attributes?.ino);
});

test("node virtio-fs adapter makes files with the guest's mode, not the host process's umask", async () => {
  const { share } = await fresh();
  const filesystem = new NodeFS(share);
  const old = process.umask(0o077);
  try {
    await filesystem.mkdir!(filesystem.root, "d", context(constants.S_IFDIR | 0o777));
    const created = await filesystem.create!(
      filesystem.root,
      "f",
      linux_open.writeonly | linux_open.create,
      context(constants.S_IFREG | 0o666),
    );
    await filesystem.release!(created.node, created.handle);
  } finally {
    process.umask(old);
  }
  assert.equal((await stat(path.join(share, "d"))).mode & 0o7777, 0o777);
  assert.equal((await stat(path.join(share, "f"))).mode & 0o7777, 0o666);
});

test("node virtio-fs adapter keeps a setgid parent's setgid on mkdir, as Linux's", async () => {
  const { share } = await fresh();
  await mkdir(path.join(share, "p"));
  await chmod(path.join(share, "p"), 0o2775);
  const filesystem = new NodeFS(share);
  await filesystem.mkdir!(await node_at(filesystem, "p"), "child", context(constants.S_IFDIR | 0o755));
  assert.equal((await stat(path.join(share, "p", "child"))).mode & 0o7777, 0o2755);
});

test("node virtio-fs adapter lists a directory once per readdir, not at opendir", async () => {
  const { share } = await fresh();
  const filesystem = new NodeFS(share);
  const fs_promises = (await import("node:fs")).promises;
  const original = fs_promises.readdir;
  let listed = 0;
  fs_promises.readdir = ((...args: Parameters<typeof original>) => {
    listed += 1;
    return original(...args);
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    const handle = await filesystem.opendir!(filesystem.root, 0);
    await filesystem.readdir!(filesystem.root, handle);
    await filesystem.releasedir!(filesystem.root, handle);
  } finally {
    fs_promises.readdir = original;
    syncBuiltinESMExports();
  }
  assert.equal(listed, 1);
});

test("node virtio-fs adapter's create of a file that's there keeps its mode", async () => {
  const { share } = await fresh();
  await chmod(path.join(share, "file"), 0o600);
  const filesystem = new NodeFS(share);
  const created = await filesystem.create!(
    filesystem.root,
    "file",
    linux_open.writeonly | linux_open.create,
    context(constants.S_IFREG | 0o666),
  );
  await filesystem.release!(created.node, created.handle);
  assert.equal((await stat(path.join(share, "file"))).mode & 0o7777, 0o600);
});

test("node virtio-fs adapter changes an unlinked file through its handle", async () => {
  const { share } = await fresh();
  const filesystem = new NodeFS(share);
  const file = await node_at(filesystem, "file");
  const handle = await filesystem.open!(file, linux_open.readwrite);
  await filesystem.unlink!(filesystem.root, "file");
  assert.equal((await filesystem.setattr!(file, { size: 3n }, handle)).size, 3n);
  assert.equal((await filesystem.setattr!(file, { mode: 0o600 }, handle)).mode & 0o7777, 0o600);
  const timed = await filesystem.setattr!(file, { mtime: { seconds: 1000n } }, handle);
  assert.equal(timed.mtime?.seconds, 1000n);
  // Without the handle, no path holds it.
  await assert.rejects(filesystem.setattr!(file, { size: 1n }), errno(116));
  await filesystem.release!(file, handle);
});

test("node virtio-fs adapter refuses a handle of another node", async () => {
  const { share } = await fresh();
  await writeFile(path.join(share, "other"), "x");
  const filesystem = new NodeFS(share);
  const file = await node_at(filesystem, "file");
  const other = await node_at(filesystem, "other");
  const handle = await filesystem.open!(file, linux_open.readonly);
  await assert.rejects(filesystem.read!(other, handle, 0n, 10), errno(9));
  await assert.rejects(filesystem.getattr(other, handle), errno(9));
  await assert.rejects(filesystem.setattr!(other, { size: 0n }, handle), errno(9));
  await filesystem.release!(file, handle);
});

test("node virtio-fs adapter closes everything at destroy, and caps how much is open", async () => {
  const { share } = await fresh();
  const filesystem = new NodeFS(share, { maxOpen: 2 });
  const file = await node_at(filesystem, "file");
  const handle = await filesystem.open!(file, linux_open.readonly);
  await filesystem.opendir!(filesystem.root, 0);
  await assert.rejects(filesystem.open!(file, linux_open.readonly), errno(24));
  await filesystem.destroy!();
  await assert.rejects(filesystem.read!(file, handle, 0n, 1), errno(9));
  assert.equal(await read_all(filesystem, await node_at(filesystem, "file")), "inside\n");
});

test("node virtio-fs adapter lists a directory as it is now each time", async () => {
  const { share } = await fresh();
  const filesystem = new NodeFS(share);
  const handle = await filesystem.opendir!(filesystem.root, 0);
  const names = async () =>
    [...(await filesystem.readdir!(filesystem.root, handle))].map((entry) => entry.name).sort();
  assert.deepEqual(await names(), ["file"]);
  await writeFile(path.join(share, "new"), "");
  assert.deepEqual(await names(), ["file", "new"]);
  await filesystem.releasedir!(filesystem.root, handle);
});

test("node virtio-fs adapter fsyncs directories, syncs the filesystem, and fallocates", async () => {
  const { share } = await fresh();
  const filesystem = new NodeFS(share);
  const directory = await filesystem.opendir!(filesystem.root, 0);
  await filesystem.fsyncdir!(filesystem.root, directory, false);
  const file = await node_at(filesystem, "file");
  const handle = await filesystem.open!(file, linux_open.readwrite);
  await filesystem.syncfs!();
  await filesystem.fallocate!(file, handle, 0n, 1000n, 0);
  assert.equal((await stat(path.join(share, "file"))).size, 1000);
  await filesystem.fallocate!(file, handle, 0n, 5000n, 1);
  assert.equal((await stat(path.join(share, "file"))).size, 1000);
  await assert.rejects(filesystem.fallocate!(file, handle, 0n, 10n, 2), errno(95));
  await filesystem.release!(file, handle);
});

test("node virtio-fs adapter serves a share at / below its first level", async () => {
  const { share } = await fresh();
  const filesystem = new NodeFS("/");
  const file = await node_at(filesystem, ...share.split(path.sep).filter(Boolean), "file");
  assert.equal(await read_all(filesystem, file), "inside\n");
});

test("node virtio-fs adapter masks setuid and setgid from the guest unless allowed", async () => {
  const { share } = await fresh();
  const filesystem = new NodeFS(share);
  await filesystem.setattr!(await node_at(filesystem, "file"), { mode: 0o6755 });
  assert.equal((await stat(path.join(share, "file"))).mode & 0o7777, 0o755);
  const allowed = new NodeFS(share, { setuid: true });
  await allowed.setattr!(await node_at(allowed, "file"), { mode: 0o2755 });
  assert.equal((await stat(path.join(share, "file"))).mode & 0o7777, 0o2755);
});

test("node virtio-fs adapter's rename of a name onto another of the same file keeps both", async () => {
  const { share } = await fresh();
  const filesystem = new NodeFS(share);
  const file = await node_at(filesystem, "file");
  await filesystem.link!(file, filesystem.root, "twin");
  await filesystem.rename!(filesystem.root, "file", filesystem.root, "twin", 0);
  await filesystem.unlink!(filesystem.root, "twin");
  // Still known by "file": had rename dropped it, this would be stale.
  assert.equal(await read_all(filesystem, file), "inside\n");
});

test("node virtio-fs adapter keeps a file's identity when another of its names becomes a symlink", async () => {
  const { share, beyond } = await fresh();
  await hard_link(path.join(share, "file"), path.join(share, "second"));
  const filesystem = new NodeFS(share);
  const file = await node_at(filesystem, "file");
  await node_at(filesystem, "second");
  await rm(path.join(share, "file"));
  await symlink(path.join(beyond, "secret"), path.join(share, "file"));
  // The node is the file, by "second" still: never the symlink's target.
  assert.equal(await read_all(filesystem, file), "inside\n");
});

test("node virtio-fs adapter opens for exec, ignoring the kernel's own open flags", async () => {
  const { share } = await fresh();
  const filesystem = new NodeFS(share);
  const file = await node_at(filesystem, "file");
  const exec = 0x20; // __FMODE_EXEC
  await filesystem.release!(file, await filesystem.open!(file, linux_open.readonly | exec));
});

test("node virtio-fs adapter refuses a share that isn't there, as it's made", async () => {
  const { directory } = await fresh();
  assert.throws(() => new NodeFS(path.join(directory, "missing")), errno(2));
  assert.throws(() => new NodeFS(path.join(directory, "share", "file")), errno(20));
});

test("node virtio-fs adapter caches long when read-only", async () => {
  const { share } = await fresh();
  assert.equal(new NodeFS(share).timeout, 1);
  assert.equal(new NodeFS(share, { readOnly: true }).timeout, 3600);
  assert.equal(new NodeFS(share, { timeout: 5 }).timeout, 5);
});

test("node virtio-fs adapter closes everything at destroy even once the share is gone", async () => {
  const { directory, share } = await fresh();
  const filesystem = new NodeFS(share);
  const file = await node_at(filesystem, "file");
  const handle = await filesystem.open!(file, linux_open.readonly);
  const listing = await filesystem.opendir!(filesystem.root, 0);
  await rm(directory, { recursive: true, force: true });
  await filesystem.destroy!();
  await assert.rejects(filesystem.read!(file, handle, 0n, 1), errno(9));
  await assert.rejects(filesystem.readdir!(filesystem.root, listing), errno(116));
  await assert.rejects(filesystem.lookup(filesystem.root, "file"), errno(116));
});
