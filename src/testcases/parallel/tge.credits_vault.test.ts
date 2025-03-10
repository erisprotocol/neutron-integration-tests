import { TestStateLocalCosmosTestNet } from '../common_localcosmosnet';
import {
  CosmosWrapper,
  NEUTRON_DENOM,
  WalletWrapper,
} from '../../helpers/cosmos';
import { AccAddress, ValAddress } from '@cosmos-client/core/cjs/types';
import { Wallet } from '../../types';
import { CreditsVaultConfig } from '../../helpers/dao';
import { NeutronContract } from '../../helpers/types';
import { InlineResponse20075TxResponse } from '@cosmos-client/core/cjs/openapi/api';
import { getHeight } from '../../helpers/wait';

describe('Neutron / Credits Vault', () => {
  let testState: TestStateLocalCosmosTestNet;
  let neutronChain: CosmosWrapper;
  let daoWallet: Wallet;
  let airdropWallet: Wallet;
  let lockdropWallet: Wallet;

  let daoAccount: WalletWrapper;
  let airdropAccount: WalletWrapper;

  let daoAddr: AccAddress | ValAddress;
  let airdropAddr: AccAddress | ValAddress;
  let lockdropAddr: AccAddress | ValAddress;

  beforeAll(async () => {
    testState = new TestStateLocalCosmosTestNet();
    await testState.init();
    daoWallet = testState.wallets.qaNeutron.genQaWal1;
    airdropWallet = testState.wallets.qaNeutronFour.genQaWal1;
    lockdropWallet = testState.wallets.qaNeutronFive.genQaWal1;

    lockdropAddr = lockdropWallet.address;

    neutronChain = new CosmosWrapper(
      testState.sdk1,
      testState.blockWaiter1,
      NEUTRON_DENOM,
    );

    daoAccount = new WalletWrapper(neutronChain, daoWallet);
    daoAddr = daoAccount.wallet.address;
    airdropAccount = new WalletWrapper(neutronChain, airdropWallet);
    airdropAddr = airdropAccount.wallet.address;
  });

  const originalName = 'credits_vault';
  const originalDescription = 'A credits vault for test purposes.';
  describe('Credits vault', () => {
    let creditsContractAddr: string;
    let creditsVaultAddr: string;

    beforeEach(async () => {
      creditsContractAddr = await setupCreditsContract(
        daoAccount,
        daoAddr.toString(),
        airdropAddr.toString(),
        lockdropAddr.toString(),
        1676016745597000,
      );

      creditsVaultAddr = await setupCreditsVault(
        daoAccount,
        originalName,
        originalDescription,
        creditsContractAddr,
        daoAddr.toString(),
        airdropAddr.toString(),
      );
    });

    test('Get config', async () => {
      expect(
        await getVaultConfig(neutronChain, creditsVaultAddr),
      ).toMatchObject({
        name: originalName,
        description: originalDescription,
        credits_contract_address: creditsContractAddr,
        owner: daoAddr.toString(),
        airdrop_contract_address: airdropAddr.toString(),
      });
    });

    const newName = 'new_credits_vault';
    const newDescription = 'A new description for the credits vault.';
    test('Update config', async () => {
      const res = await updateVaultConfig(
        daoAccount,
        creditsVaultAddr,
        creditsContractAddr,
        newName,
        newDescription,
        daoAddr.toString(),
      );
      expect(res.code).toEqual(0);

      expect(
        await getVaultConfig(neutronChain, creditsVaultAddr),
      ).toMatchObject({
        name: newName,
        description: newDescription,
        credits_contract_address: creditsContractAddr,
        owner: daoAddr.toString(),
        airdrop_contract_address: airdropAddr.toString(),
      });
    });

    test('Airdrop always has zero voting power', async () => {
      const currentHeight = await getHeight(neutronChain.sdk);
      expect(
        await getVotingPowerAtHeight(
          neutronChain,
          creditsVaultAddr,
          airdropAddr.toString(),
          currentHeight,
        ),
      ).toMatchObject({
        height: currentHeight,
        power: '0',
      });
    });

    test('Airdrop is never included in total voting power', async () => {
      let currentHeight = await getHeight(neutronChain.sdk);
      expect(
        await getTotalPowerAtHeight(
          neutronChain,
          creditsVaultAddr,
          currentHeight,
        ),
      ).toMatchObject({
        height: currentHeight,
        power: '0',
      });

      await mintTokens(daoAccount, creditsContractAddr, '1000');
      await neutronChain.blockWaiter.waitBlocks(1);

      currentHeight = await getHeight(neutronChain.sdk);
      expect(
        await getTotalPowerAtHeight(
          neutronChain,
          creditsVaultAddr,
          currentHeight,
        ),
      ).toMatchObject({
        height: currentHeight,
        power: '0',
      });

      await sendTokens(
        airdropAccount,
        creditsContractAddr,
        daoAddr.toString(),
        '500',
      );
      await neutronChain.blockWaiter.waitBlocks(1);

      currentHeight = await getHeight(neutronChain.sdk);
      expect(
        await getVotingPowerAtHeight(
          neutronChain,
          creditsVaultAddr,
          daoAddr.toString(),
          currentHeight,
        ),
      ).toMatchObject({
        height: currentHeight,
        power: '500',
      });
      expect(
        await getTotalPowerAtHeight(
          neutronChain,
          creditsVaultAddr,
          currentHeight,
        ),
      ).toMatchObject({
        height: currentHeight,
        power: '500',
      });
    });

    test('Query voting power at different heights', async () => {
      const firstHeight = await getHeight(neutronChain.sdk);

      await mintTokens(daoAccount, creditsContractAddr, '1000');
      await sendTokens(
        airdropAccount,
        creditsContractAddr,
        daoAddr.toString(),
        '1000',
      );
      await neutronChain.blockWaiter.waitBlocks(1);
      const secondHeight = await getHeight(neutronChain.sdk);

      await mintTokens(daoAccount, creditsContractAddr, '1000');
      await sendTokens(
        airdropAccount,
        creditsContractAddr,
        daoAddr.toString(),
        '1000',
      );
      await neutronChain.blockWaiter.waitBlocks(1);
      const thirdHeight = await getHeight(neutronChain.sdk);

      expect(
        await getTotalPowerAtHeight(
          neutronChain,
          creditsVaultAddr,
          secondHeight,
        ),
      ).toMatchObject({
        height: secondHeight,
        power: '1000',
      });
      expect(
        await getVotingPowerAtHeight(
          neutronChain,
          creditsVaultAddr,
          daoAddr.toString(),
          secondHeight,
        ),
      ).toMatchObject({
        height: secondHeight,
        power: '1000',
      });

      expect(
        await getTotalPowerAtHeight(
          neutronChain,
          creditsVaultAddr,
          firstHeight,
        ),
      ).toMatchObject({
        height: firstHeight,
        power: '0',
      });
      expect(
        await getVotingPowerAtHeight(
          neutronChain,
          creditsVaultAddr,
          daoAddr.toString(),
          firstHeight,
        ),
      ).toMatchObject({
        height: firstHeight,
        power: '0',
      });

      expect(
        await getTotalPowerAtHeight(
          neutronChain,
          creditsVaultAddr,
          thirdHeight,
        ),
      ).toMatchObject({
        height: thirdHeight,
        power: '2000',
      });
      expect(
        await getVotingPowerAtHeight(
          neutronChain,
          creditsVaultAddr,
          daoAddr.toString(),
          thirdHeight,
        ),
      ).toMatchObject({
        height: thirdHeight,
        power: '2000',
      });
    });
  });
});

