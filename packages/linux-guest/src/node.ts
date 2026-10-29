// SPDX-License-Identifier: MIT
//
// A host directory served to the guest over virtio-fs, through `node:fs`.
//
// The model, and what it does and doesn't guarantee:
//
// - By path, not by descriptor. virtiofsd holds a descriptor per node
//   (O_PATH) and reaches everything with *at calls relative to one, a name
//   at a time, never following a symlink: a node is always its file and
//   nothing is resolved again. Node has no openat or O_PATH, so here a node
//   is a host file (device and inode) with the paths it has been looked up
//   by, and each use re-checks one: lstat shows the same device and inode,
//   and every directory on the way is a real directory inside the share
//   (#where). Opens add O_NOFOLLOW and fstat what they got; chmod, truncate
//   and utimes never follow a symlink; the root's ".." is the root.
//
// - What that guarantees: nothing the guest names, and no rename, link or
//   symlink the guest makes, gets an operation outside the share, provided
//   no other writer changes the share between a check and the operation it
//   guards. Every operation's checks and its syscalls are serialized
//   (#path_operation), so this adapter's own requests can't be that writer.
//   Two adapters over overlapping host trees can be: give each tree one.
//
// - What it doesn't: a host process changing the share meanwhile (swapping
//   a checked directory for a symlink between the check and the use) can
//   get an operation outside it. A file known only by a path that's gone
//   (unlinked, or moved somewhere never looked up) is ESTALE: its open
//   handles still work, through their descriptors, but it can't be opened
//   again. Both are closed by virtiofsd's design, a descriptor per node,
//   which Node can't express; a native backend could.

import {
  type FS,
  type FSAttributes,
  type FSCreateContext,
  type FSDirectoryEntry,
  type FSEntry,
  FSError,
  type FSSetAttributes,
  type FSStat,
} from "@lowland/kernel";
import { constants, lstatSync, realpathSync, type BigIntStats } from "node:fs";
import {
  access,
  chmod,
  lchown,
  link,
  lstat,
  lutimes,
  mkdir,
  open,
  type FileHandle,
  readdir,
  readlink,
  realpath,
  rename,
  rmdir,
  statfs,
  symlink,
  unlink,
} from "node:fs/promises";
import path from "node:path";

function host_error(error: unknown): never {
  throw FSError.from(error);
}

async function node_call<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    host_error(error);
  }
}

function seconds(nanoseconds: bigint) {
  return {
    seconds: nanoseconds / 1_000_000_000n,
    nanoseconds: Number(nanoseconds % 1_000_000_000n),
  };
}

function checked_offset(value: bigint) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new FSError("EINVAL", "offset exceeds JavaScript's integer range");
  }
  return result;
}

// The guest uses asm-generic Linux open flags. Translate them rather than
// relying on their values happening to match the host's node:fs constants.
const linux_open = {
  access: 0x3,
  readonly: 0,
  writeonly: 0x1,
  readwrite: 0x2,
  create: 0x40,
  exclusive: 0x80,
  noTerminal: 0x100,
  truncate: 0x200,
  append: 0x400,
  nonblocking: 0x800,
  dataSync: 0x1000,
  direct: 0x4000,
  directory: 0x10000,
  noFollow: 0x20000,
  noAtime: 0x40000,
  sync: 0x100000,
  path: 0x200000,
  temporaryFile: 0x400000,
} as const;

const host_constants = constants as unknown as Record<string, number | undefined>;

