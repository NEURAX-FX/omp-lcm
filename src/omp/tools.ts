import type { HostExtensionApi } from './host.js';

// Filled in by the tool-registration task; the extension entry imports it now so
// the wiring compiles.
export function registerLcmTools(_pi: HostExtensionApi, _getRuntime: () => unknown): void {}
