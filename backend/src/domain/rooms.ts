export interface RoomGuest {
  id: string
  crewId: string
  gender: 'M' | 'F'
  roomType: 'SGL' | 'DBL'
  recordStatus: 'active' | 'cancelled'
}

export interface RoomAssignment {
  key: string
  kind: 'SGL' | 'DBL'
  bookingIds: string[]
}

function bySeniority(left: RoomGuest, right: RoomGuest): number {
  return left.crewId.localeCompare(right.crewId) || left.id.localeCompare(right.id)
}

function chunkPairs<T>(items: readonly T[]): T[][] {
  const pairs: T[][] = []
  for (let index = 0; index < items.length; index += 2) pairs.push(items.slice(index, index + 2))
  return pairs
}

function pairDoubles(doubles: readonly RoomGuest[], keptPairs: readonly (readonly string[])[]): RoomGuest[][] {
  const doublesById = new Map(doubles.map((guest) => [guest.id, guest]))
  const keptRooms = keptPairs
    .map((pair) => pair.map((bookingId) => doublesById.get(bookingId)))
    .filter((pair): pair is RoomGuest[] => pair.length === 2 && pair[0] !== undefined && pair[1] !== undefined && pair[0].id !== pair[1].id && pair[0].gender === pair[1].gender)
  const pairedIds = new Set(keptRooms.flat().map((guest) => guest.id))
  const free = doubles.filter((guest) => !pairedIds.has(guest.id)).sort(bySeniority)
  const byGender = new Map<string, RoomGuest[]>()
  for (const guest of free) {
    const list = byGender.get(guest.gender)
    if (list) list.push(guest)
    else byGender.set(guest.gender, [guest])
  }
  const fresh = [...byGender.values()].flatMap((group) => chunkPairs(group))
  return [...keptRooms, ...fresh]
}

export function assignRooms(guests: readonly RoomGuest[], keptPairs: readonly (readonly string[])[] = []): RoomAssignment[] {
  const activeDoubles = guests.filter((guest) => guest.recordStatus === 'active' && guest.roomType === 'DBL').sort(bySeniority)
  const separate = guests.filter((guest) => !(guest.recordStatus === 'active' && guest.roomType === 'DBL')).sort(bySeniority)
  const rooms = [...pairDoubles(activeDoubles, keptPairs), ...separate.map((guest) => [guest])]
  return rooms
    .map((occupants) => [...occupants].sort(bySeniority))
    .sort((left, right) => bySeniority(left[0] as RoomGuest, right[0] as RoomGuest))
    .map((occupants) => {
      const kind = occupants[0]?.roomType === 'DBL' ? 'DBL' : 'SGL'
      const bookingIds = occupants.map((guest) => guest.id)
      return { key: `${kind}:${bookingIds.join('+')}`, kind, bookingIds }
    })
}

export function roomPairs(rooms: readonly RoomAssignment[]): string[][] {
  return rooms.filter((room) => room.bookingIds.length === 2).map((room) => room.bookingIds)
}
