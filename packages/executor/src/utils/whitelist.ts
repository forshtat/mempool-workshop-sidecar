import { getAddress } from "viem";
import { IWhitelistedEntities } from "@skandha/types/lib/executor/index.js";

export type EntityRole = "sender" | "payer" | "factory";

/**
 * Maps a validation-prefix role to the `IWhitelistedEntities` key for the
 * analogous ERC-4337 concept:
 *  - "sender" (validates tx.sender's own authorization - either via a
 *    dedicated `only_verify` frame in the Canonical Paymaster shape, or
 *    folded into the `payer` frame itself in the Self Relay shape)
 *    corresponds to ERC-4337's "account".
 *  - "payer" (whoever's approval frame ends up paying gas - the sender
 *    itself when self-relaying) corresponds to ERC-4337's "paymaster".
 *  - "factory" is unchanged.
 */
export const roleToWhitelistKey: Record<
  EntityRole,
  keyof IWhitelistedEntities
> = {
  sender: "account",
  payer: "paymaster",
  factory: "factory",
};

/** Whether `addr` is whitelisted in the config under any of `roles`. */
export function isWhitelistedAs(
  whitelisted: IWhitelistedEntities,
  addr: string,
  roles: EntityRole[]
): boolean {
  return roles.some((role) =>
    (whitelisted[roleToWhitelistKey[role]] ?? []).some(
      (listed) => getAddress(listed) === getAddress(addr)
    )
  );
}
