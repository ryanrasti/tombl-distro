// SPDX-License-Identifier: MIT
//
// Dynamic linking for processes (docs/design/dylink.md in linux-workers): a
// program plus shared libraries (wasm modules with a dylink.0 section, built
// -fPIC, wasm-ld -pie/-shared), all instances in one process: its memory, a
// function table, a stack pointer and the setjmp/longjmp tag. The host is the
// dynamic loader, as ld.so is; the kernel sends it the files (exec_lib).
//
// Calls between modules stay wasm-to-wasm: an import that can't be bound when
// its module is instantiated (a program's calls into libraries instantiated
// after it) goes through a generated trampoline, a wasm function doing
// call_indirect into a table filled in once everything is instantiated. A JS
// function in between would stop JSPI from suspending through it.
//
// A thread is an instance set of its own (tombl's model: an instance per
// thread): the process's link replayed in its memory, with its own table and
// stack pointer and its modules' thread-local blocks, which run no data
// relocations or constructors again. A fork child is the parent's link
// replayed in the copy of its memory.
//
// From linux-workers' LKL-era host (src/dynlink.ts at 780325e), where a
// process's threads shared one instance set instead.

/** A wasm function, or a JS one given to wasm, of any signature. */
export type WasmFunction = (...args: never[]) => unknown;

/** A module, with what linking needs from its bytes. */
export interface Program {
  module: WebAssembly.Module;
  /** function imports' signatures, by "module.name" */
  funcTypes: Map<string, FuncType>;
  /** dylink.0: libraries, and position independent programs */
  dylink?: Dylink;
  /** imports a shared memory (built with -pthread) */
  sharedMemory: boolean;
  /** a library's name as needed or dlopened (libmount.so.1): dlopen finds a loaded library by it */
  name?: string;
  /** its trampoline module, built ahead of time (where compiling at runtime isn't allowed: Workers) */
  trampoline?: WebAssembly.Module;
}

export interface Dylink {
  memSize: number;
  memAlign: number;
  tableSize: number;
  tableAlign: number;
  /** libraries it needs (DT_NEEDED) */
  needed: string[];
  /** where to look for them (DT_RUNPATH) */
  runpath: string[];
  /** weak imports ("module.name"): undefined is fine, as 0 */
  weak: Set<string>;
}

export interface FuncType {
  params: number[];
  results: number[];
}

/** A module's dylink.0 section, read from its bytes without compiling it. */
export function dylinkOf(b: Uint8Array): Dylink | undefined {
  const section = customSection(b, "dylink.0");
  return section && parseDylink(section);
}

/** A custom section's contents (a copy), from a module's bytes. */
export function customSection(b: Uint8Array, name: string): Uint8Array | undefined {
  for (const s of sections(b)) if (s.name === name) return b.slice(s.body, s.end);
}

/** A module's sections: where each starts and ends, and a custom one's name and contents. */
function* sections(b: Uint8Array): Generator<{ start: number; end: number; name?: string; body: number }> {
  let p = 8;
  const u32 = () => {
    let v: number;
    [v, p] = readU32(b, p);
    return v;
  };
  while (p < b.length) {
    const start = p;
    const id = b[p++];
    const size = u32();
    const end = p + size;
    if (end > b.length) throw new Error("wasm: a section runs past the module's end");
    if (id === 0) {
      const n = u32();
      // (copies: TextDecoder won't read a shared memory)
      yield { start, end, name: new TextDecoder().decode(b.slice(p, p + n)), body: p + n };
    } else yield { start, end, body: p };
    p = end;
  }
}

/** A Program from a module's bytes (compiled, unless given). */
export function program(bytes: Uint8Array, module?: WebAssembly.Module): Program {
  module ??= new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>);
  const [funcTypes, sharedMemory] = parseImports(bytes);
  const dylink = WebAssembly.Module.customSections(module, "dylink.0")[0];
  return { module, funcTypes, dylink: dylink && parseDylink(new Uint8Array(dylink)), sharedMemory };
}

function envImports(p: Program): [string, FuncType][] {
  return [...p.funcTypes].filter(([k]) => k.startsWith("env.")).map(([k, t]) => [k.slice(4), t]);
}