function translate_open_flags(flags: number) {
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xffff_ffff) {
    throw new FSError("EINVAL", "invalid Linux open flags");
  }

  const access = flags & linux_open.access;
  let result: number;
  if (access === linux_open.readonly) result = constants.O_RDONLY;
  else if (access === linux_open.writeonly) result = constants.O_WRONLY;
  else if (access === linux_open.readwrite) result = constants.O_RDWR;
  else throw new FSError("EINVAL", "invalid Linux open access mode");

  if (flags & (linux_open.path | linux_open.temporaryFile)) {
    throw new FSError("EOPNOTSUPP", "unsupported Linux open mode");
  }
  const map = (linux: number, host: number | undefined, name: string) => {
    if (!(flags & linux)) return;
    if (host === undefined) {
      throw new FSError("EOPNOTSUPP", `${name} is not supported by this host`);
    }
    result |= host;
  };

  map(linux_open.create, constants.O_CREAT, "O_CREAT");
  map(linux_open.exclusive, constants.O_EXCL, "O_EXCL");
  map(linux_open.noTerminal, constants.O_NOCTTY, "O_NOCTTY");
  map(linux_open.truncate, constants.O_TRUNC, "O_TRUNC");
  map(linux_open.append, constants.O_APPEND, "O_APPEND");
  map(linux_open.nonblocking, constants.O_NONBLOCK, "O_NONBLOCK");
  if (flags & linux_open.sync) {
    result |= constants.O_SYNC;
  } else {
    map(linux_open.dataSync, host_constants.O_DSYNC, "O_DSYNC");
  }
  map(linux_open.direct, host_constants.O_DIRECT, "O_DIRECT");
  map(linux_open.directory, constants.O_DIRECTORY, "O_DIRECTORY");
  map(linux_open.noFollow, constants.O_NOFOLLOW, "O_NOFOLLOW");
  map(linux_open.noAtime, host_constants.O_NOATIME, "O_NOATIME");

  // The rest are the guest's own business, not the host open's: O_LARGEFILE
  // and O_CLOEXEC (descriptors never cross to the guest; Node opens its own
  // close-on-exec), and the kernel's internal bits a FUSE open carries, such
  // as __FMODE_EXEC (0x20) for an exec's open.
  return result;
}

