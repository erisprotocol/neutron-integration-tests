import 'jest-extended';
import { cosmosclient, rest } from '@cosmos-client/core';
import { AccAddress } from '@cosmos-client/core/cjs/types';
import {
  COSMOS_DENOM,
  CosmosWrapper,
  getSequenceId,
  IBC_ATOM_DENOM,
  NEUTRON_DENOM,
  WalletWrapper,
} from '../../helpers/cosmos';
import { AcknowledgementResult, NeutronContract, AckFailuresResponse, ErisContract } from '../../helpers/types';
import { TestStateLocalCosmosTestNet } from '../common_localcosmosnet';
import { getWithAttempts, wait } from '../../helpers/wait';
import { CosmosSDK } from '@cosmos-client/core/cjs/sdk';
import { getIca } from '../../helpers/ica';
import { ExecuteMsg } from '../../ics/hub/execute';
import { QueryMsg } from '../../ics/hub/query';
import { InstantiateMsg } from '../../ics/hub/instantiate';
import { ConfigResponse } from '../../ics/hub/response_to_config';
import { IcaResponse } from '../../ics/hub/response_to_ica';
import { StateResponse } from '../../ics/hub/response_to_state';
import { UnbondRequestsByUserResponseItemDetails } from '../../ics/hub/response_to_unbond_requests_by_user_details';
import { Wallet } from '../../types';
import { BroadcastTxMode } from '@cosmos-client/core/cjs/rest/tx/module';
import Long from 'long';

const IBC_ATOM_DENOM_REAL = 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2';

const SECONDS = 1000;
jest.setTimeout(15 * 60 * SECONDS);