const trampolines = new WeakMap<WebAssembly.Module, WebAssembly.Module>();
function trampolineOf(p: Program): WebAssembly.Module {
  if (p.trampoline) return p.trampoline;
  let t = trampolines.get(p.module);
  if (!t) {
    t = new WebAssembly.Module(trampolineBytes(envImports(p).map(([, s]) => s)) as Uint8Array<ArrayBuffer>);
    trampolines.set(p.module, t);
  }
  return t;
}

/** What a link did, in order, to replay it (a thread's instance set, a fork child's). */
export type LinkOp =
  /** defer: loaded with the program (later libraries can bind its symbols) */
  | { kind: "lib"; program: Program; memoryBase: number; defer: boolean }
  /** a function added to the table: owner 0 is the program, i the i-th library */
  | { kind: "func"; owner: number; name: string };

interface Mod {
  program: Program;
  instance?: WebAssembly.Instance;
  memoryBase: number;
  funcs: Set<string>;
  globals: Set<string>;
  /** its Asyncify buffer (0: none), shared by the process's threads: fork unwinds one at a time */
  asyncifyData: number;
}

const moduleInfo = new WeakMap<
  WebAssembly.Module,
  { funcs: Set<string>; globals: Set<string>; imports: WebAssembly.ModuleImportDescriptor[] }
>();
const linkInfo = (program: Program) => {
  let i = moduleInfo.get(program.module);
  if (!i) {
    const exports = WebAssembly.Module.exports(program.module);
    const names = (kind: string) => new Set(exports.filter((e) => e.kind === kind).map((e) => e.name));
    i = { funcs: names("function"), globals: names("global"), imports: WebAssembly.Module.imports(program.module) };
    moduleInfo.set(program.module, i);
  }
  return i;
};

const describe = (program: Program, memoryBase: number): Mod => {
  const { funcs, globals } = linkInfo(program);
  return { program, memoryBase, funcs, globals, asyncifyData: 0 };
};

const instanceOf = (m: Mod): WebAssembly.Instance => {
  if (!m.instance) throw new Error(`dynamic link: ${m.program.name ?? "the program"} isn't instantiated yet`);
  return m.instance;
};

/** a table entry to bind: table, index, symbol, weak; and for GOT.func, its global */
type Pending = [WebAssembly.Table, number, string, boolean, WebAssembly.Global?];

const Tag = (WebAssembly as unknown as { Tag: new (type: { parameters: string[] }) => unknown }).Tag;

/** The main thread's stack, grown onto the memory. */
const STACK_SIZE = 1024 * 1024;
/** Each module's Asyncify buffer (fork), grown onto the memory. */
const ASYNCIFY_DATA_SIZE = 128 * 1024;
const PAGE = 65536;

/** A module's thread-local storage (-pthread builds export these). */
interface TlsExports {
  __tls_base: WebAssembly.Global;
  __tls_size: WebAssembly.Global;
  __tls_align?: WebAssembly.Global;
  __wasm_init_tls(block: number): void;
}
const tlsExports = (instance?: WebAssembly.Instance) => {
  const e = instance?.exports as unknown as Partial<TlsExports> | undefined;
  return e?.__wasm_init_tls && e.__tls_base && e.__tls_size ? (e as TlsExports) : undefined;
};

export interface AsyncifyModule {
  exports: {
    asyncify_start_unwind(data: number): void;
    asyncify_stop_unwind(): void;
    asyncify_start_rewind(data: number): void;
    asyncify_stop_rewind(): void;
  };
  /** its buffer: Asyncify's header (next, end), then the saved frames */
  data: number;
}

export interface LinkOptions {
  /** the process's memory (its user context's) */
  memory: WebAssembly.Memory;
  /** the kernel's exports programs import (linux.syscall, get_thread_area, copy_siginfo) */
  linux: Record<string, WasmFunction>;
  main: Program;
  /** libraries, in load order (dependencies first) */
  libs: Program[];
  /** the order symbols are looked up in, after the program (default: load order) */
  search?: Program[];
  /**
   * a link to replay: a thread's (in the same memory: fresh thread-local
   * blocks), or a fork child's (in a copy of the parent's memory: its
   * blocks, and its stack pointer, are the caller's to set)
   */
  replay?: { of: Link; as: "thread" | "fork" };
  /**
   * a fresh link's: where in the memory the loader starts placing what it
   * grows (the main thread's stack, modules' data, Asyncify buffers,
   * thread-local blocks): it uses the memory up to its end before growing
   * it (default: the memory's end). A memory made larger than the program
   * declares (machine.ts: the size its last link came to) links with no
   * memory.grow, each of which costs; what the loader leaves is the heap's.
   */
  reserved?: number;
  /** a dlopen's failure */
  onError?: (...args: unknown[]) => void;
  /**
   * dlopen of a stub (a module naming another by its hash: machine.ts's
   * exec by reference): the module it names, or undefined if the bytes
   * aren't a stub (it throws if it's a stub with no module)
   */
  resolve?: (bytes: Uint8Array) => Program | undefined;
}

