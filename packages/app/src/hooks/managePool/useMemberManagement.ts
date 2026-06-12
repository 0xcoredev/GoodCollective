import { useCallback, useEffect, useMemo, useState } from 'react';
import { GoodCollectiveSDK } from '@gooddollar/goodcollective-sdk';
import { useEthersProvider, useEthersSigner } from '../useEthers';
import { SupportedNetwork, SupportedNetworkNames } from '../../models/constants';
import { StewardCollective } from '../../models/models';
import {
  assessPoolMemberEligibility,
  formatSkippedMembersMessage,
  isZeroAddress,
} from '../../lib/poolMemberEligibility';
import { parseMemberAddresses, validateMemberAddresses } from '../../lib/memberAddresses';

// Pool types as emitted by the subgraph factory mappings.
// See packages/subgraph/src/mappings/poolFactory.ts.
const UBI_POOL_TYPE = 'UBI';
const DIRECT_PAYMENTS_POOL_TYPE = 'DirectPayments';

interface UseMemberManagementParams {
  poolAddress?: string;
  pooltype?: string;
  chainId: number;
  /**
   * Initial member list from the subgraph (collective.stewardCollectives).
   * Used as the source of truth for steady state; the hook only goes on-chain
   * via sdk.getUBIPoolMembers for an immediate refresh after the user's own
   * add/remove tx, since the subgraph takes a few seconds to index events.
   */
  initialMembers?: StewardCollective[];
}

const toMemberAddresses = (stewards: StewardCollective[] | undefined): string[] =>
  stewards?.map((s) => s.steward.toLowerCase()) ?? [];

