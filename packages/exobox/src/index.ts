// SPDX-License-Identifier: MIT

export {
  bootJspiMachine,
  type ExecCache,
  type ExtensionContext,
  type JspiMachine,
  type JspiMachineOptions,
  type KernelImage,
  kernelImage,
  kernelMemoryPages,
  type MachineExtension,
  type MachineStats,
  machine_stats,
  precompiledKernel,
} from "./machine.ts";
export {
  isStub,
  type ModuleInfo,
  ModuleRegistry,
  moduleInfo,
  parseRef,
  REF_SECTION,
  type RefEntry,
  type RefModule,
  refOf,
  refStub,
} from "./modules.ts";
export {
  type DiskResult,
  type HostDevices,
  type HostDevicesOptions,
  type HostDisk,
  hostDevices,
} from "./host-devices.ts";
export {
  type FuseServer,
  type HostFuse,
  type HostFuseOptions,
  type HostFuseStats,
  hostFuse,
  hostfuse_stats,
} from "./hostfuse.ts";
