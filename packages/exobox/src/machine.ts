// SPDX-License-Identifier: MIT
//
// A machine on one event loop, for a kernel built with CONFIG_WASM_JSPI:
// every task is a coroutine (WebAssembly.promising) on one shared kernel
// instance, and blocks by suspending (kernel.jspi_switch, jspi_idle,
// jspi_yield) instead of in a worker of its own. User code is entered
// through the kernel's own function table (user.entry, user.func), so no
// JavaScript frame sits between a syscall and the task's suspension.
//
// Not yet: signal handlers that suspend (they're called through JS), memory
// shared across more than one CPU.

import { type DeviceTreeNode, generate_devicetree } from "../../kernel/src/devicetree.ts";
import type { Machine } from "../../kernel/src/index.ts";
import { configure_machine, merge_device_tree, run_machine_booted } from "../../kernel/src/plugin-internal.ts";
import type { MachinePluginInput } from "../../kernel/src/plugin.ts";
import { assert } from "../../kernel/src/util.ts";
import { close_virtio_device, virtio_device_description, virtio_imports } from "../../kernel/src/virtio/core.ts";
import { read_wasm_memories } from "../../kernel/src/wasm_binary.ts";
import { type AsyncifyModule, Link, type Program, program as parse_program } from "./dynlink.ts";
import type { ModuleRegistry } from "./modules.ts";
import {
  allocate_shared_memory,
  kernel_imports,
  MachineTerminationReason,
  memory_bytes,
  type UserContext,
} from "../../kernel/src/wasm.ts";

const PAGE_SIZE = 0x10000;
// Leave the final wasm32 page out so the physical-memory size fits in u32.
const KERNEL_MEMORY_MAXIMUM_PAGES = 0xffff;

/** Thrown out of a task's coroutine when it ends (it exited, or the machine did). */
const HALT_TASK = Symbol("halt task");

type Fn = (...args: number[]) => number;

// The JSPI API (not in TypeScript's lib yet).
declare namespace WebAssembly {
  class Suspending {
    constructor(fn: (...args: never[]) => unknown);
  }
  function promising(fn: Function): (...args: unknown[]) => Promise<unknown>;
}
const Wasm = globalThis.WebAssembly as unknown as typeof WebAssembly & typeof globalThis.WebAssembly;

/** Compiled programs and libraries, by the kernel's key for their file (device:inode:size:mtime). */
export type ExecCache = Map<
  string,
  { module: globalThis.WebAssembly.Module; minimum: number; maximum: number; program: Program }
>;

/** A user context (tombl's: a program's module and memory), with its dynamic link, if any. */
interface Context extends UserContext {
  program?: Program;
  /** the process's link (its main thread's): threads replay it */
  link?: Link;
}

/** exec of a dynamically linked program: its libraries, as the kernel sends them (exec_lib) */
interface ExecLibraries {
  main: Program;
  /** loaded, by needed name, in the order found (breadth first) */
  libs: Map<string, Program>;
  queue: { name: string; dirs: string[] }[];
  names: Set<string>;
  /** the place (in queue[0]'s dirs) being tried */
  dir: number;
  /** a library the kernel sent since the last exec_lib */
  received?: Program;
}

/** Kernel imports a machine gets from outside @lowland/kernel (`hostDevices`, ...). */
export interface MachineExtension {
  kernel_imports(machine: ExtensionContext): Record<string, Function>;
}
export interface ExtensionContext {
  readonly memory: globalThis.WebAssembly.Memory;
  /** Raises an interrupt and wakes the CPU if it's idle. */
  raise_irq(irq: number): void;
}

/** Where a machine's time went, filled in as it runs. */
export interface MachineStats {
  tasks: number;
  /** Wasm instances made: the kernel's (one) and programs'. */
  instances: number;
  compile_ms: number;
  user_instance_ms: number;
  /** Copying a parent's memory for a child (clone without CLONE_VM). */
  copy_ms: number;
  /** Kernel and user code, between resuming a task and its suspending. */
  running_ms: number;
  idle_ms: number;
  idle_waits: number;
  /** Idle waits that ended by their timer, not an interrupt. */
  timer_wakeups: number;
  yields: number;
  switches: number;
  /** execs (programs and their libraries) of a module named by reference, which the registry had */
  ref_execs: number;
  /** When the first program was exec'd (the kernel was up), from boot. */
  first_exec_ms?: number;
}
export const machine_stats = (): MachineStats => ({
  tasks: 0,
  instances: 0,
  compile_ms: 0,
  user_instance_ms: 0,
  copy_ms: 0,
  running_ms: 0,
  idle_ms: 0,
  idle_waits: 0,
  timer_wakeups: 0,
  yields: 0,
  switches: 0,
  ref_execs: 0,
});

/** A compiled kernel, to boot any number of machines from. */
export interface KernelImage {
  readonly module: globalThis.WebAssembly.Module;
  /** Its memory's minimum, in wasm pages (its data's extent). */
  readonly memory_pages: number;
}

