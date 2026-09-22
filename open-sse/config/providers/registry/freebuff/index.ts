import type { RegistryEntry } from "../../shared.ts";
import { freebuffCatalogModelsForRegistry } from "../../../../executors/freebuff/catalog.ts";

export const freebuffProvider: RegistryEntry = {
  id: "freebuff",
  alias: "fb",
  format: "openai",
  executor: "freebuff",
  baseUrl: "https://www.codebuff.com/api/v1",
  authType: "apikey",
  authHeader: "bearer",
  liveCatalogAuthoritative: true,
  models: freebuffCatalogModelsForRegistry(),
};