const setupCreditsVault = async (
  wallet: WalletWrapper,
  name: string,
  description: string,
  creditsContractAddress: string,
  owner: string,
  airdropContractAddress: string,
) => {
  const codeId = await wallet.storeWasm(NeutronContract.CREDITS_VAULT);
  return (
    await wallet.instantiateContract(
      codeId,
      JSON.stringify({
        name,
        description,
        credits_contract_address: creditsContractAddress,
        owner,
        airdrop_contract_address: airdropContractAddress,
      }),
      'credits_vault',
    )
  )[0]._contract_address;
};

const setupCreditsContract = async (
  wallet: WalletWrapper,
  daoAddress: string,
  airdropAddress: string,
  lockdropAddress: string,
  whenWithdrawable: number,
) => {
  const codeId = await wallet.storeWasm(NeutronContract.TGE_CREDITS);
  const creditsContractAddress = (
    await wallet.instantiateContract(
      codeId,
      JSON.stringify({
        dao_address: daoAddress,
      }),
      'credits',
    )
  )[0]._contract_address;

  await updateCreditsContractConfig(
    wallet,
    creditsContractAddress,
    airdropAddress,
    lockdropAddress,
    whenWithdrawable,
  );

  return creditsContractAddress;
};

const updateCreditsContractConfig = async (
  wallet: WalletWrapper,
  creditsContractAddress: string,
  airdropAddress: string,
  lockdropAddress: string,
  whenWithdrawable: number,
): Promise<InlineResponse20075TxResponse> =>
  wallet.executeContract(
    creditsContractAddress,
    JSON.stringify({
      update_config: {
        config: {
          airdrop_address: airdropAddress,
          lockdrop_address: lockdropAddress,
          when_withdrawable: whenWithdrawable,
        },
      },
    }),
  );

const getVaultConfig = async (
  cm: CosmosWrapper,
  creditsVaultContract: string,
): Promise<CreditsVaultConfig> =>
  cm.queryContract<CreditsVaultConfig>(creditsVaultContract, {
    config: {},
  });

const getTotalPowerAtHeight = async (
  cm: CosmosWrapper,
  creditsVaultContract: string,
  height: number,
): Promise<CreditsVaultConfig> =>
  cm.queryContract<CreditsVaultConfig>(creditsVaultContract, {
    total_power_at_height: {
      height,
    },
  });

const getVotingPowerAtHeight = async (
  cm: CosmosWrapper,
  creditsVaultContract: string,
  address: string,
  height: number,
): Promise<CreditsVaultConfig> =>
  cm.queryContract<CreditsVaultConfig>(creditsVaultContract, {
    voting_power_at_height: {
      address,
      height,
    },
  });

const mintTokens = async (
  wallet: WalletWrapper,
  creditsContractAddress: string,
  amount: string,
): Promise<InlineResponse20075TxResponse> =>
  wallet.executeContract(
    creditsContractAddress,
    JSON.stringify({
      mint: {},
    }),
    [
      {
        amount,
        denom: NEUTRON_DENOM,
      },
    ],
  );

const sendTokens = async (
  wallet: WalletWrapper,
  creditsContractAddress: string,
  recipient: string,
  amount: string,
): Promise<InlineResponse20075TxResponse> =>
  wallet.executeContract(
    creditsContractAddress,
    JSON.stringify({
      transfer: {
        recipient,
        amount,
      },
    }),
  );

const updateVaultConfig = async (
  wallet: WalletWrapper,
  vaultContract: string,
  creditsContractAddress: string,
  name: string,
  description: string,
  owner?: string,
): Promise<InlineResponse20075TxResponse> =>
  wallet.executeContract(
    vaultContract,
    JSON.stringify({
      update_config: {
        credits_contract_address: creditsContractAddress,
        owner,
        name,
        description,
      },
    }),
  );