/** Compiles a kernel built with CONFIG_WASM_JSPI. */
export async function kernelImage(bytes: Uint8Array<ArrayBuffer>): Promise<KernelImage> {
  const memory = read_wasm_memories(bytes).imports[0];
  assert(memory?.module === "env" && memory.name === "memory", "Kernel memory must be imported as env.memory");
  assert(memory.type.shared, "Kernel memory must be shared");
  return { module: await Wasm.compile(bytes), memory_pages: Number(memory.type.minimum) };
}

export interface JspiMachineOptions {
  kernel: KernelImage;
  /** Kernel command-line arguments, appended after `console=hvc0`. */
  args?: readonly string[];
  /** @lowland/kernel's plugins: virtio devices, device-tree fragments. */
  plugins?: readonly MachinePluginInput[];
  /** Kernel imports from outside @lowland/kernel. */
  extensions?: readonly MachineExtension[];
  /** An initial ramdisk (a cpio archive), unpacked as the root filesystem. */
  initcpio?: Uint8Array;
  /** The memory the kernel is told it has, in MiB (default: all of 4 GiB). */
  memory_mib?: number;
  /**
   * Compiled programs to reuse, shared by machines whose disks hold the same
   * files under the same keys (default: this machine's own).
   */
  exec_cache?: ExecCache;
  /**
   * Modules by their content's hash, which a file naming one runs (exec by
   * reference: modules.ts; a kernel with CONFIG_EXOBOX_EXEC_REF), shared
   * by the machines given it. None: a stub fails exec (ENOEXEC).
   */
  modules?: ModuleRegistry;
  stats?: MachineStats;
  /** a trap in a task (which kills its process: debugging) */
  on_trap?: (error: Error, task: string) => void;
}

export interface JspiMachine extends Machine {
  /** Prints every task's state on the console (the kernel's show_state; debugging a hang). */
  debugTasks(): void;
  /** Settles with why the kernel ended the machine (a panic too: init exiting is one). */
  readonly terminated: Promise<MachineTerminationReason>;
}

/** A program unwound for fork: its stack pointer and Asyncify buffer, which its copy rewinds from. */
interface Unwound {
  stack_pointer: number;
  /** the forking thread's thread-local storage (if the program has any) */
  tls_base?: number;
  asyncify_data: number;
  /** a dynamically linked process's: the forking thread's link, which the child replays */
  link?: Link;
}

interface AsyncifyExports {
  __stack_pointer: globalThis.WebAssembly.Global;
  __tls_base?: globalThis.WebAssembly.Global;
  /** libc's buffer for the saved stack: Asyncify's header (next, end), then its start */
  __wasm_fork_buffer(): number;
  asyncify_start_unwind(data: number): void;
  asyncify_stop_unwind(): void;
  asyncify_start_rewind(data: number): void;
  asyncify_stop_rewind(): void;
}

interface Task {
  name: string;
  fn: number;
  arg: number;
  /** its task_struct */
  ptr?: number;
  started: boolean;
  wake?: () => void;
  /** why the kernel is about to trap out of its coroutine: it exited, or it execs (user_restart) */
  leaving?: "exit" | "exec";
  user: TaskUser;
}

/** A task's user side: its program, and the user imports acting for it. */
interface TaskUser {
  readonly context: UserContext | null;
  /** For a fork child: where the parent's program unwound (its stack pointer, Asyncify buffer). */
  readonly unwound: Unwound | null;
  prepare(): void;
  /** Frees its program's kernel-table slots, and its thread's link (it exited). */
  release(): void;
  imports: Record<string, Function>;
}