describe('ERIS TXs', () => {
  let testState: TestStateLocalCosmosTestNet;
  let neutronChain: CosmosWrapper;
  let gaiaChain: CosmosWrapper;
  let neutronAccount: WalletWrapper;
  let gaiaAccount: WalletWrapper;
  let contractAddress: string;
  let icaAddress1: string;
  let icaAddress2: string;
  const ica_fee_collector = 'ica_fee_collector';
  const ica_reward_collector = 'ica_reward_collector';
  const ica_hub = 'ica_hub';

  const connectionId = 'connection-0';

  let owner: WalletWrapper;
  let admin: Wallet;
  let operator: WalletWrapper;
  let delegation_operator: Wallet;
  let fee_addr: WalletWrapper;
  let validator: Wallet;
  let user1: WalletWrapper;
  let user2: WalletWrapper;

  beforeAll(async () => {
    testState = new TestStateLocalCosmosTestNet();
    await testState.init();
    neutronChain = new CosmosWrapper(testState.sdk1, testState.blockWaiter1, NEUTRON_DENOM);
    neutronAccount = new WalletWrapper(neutronChain, testState.wallets.qaNeutron.genQaWal1);
    gaiaChain = new CosmosWrapper(testState.sdk2, testState.blockWaiter2, COSMOS_DENOM);
    gaiaAccount = new WalletWrapper(gaiaChain, testState.wallets.qaCosmos.genQaWal1);

    owner = new WalletWrapper(neutronChain, testState.wallets.qaNeutron.genQaWal1);
    admin = testState.wallets.qaNeutron.genQaWal1;
    user1 = new WalletWrapper(neutronChain, testState.wallets.neutron.demo1);
    user2 = new WalletWrapper(neutronChain, testState.wallets.neutron.demo2);

    operator = new WalletWrapper(neutronChain, testState.wallets.qaNeutronThree.genQaWal1);
    delegation_operator = testState.wallets.qaNeutronFour.genQaWal1;
    fee_addr = new WalletWrapper(neutronChain, testState.wallets.qaNeutronFive.genQaWal1);
    validator = testState.wallets.cosmos.val1;

    const res = await gaiaAccount.msgIBCTransfer(
      'transfer',
      'channel-0',
      { denom: COSMOS_DENOM, amount: '100000000' },
      user1.wallet.address.toString(),
      {
        revision_number: new Long(2),
        revision_height: new Long(100000000),
      },
    );

    expect(res.code).toBe(0);
    await getWithAttempts(
      neutronChain.blockWaiter,
      () => user1.queryDenomBalance(IBC_ATOM_DENOM_REAL),
      async (val) => val > 0,
    );
  });

  describe('Interchain Tx with multiple ICAs', () => {
    let codeId: number;

    describe('Setup', () => {
      test('store contract', async () => {
        console.log('store contract');
        codeId = await neutronAccount.storeWasm(ErisContract.HUB);
        expect(codeId).toBeGreaterThan(0);
      });
      test('instantiate', async () => {
        console.log('instantiate');
        const res = (
          await neutronAccount.instantiateContract(
            codeId,
            JSON.stringify(<InstantiateMsg>{
              denom: 'ampATOM',
              utoken_controller: IBC_ATOM_DENOM_REAL,
              utoken_host: COSMOS_DENOM,
              delegation_operator: delegation_operator.address.toString(),
              // epoch_period: 3 * 24 * 60 * 60,
              // unbond_period: 21 * 24 * 60 * 60,
              epoch_period: Math.ceil((10 * 60) / 7),
              unbond_period: 10 * 60,
              fee_addr: fee_addr.wallet.address.toString(),
              operator: operator.wallet.address.toString(),
              owner: owner.wallet.address.toString(),
              reward_fee: '0.05',
              validators: [validator.address.toString()],
            }),
            'eris hub',
            owner.wallet.address.toString(),
            [
              {
                denom: NEUTRON_DENOM,
                amount: (1e6).toString(),
              },
            ],
          )
        )[0]._contract_address;

        contractAddress = res;
      });
    });
    let channelCount = 0;
    let hub = '';
    let reward = '';
    let fee = '';
    let state: StateResponse;
    let config: ConfigResponse;
    let ampATOM = '';
    describe('Create ICAs and setup contract', () => {
      test('create ICAs', async () => {
        console.log('create ICAs');
        let ibcChannels = await neutronChain.listIBCChannels();
        channelCount = ibcChannels.channels.length;
        const res = await neutronAccount.executeContract(
          contractAddress,
          JSON.stringify(<ExecuteMsg>{
            a_create_accounts: {
              connection_id: connectionId,
              controller_channel: 'channel-0',
              host_channel: 'channel-0',
              host_prefix: 'cosmos',
              min_reward_restake: (1e5).toString(),
              min_fee_withdrawal: (1e4).toString(),
            },
          }),
        );
        expect(res.code).toEqual(0);
      });
      test('multiple IBC accounts created', async () => {
        console.log('multiple IBC accounts created');
        const channels = await getWithAttempts(
          neutronChain.blockWaiter,
          () => neutronChain.listIBCChannels(),
          // Wait until there are 3 channels:
          // - one exists already, it is open for IBC transfers;
          // - two more should appear soon since we are opening them implicitly
          //   through ICA creation.
          async (channels) =>
            channels.channels.length == channelCount + 3 &&
            !channels.channels.some((a) => a.counterparty.channel_id == ''),
        );
        expect(channels.channels).toBeArray();
        expect(channels.channels).toIncludeAllPartialMembers([
          {
            port_id: `icacontroller-${contractAddress}.${ica_fee_collector}`,
          },
          {
            port_id: `icacontroller-${contractAddress}.${ica_reward_collector}`,
          },
          {
            port_id: `icacontroller-${contractAddress}.${ica_hub}`,
          },
        ]);
      });
      test('create ICQs', async () => {
        console.log('create ICQs');
        const res = await neutronAccount.executeContract(
          contractAddress,
          JSON.stringify(<ExecuteMsg>{
            a_register_icqs: {
              denoms: [COSMOS_DENOM],
              balance_blocks: 5,
              delegations_blocks: 10,
            },
          }),
          [
            {
              amount: (2e6).toString(),
              denom: NEUTRON_DENOM,
            },
          ],
        );
        // console.log(JSON.stringify(res));
        expect(res.code).toEqual(0);
      });
      // test('recreate ICQs', async () => {
      //   console.log('recreate ICQs');
      //   const res = await neutronAccount.executeContract(
      //     contractAddress,
      //     JSON.stringify(<ExecuteMsg>{
      //       a_register_icqs: {
      //         denoms: [COSMOS_DENOM],
      //         balance_blocks: 5,
      //         delegations_blocks: 20,
      //       },
      //     }),
      //     [
      //       {
      //         amount: (2e6).toString(),
      //         denom: NEUTRON_DENOM,
      //       },
      //     ],
      //   );
      //   // console.log(JSON.stringify(res));
      //   expect(res.code).toEqual(0);
      // });

      test('setup ACK fee', async () => {
        console.log('setup ACK fee');
        let fee = '1000';
        const res = await neutronAccount.executeContract(
          contractAddress,
          JSON.stringify(<ExecuteMsg>{
            a_update_config: {
              ack_fee: [
                {
                  amount: fee,
                  denom: NEUTRON_DENOM,
                },
              ],
              timeout_fee: [
                {
                  amount: fee,
                  denom: NEUTRON_DENOM,
                },
              ],
            },
          }),
          [],
        );
        expect(res.code).toEqual(0);

        await neutronAccount.msgSend(contractAddress, (1e6).toString());
      });

      test('get ica address', async () => {
        console.log('get ica address');

        const result = await getWithAttempts(
          neutronChain.blockWaiter,
          () =>
            neutronChain.queryContract<IcaResponse>(contractAddress, <QueryMsg>{
              ica: {},
            }),
          async (result) => (result.ica_config?.icq_delegations_id ?? 0) > 0,
        );

        hub = result.ica_senders[0].address;
        reward = result.ica_senders[1].address;
        fee = result.ica_senders[2].address;
        state = await neutronChain.queryContract<StateResponse>(contractAddress, <QueryMsg>{ state: {} });
        config = await neutronChain.queryContract<ConfigResponse>(contractAddress, <QueryMsg>{ config: {} });
        ampATOM = config.stake_token;

        console.log(
          'HUB',
          `http://localhost:1317/cosmos/tx/v1beta1/txs?events=wasm._contract_address%3D%27${contractAddress}%27&pagination.limit=100&order_by=2`,
        );
        console.log(
          'HUB-ICA',
          `http://localhost:1316/cosmos/tx/v1beta1/txs?events=message.sender%3D%27${hub}%27&pagination.limit=100&order_by=2`,
        );

        console.log(JSON.stringify(result, null, 2));
      });

      test('setup withdraw address', async () => {
        console.log('setup withdraw address');

        const res = await operator.executeContract(
          contractAddress,
          JSON.stringify(<ExecuteMsg>{
            o_withdraw_rewards: { validators: [] },
          }),
          [],
        );

        expect(res.code).toBe(0);
      });
    });

    describe('User actions', () => {
      test('user deposits wrong denom', async () => {
        console.log('user deposits wrong denom');
        let res = await expect(
          user1.executeContract(
            contractAddress,
            <ExecuteMsg>{
              bond: {},
            },
            [
              {
                denom: NEUTRON_DENOM,
                amount: (1e6).toString(),
              },
            ],
            undefined,
            BroadcastTxMode.Async,
          ),
        ).rejects.toThrow();
      });

      test('user deposits', async () => {
        console.log('user deposits');
        let result = await user1.executeContract(
          contractAddress,
          <ExecuteMsg>{
            bond: {},
          },
          [
            {
              denom: IBC_ATOM_DENOM_REAL,
              amount: (1e6).toString(),
            },
          ],
          undefined,
          BroadcastTxMode.Block,
        );

        await getWithAttempts(
          gaiaChain.blockWaiter,
          () => gaiaChain.queryDenomBalance(hub, COSMOS_DENOM),
          async (result) => {
            return result > 0;
          },
        );

        await getWithAttempts(
          gaiaChain.blockWaiter,
          () => gaiaChain.queryDelegations(hub),
          async (result) => {
            return result.delegation_responses.length > 0;
          },
          50,
        );
      });

      test('user2 deposits through hook', async () => {
        console.log('user2 deposits through hook');
        let result = await gaiaAccount.executeContractThroughHook(
          contractAddress,
          <ExecuteMsg>{
            bond: {
              receiver: user2.wallet.address.toString(),
            },
          },
          {
            denom: COSMOS_DENOM,
            amount: (3e6).toString(),
          },
        );
        expect(result.code).toBe(0);

        let received = await getWithAttempts(
          neutronChain.blockWaiter,
          () => user2.queryDenomBalance(ampATOM),
          async (result) => {
            return result > 0;
          },
        );

        expect(received).toBe(3e6);

        await getWithAttempts(
          gaiaChain.blockWaiter,
          () => gaiaChain.queryDelegations(hub),
          async (result) => {
            return +result.delegation_responses[0].balance.amount >= 4e6;
          },
          50,
        );
      });
    });

    describe('operations', () => {
      test('withdraw rewards', async () => {
        console.log('withdraw rewards');
        let result = await operator.executeContract(contractAddress, <ExecuteMsg>{
          o_withdraw_rewards: {},
        });

        expect(result.code).toBe(0);

        await gaiaAccount.msgSend(reward, (2e5).toString());

        await getWithAttempts(
          gaiaChain.blockWaiter,
          () => gaiaChain.queryDenomBalance(reward, COSMOS_DENOM),
          async (result) => {
            return result > 0;
          },
        );

        await getWithAttempts(
          neutronChain.blockWaiter,
          () =>
            neutronChain.queryContract<IcaResponse>(contractAddress, <QueryMsg>{
              ica: {},
            }),
          async (result) =>
            +(result.account_balances.accounts[reward].coins.find((a) => a.denom === COSMOS_DENOM)?.amount ?? 0) > 0,
        );

        await getWithAttempts(
          gaiaChain.blockWaiter,
          () => gaiaChain.queryDelegations(hub),
          async (result) => {
            console.log(JSON.stringify(result));
            // now it is bigger than 4
            return +(result.delegation_responses[0]?.balance.amount ?? 0) > 4e6;
          },
          20,
        );
      });

      test('wait for fee collector', async () => {
        let result = await getWithAttempts(
          gaiaChain.blockWaiter,
          () => fee_addr.queryDenomBalance(IBC_ATOM_DENOM_REAL),
          async (result) => {
            return result > 0;
          },
          20,
        );
        console.log('RECEIVED FEE', result);
      });
    });

    describe('User actions - unbond', () => {
      test('user unbonds wrong denom', async () => {
        console.log('user unbonds wrong denom');
        let res = await expect(
          user1.executeContract(
            contractAddress,
            <ExecuteMsg>{
              queue_unbond: {},
            },
            [
              {
                denom: NEUTRON_DENOM,
                amount: (1e6).toString(),
              },
            ],
            undefined,
            BroadcastTxMode.Async,
          ),
        ).rejects.toThrow();
      });

      test('user unbonds', async () => {
        console.log('user unbonds');
        let result = await user1.executeContract(
          contractAddress,
          <ExecuteMsg>{
            queue_unbond: {},
          },
          [
            {
              denom: ampATOM,
              amount: (5e5).toString(),
            },
          ],
          undefined,
          BroadcastTxMode.Block,
        );

        let res = await getWithAttempts(
          neutronChain.blockWaiter,
          () =>
            neutronChain.queryContract<UnbondRequestsByUserResponseItemDetails[]>(contractAddress, <QueryMsg>{
              unbond_requests_by_user_details: {
                user: user1.wallet.address.toString(),
              },
            }),
          async (result) => {
            return result.length > 0;
          },
        );
        console.log(res);
      });
    });

    // describe('Random things', () => {
    //   test('deposit into rewards', async () => {
    //     // send 2 atom to reward account
    //     await gaiaAccount.msgSend(reward, (2e6).toString());

    //     const result2 = await getWithAttempts(
    //       neutronChain.blockWaiter,
    //       () =>
    //         neutronChain.queryContract<IcaResponse>(contractAddress, <QueryMsg>{
    //           ica: {},
    //         }),
    //       async (result) => +(result.account_balances.accounts[reward]?.coins[0]?.amount ?? 0) > 0,
    //     );

    //     console.log(result2);
    //   });
    // });

    describe('check resulting data', () => {
      test('print result data', async () => {
        state = await neutronChain.queryContract<StateResponse>(contractAddress, <QueryMsg>{ state: {} });
        config = await neutronChain.queryContract<ConfigResponse>(contractAddress, <QueryMsg>{ config: {} });
        let ica = await neutronChain.queryContract<ConfigResponse>(contractAddress, <QueryMsg>{ ica: {} });
        let balance = await fee_addr.queryBalances();

        console.log(`Accumulated fees ${fee_addr.wallet.address.toString()}`, balance);
        console.log(
          'HUB',
          `http://localhost:1317/cosmos/tx/v1beta1/txs?events=wasm._contract_address%3D%27${contractAddress}%27&pagination.limit=100&order_by=2`,
        );
        console.log(
          'HUB-ICA',
          `http://localhost:1316/cosmos/tx/v1beta1/txs?events=message.sender%3D%27${hub}%27&pagination.limit=100&order_by=2`,
        );
        console.log('STATE', JSON.stringify(state, null, 2));
        console.log('CONFIG', JSON.stringify(config, null, 2));
        console.log('ICA', JSON.stringify(ica, null, 2));
      });
    });

    describe('wait for unstake', () => {
      test('waiting for unstake', async () => {
        console.log('waiting for unstake');
        await wait(10 * 60);

        console.log('waiting for complete');
        let res = await getWithAttempts(
          neutronChain.blockWaiter,
          () =>
            neutronChain.queryContract<UnbondRequestsByUserResponseItemDetails[]>(contractAddress, <QueryMsg>{
              unbond_requests_by_user_details: {
                user: user1.wallet.address.toString(),
              },
            }),
          async (result) => {
            return result[0].state === 'COMPLETED' && (result[0].batch?.reconciled ?? false);
          },
          100,
        );

        let expectedAmount = (+res[0].shares / +res[0].batch!.total_shares) * +res[0].batch!.utoken_unclaimed;
        let currentBalance = await gaiaAccount.queryDenomBalance(COSMOS_DENOM);
        let result = await user1.executeContract(
          contractAddress,
          <ExecuteMsg>{
            withdraw_unbonded: {
              receiver: gaiaAccount.wallet.address.toString(),
            },
          },
          [],
          undefined,
          BroadcastTxMode.Async,
        );

        expect(result.code).toBe(0);

        console.log('WAITING RECEIVED');
        let received = await getWithAttempts(
          gaiaChain.blockWaiter,
          () => gaiaAccount.queryDenomBalance(COSMOS_DENOM),
          async (value) => value === currentBalance + expectedAmount,
          50,
        );

        console.log('DONE');
      });
    });

    //   test('set payer fees', async () => {
    //     const res = await neutronAccount.executeContract(
    //       contractAddress,
    //       JSON.stringify({
    //         set_fees: {
    //           denom: neutronChain.denom,
    //           ack_fee: '2000',
    //           recv_fee: '0',
    //           timeout_fee: '2000',
    //         },
    //       }),
    //     );
    //     expect(res.code).toEqual(0);
    //   });
    //   test('fund contract to pay fees', async () => {
    //     const res = await neutronAccount.msgSend(contractAddress, '100000');
    //     expect(res.code).toEqual(0);
    //   });
    //   test('add some money to ICAs', async () => {
    //     const res1 = await gaiaAccount.msgSend(icaAddress1.toString(), '10000');
    //     expect(res1.code).toEqual(0);
    //     const res2 = await gaiaAccount.msgSend(icaAddress2.toString(), '10000');
    //     expect(res2.code).toEqual(0);
    //   });
    // });
    // describe('Send Interchain TX', () => {
    //   test('delegate from first ICA', async () => {
    //     const res = await neutronAccount.executeContract(
    //       contractAddress,
    //       JSON.stringify({
    //         delegate: {
    //           interchain_account_id: icaId1,
    //           validator: (
    //             testState.wallets.cosmos.val1.address as cosmosclient.ValAddress
    //           ).toString(),
    //           amount: '2000',
    //           denom: gaiaChain.denom,
    //         },
    //       }),
    //     );
    //     expect(res.code).toEqual(0);
    //     const sequenceId = getSequenceId(res.raw_log);

    //     await waitForAck(neutronChain, contractAddress, icaId1, sequenceId);
    //     const qres = await getAck(
    //       neutronChain,
    //       contractAddress,
    //       icaId1,
    //       sequenceId,
    //     );
    //     expect(qres).toMatchObject<AcknowledgementResult>({
    //       success: ['/cosmos.staking.v1beta1.MsgDelegate'],
    //     });
    //   });
    //   test('check validator state', async () => {
    //     const res1 = await getWithAttempts(
    //       gaiaChain.blockWaiter,
    //       () =>
    //         rest.staking.delegatorDelegations(
    //           gaiaChain.sdk as CosmosSDK,
    //           icaAddress1 as unknown as AccAddress,
    //         ),
    //       async (delegations) =>
    //         delegations.data.delegation_responses?.length == 1,
    //     );
    //     expect(res1.data.delegation_responses).toEqual([
    //       {
    //         balance: { amount: '2000', denom: gaiaChain.denom },
    //         delegation: {
    //           delegator_address: icaAddress1,
    //           shares: '2000.000000000000000000',
    //           validator_address:
    //             'cosmosvaloper18hl5c9xn5dze2g50uaw0l2mr02ew57zk0auktn',
    //         },
    //       },
    //     ]);
    //     const res2 = await rest.staking.delegatorDelegations(
    //       gaiaChain.sdk as CosmosSDK,
    //       icaAddress2 as unknown as AccAddress,
    //     );
    //     expect(res2.data.delegation_responses).toEqual([]);
    //   });
    //   test('check contract balance', async () => {
    //     const res = await neutronChain.queryBalances(contractAddress);
    //     const balance = res.balances.find(
    //       (b) => b.denom === neutronChain.denom,
    //     )?.amount;
    //     expect(balance).toEqual('98000');
    //   });
    // });
    // describe('Error cases', () => {
    //   test('delegate for unknown validator from second ICA', async () => {
    //     const res = await neutronAccount.executeContract(
    //       contractAddress,
    //       JSON.stringify({
    //         delegate: {
    //           interchain_account_id: icaId2,
    //           validator: 'nonexistent_address',
    //           amount: '2000',
    //           denom: gaiaChain.denom,
    //         },
    //       }),
    //     );
    //     expect(res.code).toEqual(0);

    //     const sequenceId = getSequenceId(res.raw_log);

    //     await waitForAck(neutronChain, contractAddress, icaId2, sequenceId);
    //     const qres = await getAck(
    //       neutronChain,
    //       contractAddress,
    //       icaId2,
    //       sequenceId,
    //     );
    //     expect(qres).toMatchObject<AcknowledgementResult>({
    //       error: [
    //         'message',
    //         'ABCI code: 1: error handling packet: see events for details',
    //       ],
    //     });
    //   });
    //   test('undelegate from first ICA, delegate from second ICA', async () => {
    //     await cleanAckResults(neutronAccount, contractAddress);
    //     const res1 = await neutronAccount.executeContract(
    //       contractAddress,
    //       JSON.stringify({
    //         undelegate: {
    //           interchain_account_id: icaId1,
    //           validator: testState.wallets.cosmos.val1.address.toString(),
    //           amount: '1000',
    //           denom: gaiaChain.denom,
    //         },
    //       }),
    //     );
    //     expect(res1.code).toEqual(0);

    //     const sequenceId1 = getSequenceId(res1.raw_log);

    //     const res2 = await neutronAccount.executeContract(
    //       contractAddress,
    //       JSON.stringify({
    //         delegate: {
    //           interchain_account_id: icaId2,
    //           validator: testState.wallets.cosmos.val1.address.toString(),
    //           amount: '2000',
    //           denom: gaiaChain.denom,
    //         },
    //       }),
    //     );
    //     expect(res2.code).toEqual(0);

    //     const sequenceId2 = getSequenceId(res2.raw_log);

    //     const qres1 = await waitForAck(
    //       neutronChain,
    //       contractAddress,
    //       icaId1,
    //       sequenceId1,
    //     );
    //     expect(qres1).toMatchObject<AcknowledgementResult>({
    //       success: ['/cosmos.staking.v1beta1.MsgUndelegate'],
    //     });

    //     const qres2 = await waitForAck(
    //       neutronChain,
    //       contractAddress,
    //       icaId2,
    //       sequenceId2,
    //     );
    //     expect(qres2).toMatchObject<AcknowledgementResult>({
    //       success: ['/cosmos.staking.v1beta1.MsgDelegate'],
    //     });
    //   });
    //   test('delegate with timeout', async () => {
    //     await cleanAckResults(neutronAccount, contractAddress);
    //     const res = await neutronAccount.executeContract(
    //       contractAddress,
    //       JSON.stringify({
    //         delegate: {
    //           interchain_account_id: icaId1,
    //           validator: testState.wallets.cosmos.val1.address.toString(),
    //           amount: '10',
    //           denom: gaiaChain.denom,
    //           timeout: 1,
    //         },
    //       }),
    //     );
    //     expect(res.code).toEqual(0);

    //     const sequenceId = getSequenceId(res.raw_log);

    //     // timeout handling may be slow, hence we wait for up to 100 blocks here
    //     await waitForAck(
    //       neutronChain,
    //       contractAddress,
    //       icaId1,
    //       sequenceId,
    //       100,
    //     );
    //     const qres1 = await getAck(
    //       neutronChain,
    //       contractAddress,
    //       icaId1,
    //       sequenceId,
    //     );
    //     expect(qres1).toMatchObject<AcknowledgementResult>({
    //       timeout: 'message',
    //     });
    //   });
    //   test('delegate after the ICA channel was closed', async () => {
    //     let rawLog: string;
    //     try {
    //       rawLog =
    //         (
    //           await neutronAccount.executeContract(
    //             contractAddress,
    //             JSON.stringify({
    //               delegate: {
    //                 interchain_account_id: icaId1,
    //                 validator: testState.wallets.cosmos.val1.address.toString(),
    //                 amount: '10',
    //                 denom: gaiaChain.denom,
    //                 timeout: 1,
    //               },
    //             }),
    //           )
    //         ).raw_log || '';
    //     } catch (e) {
    //       rawLog = e.message;
    //     }
    //     expect(rawLog.includes('no active channel for this owner'));
    //   });
    //   describe('zero fee', () => {
    //     beforeAll(async () => {
    //       await neutronAccount.executeContract(
    //         contractAddress,
    //         JSON.stringify({
    //           set_fees: {
    //             denom: neutronChain.denom,
    //             ack_fee: '0',
    //             recv_fee: '0',
    //             timeout_fee: '0',
    //           },
    //         }),
    //       );
    //     });
    //     test('delegate with zero fee', async () => {
    //       await expect(
    //         neutronAccount.executeContract(
    //           contractAddress,
    //           JSON.stringify({
    //             delegate: {
    //               interchain_account_id: icaId1,
    //               validator: (
    //                 testState.wallets.cosmos.val1
    //                   .address as cosmosclient.ValAddress
    //               ).toString(),
    //               amount: '2000',
    //               denom: gaiaChain.denom,
    //             },
    //           }),
    //         ),
    //       ).rejects.toThrow(/invalid coins/);
    //     });
    //   });
    //   describe('insufficient funds for fee', () => {
    //     beforeAll(async () => {
    //       await neutronAccount.executeContract(
    //         contractAddress,
    //         JSON.stringify({
    //           set_fees: {
    //             denom: neutronChain.denom,
    //             ack_fee: '9999999999',
    //             recv_fee: '0',
    //             timeout_fee: '9999999999',
    //           },
    //         }),
    //       );
    //     });
    //     afterAll(async () => {
    //       await neutronAccount.executeContract(
    //         contractAddress,
    //         JSON.stringify({
    //           set_fees: {
    //             denom: neutronChain.denom,
    //             ack_fee: '2000',
    //             recv_fee: '0',
    //             timeout_fee: '2000',
    //           },
    //         }),
    //       );
    //     });
    //     test('delegate with zero fee', async () => {
    //       await expect(
    //         neutronAccount.executeContract(
    //           contractAddress,
    //           JSON.stringify({
    //             delegate: {
    //               interchain_account_id: icaId1,
    //               validator: (
    //                 testState.wallets.cosmos.val1
    //                   .address as cosmosclient.ValAddress
    //               ).toString(),
    //               amount: '2000',
    //               denom: gaiaChain.denom,
    //             },
    //           }),
    //         ),
    //       ).rejects.toThrow(/insufficient funds/);
    //     });
    //   });
    // });
    // describe('Recreation', () => {
    //   test('recreate ICA1', async () => {
    //     const res = await neutronAccount.executeContract(
    //       contractAddress,
    //       JSON.stringify({
    //         register: {
    //           connection_id: connectionId,
    //           interchain_account_id: icaId1,
    //         },
    //       }),
    //     );
    //     expect(res.code).toEqual(0);
    //     await getWithAttempts(
    //       neutronChain.blockWaiter,
    //       async () => neutronChain.listIBCChannels(),
    //       // Wait until there are 4 channels:
    //       // - one exists already, it is open for IBC transfers;
    //       // - two channels are already opened via ICA registration before
    //       // - one more, we are opening it right now
    //       async (channels) => channels.channels.length == 4,
    //     );
    //     await getWithAttempts(
    //       neutronChain.blockWaiter,
    //       () => neutronChain.listIBCChannels(),
    //       async (channels) =>
    //         channels.channels.find((c) => c.channel_id == 'channel-3')?.state ==
    //         'STATE_OPEN',
    //     );
    //   });
    //   test('delegate from first ICA after ICA recreation', async () => {
    //     await cleanAckResults(neutronAccount, contractAddress);
    //     const res = await neutronAccount.executeContract(
    //       contractAddress,
    //       JSON.stringify({
    //         delegate: {
    //           interchain_account_id: icaId1,
    //           validator: testState.wallets.cosmos.val1.address.toString(),
    //           denom: gaiaChain.denom,
    //           amount: '20',
    //         },
    //       }),
    //     );
    //     expect(res.code).toEqual(0);
    //     const sequenceId = getSequenceId(res.raw_log);

    //     const qres = await waitForAck(
    //       neutronChain,
    //       contractAddress,
    //       icaId1,
    //       sequenceId,
    //     );
    //     expect(qres).toMatchObject<AcknowledgementResult>({
    //       success: ['/cosmos.staking.v1beta1.MsgDelegate'],
    //     });
    //   });
    //   test('check validator state after ICA recreation', async () => {
    //     const res = await rest.staking.delegatorDelegations(
    //       gaiaChain.sdk as CosmosSDK,
    //       icaAddress1 as unknown as AccAddress,
    //     );
    //     expect(res.data.delegation_responses).toEqual([
    //       {
    //         balance: { amount: '1020', denom: gaiaChain.denom },
    //         delegation: {
    //           delegator_address: icaAddress1,
    //           shares: '1020.000000000000000000',
    //           validator_address:
    //             'cosmosvaloper18hl5c9xn5dze2g50uaw0l2mr02ew57zk0auktn',
    //         },
    //       },
    //     ]);
    //   });
    // });

    // describe('delegate with sudo failure', () => {
    //   beforeAll(async () => {
    //     await cleanAckResults(neutronAccount, contractAddress);

    //     const failures = await neutronChain.queryAckFailures(contractAddress);
    //     expect(failures.failures.length).toEqual(0);

    //     const acks = await getAcks(neutronChain, contractAddress);
    //     expect(acks.length).toEqual(0);
    //   });

    //   test('ack failure during sudo', async () => {
    //     // Mock sudo handler to fail
    //     await neutronAccount.executeContract(
    //       contractAddress,
    //       JSON.stringify({
    //         integration_tests_set_sudo_failure_mock: {},
    //       }),
    //     );

    //     // Testing ACK failure
    //     await neutronAccount.executeContract(
    //       contractAddress,
    //       JSON.stringify({
    //         delegate: {
    //           interchain_account_id: icaId1,
    //           validator: testState.wallets.cosmos.val1.address.toString(),
    //           amount: '10',
    //           denom: gaiaChain.denom,
    //         },
    //       }),
    //     );

    //     // wait until sudo is called and processed and failure is recorder
    //     await getWithAttempts<AckFailuresResponse>(
    //       neutronChain.blockWaiter,
    //       async () => neutronChain.queryAckFailures(contractAddress),
    //       async (data) => data.failures.length == 1,
    //       100,
    //     );

    //     // make sure contract's state hasn't been changed
    //     const acks = await getAcks(neutronChain, contractAddress);
    //     expect(acks.length).toEqual(0);

    //     // Restore sudo handler's normal state
    //     await neutronAccount.executeContract(
    //       contractAddress,
    //       JSON.stringify({
    //         integration_tests_unset_sudo_failure_mock: {},
    //       }),
    //     );
    //   });

    //   test('ack failure during sudo submsg', async () => {
    //     // Mock sudo handler to fail on submsg
    //     await neutronAccount.executeContract(
    //       contractAddress,
    //       JSON.stringify({
    //         integration_tests_set_sudo_submsg_failure_mock: {},
    //       }),
    //     );

    //     // Testing ACK failure
    //     await neutronAccount.executeContract(
    //       contractAddress,
    //       JSON.stringify({
    //         delegate: {
    //           interchain_account_id: icaId1,
    //           validator: testState.wallets.cosmos.val1.address.toString(),
    //           amount: '10',
    //           denom: gaiaChain.denom,
    //         },
    //       }),
    //     );

    //     // wait until sudo is called and processed and failure is recorder
    //     await getWithAttempts<AckFailuresResponse>(
    //       neutronChain.blockWaiter,
    //       async () => neutronChain.queryAckFailures(contractAddress),
    //       async (data) => data.failures.length == 2,
    //       100,
    //     );

    //     // make sure contract's state hasn't been changed
    //     const acks = await getAcks(neutronChain, contractAddress);
    //     expect(acks.length).toEqual(0);

    //     // Restore sudo handler's normal state
    //     await neutronAccount.executeContract(
    //       contractAddress,
    //       JSON.stringify({
    //         integration_tests_unset_sudo_failure_mock: {},
    //       }),
    //     );
    //   });

    //   test('ack failure during sudo submsg reply', async () => {
    //     // Mock sudo handler to fail on submsg reply
    //     await neutronAccount.executeContract(
    //       contractAddress,
    //       JSON.stringify({
    //         integration_tests_set_sudo_submsg_reply_failure_mock: {},
    //       }),
    //     );

    //     // Testing ACK failure
    //     await neutronAccount.executeContract(
    //       contractAddress,
    //       JSON.stringify({
    //         delegate: {
    //           interchain_account_id: icaId1,
    //           validator: testState.wallets.cosmos.val1.address.toString(),
    //           amount: '10',
    //           denom: gaiaChain.denom,
    //         },
    //       }),
    //     );

    //     // wait until sudo is called and processed and failure is recorder
    //     await getWithAttempts<AckFailuresResponse>(
    //       neutronChain.blockWaiter,
    //       async () => neutronChain.queryAckFailures(contractAddress),
    //       async (data) => data.failures.length == 3,
    //       100,
    //     );

    //     // make sure contract's state hasn't been changed
    //     const acks = await getAcks(neutronChain, contractAddress);
    //     expect(acks.length).toEqual(0);

    //     // Restore sudo handler's normal state
    //     await neutronAccount.executeContract(
    //       contractAddress,
    //       JSON.stringify({
    //         integration_tests_unset_sudo_failure_mock: {},
    //       }),
    //     );
    //   });

    //   test('timeout failure during sudo', async () => {
    //     // Mock sudo handler to fail
    //     await neutronAccount.executeContract(
    //       contractAddress,
    //       JSON.stringify({
    //         integration_tests_set_sudo_failure_mock: {},
    //       }),
    //     );

    //     // Testing timeout failure
    //     await neutronAccount.executeContract(
    //       contractAddress,
    //       JSON.stringify({
    //         delegate: {
    //           interchain_account_id: icaId1,
    //           validator: testState.wallets.cosmos.val1.address.toString(),
    //           amount: '10',
    //           denom: gaiaChain.denom,
    //           timeout: 1,
    //         },
    //       }),
    //     );

    //     // wait until sudo is called and processed and failure is recorder
    //     await getWithAttempts<AckFailuresResponse>(
    //       neutronChain.blockWaiter,
    //       async () => neutronChain.queryAckFailures(contractAddress),
    //       async (data) => data.failures.length == 4,
    //       100,
    //     );

    //     // make sure contract's state hasn't been changed
    //     const acks = await getAcks(neutronChain, contractAddress);
    //     expect(acks.length).toEqual(0);

    //     // Restore sudo handler's normal state
    //     await neutronAccount.executeContract(
    //       contractAddress,
    //       JSON.stringify({
    //         integration_tests_unset_sudo_failure_mock: {},
    //       }),
    //     );
    //   });

    //   test('check stored failures and acks', async () => {
    //     const failures = await neutronChain.queryAckFailures(contractAddress);
    //     // 3 ack failures, 1 timeout failure, just as described in the tests above
    //     expect(failures.failures).toEqual([
    //       {
    //         channel_id: 'channel-3',
    //         address:
    //           'neutron1m0z0kk0qqug74n9u9ul23e28x5fszr628h20xwt6jywjpp64xn4qatgvm0',
    //         id: '0',
    //         ack_id: '2',
    //         ack_type: 'ack',
    //       },
    //       {
    //         channel_id: 'channel-3',
    //         address:
    //           'neutron1m0z0kk0qqug74n9u9ul23e28x5fszr628h20xwt6jywjpp64xn4qatgvm0',
    //         id: '1',
    //         ack_id: '3',
    //         ack_type: 'ack',
    //       },
    //       {
    //         channel_id: 'channel-3',
    //         address:
    //           'neutron1m0z0kk0qqug74n9u9ul23e28x5fszr628h20xwt6jywjpp64xn4qatgvm0',
    //         id: '2',
    //         ack_id: '4',
    //         ack_type: 'ack',
    //       },
    //       {
    //         channel_id: 'channel-3',
    //         address:
    //           'neutron1m0z0kk0qqug74n9u9ul23e28x5fszr628h20xwt6jywjpp64xn4qatgvm0',
    //         id: '3',
    //         ack_id: '5',
    //         ack_type: 'timeout',
    //       },
    //     ]);

    //     const acks = await getAcks(neutronChain, contractAddress);
    //     // no acks at all because all sudo handling cases resulted in an error
    //     expect(acks).toEqual([]);
    //   });
    // });
  });
});

