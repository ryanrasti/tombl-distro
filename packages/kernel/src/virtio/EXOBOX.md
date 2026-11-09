# This fork's virtio-fs, NodeFS and virtio-vsock

This is [ryanrasti/tombl-distro](https://github.com/ryanrasti/tombl-distro):
tombl/distro's `main` with the changes below, each a commit.
[exobox](https://github.com/ryanrasti/linux-workers) (linux-workers) serves
host directories and its package store to its machines with this
virtio-fs device (`fs.ts`). `NodeFS` (`packages/linux-guest/src/node.ts`)
serves host directories, and linux-workers' `PackageStore`
(`src/package/store-fs.ts`) serves its package store; both implement `FS`.
Its machines' sockets to the host (TSI) go over this virtio-vsock device
(`vsock.ts`). The changes are meant to be useful to anyone running these
devices, and to go back to tombl/distro eventually.

## The virtio-fs device (`fs.ts`)

- **Replies** go straight into guest memory: descriptor views, a payload
  grown as it's written, and a read's data as it is.
- **Requests** are offered 256 pages, and Linux's driver takes 252 (its
  queue's size less 4): about 1 MiB at 4 KiB pages, with a `pageSize`
  option for other page sizes. Minors from 27 are taken. The device also
  offers `ATOMIC_O_TRUNC`, `PARALLEL_DIROPS`, `CACHE_SYMLINKS` and
  `READDIRPLUS`.
- **Inodes:**
  - A backend gives its inode numbers (`ino`), lookups with attributes
    (`entry`, and `entries` for several names at once), `timeout`,
    `keepCache` and `forget`.
  - A FORGET that comes on the high-priority queue while a request is in
    progress waits until that request is answered.
  - DESTROY ends a session: its handles are released, every node but the
    root is let go of (the guest sends no FORGETs as it unmounts), and the
    filesystem's `destroy` is called.
- **Listings:** a directory's handles share one listing of names. A
  READDIR from the start reads it, the last handle to close drops it, and
  each reply looks up the names it carries.
- **Operations:** `link`, `mknod`, renameat2's flags, `fallocate`,
  `syncfs`, `fsyncdir` and `GETXATTR` (with its size probe).
- **Errors:**
  - The guest gets an errno only for what it can cause: a backend's
    `FSError`, or a host call's error by its code's name (EIO for a name
    Linux hasn't).
  - A malformed request is EINVAL.
  - Anything else is the host's to report, and it fails the machine.
  - `FSError.from` is that mapping, for backends to use.
- **`host_work`:** a host counts each request's work until its reply is
  written. `notify`'s comment says why a filesystem sees one request of a
  queue at a time.
- **`Imports`** is a type rather than an interface, so a host passes its
  tables as `WebAssembly.ModuleImports`.

## The transport (`bus.ts`, `device.ts`, `remote.ts`, `console.ts`)

- **Queue size:** a device sets its own queue size, written to its node as
  `queue-size`. The console's is 16, since the guest fills a receive queue
  at probe, one buffer per descriptor.
- **Reset:** a reset's end is told by the device's config interrupt, so a
  guest running every task on one thread needn't wait on a word.
- **Kicks:** a kick done before it returns frees its queue at once.

These pair with the kernel's side for `virtio_wasm`, which reads
`queue-size` and sleeps until the config interrupt: ryanrasti/linux
[`936d0026`](https://github.com/ryanrasti/linux/commit/936d0026) (the reset)
and [`9c8ce710`](https://github.com/ryanrasti/linux/commit/9c8ce710) (the
queue size).

## NodeFS (`packages/linux-guest/src/node.ts`)

NodeFS follows virtiofsd's passthrough semantics.

- **Identity:** a node is a host file (its device and inode) together with
  the paths it's known by, each path re-checked when it's used. A node whose
  last name is removed leaves the inode-number map, so a new file on a
  reused inode number becomes a new node.
- **Lookups:** hard links and the host's inode numbers. A lookup returns its
  attributes with its node, and a listing's names are looked up together.
  `forget` and renames touch only what's below a name.
- **Modes and owners:**
  - `mkdir` and `create` use the guest's mode, not the host process's umask
    as well. A setgid parent's bit is kept, and `create` tries `O_EXCL`
    first.
  - setuid and setgid are masked unless allowed.
  - Options: `owner`, `setuid`, `timeout`, `maxOpen` (EMFILE past it), and
    `rootPath`.
- **Handles:** `setattr` works through an open handle, and a handle is
  checked against its node.
- **Durability:** `FLUSH` syncs nothing and `fsync` does. `fsyncdir`,
  `syncfs` and `fallocate` are supported, and `destroy` closes everything.

The model it keeps, and what that model doesn't cover, is in NodeFS's
header. Its tests are in `packages/linux-guest/tests/virtio-fs-node.test.ts`.
The device's tests, which drive its queues without a guest, are in
`packages/kernel/test/virtio-fs.test.ts`.

## virtio-vsock (`vsock.ts`)

Stream and SEQPACKET sockets between the guest and the host process,
addressed by port on the host's CID 2.

- **Listening:** the host listens on a port (`listen`). The guest's
  connection is answered once the listener says, and a port no one listens
  on is reset.
- **Connecting:** the host connects to a guest port with `open(port)` (its
  writes wait for the guest's RESPONSE) or `connect`. Each connection gets
  a host port that no live connection holds.
- **Closing:** connections half-close. A close with the host's data still
  unread is read as a reset, and so is a REQUEST on a port pair the host
  still holds (the old connection is reset, as Linux's transport does).
- **Credit:** the host's buffer is 256 KiB, and a guest that sends past it
  is reset. A SEQPACKET message larger than the guest's buffer is refused
  with EMSGSIZE, as Linux's transport does.
- **Receiving:**
  - Packets go into the guest's own buffers: 16 KiB each, queues of 64.
  - The guest's packets are read no further while as many control replies
    wait as its receive queue holds, as vhost's.
  - A malformed buffer is the device's failure, which fails the machine;
    it isn't thrown to the host's caller.

## How exobox uses it

- **The parts:** the guest's kernel runs Linux's own `virtio_fs` and
  `virtio_vsock` drivers over this virtio transport. Linux-workers gives a
  machine one virtio-fs device per tag (`fileSystemDevice(fs, { tag })`),
  and stage 1 mounts each with `mount -t virtiofs TAG DIR`.
- **One request at a time per queue:** a filesystem sees a queue's
  requests one after another, so a slow request holds up its own
  filesystem, not the machine.
- **A second mount of a tag** reuses the first's connection: `virtio_fs`
  gives it the same superblock.
- **Around the device:** linux-workers refuses, at boot, host directories
  served writable that overlap, so a guest can't race NodeFS's checks
  through two mounts. As a machine ends, each device is shut down.
- **Limits:**
  - Node has no `openat` or `O_PATH`, so NodeFS reaches files by path,
    checked at each use. A host process changing the share at the same
    moment isn't covered, and an unlinked file can't be reopened.
  - `RENAME_NOREPLACE` isn't atomic. `syncfs` syncs only open files.
    `fallocate` reserves space only as it's written. Timestamps are as
    precise as Node's `utimes`.
  - Running as root without `owner`, a guest's `chown` reaches the host's
    owners.
  - A shared `mmap` of these files is a copy, written back at `msync`,
    `munmap`, `fsync`, exec and exit.
- **The plan:** virtiofsd's Rust passthrough behind a Node addon on Linux
  hosts, a descriptor per node, which closes the path-race class. NodeFS
  stays the fallback elsewhere.