/** Boots a machine on this event loop; resolves once the kernel is running. */
export async function bootJspiMachine(options: JspiMachineOptions): Promise<JspiMachine> {
  const stats = options.stats ?? machine_stats();
  const exec_cache: ExecCache = options.exec_cache ?? new Map();
  const vmlinux = options.kernel.module;
  const started = performance.now();

  const custom_section = (name: string) => {
    const sections = Wasm.Module.customSections(vmlinux, name);
    assert(sections.length === 1, `Missing custom section: ${name}`);
    return sections[0]!;
  };
  const sections = JSON.parse(new TextDecoder().decode(custom_section(".linux.sections")));
  const initramfs = new Uint8Array(custom_section(".linux.initramfs"));

  const configured = await configure_machine(options.args ?? [], options.plugins ?? []);
  const { devices, plugins } = configured;

  // (the initramfs right after the kernel's data, as @lowland/kernel puts it)
  const initcpio = options.initcpio;
  const initcpio_address = options.kernel.memory_pages * PAGE_SIZE;
  const initcpio_pages = initcpio ? Math.ceil(initcpio.byteLength / PAGE_SIZE) : 0;
  const { memory, maximum_pages } = allocate_shared_memory(
    options.kernel.memory_pages + initcpio_pages,
    KERNEL_MEMORY_MAXIMUM_PAGES,
  );
  if (initcpio) new Uint8Array(memory.buffer).set(initcpio, initcpio_address);
  const memory_pages = options.memory_mib
    ? Math.min(maximum_pages, (options.memory_mib * 1024 * 1024) / PAGE_SIZE)
    : maximum_pages;
  const devicetree: DeviceTreeNode = {
    "#address-cells": 1,
    "#size-cells": 1,
    chosen: {
      "rng-seed": crypto.getRandomValues(new Uint8Array(64)),
      bootargs: `console=hvc0 ${configured.args.join(" ")}`,
      ncpus: 1,
      sections,
    },
    aliases: {},
    memory: { device_type: "memory", reg: [0, memory_pages * PAGE_SIZE] },
    "reserved-memory": { "#address-cells": 1, "#size-cells": 1, ranges: undefined },
  };
  for (const [i, dev] of devices.entries()) {
    const device = virtio_device_description(dev);
    devicetree[`virtio${i}`] = {
      compatible: "virtio,wasm",
      "host-id": i,
      "virtio-device-id": device.device_id,
      features: device.features,
      config: device.config,
    };
  }
  if (initcpio) {
    const chosen = devicetree.chosen as DeviceTreeNode;
    chosen["linux,initrd-start"] = initcpio_address;
    chosen["linux,initrd-end"] = initcpio_address + initcpio.byteLength;
  }
  merge_device_tree(devicetree, configured.deviceTree);
  const generated_devicetree = generate_devicetree(devicetree, {
    memory_reservations: initcpio ? [{ address: initcpio_address, size: initcpio.byteLength }] : [],
  });

  // --- the machine's end ---
  const terminated = Promise.withResolvers<MachineTerminationReason>();
  const closed = Promise.withResolvers<void>();
  void closed.promise.catch(() => {});
  void terminated.promise.catch(() => {});
  // (closed or ended: its tasks end at their next switch, yield or idle)
  let finished = false;
  const finish = (error?: unknown) => {
    if (finished) return;
    finished = true;
    idle_waiter?.();
    if (error !== undefined) terminated.reject(error);
    void Promise.allSettled(devices.map((device) => close_virtio_device(device))).then(() => {
      boot_console_close();
      if (error !== undefined) closed.reject(error);
      else closed.resolve();
    });
  };

  const boot_console = new TransformStream<Uint8Array, Uint8Array>();
  const boot_console_writer = boot_console.writable.getWriter();
  const boot_console_close = () => void boot_console_writer.close().catch(() => {});

  // --- the CPU: which task runs, and the idle wait ---
  const tasks_by_ptr = new Map<number, Task>();
  /** The task running now: the shared instance's imports act for it. */
  let current: Task | null = null;
  let instance: globalThis.WebAssembly.Instance;
  let idle_waiter: (() => void) | null = null;
  let irq_raised = false;
  /** run_on_main's callbacks, run only once the CPU is idle or yielding. */
  const main_queue: [number, number][] = [];

  let running_since = 0;
  const stop_running = () => {
    if (running_since) stats.running_ms += performance.now() - running_since;
    running_since = 0;
  };
  const start_running = () => {
    running_since = performance.now();
  };

  const kernel_exports = () => instance.exports as Record<string, Fn> & { __indirect_function_table: globalThis.WebAssembly.Table };
  const raise_irq = (irq: number) => {
    irq_raised = true;
    kernel_exports().trigger_irq!(irq);
    idle_waiter?.();
  };

  // A task suspended in __switch_to still holds the runqueue lock, which
  // these callbacks may take: run them only from a task that is idle or
  // spinning (jspi_idle, jspi_yield).
  function drain_main_queue() {
    const table = kernel_exports().__indirect_function_table;
    while (main_queue.length) {
      const [fn, arg] = main_queue.shift()!;
      (table.get(fn) as Fn)(arg);
    }
  }

  function resume(task: Task) {
    if (!task.started) {
      task.started = true;
      queueMicrotask(() => start(task));
      return;
    }
    const wake = task.wake;
    assert(wake, `resume: ${task.name} is not suspended`);
    task.wake = undefined;
    wake();
  }

  function start(task: Task) {
    current = task;
    task.user.prepare();
    run(task, kernel_exports().__indirect_function_table.get(task.fn) as Fn, task.arg);
  }

  /** Runs fn(arg) as the task, on a coroutine of its own. */
  function run(task: Task, fn: Fn, ...args: number[]) {
    start_running();
    Wasm.promising(fn)(...args).then(
      () => {},
      (error) => {
        if (error === HALT_TASK) return;
        // The kernel left the coroutine by a trap, which no cleanup in a
        // program's frames can catch: the task exited, or execs (its new
        // program runs from user_restart).
        const leaving = task.leaving;
        task.leaving = undefined;
        if (leaving === "exit") return;
        if (leaving === "exec" && !finished) {
          current = task;
          task.wake = undefined;
          run(task, kernel_exports().user_restart!);
          return;
        }
        // A trap (in the program, or a bug in the kernel), or the engine's
        // stack overflowing, unwound the task's frames: the kernel ends the
        // process by the signal Linux would, as the task
        // (arch/wasm/exobox/fault.c), or panics if it was its own.
        if (is_trap(error) && fn !== kernel_exports().user_fault && !finished) {
          stop_running();
          options.on_trap?.(error, task.name);
          current = task;
          task.wake = undefined;
          run(task, kernel_exports().user_fault!, trap_signal(error));
          return;
        }
        finish(error);
      },
    );
  }

  function spawn(fn: number, arg: number, name: string, parent_context: UserContext | null, copy: boolean): number {
    const parent = parent_context as Context | null;
    let context = parent;
    if (copy && parent) {
      // One thread: nothing else runs meanwhile, so the copy is coherent.
      const t = performance.now();
      const source = memory_bytes(parent.memory, 0);
      if (!source) return -14; // bad address
      let copied: ReturnType<typeof allocate_shared_memory>;
      try {
        copied = allocate_shared_memory(source.byteLength / PAGE_SIZE, parent.maximum_pages);
      } catch {
        return -12; // out of memory
      }
      memory_bytes(copied.memory, 0, source.byteLength)!.set(source);
      context = { module: parent.module, program: parent.program, ...copied };
      stats.copy_ms += performance.now() - t;
    }
    const task: Task = { name, fn, arg, started: false, user: undefined as never };
    task.user = user_imports(task, context, copy ? (current?.user.unwound ?? null) : null);
    stats.tasks++;
    // The first task (setup.c's "boot") runs now; the others' bootstrap args
    // start with their task_struct, which __switch_to names them by.
    if (name === "boot") resume(task);
    else {
      task.ptr = new DataView(memory.buffer).getUint32(arg >>> 0, true);
      tasks_by_ptr.set(task.ptr, task);
    }
    return 0;
  }

  // --- kernel imports ---
  const unavailable = () => {
    throw new Error("not available in a JSPI machine");
  };
  const base = kernel_imports({
    is_worker: true,
    memory,
    spawn_worker: spawn,
    boot_console_write: (message) => void boot_console_writer.write(new Uint8Array(message)).catch(() => {}),
    boot_console_close,
    terminate_machine: unavailable,
    run_on_main: (fn, arg) => void main_queue.push([fn, arg]),
    get_user_context: () => current?.user.context ?? null,
    worker_exit: unavailable,
  });
  const extension_context: ExtensionContext = { memory, raise_irq };
  const kernel = {
    ...base,
    // (a kernel with host sockets, directories, a console or disks, but
    // none given: inet loopback only, no hostfuse mounts, a console
    // nobody reads, no disks; an extension replaces these)
    ...no_sockets,
    ...no_fuse,
    ...no_console,
    ...no_disks,
    ...Object.assign({}, ...(options.extensions ?? []).map((e) => e.kernel_imports(extension_context))),
    halt_worker() {
      throw HALT_TASK;
    },
    terminate_machine(reason: MachineTerminationReason) {
      stop_running();
      terminated.resolve(reason);
      finish();
      throw HALT_TASK;
    },
    jspi_switch: new Wasm.Suspending((from: number, to: number) => {
      if (finished) throw HALT_TASK;
      const task = current;
      assert(task, "jspi_switch with no task");
      if (task.ptr === undefined) {
        task.ptr = from;
        tasks_by_ptr.set(from, task);
      }
      const next = tasks_by_ptr.get(to);
      assert(next, `jspi_switch: no task ${to.toString(16)}`);
      stop_running();
      stats.switches++;
      return new Promise<void>((resolve) => {
        task.wake = () => {
          current = task;
          resolve();
          queueMicrotask(start_running);
        };
        resume(next);
      });
    }),
    // A task that spins (cpu_relax) lets the event loop turn: what it waits
    // for may be a host completion.
    jspi_yield: new Wasm.Suspending(() => {
      if (finished) throw HALT_TASK;
      stop_running();
      const task = current;
      irq_raised = false;
      drain_main_queue();
      stats.yields++;
      // The callbacks completed something: take its interrupt now.
      if (irq_raised) return undefined;
      return new Promise<void>((resolve) =>
        next_turn(() => {
          current = task;
          resolve();
          queueMicrotask(start_running);
        }),
      );
    }),
    // A task that ended: on to the next; the kernel traps out of its coroutine.
    jspi_exit(to: number) {
      stop_running();
      const next = tasks_by_ptr.get(to);
      assert(next, `jspi_exit: no task ${to.toString(16)}`);
      const task = current;
      assert(task, "jspi_exit with no task");
      if (task.ptr !== undefined) tasks_by_ptr.delete(task.ptr);
      task.user.release();
      task.leaving = "exit";
      resume(next);
    },
    // exec: the kernel traps out of the old program, then the task runs user_restart.
    jspi_restart() {
      stop_running();
      assert(current, "jspi_restart with no task");
      current.leaving = "exec";
    },
    // The idle task: wait for an interrupt, or the next timer.
    jspi_idle: new Wasm.Suspending((word: number, timeout: bigint) => {
      if (finished) throw HALT_TASK;
      stop_running();
      drain_main_queue();
      const pending = new Int32Array(memory.buffer, word >>> 0, 2);
      if (Atomics.load(pending, 0) || Atomics.load(pending, 1)) return 0;
      const task = current;
      const since = performance.now();
      stats.idle_waits++;
      return new Promise<number>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const wake = (result: number) => {
          clearTimeout(timer);
          idle_waiter = null;
          stats.idle_ms += performance.now() - since;
          current = task;
          resolve(result);
          queueMicrotask(start_running);
        };
        idle_waiter = () => wake(0);
        if (timeout >= 0n)
          timer = setTimeout(() => {
            stats.timer_wakeups++;
            wake(2);
          }, Number(timeout) / 1e6);
      });
    }),
  };

  // --- user imports: the current task's ---
  function user_imports(_task: Task, parent: Context | null, inherited: Unwound | null): TaskUser {
    let context = parent;
    /** a dynamically linked program's: this thread's link */
    let link: Link | null = null;
    let exec_libs: ExecLibraries | null = null;
    /** this program's Asyncify buffer (0: it can't fork) */
    let asyncify_data = inherited?.asyncify_data ?? 0;
    let unwound: Unwound | null = null;
    const asyncify = () => program!.exports as unknown as AsyncifyExports;
    let pending: Context | null = null;
    let pending_bytes: Uint8Array<ArrayBuffer> | null = null;
    let pending_key: string | null = null;
    let program: globalThis.WebAssembly.Instance | null = null;
    /** Kernel-table slots this task's program functions are in, by program table index. */
    const slots = new Map<number, number>();
    const own_slots: number[] = [];
    let entry_slot = 0;

    const program_table = () => program!.exports.__indirect_function_table as globalThis.WebAssembly.Table;
    const slot_for = (f: unknown) => {
      const table = kernel_exports().__indirect_function_table;
      const slot = free_slots.pop() ?? table.grow(1);
      table.set(slot, f);
      own_slots.push(slot);
      return slot;
    };
    const release_slots = () => {
      const table = kernel_exports().__indirect_function_table;
      for (const slot of own_slots) table.set(slot, null);
      free_slots.push(...own_slots);
      own_slots.length = 0;
      slots.clear();
    };
    const copy = (to: globalThis.WebAssembly.Memory, a: number, from: globalThis.WebAssembly.Memory, b: number, n: number) => {
      const destination = memory_bytes(to, a, n);
      const source = memory_bytes(from, b, n);
      if (!destination || !source) return n;
      destination.set(source);
      return 0;
    };
    const user_word = (uaddr: number) => {
      const bytes = context && (uaddr & 3) === 0 ? memory_bytes(context.memory, uaddr >>> 0, 4) : null;
      return bytes ? new Int32Array(bytes.buffer, bytes.byteOffset, 1) : null;
    };
    const set_kernel_u32 = (address: number, value: number) =>
      new DataView(memory.buffer).setUint32(address >>> 0, value, true);

    function instantiate() {
      const k = kernel_exports();
      const t = performance.now();
      // The kernel's exports themselves, not JS wrappers: no JS frame on the syscall path.
      const linux = { syscall: k.syscall!, get_thread_area: k.get_thread_area!, copy_siginfo: k.copy_siginfo! };
      link?.release();
      link = null;
      if (context!.program?.dylink) {
        // dynamically linked: the process's link (exec), a replay of its
        // main thread's (a thread), or of the forking thread's (fork)
        if (inherited?.link) link = inherited.link.fork(context!.memory, linux);
        else if (context!.link) link = context!.link.thread(linux);
        else link = link_exec(context!, linux);
        context!.link ??= link;
        program = link.instance;
        stats.user_instance_ms += performance.now() - t;
        stats.instances++;
        inherited = null;
        release_slots();
        entry_slot = slot_for(program.exports._start);
        return;
      }
      program = new Wasm.Instance(context!.module, {
        env: { memory: context!.memory },
        linux,
      });
      stats.user_instance_ms += performance.now() - t;
      stats.instances++;
      const exports = program.exports as Partial<AsyncifyExports>;
      const can_fork =
        typeof exports.asyncify_start_unwind === "function" &&
        typeof exports.__wasm_fork_buffer === "function" &&
        exports.__stack_pointer instanceof Wasm.Global;
      if (inherited) {
        // a fork child: the parent's memory, and its stack pointer as it unwound
        asyncify().__stack_pointer.value = inherited.stack_pointer;
        if (inherited.tls_base !== undefined && exports.__tls_base instanceof Wasm.Global)
          exports.__tls_base.value = inherited.tls_base;
        inherited = null;
      } else asyncify_data = can_fork ? asyncify().__wasm_fork_buffer() >>> 0 : 0;
      release_slots();
      entry_slot = slot_for(program.exports._start);
    }

    function compiled(entry: { module: globalThis.WebAssembly.Module; program: Program }, minimum: number, maximum: number): number {
      // (a library exec_lib asked for: no memory of its own)
      if (exec_libs) {
        exec_libs.received = entry.program;
        return 0;
      }
      try {
        pending = { module: entry.module, program: entry.program, ...allocate_shared_memory(minimum, maximum) };
        return 0;
      } catch {
        return -12; // out of memory
      }
    }

    /** exec's link: the program and its libraries, which exec_lib collected */
    function link_exec(context: Context, linux: Record<string, Fn>): Link {
      const state = exec_libs;
      exec_libs = null;
      // breadth first is the search order; loaded the other way, dependencies first
      const found = state ? [...state.libs.values()] : [];
      return new Link({
        memory: context.memory,
        linux,
        main: context.program!,
        libs: [...found].reverse(),
        search: found,
        onError: (...args) => console.error(...args),
        resolve: options.modules?.resolveStub,
      });
    }

    /** queue the libraries p needs that aren't loaded or queued already */
    function needs(state: ExecLibraries, p: Program) {
      for (const name of p.dylink?.needed ?? []) {
        if (state.names.has(name)) continue;
        state.names.add(name);
        const runpath = (p.dylink?.runpath ?? []).flatMap((r) => r.split(":")).filter((d) => d && !d.includes("$"));
        state.queue.push({ name, dirs: [...runpath, "/lib", "/usr/lib"] });
      }
    }

    /** the modules fork unwinds and rewinds together (Asyncify's) */
    function fork_modules(): AsyncifyModule[] {
      if (link) return link.asyncify;
      return asyncify_data
        ? [{ exports: program!.exports as unknown as AsyncifyModule["exports"], data: asyncify_data }]
        : [];
    }

    return {
      get context() {
        return context;
      },
      get unwound() {
        return unwound;
      },
      prepare() {
        if (context) instantiate();
      },
      release() {
        release_slots();
        link?.release();
      },
      imports: {
        compile_cached(key: number, length: number, maximum_pages: number) {
          stats.first_exec_ms ??= performance.now() - started;
          pending_key = new TextDecoder().decode(new Uint8Array(memory.buffer, key >>> 0, length >>> 0).slice());
          const hit = exec_cache.get(pending_key);
          if (!hit) return 1;
          pending_key = null;
          return compiled(hit, hit.minimum, Math.min(hit.maximum, maximum_pages >>> 0));
        },
        // a module named by reference (arch/wasm/exobox/exec.c: an exobox.ref section)
        exec_ref(ref: number, length: number, maximum_pages: number) {
          stats.first_exec_ms ??= performance.now() - started;
          if (!options.modules) return 1;
          let hit: ReturnType<ModuleRegistry["getRef"]>;
          try {
            hit = options.modules.getRef(new Uint8Array(memory.buffer, ref >>> 0, length >>> 0).slice());
          } catch (error) {
            console.error("exec:", error);
            return -8; // exec format error
          }
          if (!hit) return 1;
          stats.ref_execs++;
          // (a copy: the program's name is a library's own, as needed)
          return compiled({ module: hit.module, program: { ...hit.program } }, hit.minimum, Math.min(hit.maximum, maximum_pages >>> 0));
        },
        compile_begin(size: number) {
          stats.first_exec_ms ??= performance.now() - started;
          // (a library of the program's: the program stays pending)
          if (!exec_libs) pending = null;
          try {
            pending_bytes = new Uint8Array(size >>> 0);
            return 0;
          } catch {
            return -12; // out of memory
          }
        },
        compile_write(buf: number, offset: number, size: number) {
          if (!pending_bytes) return -22; // invalid argument
          pending_bytes.set(new Uint8Array(memory.buffer, buf >>> 0, size >>> 0), offset >>> 0);
          return 0;
        },
        compile_end(maximum_pages: number) {
          const bytes = pending_bytes;
          pending_bytes = null;
          if (!bytes) return -22; // invalid argument
          let entry: { module: globalThis.WebAssembly.Module; program: Program };
          let minimum: number;
          let maximum: number;
          try {
            const memory_import = read_wasm_memories(bytes).imports[0];
            if (!memory_import || memory_import.type.maximum === undefined) return -8; // exec format error
            const t = performance.now();
            const module = new Wasm.Module(bytes);
            stats.compile_ms += performance.now() - t;
            entry = { module, program: parse_program(bytes, module) };
            minimum = Number(memory_import.type.minimum);
            maximum = Number(memory_import.type.maximum);
          } catch {
            return -8; // exec format error
          }
          if (pending_key) exec_cache.set(pending_key, { ...entry, minimum, maximum });
          pending_key = null;
          return compiled(entry, minimum, Math.min(maximum, maximum_pages >>> 0));
        },
        compile_abort() {
          pending = null;
          pending_bytes = null;
          pending_key = null;
          exec_libs = null;
        },
        // exec, after the program: the next library to send (arch/wasm/exobox/exec.c)
        exec_lib(buf: number, size: number, err: number) {
          let state = exec_libs;
          if (!state) {
            const main = pending?.program;
            if (!main?.dylink?.needed.length) return 0;
            state = { main, libs: new Map(), queue: [], names: new Set(), dir: 0 };
            exec_libs = state;
            needs(state, main);
          } else if (state.received) {
            const lib = state.received;
            state.received = undefined;
            const next = state.queue.shift()!;
            lib.name ??= next.name.split("/").pop();
            state.libs.set(next.name, lib);
            state.dir = 0;
            needs(state, lib);
          } else if (state.queue.length) {
            state.dir++; // (that one couldn't be opened: err)
          }
          const next = state.queue[0];
          if (!next) return 0;
          const dirs = next.name.includes("/") ? [""] : next.dirs;
          if (state.dir >= dirs.length) {
            console.error(`exec: can't find shared library ${next.name} (in ${dirs.join(", ")})`);
            return err || -2; // ENOENT
          }
          const path = new TextEncoder().encode(`${dirs[state.dir] ? `${dirs[state.dir]}/` : ""}${next.name}\0`);
          if (path.length > size >>> 0) return -36; // ENAMETOOLONG
          new Uint8Array(memory.buffer).set(path, buf >>> 0);
          return 1;
        },
        instantiate(fresh_memory: number) {
          if (fresh_memory) {
            context = pending;
            pending = null;
          }
          instantiate();
        },
        entry: () => entry_slot,
        // fork (arch/wasm/exobox/fork.c): the program's stack, saved into its memory and back
        can_fork: () => (fork_modules().length ? 1 : 0),
        start_unwind() {
          // (every module together: the stack may run through any of them)
          for (const m of fork_modules()) {
            const header = new DataView(context!.memory.buffer, m.data, 12);
            // (libc's static buffer: Asyncify's next and end, then the start;
            // the loader's: the saved frames right after the header)
            header.setUint32(0, link ? m.data + 8 : header.getUint32(8, true), true);
            m.exports.asyncify_start_unwind(m.data);
          }
        },
        stop_unwind() {
          for (const m of fork_modules()) m.exports.asyncify_stop_unwind();
          if (link) {
            unwound = { stack_pointer: 0, asyncify_data: 0, link };
            return;
          }
          const { __stack_pointer, __tls_base } = asyncify();
          unwound = {
            stack_pointer: __stack_pointer.value,
            tls_base: __tls_base instanceof Wasm.Global ? __tls_base.value : undefined,
            asyncify_data,
          };
        },
        start_rewind() {
          unwound = null;
          for (const m of fork_modules()) m.exports.asyncify_start_rewind(m.data);
        },
        stop_rewind() {
          for (const m of fork_modules()) m.exports.asyncify_stop_rewind();
        },
        func(fn: number) {
          let slot = slots.get(fn);
          if (slot === undefined) {
            slot = slot_for(program_table().get(fn >>> 0));
            slots.set(fn, slot);
          }
          return slot;
        },
        // (through JS: a handler can't suspend yet)
        call_signal_handler(fn: number, sig: number) {
          (program_table().get(fn >>> 0) as Fn)(sig);
        },
        call_siginfo_handler(trampoline: number, fn: number, sig: number) {
          (program_table().get(trampoline >>> 0) as Fn)(fn, sig);
          return 0;
        },
        read: (to: number, from: number, n: number) =>
          context ? copy(memory, to >>> 0, context.memory, from >>> 0, n >>> 0) : n >>> 0,
        write: (to: number, from: number, n: number) =>
          context ? copy(context.memory, to >>> 0, memory, from >>> 0, n >>> 0) : n >>> 0,
        write_zeroes(to: number, n: number) {
          const destination = context && memory_bytes(context.memory, to >>> 0, n >>> 0);
          if (!destination) return n >>> 0;
          destination.fill(0);
          return 0;
        },
        futex_atomic_op(oldval: number, uaddr: number, op: number, oparg: number) {
          const word = user_word(uaddr);
          if (!word) return -14; // bad address
          const ops = [
            Atomics.exchange,
            Atomics.add,
            Atomics.or,
            (a: Int32Array, i: number, v: number) => Atomics.and(a, i, ~v),
            Atomics.xor,
          ];
          const f = ops[op];
          if (!f) return -38; // function not implemented
          set_kernel_u32(oldval, f(word, 0, oparg));
          return 0;
        },
        futex_atomic_cmpxchg(oldval: number, uaddr: number, expected: number, replacement: number) {
          const word = user_word(uaddr);
          if (!word) return -14; // bad address
          set_kernel_u32(oldval, Atomics.compareExchange(word, 0, expected, replacement));
          return 0;
        },
      },
    };
  }
  /** Kernel-table slots freed by tasks that exited or exec'd. */
  const free_slots: number[] = [];

  // The shared instance's user imports act for the current task.
  const user = Object.fromEntries(
    Object.keys(user_imports({} as Task, null, null).imports).map((name) => [
      name,
      (...args: number[]) => (current!.user.imports as unknown as Record<string, Fn>)[name]!(...args),
    ]),
  );

  instance = new Wasm.Instance(vmlinux, {
    env: { memory },
    boot: {
      get_devicetree(buf: number, size: number) {
        if (!buf && !size) return generated_devicetree.byteLength;
        assert(size >>> 0 >= generated_devicetree.byteLength, "Device tree truncated");
        new Uint8Array(memory.buffer).set(generated_devicetree, buf >>> 0);
        return generated_devicetree.byteLength;
      },
      get_initramfs(buf: number, size: number) {
        assert(size >>> 0 >= initramfs.byteLength, "Initramfs truncated");
        new Uint8Array(memory.buffer).set(initramfs, buf >>> 0);
        return initramfs.byteLength;
      },
    },
    kernel,
    user,
    virtio: virtio_imports({ memory, devices, on_error: finish, trigger_irq: raise_irq }),
  });
  stats.instances++;

  const close = () => finish();
  const machine: JspiMachine = {
    memory,
    bootConsole: boot_console.readable,
    closed: closed.promise,
    terminated: terminated.promise,
    debugTasks: () => (kernel_exports().debug_tasks as Fn)(),
    close,
    [Symbol.dispose]: close,
    async [Symbol.asyncDispose]() {
      close();
      await closed.promise;
    },
  };
  try {
    (kernel_exports().boot as Fn)();
    await run_machine_booted(plugins, machine);
  } catch (error) {
    finish(error);
    throw error;
  }
  return machine;
}

