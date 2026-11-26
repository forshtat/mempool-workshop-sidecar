/**
 * Runner for EELS `mempool_test` fixtures (execution-specs PR #4073 format).
 *
 * Playground: the verdict backend is pluggable. The first backend asks an
 * ethrex node, through `testing_validateTransactionV1`, whether its public
 * mempool admits the transaction against the fixture's `pre` state, injected
 * as a State Override Set. Nothing is staged on chain, so one node serves all
 * fixtures without restarts.
 *
 *   bun test/mempool-fixtures/run.ts <fixture.json|dir> [--rpc http://localhost:8545] [--filter substr]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fromRlp, toRlp, hexToBytes, type Hex } from "viem";

type Alloc = Record<
  string,
  { nonce?: string; balance?: string; code?: string; storage?: Record<string, string> }
>;

interface Fixture {
  network: string;
  config: { chainid: string };
  head: { number: string; timestamp: string; gasLimit: string; baseFeePerGas?: string };
  pre: Alloc;
  policy?: { minTip?: string };
  txbytes: string;
  broadcast: boolean;
  mempoolRuleset: string;
  _info?: { mempool?: { rules?: string[] } };
}

interface Verdict {
  admitted: boolean;
  reason?: string;
}

const SUPPORTED_RULESET = "public-mempool-v1";

function files(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((name) => files(join(path, name)));
}

/** `pre` allocation -> geth State Override Set. `state` replaces all storage. */
function toStateOverrides(pre: Alloc): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [address, account] of Object.entries(pre)) {
    const pad = (hex: string) => "0x" + hex.replace(/^0x/, "").padStart(64, "0");
    const storage = Object.fromEntries(
      Object.entries(account.storage ?? {}).map(([slot, value]) => [pad(slot), pad(value)]),
    );
    const override: Record<string, unknown> = { state: storage };
    if (account.balance !== undefined) override.balance = account.balance;
    if (account.nonce !== undefined) override.nonce = account.nonce;
    if (account.code !== undefined && account.code !== "0x") override.code = account.code;
    out[address] = override;
  }
  return out;
}

async function rpc(url: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body: any = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

/**
 * Encoding bridge. The fixtures come from EELS `forks/bogota` (EIP-8141 with a
 * single `nonce`); ethrex bogota-devnet-2 takes the
 * EIP-8250 envelope (`nonce_keys`, `nonce_seq`). Frames and fees are identical.
 * The signature hash differs between the two, so the bridge is only sound for
 * transactions whose validation does not depend on it (self-verify accounts, empty
 * signature list).
 */
function toDevnet2Encoding(txbytes: string): string {
  if (hexToBytes(txbytes as Hex)[0] !== 0x06) return txbytes;
  const [chainId, nonce, sender, frames, signatures, fees, blobHashes] = fromRlp(
    ("0x" + txbytes.slice(4)) as Hex,
  ) as any[];
  if (!Array.isArray(nonce) && typeof nonce !== "string") return txbytes;
  const body = toRlp([chainId, [], nonce, sender, frames, signatures, fees, blobHashes]);
  return "0x06" + body.slice(2);
}

/** Backend 1: ethrex's own public-mempool verdict. */
function ethrexBackend(url: string) {
  return async (fixture: Fixture): Promise<Verdict> => {
    const result = await rpc(url, "testing_validateTransactionV1", [
      toDevnet2Encoding(fixture.txbytes),
      "latest",
      toStateOverrides(fixture.pre),
      null,
      { minTip: fixture.policy?.minTip ?? "0x0" },
    ]);
    return { admitted: result.admitted, reason: result.error ?? undefined };
  };
}

async function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith("--"));
  const opt = (name: string, dflt?: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : dflt;
  };
  if (!target) {
    console.error("usage: run.ts <fixture.json|dir> [--rpc URL] [--filter substr]");
    process.exit(2);
  }
  const verdictOf = ethrexBackend(opt("--rpc", "http://localhost:8545")!);
  const filter = opt("--filter");

  let passed = 0, failed = 0, skipped = 0;
  for (const file of files(target).filter((f) => f.endsWith(".json"))) {
    const fixtures = JSON.parse(readFileSync(file, "utf8")) as Record<string, Fixture>;
    for (const [name, fixture] of Object.entries(fixtures)) {
      if (filter && !name.includes(filter)) continue;
      if (fixture.mempoolRuleset !== SUPPORTED_RULESET) {
        skipped++;
        console.log(`SKIP  ${name}  (ruleset ${fixture.mempoolRuleset})`);
        continue;
      }
      try {
        const verdict = await verdictOf(fixture);
        const ok = verdict.admitted === fixture.broadcast;
        ok ? passed++ : failed++;
        console.log(
          `${ok ? "PASS" : "FAIL"}  ${name}  expected=${fixture.broadcast} got=${verdict.admitted}` +
            (verdict.reason ? `  [${verdict.reason}]` : ""),
        );
      } catch (err) {
        failed++;
        console.log(`ERROR ${name}  ${(err as Error).message}`);
      }
    }
  }
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed ? 1 : 0);
}

main();
