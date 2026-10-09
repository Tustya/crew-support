import type { ColumnKey, ColumnSetting, MailRow } from '../../domain/types'
import { formatStay } from '../../domain/time'

export function LetterPreview({
  subject,
  greeting,
  intro,
  closing,
  signature,
  hotelName,
  airportCode,
  stayDate,
  timezoneLabel,
  rows,
  columns,
  newLabel,
  cancelLabel,
}: {
  subject: string
  greeting: string
  intro: string
  closing: string
  signature: string
  hotelName: string
  airportCode: string
  stayDate: string
  timezoneLabel: string
  rows: MailRow[]
  columns: ColumnSetting[]
  newLabel: string
  cancelLabel: string
}) {
  const visible = columns.filter((column) => column.visible)
  return (
    <article className="rounded-3xl border border-line bg-white p-6 text-ink">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Так письмо увидит гостиница</p>
      <h3 className="mt-3 text-lg font-bold">{subject}</h3>
      <p className="mt-4 whitespace-pre-wrap">{greeting}</p>
      <p className="mt-3 whitespace-pre-wrap">{intro}</p>
      <p className="mt-4 font-semibold">
        {formatStay(stayDate)} · {airportCode} · {hotelName}
      </p>
      <p className="mt-1 text-xs text-ink-soft">Время местное, аэропорт {airportCode} ({timezoneLabel})</p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-left text-[13px] leading-5">
          <thead>
            <tr className="border-b border-line text-ink-soft">
              {visible.map((column) => (
                <th key={column.key} className="px-2 py-2 font-semibold">
                  {column.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.bookingId} className="border-b border-line">
                {visible.map((column) => (
                  <td key={column.key} className="px-2 py-3 align-top">
                    {column.key === 'fullName' && row.badge ? (
                      <span className="mb-1 block text-xs font-bold text-danger">{row.badge === 'new' ? newLabel : cancelLabel}</span>
                    ) : null}
                    <span className={row.changedFields.includes(column.key) || row.manualFields.includes(column.key) ? 'font-medium text-danger italic' : ''}>
                      {row[column.key as ColumnKey] || '—'}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 whitespace-pre-wrap">{closing}</p>
      <p className="mt-3 whitespace-pre-wrap font-semibold">{signature}</p>
    </article>
  )
}
