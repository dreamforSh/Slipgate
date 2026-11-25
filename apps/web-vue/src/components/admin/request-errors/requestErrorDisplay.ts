import type { RequestErrorPhase } from "@slipgate/contracts";
import type { Tone } from "../../../lib/format";

/** Badge tone of a request-error phase (ops error center and the usage page's errors tab). */
export function phaseTone(phase: RequestErrorPhase): Tone {
  switch (phase) {
    case "upstream_http":
      return "warning";
    case "outbound":
    case "stream_relay":
      return "danger";
    case "core_eval":
      return "violet";
    case "ingress":
      return "info";
    default:
      return "neutral";
  }
}
