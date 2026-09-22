import { getFreebuffCatalogSnapshot } from "../executors/freebuff/catalog.ts";
import { getFreebuffHealthSnapshot } from "../executors/freebuff/health.ts";
import { getSharedFreebuffRuntime } from "../executors/freebuff/runtime.ts";

export function getFreebuffHealthForMonitoring(configured: boolean) {
  return getFreebuffHealthSnapshot({
    configured,
    runtime: getSharedFreebuffRuntime(),
    catalog: getFreebuffCatalogSnapshot(),
  });
}
