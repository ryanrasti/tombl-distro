// SPDX-License-Identifier: MIT
//
// Exec by reference: modules named by their content's hash. A file in the
// machine can be a stub, a module with no code of its own: its dylink.0
// section, if the module it names has one (musl's dlopen reads a library's
// needs and run paths from it), then a custom section exobox.ref naming the
// module. The kernel sees the section at exec (arch/wasm/exobox/exec.c,
// CONFIG_EXOBOX_EXEC_REF) and asks the host (user.exec_ref); the host's
// registry resolves the name to a compiled module, once per registry, and
// the file isn't read further or sent. A stub whose module the host hasn't
// fails exec with ENOEXEC. dlopen of a stub (its bytes, read by musl) takes
// the module it names too.
//
// The reference's format: exobox.ref's contents are "sha256:" and the
// lowercase hex SHA-256 of the module's bytes (71 bytes, ASCII).
//
// Where modules come from is the machine's owner's (a resolver: hash to a
// module): bytes compiled here, a module compiled already, or one compiled
// ahead of time with what linking needs from its bytes (ModuleInfo), as on
// Workers, which can't compile at runtime.

import { read_wasm_memories } from "../../kernel/src/wasm_binary.ts";
import { customSection, type FuncType, type Program, parseDylink, parseImports, program } from "./dynlink.ts";

export const REF_SECTION = "exobox.ref";
const REF_PREFIX = "sha256:";

/** What exec and linking need from a module's bytes, worked out ahead of time (JSON). */
export interface ModuleInfo {
  /** function imports: "module.name", params, results (value types' codes) */
  funcTypes: [string, number[], number[]][];
  /** imports a shared memory (built with -pthread) */
  sharedMemory: boolean;
  /** its memory import's limits, in wasm pages */
  memory: { minimum: number; maximum: number };
}

/** A module a resolver gives for a hash. */
export type RefModule =
  /** its bytes, compiled here */
  | Uint8Array
  /** compiled already, and its bytes (what linking needs is read from them) */
  | { module: WebAssembly.Module; bytes: Uint8Array }
  /** compiled ahead of time (Workers: statically imported), its info, and its trampoline if it's a library */
  | { module: WebAssembly.Module; info: ModuleInfo; trampoline?: WebAssembly.Module };

/** A module ready to exec: its Program, and its memory's limits in pages. */
export interface RefEntry {
  module: WebAssembly.Module;
  program: Program;
  minimum: number;
  maximum: number;
}

/**
 * Modules by hash, each compiled once (the first exec naming it) and shared
 * by every machine given the registry. resolve(hash): the module, or
 * undefined if it isn't one of the machine's (exec then reads the file:
 * ENOEXEC for a stub). A hash it resolves is trusted to be the module's.
 */
export class ModuleRegistry {
  #resolve: (hash: string) => RefModule | undefined;
  #entries = new Map<string, RefEntry>();
  readonly stats = { hits: 0, misses: 0, compiled: 0, compile_ms: 0 };

  constructor(resolve: (hash: string) => RefModule | undefined) {
    this.#resolve = resolve;
  }

  /** the module of this hash (hex SHA-256), compiled once; undefined if the resolver hasn't it */
  get(hash: string): RefEntry | undefined {
    let entry = this.#entries.get(hash);
    if (!entry) {
      const source = this.#resolve(hash);
      if (!source) {
        this.stats.misses++;
        return undefined;
      }
      entry = this.#entry(source);
      this.#entries.set(hash, entry);
    }
    this.stats.hits++;
    return entry;
  }

  /** the module an exobox.ref section's contents name (undefined: not a reference of this format, or unknown) */
  getRef(ref: Uint8Array): RefEntry | undefined {
    const hash = parseRef(ref);
    return hash === undefined ? undefined : this.get(hash);
  }

