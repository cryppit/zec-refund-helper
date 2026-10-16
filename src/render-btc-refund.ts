// Plain-text report for a Bitcoin or Zcash deposit check (CLI): one headline for what happened, then what is left to do.

import type { BtcDepositReport } from "./btc-refund.js";
import { describeDuration } from "./core/duration.js";
import { refundPath, REQUEST_WINDOW, UTXO_CHAINS, type BoardRow, type BtcDepositFacts, type BtcDepositVerdict, type UtxoChain } from "./core/btc-refund.js";
import { classifyZcashAddress, describeZcashAddress } from "./core/zcash-address.js";

type Report = Exclude<BtcDepositReport, { error: string }>;

const day = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 10);
const when = (sec: number): string => new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const coins = (sat: number): string => (sat / 1e8).toFixed(8);

/** "the Ironwood shielded pool", "the Sapling and Orchard shielded pools", "a shielded pool". */
function poolName(f: BtcDepositFacts): string {
  const p = f.funding.pools;
  if (p.length === 0) return "a shielded pool";
  return `the ${p.join(" and ")} shielded pool${p.length > 1 ? "s" : ""}`;
}

export function fromWhom(f: BtcDepositFacts): string {
  if (f.funding.kind === "shielded") return `${poolName(f)} (no transparent sender)`;
  const t = f.senders.join(", ") || "?";
  return f.funding.kind === "mixed" ? `${t} and ${poolName(f)}` : t;
}

/** The address, and for Zcash what kind it is. */
const named = (chain: UtxoChain, address: string): string => (chain === "zcash" ? `${address}, ${describeZcashAddress(classifyZcashAddress(address))}` : address);

/** For Zcash: which refund the connector can make to this address, and why a shielded one needs a bundle built off-chain. */
function zcashRefundLines(address: string): string[] {
  const a = classifyZcashAddress(address);
  const path = refundPath("zcash", address);
  if (path === "none") {
    return [
      `The Zcash connector cannot pay ${describeZcashAddress(a)}: a refund is either one transparent output or a shielded bundle paying an Orchard receiver, and this address has neither a transparent nor an Orchard receiver. A refund request to it would be accepted but could never be executed, so ask the Omni bridge team for help instead of paying for one.`,
    ];
  }
  if (path === "transparent") return ["A transparent refund: execute_refund pays this address one ordinary output, with no shielded bundle, so near-cli can send it."];
  const why =
    "The contract cannot write a shielded output by itself: it needs a note encrypted to the recipient and a zero-knowledge proof, made off-chain. So bridge-cli (v0.3.69 or later) builds the shielded bundle (the proof, the encrypted note, the exact amount) and passes it to execute_refund; the contract checks that it pays this address's Orchard receiver the deposit minus the fee, then NEAR's MPC network signs the deposit input. Since NU6.3 no new value can enter the Orchard pool, so the refund lands in the Ironwood pool, at this same Orchard receiver: no new address is needed. Shielded is not hidden: the refund's address and amount can be read (see What others can see).";
  if (a.refund.transparent) return [`This address also has a transparent receiver. bridge-cli refunds to its Orchard receiver by default (shielded); --transparent pays its transparent receiver instead, in public. ${why}`];
  return [`This address has no transparent receiver, so the refund must be shielded: execute_refund without a bundle would try a transparent output and fail. ${why}`];
}

function feeLine(r: Report, amountSat: number, feeSat: number, stored: boolean): string {
  const { unit, minor } = UTXO_CHAINS[r.facts.chain];
  const why = stored ? "fee stored on the request" : r.facts.chain === "zcash" ? "refund fee (the ZIP-317 minimum the Zcash connector charges)" : "refund fee (the connector's max_btc_gas_fee)";
  return `A refund returns ${coins(amountSat - feeSat)} ${unit}: the deposit minus the ${feeSat}-${minor.replace(/s$/, "")} ${why}.`;
}

/** Where a requested refund goes, what it returns, and (Zcash) which execute_refund it needs. */
function requestLines(r: Report, refundTo: string): string[] {
  const q = r.facts.request;
  const lines = [`The bridge can only send it to ${named(r.facts.chain, refundTo)}.`];
  if (q) lines.push(feeLine(r, q.amountSat, q.gasFeeSat, true));
  if (r.facts.chain === "zcash") lines.push(...zcashRefundLines(refundTo));
  return lines;
}

/**
 * What happened to the deposit: the state in capitals, then why (and, for a request, where it goes and its fee).
 * The CLI and the web page say the same thing.
 */
