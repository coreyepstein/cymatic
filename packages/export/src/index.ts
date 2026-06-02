/**
 * @cymatic/export — render-to-file export pipeline for cymatic.
 *
 * Early scaffold. Frame capture and encoding (WebM/MP4/GIF) arrive in later
 * stories.
 */
import { version as coreVersion } from "@cymatic/core";

/** Semantic version of the @cymatic/export package surface. */
export const version = "0.0.0";

/** The version of @cymatic/core this exporter was built against. */
export const builtAgainstCore = coreVersion;

/** Export target formats supported by this build (none yet). */
export const supportedFormats: readonly string[] = [];
