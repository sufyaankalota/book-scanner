// Wire protocol shared between pod client (../src) and dedup server
// (../server). Both sides import from here so a renamed field fails to
// compile on both ends instead of silently drifting.
//
// Concrete message shapes land here once the dedup service is built.

export const WS_PROTOCOL_VERSION = 1 as const;

export type Placeholder = {
  v: typeof WS_PROTOCOL_VERSION;
};
