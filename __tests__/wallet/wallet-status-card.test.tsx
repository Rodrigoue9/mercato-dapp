import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import * as walletApi from '@/hooks/use-mercato-wallet'
import * as i18nApi from '@/lib/i18n/provider'
import { WalletStatusCard } from '@/components/wallet/wallet-status-card'
import en from '@/messages/en.json'
import es from '@/messages/es.json'

afterEach(() => { cleanup(); mock.restore() })

describe('wallet balance refresh feedback', () => {
  test.each([['en', en], ['es', es]] as const)('shows a refresh failure in %s without a success checkmark', async (locale: 'en' | 'es', messages: typeof en | typeof es) => {
    let balanceError = false
    const wallet = {
      provider: 'stellar-wallets-kit', publicKey: 'A', walletId: null, status: 'active',
      isConnected: true, isEmbedded: false, walletName: 'Freighter',
      wallet: null, walletInfo: null, truncatedAddress: 'A', balances: null,
      txHistory: null, canSignTransactions: true,
      connectExternalWallet: async () => {}, connectPollarWallet: async () => {}, disconnect: async () => {},
      refreshBalance: async () => { balanceError = true },
    } satisfies Omit<ReturnType<typeof walletApi.useMercatoWallet>, 'balanceError'>
    spyOn(walletApi, 'useMercatoWallet').mockImplementation(() => ({ ...wallet, balanceError }))
    spyOn(i18nApi, 'useI18n').mockReturnValue({
      locale, messages, setLocale: () => {},
      t: (key: string) => messages.walletStatus[key.split('.')[1] as keyof typeof messages.walletStatus] ?? key,
    })
    const view = render(<WalletStatusCard />)
    expect(view.queryByRole('alert')).toBeNull()
    await act(async () => { fireEvent.click(view.getByRole('button', { name: messages.walletStatus.refreshBalance })) })
    view.rerender(<WalletStatusCard />)
    expect(view.getByRole('alert').textContent).toBe(messages.walletStatus.balanceRefreshFailed)
    expect(view.container.querySelector('.lucide-circle-check')).toBeNull()
    expect(view.container.querySelector('.text-success')).toBeNull()
  })
})
