/** Match the account page's decimal rules without losing precision to Number. */
export function formatBalance(amount, currency = 'CNY') {
  const match = String(amount).match(/^(-?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i)
  if (!match) return null
  const exponent = Number(match[4] || 0)
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return null
  const digits = match[2] + (match[3] || '')
  const point = match[2].length + exponent
  const integer = (point <= 0 ? '0' : digits.slice(0, point).padEnd(point, '0')).replace(/^0+(?=\d)/, '')
  const fraction = point < 0 ? '0'.repeat(-point) + digits : digits.slice(point)
  const nonzero = /[1-9]/.test(integer + fraction)
  const negative = match[1] === '-' && nonzero
  const subcent = integer === '0' && !/[1-9]/.test(fraction.slice(0, 2)) && nonzero
  let cents = BigInt(integer) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2))
  if (subcent) cents = 1n
  else if (negative && Number(fraction[2] || 0) >= 5) cents += 1n
  const number = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + (cents % 100n).toString().padStart(2, '0')
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency
  const prefix = negative ? '-' : subcent ? '<' : ''
  return { prefix, symbol, number, text: prefix + symbol + number }
}

export function balanceRows(details, bonus = false) {
  const balance = details?.balance
  if (balance?.status !== 'ready') return null
  const wallets = bonus ? balance.bonusWallets : balance.value
  if (!Array.isArray(wallets)) return null
  if (bonus && !wallets.length) return [{ currency: balance.value?.[0]?.currency || 'CNY', balance: '0' }]
  return wallets.length ? wallets : null
}

export function platformHref(view, page) {
  const value = page === 'top-up' ? view?.links?.topUpUrl : view?.links?.usageUrl
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined } catch { return undefined }
}