/**
 * cleanAckResults clears all ACK's from contract storage
 */
const cleanAckResults = (cm: WalletWrapper, contractAddress: string) =>
  cm.executeContract(contractAddress, JSON.stringify({ clean_ack_results: {} }));

/**
 * waitForAck waits until ACK appears in contract storage
 */
const waitForAck = (cm: CosmosWrapper, contractAddress: string, icaId: string, sequenceId: number, numAttempts = 20) =>
  getWithAttempts(
    cm.blockWaiter,
    () =>
      cm.queryContract<AcknowledgementResult>(contractAddress, {
        acknowledgement_result: {
          interchain_account_id: icaId,
          sequence_id: sequenceId,
        },
      }),
    async (ack) => ack != null,
    numAttempts,
  );

const getAck = (cm: CosmosWrapper, contractAddress: string, icaId: string, sequenceId: number) =>
  cm.queryContract<AcknowledgementResult>(contractAddress, {
    acknowledgement_result: {
      interchain_account_id: icaId,
      sequence_id: sequenceId,
    },
  });

const getAcks = (cm: CosmosWrapper, contractAddress: string) =>
  cm.queryContract<AcksResponse[]>(contractAddress, {
    acknowledgement_results: {},
  });

type AcksResponse = {
  ack_result: {
    success: any[];
    error: any[];
    timeout: any[];
  };
  port_id: string;
  sequence_id: number;
};
