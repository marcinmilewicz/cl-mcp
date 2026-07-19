/**
 * Library Configuration
 *
 * Dynamic configuration derived from loaded metadata — always describes the
 * ACTIVE library (see data/registry.ts). No hardcoded library-specific values.
 */

export const METADATA_FILENAME = "component-metadata.json";

export interface LibraryConfig {
  name: string;
  selectorPrefix: string;
  packageName: string;
  version: string;
  /** Framework of the loaded metadata. Absent (legacy pre-v4.2 files) means "angular". */
  framework?: "angular" | "react";
}

let _config: LibraryConfig | null = null;

export function setLibraryConfig(config: LibraryConfig): void {
  _config = config;
}

export function getLibraryConfig(): LibraryConfig {
  if (!_config) {
    return {
      name: "component-library",
      selectorPrefix: "",
      packageName: "unknown",
      version: "0.0.0",
    };
  }
  return _config;
}