function may_write(flags: number) {
  const access = flags & linux_open.access;
  return (
    access === linux_open.writeonly ||
    access === linux_open.readwrite ||
    (flags &
      (linux_open.create | linux_open.truncate | linux_open.append | linux_open.temporaryFile)) !==
      0
  );
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const ENOENT = 2;

// renameat2's flags, and fallocate's.
const RENAME_NOREPLACE = 1 << 0;
const RENAME_EXCHANGE = 1 << 1;
const RENAME_WHITEOUT = 1 << 2;
const FALLOC_FL_KEEP_SIZE = 1;

const key_of = (stats: BigIntStats) => `${stats.dev}:${stats.ino}`;

/**
 * A host file, by device and inode, with the paths it's known by: more than
 * one for a file's hard links.
 */
class Node {
  key = "";
  readonly paths = new Set<string>();
}

class Handle {
  readonly node: Node;
  readonly file: FileHandle | undefined;

  constructor(node: Node, file?: FileHandle) {
    this.node = node;
    this.file = file;
  }
}

export interface NodeFSOptions {
  /** Reject all operations which could modify the shared directory. */
  readOnly?: boolean;
  /**
   * How long the guest may cache names and attributes, in seconds (default
   * one second; an hour when read-only).
   */
  timeout?: number;
  /**
   * Show every file as owned by this user and group, rather than by its owner
   * on the host, and ignore changes of owner (the host user can't make them).
   */
  owner?: { uid: number; gid: number };
  /**
   * Let the guest set a file's setuid and setgid bits. By default they're
   * masked out: host files the guest leaves setuid would be the host user's.
   * A directory's setgid stays, for its group to be inherited. Serving as
   * root on the host without `owner`, lchown gives host files any owner the
   * guest names: give `owner`, or don't serve as root.
   */
  setuid?: boolean;
  /**
   * The most files and directories open at once, each a host descriptor of
   * the whole process's (default 1024): EMFILE past it.
   */
  maxOpen?: number;
}

/**
 * A file just made, its mode set to `want` if the host's umask made it
 * otherwise. A host filesystem that can't chmod (vfat, some network ones:
 * EPERM, ENOTSUP) keeps what it made rather than failing the request.
 */
async function settle(have: bigint | number, want: number, change: (mode: number) => Promise<void>) {
  if ((Number(have) & 0o7777) === (want & 0o7777)) return;
  await change(want & 0o7777).catch((error: { code?: string }) => {
    if (error.code !== "EPERM" && error.code !== "ENOTSUP" && error.code !== "EOPNOTSUPP") {
      throw error;
    }
  });
}

/**
 * A virtio-fs backend rooted at a host `node:fs` directory.
 *
 * Symbolic links are returned without following them; the guest kernel
 * resolves them inside the guest namespace. See the model above for what is
 * and isn't guaranteed: use an application-owned directory, not one another
 * host process restructures concurrently.
 */
export class NodeFS implements FS<Node, Handle> {
  readonly root = new Node();
  readonly readOnly: boolean;
  /** The shared directory's real path: everything served is below it. */
  readonly rootPath: string;
  readonly timeout: number;
  readonly #owner: { uid: number; gid: number } | undefined;
  readonly #setuid: boolean;
  readonly #max_open: number;
  readonly #by_key = new Map<string, Node>();
  // The nodes' paths indexed: each path's nodes, and each directory's known
  // paths below it, so a name removed or moved costs what was below it, not
  // every path known.
  readonly #by_path = new Map<string, Set<Node>>();
  readonly #children = new Map<string, Set<string>>();
  readonly #open = new Set<Handle>();
  #path_tail = Promise.resolve();

  constructor(root: string, options: NodeFSOptions = {}) {
    this.readOnly = options.readOnly ?? false;
    this.timeout = options.timeout ?? (this.readOnly ? 3600 : 1);
    this.#owner = options.owner;
    this.#setuid = options.setuid ?? false;
    this.#max_open = options.maxOpen ?? 1024;
    try {
      // The one path checked otherwise: the share itself, as it really is.
      this.rootPath = realpathSync(path.resolve(root));
      const stats = lstatSync(this.rootPath, { bigint: true });
      if (!stats.isDirectory()) throw new FSError("ENOTDIR", "the shared path is not a directory");
      this.#adopt_root(stats);
    } catch (error) {
      host_error(error);
    }
  }

  #adopt_root(stats: BigIntStats) {
    this.root.key = key_of(stats);
    this.#by_key.set(this.root.key, this.root);
    this.#add_path(this.root, this.rootPath);
  }

  // Keep validation and its later pathname syscalls together relative to
  // every other operation through this adapter (see the model above).
  #path_operation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#path_tail.then(operation, operation);
    this.#path_tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.catch(host_error);
  }

  #writable() {
    if (this.readOnly) throw new FSError("EROFS", "filesystem is read-only");
  }

  /** Room for another open file or directory, else EMFILE. */
  #room() {
    if (this.#open.size >= this.#max_open) throw new FSError("EMFILE");
  }

  #add_path(node: Node, at: string) {
    node.paths.add(at);
    let nodes = this.#by_path.get(at);
    if (!nodes) {
      nodes = new Set();
      this.#by_path.set(at, nodes);
      const directory = path.dirname(at);
      if (directory !== at) {
        let below = this.#children.get(directory);
        if (!below) {
          below = new Set();
          this.#children.set(directory, below);
        }
        below.add(at);
      }
    }
    nodes.add(node);
  }

  #drop_path(node: Node, at: string) {
    node.paths.delete(at);
    const nodes = this.#by_path.get(at);
    if (!nodes) return;
    nodes.delete(node);
    if (nodes.size) return;
    this.#by_path.delete(at);
    const directory = path.dirname(at);
    const below = this.#children.get(directory);
    below?.delete(at);
    if (below && !below.size) this.#children.delete(directory);
  }

  /** A path and the known paths below it, with their nodes. */
  #subtree(at: string) {
    const result: [string, Node[]][] = [];
    const visit = (p: string) => {
      const nodes = this.#by_path.get(p);
      if (nodes) result.push([p, [...nodes]]);
      for (const child of this.#children.get(p) ?? []) visit(child);
    };
    visit(at);
    return result;
  }

  /** A name is gone: from whichever nodes had it, and what was below it. */
  #unname(at: string) {
    for (const [p, nodes] of this.#subtree(at)) {
      for (const node of nodes) this.#drop_path(node, p);
    }
  }

  /** The path's directories are real ones (no symlinks) inside the share. */
  async #inside(at: string) {
    if (at === this.rootPath) return true;
    const directory = path.dirname(at);
    const prefix = this.rootPath === path.sep ? path.sep : `${this.rootPath}${path.sep}`;
    if (directory !== this.rootPath && !directory.startsWith(prefix)) return false;
    return (await realpath(directory).catch(() => "")) === directory;
  }

  /** A path that holds the node's file now (forgetting those that don't), and its stats; else ESTALE. */
  async #where(node: Node): Promise<[string, BigIntStats]> {
    if (!(node instanceof Node)) {
      throw new FSError("EINVAL", "node belongs to another filesystem");
    }
    for (const at of [...node.paths]) {
      const stats = await lstat(at, { bigint: true }).catch(() => null);
      if (stats && key_of(stats) === node.key && (await this.#inside(at))) return [at, stats];
      this.#drop_path(node, at);
    }
    throw new FSError("ESTALE", "the node's file is no longer in the share");
  }

  /** A plain name in a checked directory. */
  #below(directory: string, name: string) {
    if (
      name.length === 0 ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\0") ||
      name.includes(path.sep)
    ) {
      throw new FSError("EINVAL", "invalid path component");
    }
    return path.join(directory, name);
  }

  /** A name in a directory node, its path checked. */
  async #child(parent: Node, name: string) {
    const [at, stats] = await this.#where(parent);
    if (!stats.isDirectory()) throw new FSError("ENOTDIR");
    return this.#below(at, name);
  }

  /** The node for a host file just seen at a path, known by it. */
  #node_for(stats: BigIntStats, at: string) {
    const key = key_of(stats);
    let node = this.#by_key.get(key);
    if (!node) {
      node = new Node();
      node.key = key;
      this.#by_key.set(key, node);
    }
    this.#add_path(node, at);
    return node;
  }

  #attributes(stats: BigIntStats): FSAttributes {
    return {
      ino: stats.ino,
      mode: Number(stats.mode),
      size: stats.size,
      blocks: stats.blocks,
      nlink: Number(stats.nlink),
      uid: this.#owner?.uid ?? Number(stats.uid),
      gid: this.#owner?.gid ?? Number(stats.gid),
      rdev: Number(stats.rdev),
      blockSize: Number(stats.blksize),
      atime: seconds(stats.atimeNs),
      mtime: seconds(stats.mtimeNs),
      ctime: seconds(stats.ctimeNs),
    };
  }

  async #entry(at: string): Promise<FSEntry<Node>> {
    const stats = await lstat(at, { bigint: true });
    return { node: this.#node_for(stats, at), attributes: this.#attributes(stats) };
  }

  /** A mode the guest gives a file: setuid and setgid masked out unless allowed (`setuid`). */
  #mode(mode: number, directory: boolean) {
    const bits = mode & 0o7777;
    return this.#setuid ? bits : bits & (directory ? ~0o4000 : ~0o6000);
  }

  #handle(node: Node, file?: FileHandle) {
    const handle = new Handle(node, file);
    this.#open.add(handle);
    return handle;
  }

  async lookup(parent: Node, name: string) {
    return (await this.entry(parent, name))?.node;
  }

  async entry(parent: Node, name: string) {
    return await this.#path_operation(async () => {
      const at = await this.#child(parent, name);
      try {
        return await this.#entry(at);
      } catch (error) {
        if (FSError.from(error).errno === ENOENT) return undefined;
        throw error;
      }
    });
  }

  forget(node: Node) {
    if (node === this.root) return;
    for (const at of [...node.paths]) this.#drop_path(node, at);
    if (this.#by_key.get(node.key) === node) this.#by_key.delete(node.key);
  }

  async getattr(node: Node, handle?: Handle) {
    if (handle !== undefined) {
      return this.#attributes(await node_call(this.#file(handle, node).stat({ bigint: true })));
    }
    return await this.#path_operation(async () => this.#attributes((await this.#where(node))[1]));
  }

  async readlink(node: Node) {
    return await this.#path_operation(async () => readlink((await this.#where(node))[0]));
  }

  async symlink(parent: Node, name: string, target: string, _context: FSCreateContext) {
    this.#writable();
    return await this.#path_operation(async () => {
      const at = await this.#child(parent, name);
      await symlink(target, at);
      return (await this.#entry(at)).node;
    });
  }

  /**
   * Through the handle, if one is given (ftruncate, fchmod, futimes: the file
   * it's open on, even unlinked since), else through the node's path.
   */
  async #setattr(node: Node, changes: FSSetAttributes, file?: FileHandle) {
    const target = file ? undefined : (await this.#where(node))[0];
    const current = () => (file ? file.stat({ bigint: true }) : lstat(target!, { bigint: true }));
    if (changes.mode !== undefined) {
      const stats = await current();
      if (!file && stats.isSymbolicLink()) {
        throw new FSError("EOPNOTSUPP", "cannot change a symbolic link's mode");
      }
      const mode = this.#mode(changes.mode, stats.isDirectory());
      if (file) await file.chmod(mode);
      else await chmod(target!, mode);
    }
    if ((changes.uid !== undefined || changes.gid !== undefined) && !this.#owner) {
      const stats = await current();
      const uid = changes.uid ?? Number(stats.uid);
      const gid = changes.gid ?? Number(stats.gid);
      if (file) await file.chown(uid, gid);
      else await lchown(target!, uid, gid);
    }
    if (changes.size !== undefined) {
      const size = checked_offset(changes.size);
      if (file) await file.truncate(size);
      else {
        const temporary = await open(target!, constants.O_WRONLY | constants.O_NOFOLLOW);
        try {
          await temporary.truncate(size);
        } finally {
          await temporary.close();
        }
      }
    }
    if (changes.atime !== undefined || changes.mtime !== undefined) {
      // The time not set is kept from its nanoseconds. Node takes times as
      // seconds in a double, so both round to about 0.25 us at today's
      // dates, and "now" is Date.now()'s milliseconds: Node has no
      // UTIME_OMIT or UTIME_NOW.
      const stats = await current();
      const now = Date.now() / 1000;
      const time = (value: FSSetAttributes["atime"], old: bigint) =>
        value === undefined
          ? Number(old) / 1e9
          : value === "now"
            ? now
            : Number(value.seconds) + (value.nanoseconds ?? 0) / 1e9;
      const atime = time(changes.atime, stats.atimeNs);
      const mtime = time(changes.mtime, stats.mtimeNs);
      if (file) await file.utimes(atime, mtime);
      else await lutimes(target!, atime, mtime);
    }
    return this.#attributes(await current());
  }

  async setattr(node: Node, changes: FSSetAttributes, handle?: Handle) {
    this.#writable();
    if (handle !== undefined) {
      const file = this.#file(handle, node);
      return await this.#setattr(node, changes, file).catch(host_error);
    }
    return await this.#path_operation(async () => this.#setattr(node, changes));
  }

  async mknod(parent: Node, name: string, _rdev: number, context: FSCreateContext) {
    // Regular files only: the host user can't make devices, and Node can't
    // make FIFOs or sockets.
    if ((context.mode & S_IFMT) !== S_IFREG) throw new FSError("EPERM");
    const created = await this.create(
      parent,
      name,
      linux_open.writeonly | linux_open.create | linux_open.exclusive,
      context,
    );
    await this.release(created.node, created.handle);
    return created.node;
  }

  async mkdir(parent: Node, name: string, context: FSCreateContext) {
    this.#writable();
    return await this.#path_operation(async () => {
      const at = await this.#child(parent, name);
      // The guest's umask (applied by the device), not the host process's
      // too: set again once made, as virtiofsd runs with umask 0. A setgid
      // parent's setgid, which the host gave it, is kept, as Linux's mkdir.
      const mode = this.#mode(context.mode, true);
      await mkdir(at, { mode });
      const made = await lstat(at, { bigint: true });
      await settle(made.mode, mode | (Number(made.mode) & 0o2000), (m) => chmod(at, m));
      return (await this.#entry(at)).node;
    });
  }

  async unlink(parent: Node, name: string) {
    this.#writable();
    await this.#path_operation(async () => {
      const at = await this.#child(parent, name);
      await unlink(at);
      this.#unname(at);
    });
  }

  async rmdir(parent: Node, name: string) {
    this.#writable();
    await this.#path_operation(async () => {
      const at = await this.#child(parent, name);
      await rmdir(at);
      this.#unname(at);
    });
  }

  async rename(oldParent: Node, oldName: string, newParent: Node, newName: string, flags = 0) {
    this.#writable();
    // An exchange has no Node API, and a whiteout is a device (see mknod).
    if (flags & (RENAME_EXCHANGE | RENAME_WHITEOUT)) throw new FSError("EINVAL");
    await this.#path_operation(async () => {
      const source = await this.#child(oldParent, oldName);
      const destination = await this.#child(newParent, newName);
      if (source === destination) return;
      // Not atomic, as renameat2's is (Node has no RENAME_NOREPLACE): only
      // another writer of the share, a host process, can slip between.
      if (flags & RENAME_NOREPLACE) {
        const exists = await lstat(destination).then(
          () => true,
          () => false,
        );
        if (exists) throw new FSError("EEXIST");
      }
      // Two names of one file: rename does nothing, and both stay.
      const [from, to] = await Promise.all([
        lstat(source, { bigint: true }).catch(() => null),
        lstat(destination, { bigint: true }).catch(() => null),
      ]);
      const same = from && to && key_of(from) === key_of(to);
      await rename(source, destination);
      if (same) return;
      // What was at the destination is gone; what was at the source, and
      // below it, moved (checked again when used, as every path is).
      this.#unname(destination);
      for (const [p, nodes] of this.#subtree(source)) {
        for (const node of nodes) {
          this.#drop_path(node, p);
          this.#add_path(node, destination + p.slice(source.length));
        }
      }
    });
  }

  async link(node: Node, newParent: Node, newName: string) {
    this.#writable();
    return await this.#path_operation(async () => {
      const at = await this.#child(newParent, newName);
      await link((await this.#where(node))[0], at);
      return (await this.#entry(at)).node;
    });
  }

  async open(node: Node, flags: number) {
    if (this.readOnly && may_write(flags)) this.#writable();
    this.#room();
    const host_flags = translate_open_flags(flags & ~linux_open.create) | constants.O_NOFOLLOW;
    return await this.#path_operation(async () => {
      const file = await open((await this.#where(node))[0], host_flags);
      try {
        // The file opened: the node's?
        if (key_of(await file.stat({ bigint: true })) !== node.key) {
          throw new FSError("ESTALE", "the node's file was replaced");
        }
        return this.#handle(node, file);
      } catch (error) {
        await file.close();
        throw error;
      }
    });
  }

  /**
   * A file opened, made if it isn't there, as the guest's umask has it (not
   * the host process's too: set again once made, as virtiofsd runs with
   * umask 0); one there already keeps its mode.
   */
  async #create(at: string, flags: number, mode: number, exclusive: boolean) {
    try {
      const file = await open(at, flags | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
      try {
        await settle((await file.stat({ bigint: true })).mode, mode, (m) => file.chmod(m));
      } catch (error) {
        await file.close();
        throw error;
      }
      return file;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST" || exclusive) throw error;
      // There already: opened, and not made again if a host process removed it meanwhile.
      return await open(at, flags | constants.O_NOFOLLOW);
    }
  }

  async create(parent: Node, name: string, flags: number, context: FSCreateContext) {
    this.#writable();
    this.#room();
    const host_flags = translate_open_flags(flags & ~(linux_open.create | linux_open.exclusive));
    return await this.#path_operation(async () => {
      const at = await this.#child(parent, name);
      const file = await this.#create(
        at,
        host_flags,
        this.#mode(context.mode, false),
        (flags & linux_open.exclusive) !== 0,
      );
      try {
        const { node } = await this.#entry(at);
        return { node, handle: this.#handle(node, file) };
      } catch (error) {
        await file.close();
        throw error;
      }
    });
  }

  /** An open file's descriptor, the handle the node's (as virtiofsd's find_handle(handle, inode)), else EBADF. */
  #file(handle: Handle, node?: Node) {
    if (
      !(handle instanceof Handle) ||
      !handle.file ||
      !this.#open.has(handle) ||
      (node !== undefined && handle.node !== node)
    ) {
      throw new FSError("EBADF");
    }
    return handle.file;
  }

  async read(node: Node, handle: Handle, offset: bigint, length: number) {
    const file = this.#file(handle, node);
    const start = checked_offset(offset);
    // Not zeroed: only what's read is returned.
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await node_call(file.read(buffer, read, length - read, start + read));
      if (!bytesRead) break;
      read += bytesRead;
    }
    return buffer.subarray(0, read);
  }

  async write(node: Node, handle: Handle, offset: bigint, data: Uint8Array) {
    this.#writable();
    const file = this.#file(handle, node);
    const { bytesWritten } = await node_call(
      file.write(data, 0, data.byteLength, checked_offset(offset)),
    );
    return bytesWritten;
  }

  // FLUSH comes with every close() of a descriptor (each dup's too), which
  // doesn't make data durable on Linux either: fsync() does (FSYNC, below).
  // virtiofsd's flush syncs nothing as well.
  async flush(_node: Node, handle: Handle) {
    this.#file(handle);
  }

  async fsync(node: Node, handle: Handle, dataOnly: boolean) {
    const file = this.#file(handle, node);
    await node_call(dataOnly ? file.datasync() : file.sync());
  }

  /** A directory's fsync: the directory opened and synced (a rename or create in it made durable). */
  async fsyncdir(node: Node, _handle: Handle, dataOnly: boolean) {
    const directory = await this.#path_operation(async () =>
      open((await this.#where(node))[0], constants.O_RDONLY | constants.O_DIRECTORY),
    );
    try {
      await node_call(dataOnly ? directory.datasync() : directory.sync());
    } finally {
      await directory.close();
    }
  }

  /**
   * Mode 0 extends the file to `offset + length` if it's shorter. Node has no
   * fallocate(2), so the space is reserved as written, not now, and a full
   * disk shows at the write. KEEP_SIZE: nothing to do then. Other modes
   * (punching holes, ...): EOPNOTSUPP.
   */
  async fallocate(node: Node, handle: Handle, offset: bigint, length: bigint, mode: number) {
    this.#writable();
    const file = this.#file(handle, node);
    if (mode === FALLOC_FL_KEEP_SIZE) return;
    if (mode !== 0) throw new FSError("EOPNOTSUPP");
    const end = checked_offset(offset + length);
    if ((await node_call(file.stat())).size < end) await node_call(file.truncate(end));
  }

  /**
   * Node has no syncfs(2) (nor sync(2)), so every file the guest has open
   * here is synced: what it wrote through them, at least, is durable.
   */
  async syncfs() {
    await Promise.all([...this.#open].map((handle) => handle.file && node_call(handle.file.sync())));
  }

  async release(_node: Node, handle: Handle) {
    const file = this.#file(handle);
    this.#open.delete(handle);
    await node_call(file.close());
  }

  async opendir(node: Node) {
    this.#room();
    return await this.#path_operation(async () => {
      if (!(await this.#where(node))[1].isDirectory()) throw new FSError("ENOTDIR");
      return this.#handle(node);
    });
  }

  /**
   * The directory's entries now, each with its attributes (each lstat'd: a
   * Dirent has no inode, which the guest's listing shows).
   */
  async readdir(node: Node, _handle: Handle): Promise<FSDirectoryEntry<Node>[]> {
    return await this.#path_operation(async () => {
      const [at] = await this.#where(node);
      const names = await readdir(at);
      const entries = await Promise.all(
        names.map(async (name) => {
          const child = this.#below(at, name);
          const stats = await lstat(child, { bigint: true }).catch(() => null);
          // (gone since the listing: left out)
          if (!stats) return undefined;
          return { name, node: this.#node_for(stats, child), attributes: this.#attributes(stats) };
        }),
      );
      return entries.filter((entry) => entry !== undefined);
    });
  }

  async releasedir(_node: Node, handle: Handle) {
    this.#open.delete(handle);
  }

  async access(node: Node, mask: number) {
    await this.#path_operation(async () => {
      const [at, stats] = await this.#where(node);
      if (stats.isSymbolicLink()) throw new FSError("ELOOP");
      await access(at, mask);
    });
  }

  async statfs(_node: Node): Promise<FSStat> {
    const stats = await node_call(statfs(this.rootPath, { bigint: true }));
    return {
      blocks: stats.blocks,
      blocksFree: stats.bfree,
      blocksAvailable: stats.bavail,
      files: stats.files,
      filesFree: stats.ffree,
      blockSize: Number(stats.bsize),
      fragmentSize: Number(stats.bsize),
      nameLength: 255,
    };
  }

  /**
   * The connection's end (the guest's DESTROY, or the device's close): every
   * open file closed and every node forgotten, as virtiofsd's destroy.
   */
  async destroy() {
    const files = [...this.#open].flatMap((handle) => (handle.file ? [handle.file] : []));
    this.#open.clear();
    this.#by_key.clear();
    this.#by_path.clear();
    this.#children.clear();
    this.root.paths.clear();
    this.#adopt_root(await node_call(lstat(this.rootPath, { bigint: true })));
    await Promise.all(files.map((file) => file.close().catch(() => {})));
  }
}
