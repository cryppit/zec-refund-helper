// A Zcash address checked before sending: what it is, whether a transparent-only or a shielded wallet can pay it, and
// which refund the Omni bridge can make to it. Read offline from the address itself; the page and the CLI share these words.
import { classifyZcashAddress, describeZcashAddress, refundAddressNote, zcashSendAdvice, type SendAnswer, type ZcashAddressInfo } from "./core/zcash-address.js";

export const OFFLINE_NOTE = "Read from the address itself, in your browser or terminal: nothing is looked up or sent anywhere.";
const MARK: Record<SendAnswer["can"], string> = { yes: "✓", "if-supported": "✓", no: "✕" };

/** A pasted Zcash address (any kind this helper recognizes, valid or not), or null for anything else. */
export function asZcashAddress(raw: string): ZcashAddressInfo | null {
  const a = classifyZcashAddress(raw);
  return a.kind === "unknown" ? null : a;
}

export function renderAddressText(a: ZcashAddressInfo): string {
  const advice = zcashSendAdvice(a);
  const note = refundAddressNote(a);
  return [
    a.address,
    describeZcashAddress(a),
    "",
    `What this means for you: ${advice.next}`,
    `  ${MARK[advice.transparent.can]} From a transparent-only wallet: ${advice.transparent.why}`,
    `  ${MARK[advice.shielded.can]} From a shielded wallet: ${advice.shielded.why}`,
    ...(note ? ["", note] : []),
    "",
    OFFLINE_NOTE,
  ].join("\n");
}