/**
 * A process's modules, linked: a position independent program (-pie: the
 * loader provides memory, table and stack pointer) and its libraries.
 * Symbols resolve program first, then libraries in search order (as ELF:
 * breadth first), then those loaded later (dlopen).
 */
export class Link {
  readonly main: Program;
  /** the program's exports, plus the memory, table and stack pointer */
  readonly instance: WebAssembly.Instance;
  readonly ops: LinkOp[] = [];
  #linux: Record<string, WasmFunction>;
  #memory: WebAssembly.Memory;
  #table: WebAssembly.Table;
  #stackPointer: WebAssembly.Global;
  /** [0] is the program; then the libraries, in load order */
  #mods: Mod[];
  /** the program's (#mods[0]) */
  #program: Mod;
  #search: Program[];
  #pending: Pending[] = [];
  /** each function's address, its table index: the first given it, so a function has one address */
  #slots = new Map<WasmFunction, number>();
  #pendingData: [WebAssembly.Global, string, boolean][] = [];
  #pendingRelocs: (() => void)[] = [];
  /** libraries' constructors, as table indices, for libc to run (dyn.next_ctor) */
  #ctors: number[] = [];
  /** the process's first break (libc's __heap_end): the loader's end once linked */
  #heapEnd = 0;
  /** during a fresh link: where the loader places the next thing it grows, while the memory has room */
  #next: number | undefined;
  /** the GOT entries for __heap_end, set last, past all the loader grows */
  #heapEndGot: WebAssembly.Global[] = [];
  /** fresh: not a replay (data relocated, constructors run, thread-local blocks made) */
  #fresh: boolean;
  #thread: boolean;
  #onError: (...args: unknown[]) => void;
  #resolve?: (bytes: Uint8Array) => Program | undefined;
  /**
   * the process's live links, this one's threads' and its own: what one
   * adds later (a dlopen, a dlsym's table entry), all add, at the same
   * table index and memory base, so a pointer means the same in each
   */
  #siblings: Set<Link>;
  /** exception tags no module defines (setjmp's __c_longjmp, C++'s __cpp_exception): the loader's, one each */
  #tags = new Map<string, unknown>();

