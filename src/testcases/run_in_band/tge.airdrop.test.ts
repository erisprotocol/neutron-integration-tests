import {
  CosmosWrapper,
  NEUTRON_DENOM,
  WalletWrapper,
} from '../../helpers/cosmos';
import { NeutronContract } from '../../helpers/types';
import { TestStateLocalCosmosTestNet } from '../common_localcosmosnet';
import { Airdrop, getTimestamp } from '../../helpers/tge';
import { CodeId } from '../../types';

const waitTill = (timestamp: number): Promise<void> =>
  new Promise((resolve) => {
    const diff = timestamp - Date.now() / 1000;
    setTimeout(() => {
      resolve();
    }, diff * 1000);
  });

describe('Neutron / TGE / Airdrop', () => {
  let testState: TestStateLocalCosmosTestNet;
  let neutronChain: CosmosWrapper;
  let neutronAccount1: WalletWrapper;
  let neutronAccount2: WalletWrapper;
  const codeIds: Record<string, CodeId> = {};
  const contractAddresses: Record<string, string> = {};
  let airdrop: InstanceType<typeof Airdrop>;
  const times: Record<string, number> = {};
  let reserveAddress: string;

  beforeAll(async () => {
    testState = new TestStateLocalCosmosTestNet();
    await testState.init();
    reserveAddress =
      testState.wallets.qaNeutronThree.genQaWal1.address.toString();
    neutronChain = new CosmosWrapper(
      testState.sdk1,
      testState.blockWaiter1,
      NEUTRON_DENOM,
    );
    neutronAccount1 = new WalletWrapper(
      neutronChain,
      testState.wallets.qaNeutron.genQaWal1,
    );
    neutronAccount2 = new WalletWrapper(
      neutronChain,
      testState.wallets.qaNeutronThree.genQaWal1,
    );
    const accounts = [
      {
        address: testState.wallets.neutron.demo1.address.toString(),
        amount: '100000',
      },
      {
        address: testState.wallets.neutron.demo2.address.toString(),
        amount: '200000',
      },
      {
        address: neutronAccount1.wallet.address.toString(),
        amount: '300000',
      },
      {
        address: neutronAccount2.wallet.address.toString(),
        amount: '100000',
      },
    ];
    airdrop = new Airdrop(accounts);
  });

  describe('Deploy', () => {
    it('should store contracts', async () => {
      for (const contract of ['TGE_CREDITS', 'TGE_AIRDROP']) {
        const codeId = await neutronAccount1.storeWasm(
          NeutronContract[contract],
        );
        expect(codeId).toBeGreaterThan(0);
        codeIds[contract] = codeId;
      }
    });
    it('should instantiate credits contract', async () => {
      const res = await neutronAccount1.instantiateContract(
        codeIds['TGE_CREDITS'],
        JSON.stringify({
          dao_address: neutronAccount1.wallet.address.toString(),
        }),
        'credits',
      );
      expect(res).toBeTruthy();
      contractAddresses['TGE_CREDITS'] = res[0]._contract_address;
    });
    it('should instantiate airdrop contract', async () => {
      times.airdropStart = getTimestamp(30);
      times.airdropVestingStart = getTimestamp(40);
      times.vestingDuration = 25;
      const initParams = {
        credits_address: contractAddresses['TGE_CREDITS'],
        reserve_address: reserveAddress,
        merkle_root: airdrop.getMerkleRoot(),
        airdrop_start: times.airdropStart,
        vesting_start: times.airdropVestingStart,
        vesting_duration_seconds: times.vestingDuration,
        total_amount: '100000000',
        hrp: 'neutron',
      };
      const res = await neutronAccount1.instantiateContract(
        codeIds['TGE_AIRDROP'],
        JSON.stringify(initParams),
        'airdrop',
      );
      expect(res).toBeTruthy();
      contractAddresses['TGE_AIRDROP'] = res[0]._contract_address;
    });
    test('config query should match with instantiate params', async () => {
      expect(
        await neutronChain.queryContract(contractAddresses.TGE_AIRDROP, {
          config: {},
        }),
      ).toMatchObject({
        owner: neutronAccount1.wallet.address.toString(),
        credits_address: contractAddresses.TGE_CREDITS,
        reserve_address: reserveAddress,
      });
    });
    it('should set airdrop address for credits contract', async () => {
      times.creditsWhenWithdrawable = getTimestamp(50);
      const res = await neutronAccount1.executeContract(
        contractAddresses['TGE_CREDITS'],
        JSON.stringify({
          update_config: {
            config: {
              airdrop_address: contractAddresses['TGE_AIRDROP'],
              when_withdrawable: times.creditsWhenWithdrawable,
            },
          },
        }),
      );
      expect(res.code).toEqual(0);
    });
  });

  describe('Airdrop', () => {
    let proofMain: string[];
    let proofSecond: string[];
    beforeAll(() => {
      proofMain = airdrop.getMerkleProof({
        address: neutronAccount1.wallet.address.toString(),
        amount: '300000',
      });
      proofSecond = airdrop.getMerkleProof({
        address: neutronAccount2.wallet.address.toString(),
        amount: '100000',
      });
    });
    it('should not claim before airdrop start', async () => {
      const payload = {
        claim: {
          address: neutronAccount1.wallet.address.toString(),
          amount: '300000',
          proof: proofMain,
        },
      };
      await expect(
        neutronAccount1.executeContract(
          contractAddresses['TGE_AIRDROP'],
          JSON.stringify(payload),
        ),
      ).rejects.toThrow(/Airdrop begins at/);
    });
    it('should not pause before airdrop start', async () => {
      const payload = {
        pause: {},
      };
      await expect(
        neutronAccount1.executeContract(
          contractAddresses['TGE_AIRDROP'],
          JSON.stringify(payload),
        ),
      ).rejects.toThrow(/Airdrop begins at/);
    });
    it('should not claim before airdrop mint', async () => {
      const payload = {
        claim: {
          address: neutronAccount1.wallet.address.toString(),
          amount: '300000',
          proof: proofMain,
        },
      };
      await expect(
        neutronAccount1.executeContract(
          contractAddresses['TGE_AIRDROP'],
          JSON.stringify(payload),
        ),
      ).rejects.toThrow(/Airdrop begins at/);
    });
    it('should return is claimed false', async () => {
      const res = await neutronChain.queryContract<{ is_claimed: boolean }>(
        contractAddresses['TGE_AIRDROP'],
        {
          is_claimed: {
            address: neutronAccount1.wallet.address.toString(),
          },
        },
      );
      expect(res).toEqual({ is_claimed: false });
    });
    it('should mint credits CW20 tokens', async () => {
      const res = await neutronAccount1.executeContract(
        contractAddresses['TGE_CREDITS'],
        JSON.stringify({
          mint: {},
        }),
        [{ amount: '1000000', denom: NEUTRON_DENOM }],
      );
      expect(res.code).toEqual(0);
    });
    it('should not claim airdrop more than needed', async () => {
      await waitTill(times.airdropStart + 5);
      const proofs = airdrop.getMerkleProof({
        address: neutronAccount1.wallet.address.toString(),
        amount: '300000',
      });
      const payload = {
        claim: {
          address: neutronAccount1.wallet.address.toString(),
          amount: '400000',
          proof: proofs,
        },
      };
      await expect(
        neutronAccount1.executeContract(
          contractAddresses['TGE_AIRDROP'],
          JSON.stringify(payload),
        ),
      ).rejects.toThrow(/Verification failed/);
    });
    it('should not claim airdrop with wrong proof', async () => {
      const proofs = airdrop.getMerkleProof({
        address: testState.wallets.neutron.demo2.address.toString(),
        amount: '200000',
      });
      const payload = {
        claim: {
          address: neutronAccount1.wallet.address.toString(),
          amount: '400000',
          proof: proofs,
        },
      };
      await expect(
        neutronAccount1.executeContract(
          contractAddresses['TGE_AIRDROP'],
          JSON.stringify(payload),
        ),
      ).rejects.toThrow(/Verification failed/);
    });
    it('should claim airdrop', async () => {
      const proofs = airdrop.getMerkleProof({
        address: neutronAccount1.wallet.address.toString(),
        amount: '300000',
      });
      const payload = {
        claim: {
          address: neutronAccount1.wallet.address.toString(),
          amount: '300000',
          proof: proofs,
        },
      };
      const res = await neutronAccount1.executeContract(
        contractAddresses['TGE_AIRDROP'],
        JSON.stringify(payload),
      );
      expect(res.code).toEqual(0);
    });
    it('should return is claimed true', async () => {
      const res = await neutronChain.queryContract<{ is_claimed: boolean }>(
        contractAddresses['TGE_AIRDROP'],
        {
          is_claimed: {
            address: neutronAccount1.wallet.address.toString(),
          },
        },
      );
      expect(res).toEqual({ is_claimed: true });
    });
    it('should not claim twice', async () => {
      const proofs = airdrop.getMerkleProof({
        address: neutronAccount1.wallet.address.toString(),
        amount: '300000',
      });
      const payload = {
        claim: {
          address: neutronAccount1.wallet.address.toString(),
          amount: '300000',
          proof: proofs,
        },
      };
      await expect(
        neutronAccount1.executeContract(
          contractAddresses['TGE_AIRDROP'],
          JSON.stringify(payload),
        ),
      ).rejects.toThrow(/Already claimed/);
    });
    it('should return correct balance', async () => {
      const res = await neutronChain.queryContract<{ balance: string }>(
        contractAddresses['TGE_CREDITS'],
        {
          balance: {
            address: neutronAccount1.wallet.address.toString(),
          },
        },
      );
      expect(res).toEqual({ balance: '300000' });
    });
    it('should return is_pause false', async () => {
      const res = await neutronChain.queryContract<{ is_paused: boolean }>(
        contractAddresses['TGE_AIRDROP'],
        {
          is_paused: {},
        },
      );
      expect(res).toEqual({ is_paused: false });
    });
    it('should be able to pause', async () => {
      const payload = {
        pause: {},
      };
      const res = await neutronAccount1.executeContract(
        contractAddresses['TGE_AIRDROP'],
        JSON.stringify(payload),
      );
      expect(res.code).toEqual(0);
    });
    it('should return is_pause true', async () => {
      const res = await neutronChain.queryContract<{ is_paused: boolean }>(
        contractAddresses['TGE_AIRDROP'],
        {
          is_paused: {},
        },
      );
      expect(res).toEqual({ is_paused: true });
    });
    it('should not claim because of pause', async () => {
      const proofs = airdrop.getMerkleProof({
        address: neutronAccount1.wallet.address.toString(),
        amount: '300000',
      });
      const payload = {
        claim: {
          address: neutronAccount1.wallet.address.toString(),
          amount: '300000',
          proof: proofs,
        },
      };
      await expect(
        neutronAccount1.executeContract(
          contractAddresses['TGE_AIRDROP'],
          JSON.stringify(payload),
        ),
      ).rejects.toThrow(/Airdrop is paused/);
    });
    it('should be able to resume', async () => {
      const payload = {
        resume: {},
      };
      const res = await neutronAccount1.executeContract(
        contractAddresses['TGE_AIRDROP'],
        JSON.stringify(payload),
      );
      expect(res.code).toEqual(0);
    });
    it('should be able to claim after resume', async () => {
      const payload = {
        claim: {
          address: neutronAccount2.wallet.address.toString(),
          amount: '100000',
          proof: proofSecond,
        },
      };
      const res = await neutronAccount2.executeContract(
        contractAddresses['TGE_AIRDROP'],
        JSON.stringify(payload),
        [],
      );
      expect(res.code).toEqual(0);
    });
    it('should return correct total claimed', async () => {
      const res = await neutronChain.queryContract<{
        total_claimed: string;
      }>(contractAddresses['TGE_AIRDROP'], {
        total_claimed: {},
      });
      expect(res).toEqual({ total_claimed: '400000' });
    });
    it('should not be able to withdraw all before end', async () => {
      await expect(
        neutronAccount1.executeContract(
          contractAddresses['TGE_AIRDROP'],
          JSON.stringify({
            withdraw_all: {},
          }),
          [],
        ),
      ).rejects.toThrow(
        /withdraw_all is unavailable, it will become available at/,
      );
    });
    it('should be able to withdraw all', async () => {
      await waitTill(times.airdropVestingStart + times.vestingDuration + 5);
      const availableBalanceCNTRN = await neutronChain.queryContract<{
        balance: string;
      }>(contractAddresses['TGE_CREDITS'], {
        balance: {
          address: contractAddresses['TGE_AIRDROP'],
        },
      });
      const reserveBalanceNTRN = (
        await neutronChain.queryBalances(reserveAddress)
      ).balances.find((b) => b.denom === NEUTRON_DENOM)?.amount;
      const res = await neutronAccount1.executeContract(
        contractAddresses['TGE_AIRDROP'],
        JSON.stringify({
          withdraw_all: {},
        }),
        [],
      );
      expect(res.code).toEqual(0);

      const availableBalanceCNTRNAfter = await neutronChain.queryContract<{
        balance: string;
      }>(contractAddresses['TGE_CREDITS'], {
        balance: {
          address: contractAddresses['TGE_AIRDROP'],
        },
      });
      const reserveBalanceNTRNAfter = (
        await neutronChain.queryBalances(reserveAddress)
      ).balances.find((b) => b.denom === NEUTRON_DENOM)?.amount;
      expect(availableBalanceCNTRNAfter.balance).toEqual('0');
      expect(
        parseInt(reserveBalanceNTRNAfter || '0') -
          parseInt(reserveBalanceNTRN || '0'),
      ).toEqual(parseInt(availableBalanceCNTRN.balance));
    });
  });
});
