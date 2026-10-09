import { formatStay } from '../domain/time'
import type { ColumnSetting, MailRow } from '../domain/types'
import { columnValue } from '../domain/email'

export function EmailPreview({
  hotelName,
  airportCode,
  stayDate,
  timezoneLabel,
  greeting,
  intro,
  closing,
  signature,
  rows,
  columns,
  newLabel,
  cancelLabel,
  caption = 'Так письмо увидит гостиница',
}: {
  hotelName: string
  airportCode: string
  stayDate: string
  timezoneLabel: string
  greeting: string
  intro: string
  closing: string
  signature: string
  rows: MailRow[]
  columns: ColumnSetting[]
  newLabel: string
  cancelLabel: string
  caption?: string
}) {
  const visible = columns.filter((column) => column.visible)
  return (
    <article className="rounded-2xl border border-line bg-white p-5">
      <p className="mb-3 text-xs font-semibold text-ink-soft">{caption}</p>
      <p className="whitespace-pre-wrap">{greeting}</p>
      <p className="mt-3 whitespace-pre-wrap">{intro}</p>
      <p className="mt-4 font-semibold">
        {formatStay(stayDate)} · {airportCode} · {hotelName}
      </p>
      <p className="mb-3 text-xs text-ink-soft">Время местное, {timezoneLabel}</p>
      <div className="overflow-x-auto">
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
              <tr key={row.bookingId} className="border-b border-line align-top">
                {visible.map((column) => {
                  const marked = row.badge !== 'cancel' && (row.changedFields.includes(column.key) || row.manualFields.includes(column.key))
                  return (
                    <td key={column.key} className="px-2 py-3 tabular-nums">
                      {column.key === 'fullName' && row.badge ? (
                        <span className="mb-1 mr-2 inline-flex rounded-full bg-[#fdecea] px-2 py-0.5 text-xs font-semibold text-danger">
                          {row.badge === 'cancel' ? cancelLabel : newLabel}
                        </span>
                      ) : null}
                      <span className={marked ? 'email-change' : row.badge === 'cancel' ? 'text-ink-soft' : undefined}>{columnValue(row, column.key)}</span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 whitespace-pre-wrap">{closing}</p>
      <p className="mt-3 whitespace-pre-wrap text-ink-soft">{signature}</p>
    </article>
  )
}
