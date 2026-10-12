// Bevy telemetry adapted for the imported cockpit components.
import type {snapshot} from "./telemetry";
export type SimSnapshot = ReturnType<typeof snapshot>;
export type GliderState = SimSnapshot["state"];