export function headline(r: Report): string[] {
  const v = r.verdict;
  const f = r.facts;
  const { name, minor } = UTXO_CHAINS[f.chain];
  switch (v.state) {
    case "unconfirmed":
      return [`NOT CONFIRMED YET  the bridge counts a deposit only after ${name} confirms it; check again later.`];
    case "not_a_deposit":
      return [
        `NOT AN OMNI ${f.chain.toUpperCase()} DEPOSIT  no output of this transaction pays a deposit address the Omni ${name} bridge knows.`,
        "A deposit through the PoA bridge is not covered here.",
      ];
    case "credited":
      return [`CREDITED  the bridge took this deposit in; its NEAR order account is ${v.orderAccount}.`];
    case "absorbed":
      return [
        `ABSORBED  the bridge verified this deposit but it is below the ${v.minDepositSat}-${minor.replace(/s$/, "")} minimum, so nothing was minted on NEAR. The contract keeps the coin in its unavailable UTXOs and has no refund path for it: request_refund refuses a verified deposit, and no method spends or releases it.`,
        "Only the Omni bridge team can recover it (a contract change); this tool has no commands to give.",
      ];
    case "placeholder_refund":
      return [
        `NOT RECOVERABLE BY ITS SENDER  the deposit message pins the refund to ${v.refundTo}, a public example address used in documentation, not the depositor's wallet. The bridge can only refund there, so do not request it.`,
        "Only the Omni bridge team can recover it; this tool has no commands to give.",
      ];
    case "too_old":
      return [
        `TOO OLD TO REQUEST  the bridge's light client keeps ${REQUEST_WINDOW[f.chain].span} of ${name} blocks and no longer has this deposit's (since about ${day(v.requestBySec)}), so request_refund fails.`,
        "Only the Omni bridge team can recover it; this tool has no commands to give.",
      ];
    case "refunded":
      return [`REFUNDED  sent back to ${v.refundTo} in ${name} transaction ${v.refundTx}`];
    case "crediting":
      return [`CREDITING  not credited yet, which is normal in the first hours; if nothing changes by ${when(v.stuckAfterSec)}, check again for the refund steps.`];
    case "requested":
      return [`REFUND REQUESTED  the lock ends on ${when(v.unlocksAtSec)}; after that anyone can execute it.`, ...requestLines(r, v.refundTo)];
    case "ready":
      return [
        `READY TO REFUND  the refund was requested on ${day(f.request?.createdAtSec ?? v.unlockedAtSec)} and its lock ended on ${day(v.unlockedAtSec)}; nobody has executed it yet.`,
        ...requestLines(r, v.refundTo),
      ];
    case "executed":
      return [`REFUND EXECUTED  waiting for the bridge to sign the ${name} refund to ${v.refundTo} and broadcast it.`];
    case "refundable": {
      const lines = [`STUCK  confirmed ${day(f.confirmedAtSec ?? 0)} and never credited on NEAR. The bridge's own refund can send it back.`];
      if (v.belowMinimum) lines.push(`It is below the bridge's ${r.config.minDepositSat}-${minor.replace(/s$/, "")} minimum deposit, which is likely why it was never credited.`);
      if (v.tooSmall) {
        lines.push(`It is not larger than the refund fee (${v.feeSat} ${minor}), so the contract would refuse a refund request.`);
        return lines;
      }
      if (v.refundTo === null && v.noTransparentSender) {
        lines.push(
          `This deposit came from ${poolName(f)}, so it has no transparent sender, and it names no refund address. You name the address in the request: use one you control, ideally your own unified address with an Orchard receiver so the refund stays shielded (a Sapling-only zs1 address cannot be refunded by this contract). The contract cannot check that the address is yours, so this takes the ${Math.round(v.lockSec / 86_400)}-day lock, during which the bridge's DAO or operator can reject a false claim.`,
        );
      } else if (v.refundTo === null) {
        lines.push(`Several wallets funded this transaction, so we cannot tell which is yours; the refund address has to be named by the depositor (bridge-cli --refund-address).`);
      } else {
        lines.push(
          v.refundToFromDeposit
            ? `The deposit names its refund address: ${named(f.chain, v.refundTo)}.`
            : `The deposit names no refund address; the refund would go to the wallet that sent it: ${named(f.chain, v.refundTo)}.`,
        );
        if (f.chain === "zcash") lines.push(...zcashRefundLines(v.refundTo));
      }
      lines.push(feeLine(r, f.amountSat, v.feeSat, false));
      return lines;
    }
  }
}

export function renderBtcRefundText(r: Report): string {
  const f = r.facts;
  const { name, unit } = UTXO_CHAINS[f.chain];
  const lines: string[] = [];
  lines.push(`${`${name} deposit`.padEnd(18)}${f.txid} (output ${f.vout})`);
  lines.push(`                  ${coins(f.amountSat)} ${unit} from ${fromWhom(f)} to ${f.depositAddress}${f.confirmedAtSec ? `, confirmed ${when(f.confirmedAtSec)}` : ""}`);
  if (r.orderAccount) lines.push(`For NEAR account  ${r.orderAccount}`);
  lines.push("");
  lines.push(...headline(r));
  const intro = stepsIntro(r);
  if (intro) {
    lines.push("");
    lines.push(`What is left. ${intro}`);
    r.steps.forEach((s, i) => {
      lines.push(`${i + 1}. ${s.title}`);
      if (s.command) lines.push(`   ${s.command}`);
      if (s.note) lines.push(`   ${s.note}`);
    });
    lines.push(NEAR_CLI_TIMEOUT_NOTE);
  }
  const privacy = privacyLines(r);
  if (privacy.length) {
    lines.push("");
    lines.push("What others can see:");
    for (const line of privacy) lines.push(`- ${line}`);
  }
  lines.push("");
  lines.push(sourcesLine(r));
  return lines.join("\n");
}

