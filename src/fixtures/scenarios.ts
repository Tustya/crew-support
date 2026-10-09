import { baselinesFrom, emptyData, makeActivity, prepareDueGroups } from '../domain/flow'
import { addMinutes, AT_1340, AT_1355, DEMO_START_ISO, MORNING_ISO } from '../domain/time'
import type { Booking, DemoData, Hotel, Role, ScenarioId, Settings, Snapshot, ValidationIssue } from '../domain/types'

const PEOPLE: Array<[string, string]> = [
  ['crew-01', 'Соколова Мария Андреевна'],
  ['crew-02', 'Волков Игорь Петрович'],
  ['crew-03', 'Морозова Елена Сергеевна'],
  ['crew-04', 'Лебедев Павел Николаевич'],
  ['crew-05', 'Орлова Анна Викторовна'],
  ['crew-06', 'Кузнецов Артём Ильич'],
  ['crew-07', 'Белова Дарья Олеговна'],
  ['crew-08', 'Новиков Степан Романович'],
  ['crew-09', 'Фролова Кира Денисовна'],
  ['crew-10', 'Егоров Матвей Артёмович'],
  ['crew-11', 'Павлова Алина Глебовна'],
  ['crew-12', 'Сорокин Никита Львович'],
  ['crew-13', 'Зайцева Вера Павловна'],
  ['crew-14', 'Киселёв Роман Евгеньевич'],
  ['crew-15', 'Тихонова Ольга Борисовна'],
  ['crew-16', 'Медведев Глеб Андреевич'],
  ['crew-17', 'Комарова Инна Юрьевна'],
  ['crew-18', 'Сафонов Пётр Алексеевич'],
  ['crew-19', 'Виноградова Яна Игоревна'],
  ['crew-20', 'Баранов Денис Олегович'],
  ['crew-21', 'Крылова Светлана Максимовна'],
  ['crew-22', 'Гусев Тимофей Сергеевич'],
  ['crew-23', 'Ершова Лидия Павловна'],
  ['crew-24', 'Фомин Юрий Владимирович'],
]

export const SCENARIOS: Array<{ id: ScenarioId; title: string; summary: string; primary: boolean }> = [
  { id: 'calm', title: 'Спокойная смена', summary: 'Одна задержка в SVX, затем тишина и один черновик.', primary: true },
  { id: 'delays', title: 'Массовые задержки', summary: 'Шесть групп и 18 событий. Таймеры независимы.', primary: true },
  { id: 'errors', title: 'Ошибки и исключения', summary: 'Нет адреса, нет договора, дубль и сбой источника.', primary: true },
  { id: 'stale', title: 'Черновик устарел', summary: 'Проверенное письмо, затем новая задержка.', primary: false },
  { id: 'replacement', title: 'Замена и полночь', summary: 'Отмена и новый человек, перенос 23:40 → 00:30.', primary: false },
  { id: 'send_error', title: 'Ошибка отправки', summary: 'Первая отправка падает, повтор проходит один раз.', primary: false },
  { id: 'reverted', title: 'Изменение вернулось', summary: 'Откат до уведомления. Очередь пустая, история цела.', primary: false },
  { id: 'unknown_base', title: 'Неизвестная база', summary: 'Снимок без уведомлённого состояния.', primary: false },
]

function hotel(id: string, name: string, city: string, airportCode: string, airportName: string, timezone: string, utcOffset: string, email: string): Hotel {
  return {
    id,
    name,
    city,
    airportCode,
    airportName,
    timezone,
    utcOffset,
    recipients: [email],
    cc: [],
    contractStatus: 'confirmed',
    active: true,
    recipientSource: 'aviabit',
    comment: '',
    sourceRecipients: [email],
    sourceCc: [],
  }
}