/** A trap, or the engine's stack overflowing (a RangeError, not a trap: V8's own limit). */
function is_trap(error: unknown): error is Error {
  return error instanceof Wasm.RuntimeError || (error instanceof RangeError && /call stack size/.test(error.message));
}

/** host sockets' imports (arch/wasm/exobox/hostsock.c) with no network: sock_init says so */
const no_sockets = {
  sock_init: () => 0,
  sock_irq: () => {},
  ...Object.fromEntries(
    ["sock_open", "sock_connect", "sock_listen", "sock_accept", "sock_send", "sock_recv", "sock_getname",
     "sock_shutdown", "sock_close", "sock_changed", "sock_state", "sock_pending"].map((name) => [
      name,
      () => {
        throw new Error(`kernel.${name} with no network (sock_init said so)`);
      },
    ]),
  ),
};

/** host directories' imports (arch/wasm/exobox/hostfuse.c) with none: mount -t hostfuse finds no filesystem */
const no_fuse = {
  fuse_connect: () => -2, // ENOENT
  ...Object.fromEntries(
    ["fuse_submit", "fuse_complete", "fuse_disconnect"].map((name) => [
      name,
      () => {
        throw new Error(`kernel.${name} with no host directories (fuse_connect said so)`);
      },
    ]),
  ),
};