export const useMemberManagement = ({ poolAddress, pooltype, chainId, initialMembers }: UseMemberManagementParams) => {
  const provider = useEthersProvider({ chainId });
  const signer = useEthersSigner({ chainId });

  const sdk = useMemo(() => {
    if (!provider || !chainId) return null;
    const chainIdString = chainId.toString() as `${SupportedNetwork}`;
    const network = SupportedNetworkNames[chainId as SupportedNetwork];
    return new GoodCollectiveSDK(chainIdString, provider as any, { network });
  }, [chainId, provider]);

  const [memberInput, setMemberInput] = useState('');
  const [memberError, setMemberError] = useState<string | null>(null);
  const [memberSuccess, setMemberSuccess] = useState<string | null>(null);
  const [isAddingMembers, setIsAddingMembers] = useState(false);
  const [removingMemberAddress, setRemovingMemberAddress] = useState<string | null>(null);

  const subgraphMembers = useMemo(() => toMemberAddresses(initialMembers), [initialMembers]);

  // Steady-state member list seeded from the subgraph. Add/remove flows update
  // this locally (and refresh from chain for UBI) so the UI stays in sync
  // between subgraph polls.
  const [managedMembers, setManagedMembers] = useState<string[]>(subgraphMembers);
  const [totalMemberCount, setTotalMemberCount] = useState<number | null>(
    initialMembers ? initialMembers.length : null
  );

  // Re-seed from subgraph whenever the upstream data changes (poll refresh,
  // route change, etc.). The local set is replaced rather than merged because
  // the subgraph is authoritative for steady state.
  useEffect(() => {
    if (initialMembers === undefined) return;
    setManagedMembers(toMemberAddresses(initialMembers));
    setTotalMemberCount(initialMembers.length);
  }, [initialMembers]);

  // Pull the live on-chain member set for UBI pools. Only called right after
  // the user's own add/remove tx so the UI reflects the change before the
  // subgraph has indexed the events. Falls back to a no-op on DirectPayments
  // pools (no SDK helper) and on read failures (we keep the optimistic state).
  const refreshUbiMembersFromChain = useCallback(async (): Promise<void> => {
    if (!sdk || !poolAddress || pooltype !== UBI_POOL_TYPE) return;
    try {
      const result = await sdk.getUBIPoolMembers(poolAddress);
      setManagedMembers(result.members);
      setTotalMemberCount(result.onChainCount ?? result.count);
    } catch (error) {
      // Optimistic local state already reflects the user's intent; the next
      // subgraph poll will reconcile if the SDK read failed.
      console.error('Failed to refresh UBI members after tx:', error);
    }
  }, [sdk, poolAddress, pooltype]);

  const parsedMemberAddresses = useMemo(() => parseMemberAddresses(memberInput), [memberInput]);

  useEffect(() => {
    if (memberInput.trim() !== '') {
      setMemberSuccess(null);
      setMemberError(null);
    }
  }, [memberInput]);

  const clearStatus = () => {
    setMemberError(null);
    setMemberSuccess(null);
  };

  const handleAddMembers = async () => {
    clearStatus();
    const error = validateMemberAddresses(parsedMemberAddresses);
    if (error) {
      setMemberError(error);
      return;
    }

    if (!signer || !poolAddress || !pooltype || !provider || !sdk) {
      setMemberError('Pool management is not fully initialized.');
      return;
    }

    if (pooltype !== UBI_POOL_TYPE && pooltype !== DIRECT_PAYMENTS_POOL_TYPE) {
      setMemberError('Member management is currently supported for UBI and Direct Payments pools only.');
      return;
    }

    const addressesToAdd = parsedMemberAddresses.filter(
      (addr) => !managedMembers.some((m) => m.toLowerCase() === addr.toLowerCase())
    );

    if (addressesToAdd.length === 0) {
      setMemberError('All entered addresses are already members of this pool.');
      return;
    }

    try {
      setIsAddingMembers(true);
      const operatorAddress = (await signer.getAddress()).toLowerCase();
      const pool = pooltype === UBI_POOL_TYPE ? sdk.ubipool.attach(poolAddress) : sdk.pool.attach(poolAddress);
      const settings = (await (pool as any).settings()) as {
        membersValidator?: string;
        uniquenessValidator?: string;
      };

      const { validAddresses, skippedAddresses } = await assessPoolMemberEligibility({
        provider,
        addresses: addressesToAdd,
        uniquenessValidator: settings.uniquenessValidator,
        membersValidator: settings.membersValidator,
        poolAddress,
        operatorAddress,
        existingMembers: managedMembers,
      });

      if (validAddresses.length === 0) {
        const skippedSummary = formatSkippedMembersMessage(skippedAddresses);
        const fallbackReason =
          pooltype === UBI_POOL_TYPE && !isZeroAddress(settings.uniquenessValidator)
            ? 'For this pool, members must be verified by the pool uniqueness validator before they can be added.'
            : 'None of the pasted addresses can be added to this pool.';

        setMemberError(skippedSummary ? `No members were added. ${skippedSummary}` : fallbackReason);
        setMemberSuccess(null);
        return;
      }

      const extraData = validAddresses.map(() => '0x');
      const tx = await sdk.addPoolMembers(signer as any, poolAddress, validAddresses, extraData);
      await tx.wait();

      // Optimistically merge the newly-added valid addresses into local state.
      // For UBI pools we also refresh from chain so the count reflects on-chain
      // truth even if validation skipped some addresses server-side.
      setManagedMembers((prev) => {
        const next = new Set(prev.map((a) => a.toLowerCase()));
        validAddresses.forEach((a) => next.add(a.toLowerCase()));
        return Array.from(next);
      });
      if (pooltype === UBI_POOL_TYPE) {
        await refreshUbiMembersFromChain();
      } else {
        setTotalMemberCount((prev) => (prev ?? managedMembers.length) + validAddresses.length);
      }

      const skippedSummary = formatSkippedMembersMessage(skippedAddresses);
      setMemberInput('');
      setMemberSuccess(
        `Successfully added ${validAddresses.length} member${validAddresses.length !== 1 ? 's' : ''}.${
          skippedSummary ? ` Skipped: ${skippedSummary}.` : ''
        }`
      );
    } catch (e: any) {
      setMemberError(e?.reason || e?.message || 'Failed to add members.');
      setMemberSuccess(null);
    } finally {
      setIsAddingMembers(false);
    }
  };

  const handleRemoveMember = async (member: string) => {
    clearStatus();

    if (!signer || !poolAddress || !provider || !sdk) {
      setMemberError('Pool management is not fully initialized.');
      return;
    }

    if (pooltype !== UBI_POOL_TYPE) {
      setMemberError('Member removal is currently supported for UBI pools only.');
      return;
    }

    try {
      setRemovingMemberAddress(member);

      const tx = await sdk.removeUBIPoolMember(signer as any, poolAddress, member);
      await tx.wait();

      // Optimistic local removal so the row disappears immediately, then
      // reconcile with chain state.
      const memberLower = member.toLowerCase();
      setManagedMembers((prev) => prev.filter((m) => m.toLowerCase() !== memberLower));
      await refreshUbiMembersFromChain();

      setMemberSuccess('Successfully removed member.');
    } catch (e: any) {
      setMemberError(e?.reason || e?.message || 'Failed to remove member.');
      setMemberSuccess(null);
    } finally {
      setRemovingMemberAddress(null);
    }
  };

  return {
    memberInput,
    setMemberInput,
    memberError,
    memberSuccess,
    isAddingMembers,
    removingMemberAddress,
    managedMembers,
    totalMemberCount,
    handleAddMembers,
    handleRemoveMember,
    parsedMemberAddresses,
  };
};