export function baseHotels(): Hotel[] {
  return [
    hotel('hotel-angel', 'Ангел', 'Екатеринбург', 'SVX', 'Кольцово', 'Asia/Yekaterinburg', '+05:00', 'crew.svx@example.com'),
    hotel('hotel-neva', 'Нева', 'Санкт-Петербург', 'LED', 'Пулково', 'Europe/Moscow', '+03:00', 'crew.led@example.com'),
    hotel('hotel-morskoy', 'Морской', 'Сочи', 'AER', 'Сочи', 'Europe/Moscow', '+03:00', 'crew.aer@example.com'),
    hotel('hotel-kazan', 'Казанская', 'Казань', 'KZN', 'Казань', 'Europe/Moscow', '+03:00', 'crew.kzn@example.com'),
  ]
}

function stay(id: string, crewId: string, fullName: string, hotelId: string, airportCode: string, stayDate: string, arrivalTime: string, room: 'SGL' | 'DBL'): Booking {
  const number = Number(id.replace(/\D/g, '').slice(-2) || '1')
  return {
    id,
    crewId,
    fullName,
    hotelId,
    airportCode,
    localStayDate: stayDate,
    arrivalFlight: `CS${100 + number}`,
    arrivalLocalDate: stayDate,
    arrivalLocalTime: arrivalTime,
    departureFlight: `CS${200 + number}`,
    departureLocalDate: stayDate,
    departureLocalTime: '21:10',
    roomType: room,
    recordStatus: 'active',
  }
}

function clone(bookings: Booking[]): Booking[] {
  return bookings.map((booking) => ({ ...booking }))
}

function calmBookings(): Booking[] {
  return [
    stay('b-svx-1', 'crew-01', 'Соколова Мария Андреевна', 'hotel-angel', 'SVX', '2026-10-09', '14:20', 'SGL'),
    stay('b-svx-2', 'crew-02', 'Волков Игорь Петрович', 'hotel-angel', 'SVX', '2026-10-09', '16:05', 'DBL'),
    stay('b-svx-3', 'crew-06', 'Кузнецов Артём Ильич', 'hotel-angel', 'SVX', '2026-10-09', '12:30', 'SGL'),
    stay('b-led-1', 'crew-03', 'Морозова Елена Сергеевна', 'hotel-neva', 'LED', '2026-10-09', '11:40', 'SGL'),
    stay('b-aer-1', 'crew-04', 'Лебедев Павел Николаевич', 'hotel-morskoy', 'AER', '2026-10-09', '13:15', 'SGL'),
    stay('b-kzn-1', 'crew-05', 'Орлова Анна Викторовна', 'hotel-kazan', 'KZN', '2026-10-10', '09:50', 'DBL'),
  ]
}

function snapshot(input: {
  id: string
  sequence: number
  fetchedAt: string
  label: string
  bookings: Booking[]
  scenarioId: ScenarioId
  seriesId: string
  issues?: ValidationIssue[]
}): Snapshot {
  return {
    id: input.id,
    source: 'demo_api',
    fetchedAt: input.fetchedAt,
    label: input.label,
    windowFrom: '2026-10-06',
    windowTo: '2026-10-10',
    bookings: input.bookings,
    validationIssues: input.issues ?? [],
    scenarioId: input.scenarioId,
    seriesId: input.seriesId,
    sequence: input.sequence,
  }
}

function timers(entries: Array<[string, string]>, quietMinutes: number): DemoData['groupTimers'] {
  const next: DemoData['groupTimers'] = {}
  for (const [key, at] of entries) next[key] = { lastChangeAt: at, dueAt: addMinutes(at, quietMinutes) }
  return next
}

