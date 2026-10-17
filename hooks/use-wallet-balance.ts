'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PollarClient, TxHistoryState } from '@pollar/core'
import { usePollarSession } from '@/providers/pollar-provider'
import {
  fetchHorizonBalances,
  getStellarNetwork,
  normalizePollarWalletBalance,
  type ConnectedWallet,
  type WalletBalanceSummary,
} from '@/lib/mercato-wallet'

type WalletScope = {
  provider: ConnectedWallet['provider'] | null
  publicKey: string
  network: 'mainnet' | 'testnet'
}
type BalanceOwner = { scope: WalletScope; request: number }
type BalanceSnapshot = {
  scope: WalletScope
  balances: WalletBalanceSummary | null
  txHistory: TxHistoryState | null
  balanceError: boolean
}

async function loadWalletSnapshot(
  scope: WalletScope,
  refreshWalletBalance: () => Promise<void>,
  getClient: () => PollarClient,
): Promise<Pick<BalanceSnapshot, 'balances' | 'txHistory'>> {
  if (scope.provider !== 'pollar') {
    return { balances: await fetchHorizonBalances(scope.publicKey), txHistory: null }
  }

  const client = getClient()
  const historyParams = { network: scope.network }
  // Ambient SDK state can still be updated by a previous wallet. Read only
  // after an owned request; history also preserves its request's params object.
  const [balanceState, historyState] = await Promise.all([
    refreshWalletBalance().then(() => client.getWalletBalanceState()),
    client.fetchTxHistory(historyParams).then(() => client.getTxHistoryState()).catch(() => null),
  ])
  if (
    balanceState.step !== 'loaded' ||
    balanceState.data.publicKey !== scope.publicKey ||
    balanceState.data.network !== scope.network
  ) {
    throw new Error('Pollar balance refresh did not return the connected wallet')
  }

  return {
    balances: normalizePollarWalletBalance(balanceState),
    txHistory: historyState && historyState.step !== 'idle' && historyState.params === historyParams
      ? historyState : null,
  }
}

export function useWalletBalance(wallet: ConnectedWallet | null) {
  const { refreshWalletBalance, getClient, walletAddress } = usePollarSession()
  const provider = wallet?.provider ?? null
  const publicKey = wallet?.publicKey ?? ''
  const network = provider === 'pollar'
    ? process.env.NEXT_PUBLIC_POLLAR_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
    : getStellarNetwork()
  const scope = useMemo(() => ({ provider, publicKey, network }), [provider, publicKey, network])
  const activeOwner = useRef<BalanceOwner | null>(null)
  const [snapshot, setSnapshot] = useState<BalanceSnapshot | null>(null)

  // A new connection gets a new owner, including A -> B -> A. Invalidate at
  // commit time, before an old promise can settle ahead of passive effects.
  useLayoutEffect(() => {
    const owner = { scope, request: 0 }
    activeOwner.current = owner
    return () => {
      activeOwner.current = null
    }
  }, [scope])

  const refreshBalance = useCallback(async (): Promise<void> => {
    const owner = activeOwner.current
    if (!scope.publicKey || owner?.scope !== scope) return
    if (scope.provider === 'pollar' && walletAddress !== scope.publicKey) return

    const request = ++owner.request
    const isCurrent = () => activeOwner.current === owner && owner.request === request

    await loadWalletSnapshot(scope, refreshWalletBalance, getClient).then(
      ({ balances, txHistory }) => {
        if (isCurrent()) setSnapshot({ scope, balances, txHistory, balanceError: false })
      },
      (error: unknown) => {
        if (!isCurrent()) return
        console.error('[wallet-balance] failed to refresh wallet balances', error)
        // Retain only this connection's last successful data. Refresh failures
        // are visible without rejecting a caller's already-completed transaction.
        setSnapshot((previous) => ({
          scope,
          balances: previous?.scope === scope ? previous.balances : null,
          txHistory: previous?.scope === scope ? previous.txHistory : null,
          balanceError: true,
        }))
      },
    )
  }, [scope, walletAddress, refreshWalletBalance, getClient])

  useEffect(() => { void refreshBalance() }, [refreshBalance])

  const clearBalances = useCallback(() => {
    const owner = activeOwner.current
    // Rotate synchronously so even a completion in this event's microtasks is
    // invalidated. Keep the scope so a later explicit refresh is still usable.
    if (owner) activeOwner.current = { scope: owner.scope, request: 0 }
    setSnapshot(null)
  }, [])

  // Mask the previous connection during render, before effect cleanup runs.
  const current = snapshot?.scope === scope ? snapshot : null
  return {
    balances: current?.balances ?? null,
    txHistory: current?.txHistory ?? null,
    balanceError: current?.balanceError ?? false,
    refreshBalance,
    clearBalances,
  }
}
