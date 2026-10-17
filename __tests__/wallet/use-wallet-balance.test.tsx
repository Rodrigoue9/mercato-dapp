import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { StrictMode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { PollarClient, TxHistoryParams, TxHistoryState, WalletBalanceState } from '@pollar/core'
import * as walletApi from '@/lib/mercato-wallet'
import * as pollarApi from '@/providers/pollar-provider'
import { useWalletBalance } from '@/hooks/use-wallet-balance'
import type { ConnectedWallet, WalletBalanceSummary } from '@/lib/mercato-wallet'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const external = (publicKey: string): ConnectedWallet => ({
  publicKey, provider: 'stellar-wallets-kit', isEmbedded: false,
})
const embedded = (publicKey: string): ConnectedWallet => ({
  publicKey, provider: 'pollar', isEmbedded: true,
})
const balance = (xlm: string): WalletBalanceSummary => ({
  xlm, usdc: '5', records: [], source: 'horizon', updatedAt: '2026-10-17T00:00:00Z',
})
const sdkBalance = (publicKey: string, xlm: string, network = 'testnet'): WalletBalanceState => ({
  step: 'loaded',
  data: {
    publicKey, network: network as 'testnet' | 'mainnet', exists: true,
    balances: [{ type: 'native', code: 'XLM', balance: xlm, available: xlm,
      enabledInApp: true, trustlineRemoved: false }],
  },
})
const history = (count: number): Extract<TxHistoryState, { step: 'loaded' }> => ({
  step: 'loaded', params: { network: 'testnet' },
  data: { records: [], total: count, limit: 10, offset: 0 },
})

type PollarSession = ReturnType<typeof pollarApi.usePollarSession>
let session: PollarSession
let sdkBalanceState: WalletBalanceState
let sdkHistoryState: TxHistoryState
let externalRequests: Array<ReturnType<typeof deferred<WalletBalanceSummary>>>
let embeddedRequests: Array<ReturnType<typeof deferred<void>>>
let historyRequests: Array<ReturnType<typeof deferred<void>>>
let historyParams: TxHistoryParams[]
const originalPollarNetwork = process.env.NEXT_PUBLIC_POLLAR_NETWORK
const originalTrustlessNetwork = process.env.NEXT_PUBLIC_TRUSTLESS_NETWORK

beforeEach(() => {
  process.env.NEXT_PUBLIC_POLLAR_NETWORK = 'testnet'
  process.env.NEXT_PUBLIC_TRUSTLESS_NETWORK = 'testnet'
  externalRequests = []
  embeddedRequests = []
  historyRequests = []
  historyParams = []
  sdkBalanceState = { step: 'idle' }
  sdkHistoryState = { step: 'idle' }
  const client = {
    getWalletBalanceState: () => sdkBalanceState,
    getTxHistoryState: () => sdkHistoryState,
    fetchTxHistory: mock((params: TxHistoryParams) => {
      const request = deferred<void>()
      historyRequests.push(request)
      historyParams.push(params)
      return request.promise
    }),
  } as unknown as PollarClient
  session = {
    session: null, isLoading: false, isAuthenticated: true, isPollarEmbedReady: true,
    walletAddress: 'A', walletType: null, walletBalance: sdkBalanceState, txHistory: sdkHistoryState,
    login: () => {}, logout: () => {}, openLoginModal: () => {},
    signAndSubmitTx: async () => '', getClient: () => client,
    refreshWalletBalance: mock(() => {
      const request = deferred<void>()
      embeddedRequests.push(request)
      return request.promise
    }),
  }
  spyOn(pollarApi, 'usePollarSession').mockImplementation(() => session)
  spyOn(walletApi, 'fetchHorizonBalances').mockImplementation(() => {
    const request = deferred<WalletBalanceSummary>()
    externalRequests.push(request)
    return request.promise
  })
  spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  mock.restore()
  if (originalPollarNetwork === undefined) delete process.env.NEXT_PUBLIC_POLLAR_NETWORK
  else process.env.NEXT_PUBLIC_POLLAR_NETWORK = originalPollarNetwork
  if (originalTrustlessNetwork === undefined) delete process.env.NEXT_PUBLIC_TRUSTLESS_NETWORK
  else process.env.NEXT_PUBLIC_TRUSTLESS_NETWORK = originalTrustlessNetwork
})

function mount(wallet: ConnectedWallet | null) {
  return renderHook(({ wallet }: { wallet: ConnectedWallet | null }) => useWalletBalance(wallet), {
    initialProps: { wallet },
  })
}

async function resolveExternal(index: number, xlm: string) {
  await act(async () => { externalRequests[index].resolve(balance(xlm)) })
}

async function resolveEmbedded(index: number, publicKey: string, xlm: string, count = 0) {
  await act(async () => {
    sdkBalanceState = sdkBalance(publicKey, xlm)
    sdkHistoryState = { ...history(count), params: historyParams[index] }
    session = { ...session, walletBalance: sdkBalanceState, txHistory: sdkHistoryState }
    embeddedRequests[index].resolve()
    historyRequests[index]?.resolve()
  })
}

describe('connected wallet balance ownership', () => {
  test('manual refresh remains awaitable and updates the same wallet', async () => {
    const { result } = mount(external('A'))
    await resolveExternal(0, '10')
    let settled = false
    let refresh!: Promise<void>
    act(() => { refresh = result.current.refreshBalance().then(() => { settled = true }) })
    expect(settled).toBe(false)
    await resolveExternal(1, '20')
    await refresh
    expect(settled).toBe(true)
    expect(result.current.balances?.xlm).toBe('20')
  })

  test('hides A immediately while B is loading and ignores the old automatic response', async () => {
    const { result, rerender } = mount(external('A'))
    rerender({ wallet: external('B') })
    expect(result.current.balances).toBeNull()
    await resolveExternal(1, '20')
    await resolveExternal(0, '10')
    expect(result.current.balances?.xlm).toBe('20')
  })

  test('hides already loaded balances on a wallet switch', async () => {
    const { result, rerender } = mount(external('A'))
    await resolveExternal(0, '10')
    rerender({ wallet: external('B') })
    expect(result.current.balances).toBeNull()
    await resolveExternal(1, '20')
    expect(result.current.balances?.xlm).toBe('20')
  })

  test('an old manual refresh cannot overwrite B', async () => {
    const { result, rerender } = mount(external('A'))
    await resolveExternal(0, '10')
    act(() => { void result.current.refreshBalance() })
    rerender({ wallet: external('B') })
    await resolveExternal(2, '20')
    await resolveExternal(1, '99')
    expect(result.current.balances?.xlm).toBe('20')
  })

  test('disconnect invalidates automatic and manual work', async () => {
    const { result, rerender } = mount(external('A'))
    act(() => { void result.current.refreshBalance() })
    rerender({ wallet: null })
    await resolveExternal(0, '10')
    await resolveExternal(1, '99')
    expect(result.current.balances).toBeNull()
    expect(result.current.txHistory).toBeNull()
  })

  test('returning to A does not reactivate a refresh from the previous A connection', async () => {
    const { result, rerender } = mount(external('A'))
    act(() => { void result.current.refreshBalance() })
    rerender({ wallet: external('B') })
    rerender({ wallet: external('A') })
    await resolveExternal(3, '30')
    await resolveExternal(1, '99')
    expect(result.current.balances?.xlm).toBe('30')
  })

  test('clearBalances invalidates both refresh paths and allows a later explicit refresh', async () => {
    const { result, rerender } = mount(external('A'))
    act(() => { void result.current.refreshBalance() })
    act(() => { result.current.clearBalances() })
    await resolveExternal(0, '10')
    await resolveExternal(1, '99')
    rerender({ wallet: external('A') })
    expect(result.current.balances).toBeNull()
    expect(externalRequests).toHaveLength(2)
    act(() => { void result.current.refreshBalance() })
    await resolveExternal(2, '30')
    expect(result.current.balances?.xlm).toBe('30')
  })

  test('clearing and resolving in the same event cannot restore the cleared balance', async () => {
    const { result } = mount(external('A'))
    await act(async () => {
      result.current.clearBalances()
      externalRequests[0].resolve(balance('99'))
    })
    expect(result.current.balances).toBeNull()
  })

  test('a saved callback from A cannot start a refresh after switching to B', async () => {
    const { result, rerender } = mount(external('A'))
    const refreshA = result.current.refreshBalance
    rerender({ wallet: external('B') })
    const staleRefresh = refreshA()
    expect(externalRequests).toHaveLength(2)
    await staleRefresh
  })

  test('network changes invalidate balances and pending requests for the same address', async () => {
    const { result, rerender } = mount(external('A'))
    await resolveExternal(0, '10')
    act(() => { void result.current.refreshBalance() })
    process.env.NEXT_PUBLIC_TRUSTLESS_NETWORK = 'mainnet'
    rerender({ wallet: external('A') })
    expect(result.current.balances).toBeNull()
    expect(externalRequests).toHaveLength(3)
    await resolveExternal(2, '20')
    await resolveExternal(1, '99')
    expect(result.current.balances?.xlm).toBe('20')
  })

  test('the most recent refresh wins when same-wallet requests finish out of order', async () => {
    const { result } = mount(external('A'))
    act(() => { void result.current.refreshBalance() })
    await resolveExternal(1, '20')
    await resolveExternal(0, '10')
    expect(result.current.balances?.xlm).toBe('20')
  })

  test('current failures are visible, preserve same-wallet data, and recover on refresh', async () => {
    const { result } = mount(external('A'))
    await resolveExternal(0, '10')
    act(() => { void result.current.refreshBalance() })
    await act(async () => { externalRequests[1].reject(new Error('offline')) })
    expect(result.current.balanceError).toBe(true)
    expect(result.current.balances?.xlm).toBe('10')
    act(() => { void result.current.refreshBalance() })
    await resolveExternal(2, '20')
    expect(result.current.balanceError).toBe(false)
    expect(result.current.balances?.xlm).toBe('20')
  })

  test('B failure never restores A and old A failures do not alter B error state', async () => {
    const { result, rerender } = mount(external('A'))
    await resolveExternal(0, '10')
    act(() => { void result.current.refreshBalance() })
    rerender({ wallet: external('B') })
    await act(async () => { externalRequests[2].reject(new Error('B offline')) })
    expect(result.current.balances).toBeNull()
    expect(result.current.balanceError).toBe(true)
    act(() => { void result.current.refreshBalance() })
    await resolveExternal(3, '20')
    await act(async () => { externalRequests[1].reject(new Error('A offline')) })
    expect(result.current.balances?.xlm).toBe('20')
    expect(result.current.balanceError).toBe(false)
  })

  test('clearBalances invalidates errors and unmount makes saved refreshes inert', async () => {
    const { result, unmount } = mount(external('A'))
    act(() => { result.current.clearBalances() })
    await act(async () => { externalRequests[0].reject(new Error('offline')) })
    expect(result.current.balanceError).toBe(false)
    const refresh = result.current.refreshBalance
    unmount()
    const staleRefresh = refresh()
    expect(externalRequests).toHaveLength(1)
    await staleRefresh
  })

  test('works with StrictMode effect cleanup and a later automatic refresh', async () => {
    const { result } = renderHook(() => useWalletBalance(external('A')), { wrapper: StrictMode })
    expect(externalRequests.length).toBeGreaterThan(0)
    await resolveExternal(externalRequests.length - 1, '20')
    expect(result.current.balances?.xlm).toBe('20')
  })
})

describe('embedded wallet balance and history ownership', () => {
  test('loads owned balance/history and keeps manual refresh awaitable', async () => {
    const { result } = mount(embedded('A'))
    await resolveEmbedded(0, 'A', '10', 1)
    expect(result.current.balances?.xlm).toBe('10')
    expect(result.current.txHistory).toEqual(history(1))
    let settled = false
    act(() => { void result.current.refreshBalance().then(() => { settled = true }) })
    expect(settled).toBe(false)
    await resolveEmbedded(1, 'A', '20', 2)
    expect(settled).toBe(true)
    expect(result.current.balances?.xlm).toBe('20')
    expect(result.current.txHistory).toEqual(history(2))
  })

  test('does not attribute already-loaded SDK state to a newly connected wallet', () => {
    session.walletBalance = sdkBalance('old-wallet', '99')
    session.txHistory = history(99)
    const { result } = mount(embedded('A'))
    expect(result.current.balances).toBeNull()
    expect(result.current.txHistory).toBeNull()
    expect(embeddedRequests).toHaveLength(1)
  })

  test('a provider switch with the same public key invalidates external requests', async () => {
    const { result, rerender } = mount(external('A'))
    act(() => { void result.current.refreshBalance() })
    rerender({ wallet: embedded('A') })
    await resolveEmbedded(0, 'A', '20')
    await resolveExternal(1, '99')
    expect(result.current.balances?.source).toBe('pollar')
    expect(result.current.balances?.xlm).toBe('20')
  })

  test('a provider switch clears embedded balances/history and ignores late SDK updates', async () => {
    const { result, rerender } = mount(embedded('A'))
    await resolveEmbedded(0, 'A', '10', 1)
    act(() => { void result.current.refreshBalance() })
    rerender({ wallet: external('A') })
    expect(result.current.balances).toBeNull()
    expect(result.current.txHistory).toBeNull()
    await resolveExternal(0, '20')
    await resolveEmbedded(1, 'A', '99', 99)
    rerender({ wallet: external('A') })
    expect(result.current.balances?.source).toBe('horizon')
    expect(result.current.balances?.xlm).toBe('20')
    expect(result.current.txHistory).toBeNull()
  })

  test('switching embedded accounts masks history and ignores old automatic/manual responses', async () => {
    const { result, rerender } = mount(embedded('A'))
    act(() => { void result.current.refreshBalance() })
    session = { ...session, walletAddress: 'B' }
    rerender({ wallet: embedded('B') })
    expect(result.current.txHistory).toBeNull()
    await resolveEmbedded(2, 'B', '20', 2)
    await resolveEmbedded(0, 'A', '90', 90)
    await resolveEmbedded(1, 'A', '99', 99)
    rerender({ wallet: embedded('B') })
    expect(result.current.balances?.xlm).toBe('20')
    expect(result.current.txHistory).toEqual(history(2))
  })

  test('clearing embedded state prevents ambient SDK events from repopulating it', async () => {
    const { result, rerender } = mount(embedded('A'))
    await resolveEmbedded(0, 'A', '10', 1)
    act(() => { void result.current.refreshBalance() })
    act(() => { result.current.clearBalances() })
    await resolveEmbedded(1, 'A', '99', 99)
    rerender({ wallet: embedded('A') })
    expect(result.current.balances).toBeNull()
    expect(result.current.txHistory).toBeNull()
    act(() => { void result.current.refreshBalance() })
    await resolveEmbedded(2, 'A', '20', 2)
    expect(result.current.balances?.xlm).toBe('20')
  })

  test('disconnecting embedded wallets invalidates their pending results', async () => {
    const { result, rerender } = mount(embedded('A'))
    rerender({ wallet: null })
    await resolveEmbedded(0, 'A', '99', 99)
    rerender({ wallet: null })
    expect(result.current.balances).toBeNull()
    expect(result.current.txHistory).toBeNull()
  })

  test.each([
    ['wrong public key', sdkBalance('B', '99')],
    ['wrong network', sdkBalance('A', '99', 'mainnet')],
    ['SDK error state', { step: 'error', message: 'offline' } as WalletBalanceState],
  ] as Array<[string, WalletBalanceState]>)('rejects %s from an awaited SDK refresh', async (_name, nextState) => {
    const { result } = mount(embedded('A'))
    await act(async () => {
      sdkBalanceState = nextState
      sdkHistoryState = history(99)
      embeddedRequests[0].resolve()
      historyRequests[0]?.resolve()
    })
    expect(result.current.balances).toBeNull()
    expect(result.current.txHistory).toBeNull()
    expect(result.current.balanceError).toBe(true)
  })

  test('does not refresh the SDK wallet until its address matches the connected wallet', () => {
    session.walletAddress = 'B'
    const { result, rerender } = mount(embedded('A'))
    expect(embeddedRequests).toHaveLength(0)
    expect(result.current.balances).toBeNull()
    session = { ...session, walletAddress: 'A' }
    rerender({ wallet: embedded('A') })
    expect(embeddedRequests).toHaveLength(1)
  })

  test('embedded network changes invalidate the previous balance and history', async () => {
    const { result, rerender } = mount(embedded('A'))
    await resolveEmbedded(0, 'A', '10', 1)
    act(() => { void result.current.refreshBalance() })
    process.env.NEXT_PUBLIC_POLLAR_NETWORK = 'mainnet'
    rerender({ wallet: embedded('A') })
    expect(result.current.balances).toBeNull()
    expect(result.current.txHistory).toBeNull()
    expect(embeddedRequests).toHaveLength(3)
    await act(async () => {
      sdkBalanceState = sdkBalance('A', '20', 'mainnet')
      sdkHistoryState = { ...history(2), params: historyParams[2] }
      embeddedRequests[2].resolve()
      historyRequests[2].resolve()
    })
    await resolveEmbedded(1, 'A', '99', 99)
    rerender({ wallet: embedded('A') })
    expect(result.current.balances?.xlm).toBe('20')
    expect(result.current.txHistory?.step).toBe('loaded')
  })

  test('embedded refresh rejection is visible and does not reject post-transaction callers', async () => {
    const { result } = mount(embedded('A'))
    await resolveEmbedded(0, 'A', '10')
    let refresh!: Promise<void>
    act(() => { refresh = result.current.refreshBalance() })
    await act(async () => {
      embeddedRequests[1].reject(new Error('offline'))
      historyRequests[1].resolve()
      await refresh
    })
    expect(result.current.balanceError).toBe(true)
    expect(result.current.balances?.xlm).toBe('10')
  })

  test('history from a different SDK request is never bridged even on the same network', async () => {
    const { result } = mount(embedded('A'))
    await act(async () => {
      sdkBalanceState = sdkBalance('A', '20')
      sdkHistoryState = history(99)
      embeddedRequests[0].resolve()
      historyRequests[0].resolve()
    })
    expect(result.current.balances?.xlm).toBe('20')
    expect(result.current.txHistory).toBeNull()
  })

  test('history failure does not discard a successful balance refresh', async () => {
    const { result } = mount(embedded('A'))
    await act(async () => {
      sdkBalanceState = sdkBalance('A', '20')
      embeddedRequests[0].resolve()
      historyRequests[0].reject(new Error('history offline'))
    })
    expect(result.current.balances?.xlm).toBe('20')
    expect(result.current.balanceError).toBe(false)
    expect(result.current.txHistory).toBeNull()
  })
})