function running(input: {
  scenarioId: ScenarioId
  settings: Settings
  role: Role
  hotels: Hotel[]
  snapshots: Snapshot[]
  baselineEstablished: boolean
  groupTimers: DemoData['groupTimers']
  sourceStatus?: DemoData['sourceStatus']
  sourceOutage?: boolean
  lastSuccessAt?: string | null
  lastErrorAt?: string | null
  mailFailOnce?: boolean
  description: string
}): DemoData {
  const seriesId = input.snapshots[0]?.seriesId ?? `series-${input.scenarioId}`
  const baselineSource = input.snapshots[0]
  const data: DemoData = {
    ...emptyData(),
    phase: 'running',
    scenarioId: input.scenarioId,
    role: input.role,
    clockIso: DEMO_START_ISO,
    clockPaused: true,
    settings: input.settings,
    hotels: input.hotels,
    snapshots: input.snapshots,
    baselines: input.baselineEstablished && baselineSource ? baselinesFrom(baselineSource, 'scenario', MORNING_ISO) : {},
    baselineEstablished: input.baselineEstablished,
    groupTimers: input.groupTimers,
    sourceStatus: input.sourceStatus ?? 'ok',
    sourceOutage: input.sourceOutage ?? false,
    lastSuccessAt: input.lastSuccessAt === undefined ? DEMO_START_ISO : input.lastSuccessAt,
    lastErrorAt: input.lastErrorAt ?? null,
    nextCheckAt: input.settings.autoCheck ? addMinutes(DEMO_START_ISO, input.settings.pollMinutes) : null,
    mailFailOnce: input.mailFailOnce ?? false,
    seriesId,
    activities: [
      makeActivity(
        { ...emptyData(), role: input.role, clockIso: DEMO_START_ISO },
        {
          timestamp: DEMO_START_ISO,
          actor: 'Система',
          action: 'Смена запущена',
          hotelName: '',
          airportCode: '',
          localStayDate: '',
          description: input.description,
          result: 'info',
          groupKey: null,
          draftId: null,
          revision: null,
        },
      ),
    ],
  }
  return prepareDueGroups(data)
}

function markReviewed(data: DemoData, groupKey: string): DemoData {
  return {
    ...data,
    drafts: data.drafts.map((draft) =>
      draft.groupKey === groupKey && draft.status === 'active'
        ? { ...draft, status: 'reviewed', reviewedRevision: draft.revision, reviewedAt: data.clockIso, reviewedBy: 'Сменный специалист', saved: true }
        : draft,
    ),
  }
}