  constructor(o: LinkOptions) {
    this.main = o.main;
    this.#linux = o.linux;
    this.#memory = o.memory;
    this.#onError = o.onError ?? console.error;
    this.#resolve = o.resolve;
    this.#fresh = !o.replay;
    if (this.#fresh) this.#next = o.reserved ?? this.#memory.buffer.byteLength;
    this.#thread = o.replay?.as === "thread";
    this.#siblings = o.replay?.as === "thread" ? o.replay.of.#siblings : new Set();
    this.#siblings.add(this);
    if (!o.main.dylink) throw new Error("dynamic link: the program isn't position independent (no dylink.0)");
    const programs = [o.main, ...o.libs];
    if (programs.some((p) => !p.sharedMemory))
      throw new Error("dynamic link: every module must import a shared memory (built with -pthread)");
    this.#program = describe(o.main, 0);
    this.#mods = [this.#program];
    // (0 is NULL; 1 and 2 are SIG_IGN and SIG_HOLD, never a function's)
    this.#table = new WebAssembly.Table({ element: "anyfunc", initial: 3 });
    // the main thread's stack, past what's in the memory (a thread's: its libc
    // sets it on entry; a fork child's: the caller sets the parent's)
    const stackTop = this.#fresh ? this.#grow(STACK_SIZE) + STACK_SIZE : 0;
    this.#stackPointer = new WebAssembly.Global({ value: "i32", mutable: true }, stackTop);
    if (o.replay) {
      const parent = o.replay.of;
      this.#search = [o.main, ...parent.#search.slice(1)];
      this.#heapEnd = parent.#heapEnd;
      for (const op of parent.ops) {
        if (op.kind === "func") this.#addFunc(op.owner, op.name, true);
        else this.#load(op.program, op.memoryBase, op.defer, parent.#mods.find((m) => m.program === op.program));
      }
      this.ops.splice(0, this.ops.length, ...parent.ops);
    } else {
      this.#search = [o.main, ...(o.search ?? o.libs)];
      for (const lib of o.libs) this.#load(lib, undefined, true);
      this.#load(o.main, undefined, true);
    }
    this.#bind(this.#pending.splice(0));
    for (const [g, name, isWeak] of this.#pendingData.splice(0)) g.value = this.#data(name, !isWeak) ?? 0;
    for (const relocate of this.#pendingRelocs.splice(0)) relocate();
    // (after the thread-local blocks, the last the loader grows; then what
    // grows the memory is its own: the heap's, sbrk's, past this)
    this.#heapEnd ||= this.#next ?? this.#memory.buffer.byteLength;
    this.#next = undefined;
    for (const g of this.#heapEndGot) g.value = this.#heapEnd;
    const program = instanceOf(this.#program);
    this.instance = {
      exports: {
        ...program.exports,
        memory: this.#memory,
        __indirect_function_table: this.#table,
        __stack_pointer: this.#stackPointer,
      },
    } as unknown as WebAssembly.Instance;
  }

  /** This thread's link is done with (it exited, or exec'd). */
  release(): void {
    this.#siblings.delete(this);
  }

  /** A thread's instance set: this link, replayed in the same memory. */
  thread(linux: Record<string, WasmFunction>): Link {
    return new Link({
      memory: this.#memory,
      linux,
      main: this.main,
      libs: [],
      replay: { of: this, as: "thread" },
      onError: this.#onError,
      resolve: this.#resolve,
    });
  }

  /** A fork child's: this link, replayed in the copy of the memory (its stack pointer, the caller's). */
  fork(memory: WebAssembly.Memory, linux: Record<string, WasmFunction>): Link {
    const child = new Link({
      memory,
      linux,
      main: this.main,
      libs: [],
      replay: { of: this, as: "fork" },
      onError: this.#onError,
      resolve: this.#resolve,
    });
    child.#stackPointer.value = this.#stackPointer.value;
    // (the copy has the forking thread's blocks: point each module at them)
    this.#mods.forEach((m, i) => {
      const from = tlsExports(m.instance);
      const to = tlsExports(child.#mods[i]?.instance);
      if (from && to) to.__tls_base.value = from.__tls_base.value;
    });
    return child;
  }

  /** The modules that fork unwinds and rewinds: every one with Asyncify's exports. */
  get asyncify(): AsyncifyModule[] {
    return this.#mods.flatMap((m) =>
      m.asyncifyData && m.instance
        ? [{ exports: m.instance.exports as unknown as AsyncifyModule["exports"], data: m.asyncifyData }]
        : [],
    );
  }

  /** dlopen: load a library into the running process (its dependencies first: libc's). Its handle. */
  load(bytes: Uint8Array, name?: string): number {
    const lib = this.#resolve?.(bytes) ?? program(bytes);
    lib.name = name;
    const at = this.ops.length;
    this.#load(lib);
    this.#share(at);
    return this.#mods.length - 1;
  }

  /** dlopen: the handle of a library loaded under this name, or 0 */
  find(name: string): number {
    const i = this.#mods.findIndex((m, i) => i > 0 && m.program.name === name);
    return i > 0 ? i : 0;
  }

  /** dlsym: a function's table index or a data symbol's address; 0 if none */
  sym(handle: number, name: string): number {
    const owners = handle ? [handle] : this.#search.map((p) => this.#mods.findIndex((m) => m.program === p));
    for (const owner of owners) {
      const m = this.#mods[owner];
      if (m?.funcs.has(name)) {
        const at = this.ops.length;
        const slot = this.#addFunc(owner, name);
        this.#share(at);
        return slot;
      }
      if (m?.globals.has(name)) return m.memoryBase + ((instanceOf(m).exports[name] as WebAssembly.Global).value as number);
    }
    return 0;
  }

  /** the ops from at on, done by every sibling too (each a thread's link) */
  #share(at: number): void {
    const ops = this.ops.slice(at);
    for (const other of this.#siblings) {
      if (other === this) continue;
      for (const op of ops) {
        if (op.kind === "func") other.#addFunc(op.owner, op.name, true);
        else other.#load(op.program, op.memoryBase, op.defer, this.#mods.find((m) => m.program === op.program));
      }
    }
  }

  /** the process's first break: where what the loader placed ends */
  get heapEnd(): number {
    return this.#heapEnd;
  }

  /** memory for the loader's own use (n bytes, whole pages): the memory's, while a fresh link has room, else grown. Its address */
  #grow(n: number): number {
    const bytes = Math.ceil(n / PAGE) * PAGE;
    if (this.#next !== undefined) {
      const at = this.#next;
      const end = this.#memory.buffer.byteLength;
      if (at + bytes > end) this.#memory.grow((at + bytes - end) / PAGE);
      this.#next = at + bytes;
      return at;
    }
    return this.#memory.grow(bytes / PAGE) * PAGE;
  }

  #dynImports() {
    const mem = () => new Uint8Array(this.#memory.buffer);
    const cstring = (p: number) => new TextDecoder().decode(mem().slice(p, mem().indexOf(0, p)));
    const put = (s: string, out: number, size: number) => {
      const b = new TextEncoder().encode(`${s}\0`);
      if (b.length > size) return -1;
      mem().set(b, out);
      return b.length - 1;
    };
    return {
      load: (ptr: number, len: number, name: number) => {
        try {
          return this.load(mem().slice(ptr, ptr + len), name ? cstring(name) : undefined);
        } catch (e) {
          this.#onError("dlopen:", e);
          return 0;
        }
      },
      find: (name: number) => this.find(cstring(name)),
      needed: (ptr: number, len: number, i: number, out: number, size: number) => {
        const name = dylinkOf(mem().subarray(ptr, ptr + len))?.needed[i];
        return name === undefined ? -1 : put(name, out, size);
      },
      runpath: (ptr: number, len: number, i: number, out: number, size: number) => {
        const paths = ptr
          ? (dylinkOf(mem().subarray(ptr, ptr + len))?.runpath ?? [])
          : [...new Set(this.#mods.flatMap((m) => m.program.dylink?.runpath ?? []))];
        const dir = paths.flatMap((p) => p.split(":")).filter((p) => p && !p.includes("$"))[i];
        return dir === undefined ? -1 : put(dir, out, size);
      },
      sym: (handle: number, name: number) => this.sym(handle, cstring(name)),
      next_ctor: () => this.#ctors.shift() ?? 0,
    };
  }

  /**
   * Instantiate a library (or the program). With defer (loaded with the
   * program), symbols not defined yet are bound at the end of linking;
   * otherwise a missing one fails the load. A replay (parent: the module as
   * the replayed link has it) reuses its memory base and Asyncify buffer.
   */
  #load(lib: Program, memoryBase?: number, defer = false, parent?: Mod): void {
    const info = lib.dylink;
    if (!info) throw new Error("dynamic link: not a shared library (no dylink.0 section)");
    memoryBase ??= info.memSize ? this.#grow(info.memSize) : 0;
    this.ops.push({ kind: "lib", program: lib, memoryBase, defer });
    const tableBase = this.#table.grow(info.tableSize);
    const isMain = lib === this.main;
    const pending: Pending[] = [];
    const pendingData: [WebAssembly.Global, string, boolean][] = [];
    const weak = (key: string) => info.weak.has(key);

    const env: Record<string, WebAssembly.ImportValue> = {
      memory: this.#memory,
      __indirect_function_table: this.#table,
      __stack_pointer: this.#stackPointer,
      __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, memoryBase),
      __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, tableBase),
    };
    const gotMem: Record<string, WebAssembly.Global> = {};
    const gotFunc: Record<string, WebAssembly.Global> = {};
    const unbound: [string, number, boolean][] = [];
    const envIndex = new Map(envImports(lib).map(([name], i) => [name, i]));
    for (const imp of linkInfo(lib).imports) {
      if (imp.module === "env" && imp.kind === "function") {
        const f = this.#func(imp.name);
        if (f) env[imp.name] = f as WebAssembly.ImportValue;
        else {
          const j = envIndex.get(imp.name);
          if (j === undefined) throw new Error(`dynamic link: no trampoline for ${imp.name}`);
          unbound.push([imp.name, j, weak(`env.${imp.name}`)]);
        }
      } else if (imp.module === "env" && (imp.kind as string) === "tag") {
        const owner = this.#mods.find((m) => m.instance?.exports[imp.name] instanceof Tag);
        if (owner) env[imp.name] = instanceOf(owner).exports[imp.name] as WebAssembly.ImportValue;
        else {
          // (both carry one i32: setjmp's state, C++'s exception object)
          let tag = this.#tags.get(imp.name);
          if (!tag) this.#tags.set(imp.name, (tag = new Tag({ parameters: ["i32"] })));
          env[imp.name] = tag as WebAssembly.ImportValue;
        }
      } else if (imp.module === "GOT.mem" && imp.name === "__heap_end") {
        // libc's first break: no module has a heap of its own (set once linked)
        const g = new WebAssembly.Global({ value: "i32", mutable: true }, this.#heapEnd);
        gotMem[imp.name] = g;
        this.#heapEndGot.push(g);
      } else if (imp.module === "GOT.mem") {
        const g = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
        gotMem[imp.name] = g;
        pendingData.push([g, imp.name, weak(`GOT.mem.${imp.name}`) || weak(`env.${imp.name}`)]);
      } else if (imp.module === "GOT.func") {
        const index = this.#table.grow(1);
        const g = new WebAssembly.Global({ value: "i32", mutable: true }, index);
        pending.push([this.#table, index, imp.name, weak(`GOT.func.${imp.name}`) || weak(`env.${imp.name}`), g]);
        gotFunc[imp.name] = g;
      }
    }
    if (unbound.length) {
      const table = new WebAssembly.Table({ element: "anyfunc", initial: Math.max(envIndex.size, 1) });
      const thunks = new WebAssembly.Instance(trampolineOf(lib), { env: { t: table } });
      for (const [name, j, isWeak] of unbound) {
        env[name] = thunks.exports[`f${j}`] as WebAssembly.ImportValue;
        pending.push([table, j, name, isWeak]);
      }
    }
    const instance = new WebAssembly.Instance(lib.module, {
      env,
      "GOT.mem": gotMem,
      "GOT.func": gotFunc,
      linux: this.#linux,
      dyn: this.#dynImports(),
    });

    const mod = isMain ? this.#program : describe(lib, memoryBase);
    mod.instance = instance;
    mod.memoryBase = memoryBase;
    if (!isMain) this.#mods.push(mod);
    if (!this.#search.includes(lib)) this.#search.push(lib);
    try {
      if (defer) {
        this.#pending.push(...pending);
        for (const entry of pendingData) {
          const v = this.#data(entry[1], false);
          if (v === undefined) this.#pendingData.push(entry);
          else entry[0].value = v;
        }
      } else {
        for (const [g, name, isWeak] of pendingData) g.value = this.#data(name, !isWeak) ?? 0;
        this.#bind(pending);
      }
    } catch (e) {
      if (!isMain) this.#mods.pop();
      if (this.#search.at(-1) === lib && !isMain) this.#search.pop();
      throw e;
    }
    const hasAsyncify = typeof instance.exports.asyncify_start_unwind === "function";
    if (parent) {
      mod.asyncifyData = parent.asyncifyData;
    } else if (hasAsyncify) {
      mod.asyncifyData = this.#grow(ASYNCIFY_DATA_SIZE);
      const header = new DataView(this.#memory.buffer, mod.asyncifyData, 8);
      header.setUint32(4, mod.asyncifyData + ASYNCIFY_DATA_SIZE, true);
    }
    // Relocations write memory: only the load's first time (a replay's
    // memory has them). Thread-local blocks: then, and in each thread (a
    // fork child's are the copy's). Constructors may make syscalls: libc
    // runs them (dyn.next_ctor), but the program's own (crt1 calls them).
    const fresh = !parent;
    const relocate = () => {
      if (fresh) (instance.exports.__wasm_apply_data_relocs as WasmFunction | undefined)?.();
      if (fresh || this.#thread) this.#threadLocal(instance);
    };
    if (defer) this.#pendingRelocs.push(relocate);
    else relocate();
    if (fresh && !isMain && instance.exports.__wasm_call_ctors)
      this.#ctors.push(this.#addFunc(this.#mods.indexOf(mod), "__wasm_call_ctors"));
  }

  /** a module's thread-local block, made and current */
  #threadLocal(instance: WebAssembly.Instance): void {
    const tls = tlsExports(instance);
    if (!tls) return;
    const size = tls.__tls_size.value as number;
    const align = Math.max((tls.__tls_align?.value as number | undefined) ?? 16, 16);
    const block = ((this.#grow(size + align) + align - 1) & -align) >>> 0;
    tls.__wasm_init_tls(block);
  }

  #bind(entries: Pending[]): void {
    const found = entries.map(([, , name, weak]) => {
      const f = this.#func(name);
      if (!f && !weak) throw new Error(`dynamic link: undefined symbol ${name}`);
      return f ?? null;
    });
    entries.forEach(([table, index, , , address], i) => {
      const f = found[i];
      table.set(index, f);
      if (!address) return;
      if (!f) address.value = 0;
      else if (this.#slots.has(f)) address.value = this.#slots.get(f) as number;
      else this.#slots.set(f, index);
    });
  }

  #addFunc(owner: number, name: string, replay = false): number {
    const f = instanceOf(this.#mods[owner] as Mod).exports[name] as WasmFunction;
    const known = this.#slots.get(f);
    if (known !== undefined && !replay) return known;
    this.ops.push({ kind: "func", owner, name });
    const slot = this.#table.grow(1, f);
    if (known === undefined) this.#slots.set(f, slot);
    return slot;
  }

  #func(name: string): WasmFunction | undefined {
    if (name.startsWith("asyncify_")) return;
    const m = this.#provider((p) => linkInfo(p).funcs.has(name));
    return m?.instance?.exports[name] as WasmFunction | undefined;
  }

  #provider(defines: (p: Program) => boolean): Mod | undefined {
    const p = this.#search.find(defines);
    return p && (this.#mods.find((m) => m.program === p) ?? describe(p, 0));
  }

  /** A data symbol's address; undefined if not known yet (and not required). */
  #data(name: string, required: boolean): number | undefined {
    const m = this.#provider((p) => linkInfo(p).globals.has(name));
    if (m?.instance) return m.memoryBase + ((m.instance.exports[name] as WebAssembly.Global).value as number);
    if (required) throw new Error(`dynamic link: undefined data symbol ${name}`);
  }
}

// --- wasm binary bits ---

function readU32(b: Uint8Array, pos: number): [number, number] {
  let result = 0;
  for (let shift = 0; shift < 35; shift += 7) {
    if (pos >= b.length) throw new Error("wasm: truncated");
    const byte = b[pos++] as number;
    result |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [result >>> 0, pos];
  }
  throw new Error("wasm: a u32 longer than 5 bytes");
}

export function parseDylink(b: Uint8Array): Dylink {
  const d: Dylink = { memSize: 0, memAlign: 0, tableSize: 0, tableAlign: 0, needed: [], runpath: [], weak: new Set() };
  const dec = new TextDecoder();
  for (let pos = 0; pos < b.length; ) {
    const id = b[pos++];
    let size: number;
    [size, pos] = readU32(b, pos);
    let p = pos;
    const u32 = () => {
      let v: number;
      [v, p] = readU32(b, p);
      return v;
    };
    const str = () => {
      const len = u32();
      if (p + len > b.length) throw new Error("wasm: truncated");
      const v = dec.decode(b.slice(p, p + len));
      p += len;
      return v;
    };
    if (id === 1) {
      [d.memSize, d.memAlign, d.tableSize, d.tableAlign] = [u32(), u32(), u32(), u32()];
    } else if (id === 2) {
      for (let n = u32(); n > 0; n--) d.needed.push(str());
    } else if (id === 5 /* WASM_DYLINK_RUNTIME_PATH */) {
      for (let n = u32(); n > 0; n--) d.runpath.push(str());
    } else if (id === 4) {
      for (let n = u32(); n > 0; n--) {
        const key = `${str()}.${str()}`;
        if (u32() & 1 /* WASM_SYMBOL_BINDING_WEAK */) d.weak.add(key);
      }
    }
    pos += size;
  }
  return d;
}

/** Function imports' signatures, from the type and import sections; and whether the memory import is shared. */
export function parseImports(b: Uint8Array): [Map<string, FuncType>, boolean] {
  const types: FuncType[] = [];
  const out = new Map<string, FuncType>();
  let shared = false;
  const dec = new TextDecoder();
  let pos = 8;
  while (pos < b.length) {
    const id = b[pos++];
    let size: number;
    [size, pos] = readU32(b, pos);
    const end = pos + size;
    if (id === 1) {
      let [n, p] = readU32(b, pos);
      for (let i = 0; i < n; i++) {
        if (b[p++] !== 0x60) throw new Error("dynamic link: unsupported type");
        let np: number;
        let nr: number;
        [np, p] = readU32(b, p);
        const params = [...b.subarray(p, p + np)];
        p += np;
        [nr, p] = readU32(b, p);
        const results = [...b.subarray(p, p + nr)];
        p += nr;
        types.push({ params, results });
      }
    } else if (id === 2) {
      let [n, p] = readU32(b, pos);
      const name = () => {
        let len: number;
        [len, p] = readU32(b, p);
        const s = dec.decode(b.slice(p, p + len));
        p += len;
        return s;
      };
      const limits = () => {
        const flags = b[p++] as number;
        [, p] = readU32(b, p);
        if (flags & 1) [, p] = readU32(b, p);
        return flags;
      };
      for (let i = 0; i < n; i++) {
        const key = `${name()}.${name()}`;
        const kind = b[p++];
        if (kind === 0) {
          let t: number;
          [t, p] = readU32(b, p);
          const type = types[t];
          if (type) out.set(key, type);
        } else if (kind === 1) {
          p++; // reftype
          limits();
        } else if (kind === 2) {
          if (limits() & 2) shared = true;
        } else if (kind === 3) {
          p += 2; // valtype, mutability
        } else if (kind === 4) {
          p++; // attribute
          [, p] = readU32(b, p);
        }
      }
    }
    pos = end;
  }
  return [out, shared];
}

const leb = (n: number): number[] => {
  const out: number[] = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return out;
};

const sleb = (n: number): number[] => {
  const out: number[] = [];
  for (;;) {
    const byte = n & 0x7f;
    n >>= 7;
    if ((n === 0 && !(byte & 0x40)) || (n === -1 && byte & 0x40)) {
      out.push(byte);
      return out;
    }
    out.push(byte | 0x80);
  }
};

const section = (id: number, body: number[]) => [id, ...leb(body.length), ...body];
const vec = (items: number[][]) => [...leb(items.length), ...items.flat()];
const str = (s: string) => {
  const b = [...new TextEncoder().encode(s)];
  return [...leb(b.length), ...b];
};

/** A module of functions f0..fN-1 with the given signatures, each calling entry i of table env.t. */
export function trampolineBytes(sigs: FuncType[]): Uint8Array {
  const typeKeys = [...new Set(sigs.map((s) => JSON.stringify(s)))];
  const typeIndex = (s: FuncType) => typeKeys.indexOf(JSON.stringify(s));
  const types = typeKeys.map((k) => {
    const { params, results } = JSON.parse(k) as FuncType;
    return [0x60, ...leb(params.length), ...params, ...leb(results.length), ...results];
  });
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec(types)),
    // import env.t: table funcref, min = number of functions
    ...section(2, vec([[...str("env"), ...str("t"), 0x01, 0x70, 0x00, ...leb(Math.max(sigs.length, 1))]])),
    ...section(3, vec(sigs.map((s) => leb(typeIndex(s))))),
    ...section(7, vec(sigs.map((_, i) => [...str(`f${i}`), 0x00, ...leb(i)]))),
    ...section(
      10,
      vec(
        sigs.map((s, i) => {
          const body = [
            0x00, // no locals
            ...s.params.flatMap((_, p) => [0x20, ...leb(p)]), // local.get
            0x41, ...sleb(i), // i32.const i
            0x11, ...leb(typeIndex(s)), 0x00, // call_indirect type, table 0
            0x0b,
          ];
          return [...leb(body.length), ...body];
        }),
      ),
    ),
  ]);
}
