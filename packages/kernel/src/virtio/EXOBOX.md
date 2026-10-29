# This fork's virtio-fs and NodeFS

This is [ryanrasti/tombl-distro](https://github.com/ryanrasti/tombl-distro)'s
`exobox` branch: tombl/distro's `main` (`189b9c3`) with the changes below.
[exobox](https://github.com/ryanrasti/linux-workers) (linux-workers) serves
host directories and its package store to its machines with this device:
`fileSystemDevice` (`fs.ts`), with `NodeFS`
(`packages/linux-guest/src/node.ts`) for host directories and its own
`PackageStore` (linux-workers' `src/fuse/package-store.ts`) for `/nix/store`,
both implementing `FS`. The changes are meant to be useful to anyone running
this device, and to go back to tombl/distro eventually.

## What changes, and why

Each a commit on `exobox`, in order; the numbers come from linux-workers'
harness (the Appendix has the conditions).

**The device (`packages/kernel/src/virtio/fs.ts`)**

| Commit | What | Why |
|---|---|---|
| `21594e9` | a directory read once per handle, not per `READDIR` | each `READDIR` re-read the whole directory and skipped `off` entries: a 5,000-entry readdir from memory 1031 to 38 ms |
| `7ab98f6` | a directory entry's type from the listing, not a getattr each | 455 to 51 ms for 5,000 entries over NodeFS |
| `a34d5a5` | replies written straight into guest memory (descriptor views, a payload grown as written, a read's data as is) | a reply was copied several times into fresh zeroed arrays the size of the guest's response buffer; reading 32 MiB again 64 to 41 ms (his device), 48 to 24 ms (exobox's server on this transport), measured for the same change on the old virtio layer (`f18c90a`) |
| `f436d91` | a backend error's Linux errno (the whole table; a host error by its name, else on a Linux host by its number) | anything outside 17 errnos became EIO: ESTALE, EXDEV, EBUSY, EMFILE, EFBIG, ... never reached the guest |
| `0de38c7` | requests of 256 pages (`max_write` 1 MiB at 4 KiB pages, a `pageSize` option for others), minors from 27, `ATOMIC_O_TRUNC`, `PARALLEL_DIROPS`, `CACHE_SYMLINKS` | 16 pages was 64 KiB requests at 4 KiB pages: twice the read and write requests |
| `ffdad9d` | a backend's inode numbers (`ino`), lookups with attributes (`entry`), listings with attributes, `timeout`, `keepCache`, `forget` | the device's record ids were the inodes, so a node forgotten and looked up again was a different file (exec caches keyed by inode, `ls -i`); every lookup was also a getattr |
| `d443d51` | `link`, `mknod`, renameat2's flags, `fallocate`, `syncfs`, `fsyncdir` | ENOSYS before: no hard links, `mkfifo`, `mv -n`, `posix_fallocate`, or `sync` reaching the backend |
| `88e8d69` | `READDIRPLUS` | `ls -l` was a `READDIR`, then a `LOOKUP` and a `GETATTR` an entry: 2,957 lookups and 3,455 getattrs for a 2,700-file tree, against 557 requests |
| `5e5f34a` | `FSError.from` (the device's own mapping, for backends), numeric `FSError`s, `FSEntry` exported | for NodeFS, and any backend, to throw what the device would give |
| `19f3f37` | a host counts a request's work (`VirtioConnectionContext.host_work`, any device's), each request through it till its reply is written; a queue's one request at a time documented in `notify` | exobox's host turns its event loop more often while the guest waits on host work: without it, a filesystem request waited for a time slice's turn |
| `4a805ce` | `Imports` a type, not an interface | an interface has no implicit index signature, so a host cast its tables to pass them as `WebAssembly.ModuleImports` |

**The transport (`bus.ts`, `device.ts`, `remote.ts`, `console.ts`)**

| Commit | What | Why |
|---|---|---|
| `89650a3` | a device's `queue_size`, written to its node as `queue-size` (the console 16) | the guest fills a receive queue at probe, a buffer a descriptor: 256 for a console |
| `c9514fe` | a reset's end told by the device's config interrupt, not an atomic notify | a guest running every task on one thread can't wait on the word: the console's probe 44 to 23 ms of boot |

These two pair with the kernel's side, which reads `queue-size` and sleeps
till the config interrupt: ryanrasti/linux
[`936d0026`](https://github.com/ryanrasti/linux/commit/936d0026) (the reset)
and [`9c8ce710`](https://github.com/ryanrasti/linux/commit/9c8ce710) (the
queue size), for `virtio_wasm`. A kernel without `936d0026` still waits on
the word with an atomic wait and needs the notify back.

**NodeFS (`packages/linux-guest/src/node.ts`)**

| Commit | What | Why |
|---|---|---|
| `af7adb6` | `FLUSH` syncs nothing; `fsync` does | `FLUSH` (every `close()`) was an `fdatasync`: creating 500 files 2.4 to 0.35 s |
| `b6f5219` | forgets and renames what's below a name, not every node | every unlink, rename and negative lookup scanned every node: `rm -r` of the tree 1480 to 545 ms |
| `d693f17` | a node is a host file (device and inode) with the paths it's known by, each re-checked at use; virtiofsd's semantics throughout | below |

`d693f17` brings NodeFS to what exobox's own passthrough had (which it now
replaces), as virtiofsd's passthrough (`~/src/virtiofsd`, the reference)
behaves: hard links; the host's inode numbers; a lookup's attributes with
its node, so `LOOKUP` and `READDIRPLUS` need no getattr; `forget`; the
guest's mode on `mkdir` and `create` rather than the host process's umask
too (a setgid parent's bit kept, `O_EXCL` first in create); `setattr`
through an open handle (an unlinked file's `ftruncate`, `fchmod`,
`futimes`); a handle checked against its node; setuid and setgid masked
unless allowed; `mknod` of regular files; `RENAME_NOREPLACE`; `fsyncdir`,
`syncfs`, `fallocate`; `destroy` closing everything and an open-file cap
(`EMFILE`); open flags it needn't act on ignored (an exec's
`__FMODE_EXEC`); a share at `/`; a missing share refused as the adapter is
made; options `timeout`, `owner`, `setuid`, `maxOpen`; `rootPath`. Its
safety model, and what it doesn't guarantee (host processes changing the
share meanwhile; an unlinked file can't be reopened), is in its header.
Its tests are in `packages/linux-guest/tests/virtio-fs-node.test.ts`; the
device's, driven through its request queue with no guest, in
`packages/kernel/test/virtio-fs.test.ts`.

## How exobox uses it

- **The parts:** the guest's kernel runs Linux's own `virtio_fs` driver
  (stock), over this repo's virtio transport (`bus.ts`, `device.ts`, with
  the queue size and reset changes above; the kernel side of the reset is
  ryanrasti/linux's `7a6043bf`, `7fc646b7`). This device is the one FUSE
  server; its filesystems are `NodeFS` for host directories (a mount, or
  the host's `/nix/store`) and linux-workers' `PackageStore` for its
  package store. linux-workers gives a machine one device a tag
  (`fileSystemDevice(fs, { tag })`); stage 1 mounts each with
  `mount -t virtiofs TAG DIR`.
- **One request at a time per queue:** a filesystem sees a queue's
  requests one after another (`notify`'s comment); a slow one holds up its
  filesystem, not the machine. Each is the host's work (`host_work`) until
  its reply is written, so exobox's event loop turns sooner meanwhile.
- **A second mount of a tag** is the first's connection again: `virtio_fs`
  gives it the same superblock, so no two connections serve a filesystem.
- **Around the device, exobox's own** (linux-workers' `src/node/machine.ts`,
  stated precisely in its `docs/internals.md`): no two host directories
  served writable may overlap, refused at boot across every machine in the
  process by real path, so a guest can't race NodeFS's checks through two
  mounts. As a machine ends, each device is shut down (`shutdown`: no more
  requests, the one in progress settled, then every handle released and
  the filesystem's `destroy`).
- **Limits:**
  - Node has no `openat` or `O_PATH`, so NodeFS reaches files by path,
    checked at each use. A host process changing the share at the same
    moment isn't covered, and an unlinked file can't be reopened (its
    header has the model);
  - `RENAME_NOREPLACE` isn't atomic; `syncfs` syncs open files only;
    `fallocate` reserves space as it's written; timestamps are as precise
    as Node's `utimes` (and "now" its milliseconds); a listing `lstat`s
    each entry (Node's `Dirent` has no inode);
  - running as root without `owner`, a guest's `chown` reaches the host's
    owners; setuid and setgid bits are masked unless `setuid` allows them;
    `maxOpen` files at most (EMFILE past it);
  - shared `mmap` of these files is a copy, written back at `msync`,
    `munmap`, `fsync`, exec and exit (exobox's kernel keeps mappings), as
    of every file in its machines.
- **The plan:** virtiofsd's Rust passthrough behind a Node addon on Linux
  hosts: a descriptor per node, which closes the path-race class; NodeFS
  stays the fallback elsewhere.

## What hostfuse was

Until October 29, 2026, exobox served host directories with its own FUSE
transport: `hostfuse`, a kernel driver (`arch/wasm/exobox/hostfuse.c`,
modelled on `virtio_fs.c`, without virtqueues: each request handed to the
host as a list of its pieces in the kernel's memory, the reply written
back into such a list), a host device, and its own FUSE server and
passthrough (`src/fuse/`). It existed because this stack was slow for it
then: the console's virtio reset polled with a timer (44 ms of boot), and
the server cost 2 to 7 times more per operation (no `READDIRPLUS`, a
directory re-read per `READDIR`, an `fdatasync` per `close()`, double
lookups, 64 KiB requests). It went when the reset fix made a virtio device
cost no boot time and this transport with a fast server matched it (the
numbers below); this device and NodeFS then took on what exobox's server
and passthrough did, as the commits above. Its last code is
linux-workers `02e67aa`.

## The current numbers (October 29, 2026)

The tree walk, hostfuse (linux-workers `02e67aa` and its kernel) against
this device with NodeFS on exobox's JSPI host: musl's source, 2,690 files;
a fresh machine a run; 6 runs a transport a round, the first thrown away;
three rounds, the transports interleaved; a quiet laptop (load 0.3 to
0.6). Median [range], ms:

| | round 1: hostfuse / virtio-fs | round 2 | round 3 | virtio-fs ÷ hostfuse |
|---|---|---|---|---|
| `ls -lR` cold | 234 [185–552] / 166 [123–240] | 356 [203–643] / 147 [121–170] | 342 [223–524] / 128 [122–259] | 0.71, 0.41, 0.37 |
| `ls -lR` warm | 224 [173–335] / 186 [150–229] | 204 [170–455] / 125 [120–317] | 311 [230–531] / 144 [126–242] | 0.83, 0.61, 0.46 |
| `du -s` warm | 137 [100–364] / 87 [75–128] | 144 [118–401] / 79 [68–86] | 183 [118–238] / 78 [73–105] | 0.64, 0.55, 0.43 |
| `cat` every `.c` warm | 1747 [666–2787] / 748 [415–2650] | 772 [450–2790] / 1200 [437–2403] | 1403 [529–1921] / 1221 [384–1481] | 0.43, 1.55, 0.87 |

- **Metadata is faster here**, 1.2 to 2.7 times, and steadier:
  `READDIRPLUS` and the commits above.
- **Reading every file is level**: both spread from about 0.4 to 2.8 s
  (the page cache or GC, not the transport), and the median changes sides
  between rounds.
- **Boot** (exobox's `boot-bench`, ready / first command, median of 7):
  hostfuse 12.4 / 1.5 and 11.3 / 1.4 ms, virtio-fs 12.5 / 1.4 and
  13.7 / 1.6 ms: within the noise.
- Absolute numbers drift (hostfuse measured 151 ms for `ls -lR` cold in a
  quiet run earlier that day); the comparison is within each round.

The older measurements below are labelled by date and conditions.

## Appendix: measurements and analysis

From linux-workers' harness (`bench/fs/`, removed from linux-workers in
October 2026 and in its git history; the Oct 29 numbers from
`bench-vfs.ts` on its `spike/virtio-fs-boot` branch). "His device" is this
device with NodeFS before the commits above; "exobox's server" is
linux-workers' own FUSE server of the time, on this transport.

### Conditions (October 21, 2026)

- **The desktop** (a Ryzen 9 7950X, idle, Node 24.21), one process: 6 runs,
  the first thrown away, the median of 5 (and the range). Each run boots a
  machine per transport (exobox's kernel config with `CONFIG_VIRTIO_FS` and
  `CONFIG_VIRTIO_WASM` added, the same kernel for all) serving the same host
  directory at `/mnt/d`. **The laptop**, where marked.
- **In the machine**: a C program times each operation with
  `CLOCK_MONOTONIC`; "cold" drops the kernel's caches first, so every name
  and page goes to the host. The tree's workloads are bash and coreutils on
  musl's source (2,710 files, 249 directories, 14 MB).

### The fixes, together (October 21, 2026, desktop)

On the desktop (virtio before, after `21594e9` through `b6f5219` and
`a34d5a5`'s original, `f18c90a`): readdir 5000 1131 to 25 ms, `ls -lR` 474
to 359, create 500 2247 to 147, `cat` the tree 1299 to 757, copying it in
12,993 to 990, `rm -r` 1578 to 534, reading 32 MiB 88 to 48.

Originally `7ad0c9d`, `7a45e05`, `1099e34`, `7292910` and `f18c90a` on
`packages/distro`'s `refactor/hostdirs`; here `21594e9`, `7ab98f6`,
`af7adb6`, `b6f5219` and `a34d5a5`, the last reworked for the private
virtio layer of tombl's `bb7c6c5` (descriptor views in place of the old
`VirtqueueChain.release(written, data)`).

### Where the time went (October 21, 2026, before the device and NodeFS changes above)

**His server**, against exobox's on this transport:

- no `READDIRPLUS`: `ls -lR` is 2,957 lookups and 3,455 getattrs where
  exobox's server answers 557 `READDIRPLUS` requests (now `88e8d69`);
- a lookup is `NodeFS.lookup` (a `realpath` of the directory and an
  `lstat`) then the device's `getattr` (both again), serialized through its
  path lock: 81 against 57 us (now one `entry`: `ffdad9d`, `d693f17`);
- `max_pages` 16: 1 MiB with 64 KiB pages, 64 KiB with 4 KiB ones (twice
  the read and write requests; now `0de38c7`).

**The transport**, about 5 us more a request than exobox's former
`hostfuse` transport (10 against 15 us a lookup from memory, and 5 to 25%
on the tree's workloads), with the same task switches and idle waits:

- in the host, the packed ring's descriptors read through `@lowland/bytes`
  structs over a new `DataView` of the memory each, a chain and buffer
  objects per request, the readable buffers sliced, the async notify chain
  (promises, a microtask for the interrupt). Profiled (in-memory `stat`,
  1000 lookups): 2.3 ms in the old `core.ts` against 0.9 in `hostfuse.ts`,
  4.4 ms more native time (promises, transitions) and 0.5 ms more GC;
- in the kernel, `virtio_fs` copies a request's arguments into a
  `kmalloc`ed buffer and back, builds a scatterlist and an indirect
  descriptor table, and ends requests from a work item (0.8 ms in the
  virtio functions);
- **FORGETs**: virtio sends each on its high-priority queue and takes a
  completion for it (an interrupt, a work item, a wakeup): after a cold
  `cat` of the tree, 2,959 forgets were about 3,000 idle waits and 6,000
  task switches more than `hostfuse`'s, where a forget was a host call with
  no reply. Unsettled, they land in the next operation (an
  open-read-close of 1000 files measured 225 against 155 ms);
- **request size**: the ring (256 descriptors) caps a request at 252
  pages, so a 1 MiB write is two requests (64 for 32 MiB, against 32).

### Boot, and a small directory (October 29, 2026, on exobox's JSPI host)

One kernel (exobox's, with `CONFIG_VIRTIO`, `CONFIG_VIRTIO_WASM`,
`CONFIG_VIRTIO_FS` and the reset fix `936d0026`), a fresh directory of a
few files at `/mnt/d`; 60 runs a case, the order rotated, median [range] in
ms. Local, under other work's load, so the ranges are wide; the medians
held across three batches. Before the device and NodeFS changes above.

| | boot to ready | to the first command | mount to the first `ls` | a warm `ls -l` |
|---|---|---|---|---|
| no mount | 12.4 [10.8–33.6] | 13.4 | — | — |
| `hostfuse` (mounted in stage 1) | 12.5 [10.9–30.7] | 13.5 | 5.9 [2.0–17.9] | 4.7 [1.4–14.5] |
| virtio-fs: his device and `NodeFS` | 12.3 [10.8–29.0] | 13.4 | 10.2 [5.6–20.7] | 17.4 [5.4–46.1] |
| virtio-fs: this transport, exobox's server | 12.8 [11.2–26.3] | 13.9 | 4.4 [1.9–16.1] | 2.5 [1.5–15.9] |
| the same, a 1024-entry queue | 12.5 [11.0–50.9] | 13.6 | 4.9 [1.9–16.0] | 3.1 [1.4–13.7] |

Probing a virtio-fs device adds nothing measurable to boot with the reset
fix; this transport with exobox's server was on par with `hostfuse`, his
device and `NodeFS` 2 to 7 times slower on everything.

### Still open

- **The transport's host side**: a `DataView` kept per memory rather than
  made per descriptor, and chain and buffer objects per request.
- **FORGETs**: completed without an interrupt (the kernel's `virtio_fs`
  reclaiming its forget buffers lazily, as the next one is sent), or
  batched (the kernel sends `BATCH_FORGET` when it queues several).
- **NodeFS's metadata calls synchronous** (`lstatSync`,
  `realpathSync.native`): 1.3 and 2.1 us against about 9 us each through
  promises, so a lookup from about 35 us of `fs` calls to about 5. It
  blocks the event loop for the call, which for a local directory is less
  than the promise's round trip; a network directory would want them
  asynchronous.
- **Reads straight into the guest's pages**: a backend could `readv` the
  file into the request's writable descriptors (views of guest memory now),
  with no copy on the host at all.
- **A descriptor per node**, virtiofsd's design, which Node can't express:
  it would close NodeFS's documented gaps (host processes changing the
  share meanwhile; reopening an unlinked file).