/** The refund address, for the states that have a refund to talk about. */
function refundAddressOf(v: BtcDepositVerdict): string | null {
  switch (v.state) {
    case "requested":
    case "ready":
    case "executed":
    case "refunded":
    case "refundable":
      return v.refundTo;
    default:
      return null;
  }
}

/**
 * What anyone watching the chains can see about this deposit, and what stays hidden. The bridge only takes deposits at
 * transparent addresses, so the way in is public. A refund to an address with an Orchard receiver is shielded (since
 * NU6.3 in the Ironwood pool) but readable: the address is on NEAR, and the connector checks the bundle by recovering
 * its output with an all-zero outgoing viewing key (orchard_policy.rs, BRIDGE_OVK), which anyone can do too.
 */
export function privacyLines(r: Report): string[] {
  const f = r.facts;
  if (!f.msg) return [];
  const lines: string[] = [];
  if (f.chain === "btc") {
    lines.push(`Public: the sender, ${f.senders.join(", ") || "the sending wallet"}; Bitcoin has no shielded pool.`, "Public: the amount and the bridge's deposit address.");
  } else {
    if (f.funding.kind === "shielded") lines.push(`Hidden: the sender; the ZEC came straight from ${poolName(f)}.`);
    else if (f.funding.kind === "mixed") lines.push(`Partly public: the transparent sender ${f.senders.join(", ")} is public; the rest came from ${poolName(f)}, which hides its sender.`);
    else lines.push(`Public: the sender, ${f.senders.join(", ") || "a transparent address"}.`);
    lines.push("Public: the amount and the bridge's deposit address; the bridge only takes deposits at transparent addresses, so every deposit is visible on the way in.");
  }
  if (r.orderAccount) lines.push(`Public: the NEAR account this deposit is for, ${r.orderAccount}, named in the bridge's deposit message.`);
  const refundTo = refundAddressOf(r.verdict);
  if (refundTo) {
    const path = f.chain === "zcash" ? refundPath("zcash", refundTo) : "transparent";
    if (path === "shielded") {
      lines.push(
        `Public: where the refund goes, ${refundTo}: the address is on NEAR (in the deposit message or the refund request), and the bridge writes shielded outputs with an all-zero outgoing viewing key, so anyone can recover the refund's recipient and amount from the Zcash transaction.`,
        "Hidden: what happens to the ZEC next, while it stays shielded; since NU6.3 the refund lands in the Ironwood pool, at this address's Orchard receiver.",
      );
    }
    else if (path === "transparent") lines.push(`Public: the refund, ${f.chain === "btc" ? "an ordinary Bitcoin payment" : "a transparent payment"} to ${refundTo}.`);
  }
  if (r.steps.length) lines.push("Public: the NEAR account that signs the steps above, linked to this deposit for good.");
  return lines;
}

/** Who signs the steps and where the coin can go; null when nothing is left to do. */
export function stepsIntro(r: Report): string | null {
  if (!r.steps.length) return null;
  const where = r.verdict.state === "refundable" && r.verdict.refundTo === null ? "the address named in the request" : "the address above";
  return `Sign each step with a NEAR account you control; anyone can pay these fees, and the coin can only go to ${where}. That account is linked to this deposit in public, so for privacy use one not tied to your name or main wallet.`;
}

// nearcore 2.14 changes the RPC's timeout error; older near CLIs can report one for a call that landed.
export const NEAR_CLI_TIMEOUT_NOTE = "If the near CLI shows an error or a timeout, look the transaction up on nearblocks.io before sending it again: it may have gone through.";

/** Where every fact in the report came from. */
export function sourcesLine(r: Report): string {
  const { connector } = UTXO_CHAINS[r.facts.chain];
  const explorer = r.facts.chain === "btc" ? "mempool.space" : "Blockchair";
  return `Sources: ${explorer}; the Omni bridge indexer's deposit message, checked against ${connector}; ${connector} (refund request, timelocks, fees). We never hold keys or sign anything.`;
}

/** The stuck-money board: every open refund request, ready ones first. */
export function renderRefundBoardText(rows: BoardRow[], nowSec: number): string {
  if (rows.length === 0) return "No refund requests are open on the Omni Bitcoin and Zcash bridges.";
  const lines = [`${rows.length} refund request${rows.length === 1 ? "" : "s"} on the Omni Bitcoin and Zcash bridges (${when(nowSec)}):`, ""];
  for (const r of rows) {
    const state = r.state === "ready" ? `READY ${describeDuration(r.readyForSec)}` : r.state === "locked" ? `locked until ${day(r.unlocksAtSec)}` : "executed";
    lines.push(`${state.padEnd(14)} ${(r.amountSat / 1e8).toFixed(8)} ${UTXO_CHAINS[r.chain].unit}  -> ${r.refundTo}  ${r.txid}@${r.vout}`);
  }
  lines.push("", "READY: the lock has passed and anyone can execute the refund; the coin can only go to the address shown.");
  return lines.join("\n");
}
