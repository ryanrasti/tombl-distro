# @exobox/kernel-host

exobox's additions to [@lowland/kernel](../kernel), kept apart from it as
the kernel keeps its own in `arch/wasm/exobox/`:

- **`bootJspiMachine`**: a machine on one event loop, for a kernel built with
  `CONFIG_WASM_JSPI` (no SMP). Every task is a coroutine (JSPI) on one shared
  kernel instance; a task blocks by suspending, not in a worker of its own.
  Devices are @lowland/kernel's (virtio, plugins, device tree).
- **The exec cache**: exec asks the host for a file's compiled module first,
  by the kernel's key for the file (device, inode, size, mtime).
- **`hostDevices`**: the console and disks as direct host calls
  (`CONFIG_EXOBOX`), instead of virtio.

What proves generic here is meant to move into @lowland/kernel.