export function loadScenario(scenarioId: ScenarioId, settings: Settings, role: Role): DemoData {
  const seriesId = `series-${scenarioId}`
  const hotels = baseHotels()
  if (scenarioId === 'calm') {
    const older = calmBookings()
    const latest = clone(older).map((booking) => (booking.id === 'b-svx-1' ? { ...booking, arrivalLocalTime: '17:45' } : booking))
    return running({
      scenarioId,
      settings,
      role,
      hotels,
      snapshots: [
        snapshot({ id: 'snap-calm-1', sequence: 1, fetchedAt: MORNING_ISO, label: 'Утренняя рассылка · демо', bookings: older, scenarioId, seriesId }),
        snapshot({ id: 'snap-calm-2', sequence: 2, fetchedAt: DEMO_START_ISO, label: 'Проверка 14:00 · демо', bookings: latest, scenarioId, seriesId }),
      ],
      baselineEstablished: true,
      groupTimers: timers([['hotel-angel|SVX|2026-10-09', DEMO_START_ISO]], settings.quietMinutes),
      description: 'Спокойная смена. База 06:00 подтверждена, в SVX одна задержка.',
    })
  }
  if (scenarioId === 'delays') {
    const groups = [
      { hotelId: 'hotel-angel', airportCode: 'SVX', stay: '2026-10-09', at: DEMO_START_ISO },
      { hotelId: 'hotel-angel', airportCode: 'SVX', stay: '2026-10-10', at: addMinutes(DEMO_START_ISO, -20) },
      { hotelId: 'hotel-neva', airportCode: 'LED', stay: '2026-10-09', at: addMinutes(DEMO_START_ISO, -5) },
      { hotelId: 'hotel-neva', airportCode: 'LED', stay: '2026-10-10', at: addMinutes(DEMO_START_ISO, -5) },
      { hotelId: 'hotel-morskoy', airportCode: 'AER', stay: '2026-10-09', at: addMinutes(DEMO_START_ISO, -4) },
      { hotelId: 'hotel-kazan', airportCode: 'KZN', stay: '2026-10-09', at: addMinutes(DEMO_START_ISO, -3) },
    ]
    const older: Booking[] = []
    const latest: Booking[] = []
    groups.forEach((group, groupIndex) => {
      for (let seat = 0; seat < 4; seat += 1) {
        const person = PEOPLE[groupIndex * 4 + seat]
        const minutes = 8 * 60 + groupIndex * 20 + seat * 15
        const arrival = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
        const booking = stay(`b-m-${groupIndex}${seat}`, person[0], person[1], group.hotelId, group.airportCode, group.stay, arrival, seat % 2 ? 'DBL' : 'SGL')
        older.push(booking)
        const delayed = seat < 3 ? addMinutes(`2026-10-09T${arrival}:00.000Z`, 40).slice(11, 16) : arrival
        latest.push(seat < 3 ? { ...booking, arrivalLocalTime: delayed } : booking)
      }
    })
    return running({
      scenarioId,
      settings,
      role,
      hotels,
      snapshots: [
        snapshot({ id: 'snap-delay-1', sequence: 1, fetchedAt: MORNING_ISO, label: 'Утренняя рассылка · демо', bookings: older, scenarioId, seriesId }),
        snapshot({ id: 'snap-delay-2', sequence: 2, fetchedAt: DEMO_START_ISO, label: 'Массовые задержки · демо', bookings: latest, scenarioId, seriesId }),
      ],
      baselineEstablished: true,
      groupTimers: timers(groups.map((group) => [`${group.hotelId}|${group.airportCode}|${group.stay}`, group.at]), settings.quietMinutes),
      description: 'Массовые задержки: 6 групп, 18 событий. Черновик готов только у группы, чей срок тишины уже прошёл.',
    })
  }
  if (scenarioId === 'errors') {
    const older = calmBookings()
    older.push(stay('b-bad', 'crew-19', 'Виноградова Яна Игоревна', 'hotel-kazan', 'KZN', '2026-10-09', '14:00', 'SGL'))
    older.push(stay('b-unknown', 'crew-20', 'Баранов Денис Олегович', 'hotel-lazure', 'AER', '2026-10-09', '18:00', 'SGL'))
    const latest = clone(older).map((booking) => {
      if (booking.id === 'b-aer-1') return { ...booking, arrivalLocalTime: '18:05' }
      if (booking.id === 'b-unknown') return { ...booking, arrivalLocalTime: '19:20' }
      if (booking.id === 'b-bad') return { ...booking, arrivalFlight: '' }
      return booking
    })
    latest.push(stay('b-dup', 'crew-03', 'Морозова Елена Сергеевна', 'hotel-neva', 'LED', '2026-10-09', '12:40', 'SGL'))
    const broken = hotels.map((item) => (item.id === 'hotel-morskoy' ? { ...item, recipients: [] } : item))
    broken.push({
      ...hotel('hotel-lazure', 'Лазурь', 'Сочи', 'AER', 'Сочи', 'Europe/Moscow', '+03:00', 'lazure.desk@example.com'),
      contractStatus: 'unknown',
      recipients: ['lazure.desk@example.com'],
      sourceRecipients: [],
      recipientSource: 'local',
    })
    return running({
      scenarioId,
      settings,
      role,
      hotels: broken,
      snapshots: [
        snapshot({ id: 'snap-err-1', sequence: 1, fetchedAt: MORNING_ISO, label: 'Утренняя рассылка · демо', bookings: older, scenarioId, seriesId }),
        snapshot({
          id: 'snap-err-2',
          sequence: 2,
          fetchedAt: AT_1355,
          label: 'Последний успешный снимок · демо',
          bookings: latest,
          scenarioId,
          seriesId,
          issues: [{ bookingId: 'b-bad', field: 'arrivalFlight', message: 'Пустой рейс прибытия. Запись не додумана автоматически.' }],
        }),
      ],
      baselineEstablished: true,
      groupTimers: timers(
        [
          ['hotel-morskoy|AER|2026-10-09', AT_1355],
          ['hotel-neva|LED|2026-10-09', AT_1355],
          ['hotel-kazan|KZN|2026-10-09', AT_1355],
          ['hotel-lazure|AER|2026-10-09', AT_1355],
        ],
        settings.quietMinutes,
      ),
      sourceStatus: 'error',
      sourceOutage: true,
      lastSuccessAt: AT_1340,
      lastErrorAt: DEMO_START_ISO,
      description: 'Источник недоступен. Очередь и последний снимок сохранены.',
    })
  }
  if (scenarioId === 'replacement') {
    const older = [
      stay('b-old', 'crew-21', 'Крылова Светлана Максимовна', 'hotel-angel', 'SVX', '2026-10-09', '18:00', 'SGL'),
      stay('b-keep', 'crew-02', 'Волков Игорь Петрович', 'hotel-angel', 'SVX', '2026-10-09', '16:05', 'DBL'),
      { ...stay('b-night', 'crew-22', 'Гусев Тимофей Сергеевич', 'hotel-neva', 'LED', '2026-10-09', '23:40', 'SGL'), departureLocalDate: '2026-10-10', departureLocalTime: '08:20' },
    ]
    const latest = [
      { ...stay('b-new', 'crew-23', 'Ершова Лидия Павловна', 'hotel-angel', 'SVX', '2026-10-09', '18:00', 'SGL'), replacementOf: 'b-old' },
      { ...stay('b-keep', 'crew-02', 'Волков Игорь Петрович', 'hotel-neva', 'LED', '2026-10-09', '16:05', 'DBL') },
      { ...stay('b-night', 'crew-22', 'Гусев Тимофей Сергеевич', 'hotel-neva', 'LED', '2026-10-10', '00:30', 'SGL'), arrivalLocalDate: '2026-10-10', departureLocalDate: '2026-10-10', departureLocalTime: '08:20' },
    ]
    return running({
      scenarioId,
      settings,
      role,
      hotels,
      snapshots: [
        snapshot({ id: 'snap-repl-1', sequence: 1, fetchedAt: MORNING_ISO, label: 'Утренняя рассылка · демо', bookings: older, scenarioId, seriesId }),
        snapshot({ id: 'snap-repl-2', sequence: 2, fetchedAt: DEMO_START_ISO, label: 'Замена и полночь · демо', bookings: latest, scenarioId, seriesId }),
      ],
      baselineEstablished: true,
      groupTimers: timers(
        [
          ['hotel-angel|SVX|2026-10-09', DEMO_START_ISO],
          ['hotel-neva|LED|2026-10-09', DEMO_START_ISO],
          ['hotel-neva|LED|2026-10-10', DEMO_START_ISO],
        ],
        settings.quietMinutes,
      ),
      description: 'Замена человека, переезд в другую гостиницу и перенос через полночь.',
    })
  }
  if (scenarioId === 'reverted') {
    const older = calmBookings()
    const middle = clone(older).map((booking) => (booking.id === 'b-svx-1' ? { ...booking, arrivalLocalTime: '17:45' } : booking))
    const data = running({
      scenarioId,
      settings,
      role,
      hotels,
      snapshots: [
        snapshot({ id: 'snap-rev-1', sequence: 1, fetchedAt: MORNING_ISO, label: 'Утренняя рассылка · демо', bookings: older, scenarioId, seriesId }),
        snapshot({ id: 'snap-rev-2', sequence: 2, fetchedAt: AT_1340, label: 'Задержка 17:45 · демо', bookings: middle, scenarioId, seriesId }),
        snapshot({ id: 'snap-rev-3', sequence: 3, fetchedAt: AT_1355, label: 'Откат к 14:20 · демо', bookings: clone(older), scenarioId, seriesId }),
      ],
      baselineEstablished: true,
      groupTimers: {},
      description: 'Задержка откатилась до уведомления гостиницы.',
    })
    return {
      ...data,
      activities: [
        makeActivity(data, {
          timestamp: AT_1355,
          actor: 'Система',
          action: 'Проверка успешна',
          hotelName: 'Ангел',
          airportCode: 'SVX',
          localStayDate: '2026-10-09',
          description: 'Повторная проверка: время снова 14:20. Итоговой корректировки нет.',
          result: 'ok',
          groupKey: 'hotel-angel|SVX|2026-10-09',
          draftId: null,
          revision: null,
        }),
        makeActivity(data, {
          timestamp: AT_1340,
          actor: 'Система',
          action: 'Изменение обнаружено',
          hotelName: 'Ангел',
          airportCode: 'SVX',
          localStayDate: '2026-10-09',
          description: 'Прилёт Соколовой 14:20 → 17:45.',
          result: 'info',
          groupKey: 'hotel-angel|SVX|2026-10-09',
          draftId: null,
          revision: null,
        }),
        ...data.activities,
      ],
    }
  }
  if (scenarioId === 'unknown_base') {
    const older = calmBookings()
    const latest = clone(older).map((booking) => (booking.id === 'b-svx-1' ? { ...booking, arrivalLocalTime: '17:45' } : booking))
    return running({
      scenarioId,
      settings,
      role,
      hotels,
      snapshots: [
        snapshot({ id: 'snap-base-1', sequence: 1, fetchedAt: MORNING_ISO, label: 'Первый снимок · демо', bookings: older, scenarioId, seriesId }),
        snapshot({ id: 'snap-base-2', sequence: 2, fetchedAt: DEMO_START_ISO, label: 'Новый снимок · демо', bookings: latest, scenarioId, seriesId }),
      ],
      baselineEstablished: false,
      groupTimers: {},
      description: 'Уведомлённое состояние не подтверждено. Снимок не объявлен новыми заявками.',
    })
  }
  const older = calmBookings()
  const latest = clone(older).map((booking) => (booking.id === 'b-svx-1' ? { ...booking, arrivalLocalTime: '17:45' } : booking))
  const prepared = running({
    scenarioId,
    settings,
    role,
    hotels,
    snapshots: [
      snapshot({ id: `snap-${scenarioId}-1`, sequence: 1, fetchedAt: MORNING_ISO, label: 'Утренняя рассылка · демо', bookings: older, scenarioId, seriesId }),
      snapshot({ id: `snap-${scenarioId}-2`, sequence: 2, fetchedAt: addMinutes(DEMO_START_ISO, -30), label: 'Черновик v1 · демо', bookings: latest, scenarioId, seriesId }),
    ],
    baselineEstablished: true,
    groupTimers: timers([['hotel-angel|SVX|2026-10-09', addMinutes(DEMO_START_ISO, -30)]], settings.quietMinutes),
    mailFailOnce: scenarioId === 'send_error',
    description: scenarioId === 'stale' ? 'Черновик проверен до новой задержки.' : 'Черновик проверен. Почта один раз ответит ошибкой.',
  })
  const reviewed = markReviewed(prepared, 'hotel-angel|SVX|2026-10-09')
  if (scenarioId === 'send_error') return reviewed
  const shifted = clone(latest).map((booking) => (booking.id === 'b-svx-1' ? { ...booking, arrivalLocalTime: '19:10' } : booking))
  const extra = snapshot({ id: 'snap-stale-3', sequence: 3, fetchedAt: DEMO_START_ISO, label: 'Новая задержка · демо', bookings: shifted, scenarioId, seriesId })
  return {
    ...reviewed,
    snapshots: [...reviewed.snapshots, extra],
    groupTimers: timers([['hotel-angel|SVX|2026-10-09', DEMO_START_ISO]], settings.quietMinutes),
    activities: [
      makeActivity(reviewed, {
        timestamp: DEMO_START_ISO,
        actor: 'Система',
        action: 'Черновик устарел',
        hotelName: 'Ангел',
        airportCode: 'SVX',
        localStayDate: '2026-10-09',
        description: 'После проверки v1 прилёт изменился на 19:10. Отправка закрыта.',
        result: 'info',
        groupKey: 'hotel-angel|SVX|2026-10-09',
        draftId: reviewed.drafts[0]?.id ?? null,
        revision: 1,
      }),
      ...reviewed.activities,
    ],
  }
}