/** the console's imports (arch/wasm/exobox/console.c) with none: output dropped, no input */
const no_console = {
  console_write: () => {},
  console_read: () => 0,
  console_irq: () => {},
};

/** disks' imports (arch/wasm/exobox/hostblk.c) with none: blk_count says so */
const no_disks = {
  blk_count: () => 0,
  ...Object.fromEntries(
    ["blk_size", "blk_writable", "blk_irq", "blk_submit", "blk_complete"].map((name) => [
      name,
      () => {
        throw new Error(`kernel.${name} with no disks (blk_count said so)`);
      },
    ]),
  ),
};

/** The signal Linux kills a process by for what trapped (V8's messages). */
function trap_signal(error: Error): number {
  const SIGILL = 4, SIGFPE = 8, SIGSEGV = 11;
  if (/unreachable/.test(error.message)) return SIGILL;
  if (/divide by zero|remainder by zero|integer overflow|float unrepresentable/.test(error.message)) return SIGFPE;
  return SIGSEGV;
}

/** Lets the event loop turn once (I/O and timers included), then runs `f`. */
const next_turn: (f: () => void) => void =
  typeof (globalThis as { setImmediate?: unknown }).setImmediate === "function"
    ? (f) => (globalThis as unknown as { setImmediate(f: () => void): void }).setImmediate(f)
    : (f) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          channel.port1.close();
          f();
        };
        channel.port2.postMessage(null);
      };
