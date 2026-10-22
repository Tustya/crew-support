export interface HotelLookup {
  id: string
  sourceHotelId: string | null
  airportCode: string
}

export interface HotelIndex {
  bySourceId: Map<string, HotelLookup>
  byAirport: Map<string, HotelLookup[]>
}

export type HotelMapping =
  | { hotelId: string }
  | { error: 'UNKNOWN_HOTEL' | 'HOTEL_MAPPING_MISSING' | 'HOTEL_MAPPING_AMBIGUOUS' }

export function indexHotels(hotels: readonly HotelLookup[]): HotelIndex {
  const bySourceId = new Map<string, HotelLookup>()
  const byAirport = new Map<string, HotelLookup[]>()
  for (const hotel of hotels) {
    if (hotel.sourceHotelId) bySourceId.set(hotel.sourceHotelId, hotel)
    const list = byAirport.get(hotel.airportCode)
    if (list) list.push(hotel)
    else byAirport.set(hotel.airportCode, [hotel])
  }
  return { bySourceId, byAirport }
}

export function resolveHotelMapping(index: HotelIndex, sourceHotelId: string | null, airportCode: string): HotelMapping {
  if (sourceHotelId) {
    const hotel = index.bySourceId.get(sourceHotelId)
    return hotel ? { hotelId: hotel.id } : { error: 'UNKNOWN_HOTEL' }
  }
  const matches = index.byAirport.get(airportCode) ?? []
  if (matches.length > 1) return { error: 'HOTEL_MAPPING_AMBIGUOUS' }
  return { error: 'HOTEL_MAPPING_MISSING' }
}
