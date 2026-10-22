# @exobox/kernel-host

exobox's additions to [@lowland/kernel](../kernel), kept apart from it as
the kernel keeps its own in `arch/wasm/exobox/`:

- **`bootJspiMachine`**: a machine on one event loop, for a kernel built with
  `CONFIG_WASM_JSPI` (no SMP). Every task is a coroutine (JSPI) on one shared
  kernel instance; a task blocks by suspending, not in a worker of its own.
  Devices are @lowland/kernel's (virtio, plugins, device tree).
- **Processes**: fork (Asyncify unwinds the program, the host copies its
  memory, both rewind), traps as signals (`on_trap`), and dynamic linking
  (`dynlink.ts`: the host as loader; threads and fork children replay the
  link).
- **The exec cache**: exec asks the host for a file's compiled module first,
  by the kernel's key for the file (device, inode, size, mtime).
- **Exec by reference** (`modules.ts`, `CONFIG_EXOBOX_EXEC_REF`): a file
  naming a module by its content's hash (an `exobox.ref` section) runs the
  module a `ModuleRegistry` resolves, compiled once for every machine, or
  ahead of time (Workers).
- **`hostDevices`**: the console and disks as direct host calls
  (`CONFIG_EXOBOX_CONSOLE`, `CONFIG_EXOBOX_HOSTBLK`), instead of virtio;
  disk requests asynchronous (`blk_submit`, `blk_complete`).
- **`hostFuse`**: host directories (`CONFIG_EXOBOX_HOSTFUSE`): filesystems
  served with FUSE, by tag (`mount -t hostfuse TAG DIR`), each request and
  reply a list of pieces in the kernel's memory, completed by an interrupt.
  The transport only: a `FuseServer` per tag answers the requests.
- **Stand-ins**: a kernel part no extension provides (sockets, host
  directories, console, disks) gets one that says it's absent (`no_sockets`,
  `no_fuse`, `no_console`, `no_disks`), so a kernel links without it.

What proves generic here is meant to move into @lowland/kernel.