  /**
   * dlopen's view (dynlink.ts's LinkOptions.resolve): the Program a stub's
   * bytes name, a copy of its own (dlopen names it); undefined if they
   * aren't a stub; throws for a stub with no module.
   */
  resolveStub = (bytes: Uint8Array): Program | undefined => {
    const ref = customSection(bytes, REF_SECTION);
    if (!ref) return undefined;
    const entry = this.getRef(ref);
    if (entry) return { ...entry.program };
    if (isStub(bytes)) throw new Error(`no module for ${new TextDecoder().decode(ref)}`);
    return undefined;
  };

  #entry(source: RefModule): RefEntry {
    if ("info" in source) {
      const dylink = WebAssembly.Module.customSections(source.module, "dylink.0")[0];
      const { funcTypes, sharedMemory, memory } = source.info;
      return {
        module: source.module,
        program: {
          module: source.module,
          funcTypes: new Map(funcTypes.map(([k, params, results]): [string, FuncType] => [k, { params, results }])),
          dylink: dylink && parseDylink(new Uint8Array(dylink)),
          sharedMemory,
          trampoline: source.trampoline,
        },
        minimum: memory.minimum,
        maximum: memory.maximum,
      };
    }
    const bytes = source instanceof Uint8Array ? source : source.bytes;
    const { memory } = moduleInfo(bytes);
    let module = source instanceof Uint8Array ? undefined : source.module;
    if (!module) {
      const t = performance.now();
      module = new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>);
      this.stats.compile_ms += performance.now() - t;
      this.stats.compiled++;
    }
    return { module, program: program(bytes, module), minimum: memory.minimum, maximum: memory.maximum };
  }
}

/** an exobox.ref section's contents: the hash it names (hex), or undefined if it isn't of our format */
export function parseRef(ref: Uint8Array): string | undefined {
  const text = new TextDecoder().decode(ref.slice());
  return /^sha256:[0-9a-f]{64}$/.test(text) ? text.slice(REF_PREFIX.length) : undefined;
}

/** A module's info, for exec without its bytes (ModuleInfo: a bundle's, Workers'). */
export function moduleInfo(bytes: Uint8Array): ModuleInfo {
  const memory = read_wasm_memories(bytes).imports[0];
  if (!memory || memory.type.maximum === undefined) throw new Error("not a program: no memory import with a maximum");
  const [funcTypes, sharedMemory] = parseImports(bytes);
  return {
    funcTypes: [...funcTypes].map(([k, t]) => [k, t.params, t.results]),
    sharedMemory,
    memory: { minimum: Number(memory.type.minimum), maximum: Number(memory.type.maximum) },
  };
}

/** whether bytes are a module with nothing but custom sections (a stub) */
export function isStub(bytes: Uint8Array): boolean {
  let p = 8;
  while (p < bytes.length) {
    if (bytes[p++] !== 0) return false;
    let size = 0;
    for (let shift = 0; ; shift += 7) {
      const b = bytes[p++]!;
      size |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      if (shift > 28) return false;
    }
    p += size >>> 0;
  }
  return p === bytes.length;
}

/**
 * The stub for a module (its bytes) of this hash (hex SHA-256): wasm's
 * header, its dylink.0 section if it has one (first, as the tool
 * conventions want), and exobox.ref.
 */
export function refStub(bytes: Uint8Array, hash: string): Uint8Array<ArrayBuffer> {
  const dylink = customSection(bytes, "dylink.0");
  const parts: Uint8Array[] = [new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])];
  if (dylink) parts.push(custom("dylink.0", dylink));
  parts.push(custom(REF_SECTION, new TextEncoder().encode(REF_PREFIX + hash)));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** a module's exobox.ref (the hash it names), if it has one */
export function refOf(bytes: Uint8Array): string | undefined {
  const ref = customSection(bytes, REF_SECTION);
  return ref && parseRef(ref);
}

/** a custom section: id 0, size, name, contents */
function custom(name: string, body: Uint8Array): Uint8Array {
  const n = new TextEncoder().encode(name);
  const payload = [...leb(n.length), ...n, ...body];
  return new Uint8Array([0, ...leb(payload.length), ...payload]);
}

function leb(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}
