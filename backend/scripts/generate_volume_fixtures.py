import zipfile
from datetime import date, timedelta
from pathlib import Path
from xml.sax.saxutils import escape

OUT = Path(__file__).resolve().parents[1] / 'fixtures' / 'volume'
HOTEL_AIRPORT = {'angel': 'SVX', 'bereg': 'SVX', 'south': 'AER', 'north': 'AER'}
HOTEL_SWAP = {'angel': 'bereg', 'bereg': 'angel', 'south': 'north', 'north': 'south'}
SURNAMES = [
    'Иванов', 'Петров', 'Сидоров', 'Кузнецов', 'Смирнов', 'Попов', 'Соколов', 'Лебедев', 'Козлов', 'Новиков',
    'Морозов', 'Волков', 'Алексеев', 'Семенов', 'Егоров', 'Павлов', 'Степанов', 'Николаев', 'Орлов', 'Андреев',
    'Макаров', 'Никитин', 'Захаров', 'Зайцев', 'Соловьев', 'Борисов', 'Яковлев', 'Григорьев', 'Романов', 'Воробьев',
]
LETTERS = 'АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЭЮЯ'
POSITIONS = ['КВС', 'БП', 'СБ']
BASE = date(2026, 10, 23)


def dotted(value: date) -> str:
    return value.strftime('%d.%m.%Y')


def shift_date(value: str, days: int) -> str:
    day, month, year = (int(part) for part in value.split('.'))
    return dotted(date(year, month, day) + timedelta(days=days))


def shift_time(value: str, minutes: int) -> str:
    hour, minute = (int(part) for part in value.split(':'))
    total = hour * 60 + minute + minutes
    return f'{(total // 60) % 24:02d}:{total % 60:02d}'


def person(index: int, surname_shift: int = 0) -> str:
    surname = SURNAMES[(index + surname_shift) % len(SURNAMES)]
    return f'{surname} {LETTERS[(index // 30) % len(LETTERS)]}.{LETTERS[index % len(LETTERS)]}.'


def make_row(index: int, booking_id: str, surname_shift: int = 0) -> dict[str, str]:
    hotel = ('angel', 'bereg', 'south', 'north')[(index - 1) % 4]
    stay = BASE if index % 2 == 0 else BASE + timedelta(days=1)
    arrival = 8 * 60 + (index % 6) * 60
    departure = 18 * 60 + (index % 4) * 30
    return {
        'id': booking_id,
        'name': person(index, surname_shift),
        'position': POSITIONS[index % 3],
        'gender': 'М' if index % 2 == 0 else 'Ж',
        'airport': HOTEL_AIRPORT[hotel],
        'hotel': hotel,
        'stay': dotted(stay),
        'arrival_flight': f'DP{1000 + index}',
        'arrival_date': dotted(stay),
        'arrival_time': f'{arrival // 60:02d}:{arrival % 60:02d}',
        'departure_flight': f'DP{2000 + index}',
        'departure_date': dotted(stay + timedelta(days=1)),
        'departure_time': f'{departure // 60:02d}:{departure % 60:02d}',
        'room': 'SGL' if index % 2 == 0 else 'DBL',
        'duration': '10:00',
    }


def base_rows() -> list[dict[str, str]]:
    return [make_row(index, f'b-{index:04d}') for index in range(1, 301)]


def ids(start: int, end: int, prefix: str = 'b-', width: int = 4) -> set[str]:
    return {f'{prefix}{index:0{width}d}' for index in range(start, end + 1)}


def swap_hotel(rows: list[dict[str, str]], booking_ids: set[str]) -> None:
    for row in rows:
        if row['id'] not in booking_ids:
            continue
        hotel = HOTEL_SWAP[row['hotel']]
        row['hotel'] = hotel
        row['airport'] = HOTEL_AIRPORT[hotel]


def shift_stay(rows: list[dict[str, str]], booking_ids: set[str]) -> None:
    for row in rows:
        if row['id'] in booking_ids:
            row['stay'] = shift_date(row['stay'], 1)


def shift_arrival(rows: list[dict[str, str]], booking_ids: set[str], minutes: int) -> None:
    for row in rows:
        if row['id'] in booking_ids:
            row['arrival_time'] = shift_time(row['arrival_time'], minutes)


def shift_departure(rows: list[dict[str, str]], booking_ids: set[str], minutes: int) -> None:
    for row in rows:
        if row['id'] in booking_ids:
            row['departure_time'] = shift_time(row['departure_time'], minutes)


def replace(rows: list[dict[str, str]], removed: set[str], added: list[dict[str, str]]) -> list[dict[str, str]]:
    kept = [row for row in rows if row['id'] not in removed]
    return kept + added


def workbook(rows: list[dict[str, str]]) -> bytes:
    parent = ['Аэропорт', 'Фамилия И.О.', 'Должность', 'Пол', 'Рейс прибытия', 'Локальная дата и время аэропорта прибытия', None, 'Рейс отправления', 'Локальная дата и время аэропорта отправления', None, 'Тип комнаты', 'Время в гостинице', 'Идентификатор брони', 'Код гостиницы', 'Дата проживания']
    child = [None, None, None, None, None, 'Дата прибытия', 'Время прибытия', None, 'Дата отправления', 'Время отправления', None, None, None, None, None]
    sheet_rows = [[], [], parent, child]
    for row in rows:
        sheet_rows.append([
            row['airport'], row['name'], row['position'], row['gender'], row['arrival_flight'], row['arrival_date'], row['arrival_time'],
            row['departure_flight'], row['departure_date'], row['departure_time'], row['room'], row['duration'], row['id'], row['hotel'], row['stay'],
        ])
    sheet_rows.append(['Итого'])
    return xlsx(sheet_rows)


def xlsx(rows: list[list[str | None]]) -> bytes:
    from io import BytesIO

    body = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>']
    body.append('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>')
    for row_index, row in enumerate(rows, start=1):
        cells = []
        for column_index, value in enumerate(row):
            if value is None or value == '':
                continue
            ref = f'{column_name(column_index)}{row_index}'
            cells.append(f'<c r="{ref}" t="inlineStr"><is><t>{escape(value)}</t></is></c>')
        if cells:
            body.append(f'<row r="{row_index}">{"".join(cells)}</row>')
    body.append('</sheetData></worksheet>')
    content_types = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>'''
    rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>'''
    workbook_xml = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Выгрузка" sheetId="1" r:id="rId1"/></sheets></workbook>'''
    workbook_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>'''
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('[Content_Types].xml', content_types)
        archive.writestr('_rels/.rels', rels)
        archive.writestr('xl/workbook.xml', workbook_xml)
        archive.writestr('xl/_rels/workbook.xml.rels', workbook_rels)
        archive.writestr('xl/worksheets/sheet1.xml', ''.join(body))
    return buffer.getvalue()


def column_name(index: int) -> str:
    name = ''
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        name = chr(65 + remainder) + name
    return name


def build() -> dict[str, list[dict[str, str]]]:
    rows = base_rows()
    stages: dict[str, list[dict[str, str]]] = {'01-baseline.xlsx': [dict(row) for row in rows]}
    shift_arrival(rows, ids(1, 50), 30)
    stages['02-arrival.xlsx'] = [dict(row) for row in rows]
    shift_departure(rows, ids(51, 100), 45)
    stages['03-departure.xlsx'] = [dict(row) for row in rows]
    for row in rows:
        if row['id'] in ids(101, 150):
            row['arrival_flight'] = f"{row['id']}-arr"
            row['departure_flight'] = f"{row['id']}-dep"
    stages['04-flight.xlsx'] = [dict(row) for row in rows]
    for row in rows:
        if row['id'] in ids(151, 200):
            row['room'] = 'DBL' if row['room'] == 'SGL' else 'SGL'
    stages['05-room.xlsx'] = [dict(row) for row in rows]
    added = [make_row(index, f'b-{1000 + index:04d}', surname_shift=11) for index in range(1, 31)]
    rows = replace(rows, ids(201, 230), added)
    stages['06-cancel-and-new.xlsx'] = [dict(row) for row in rows]
    swap_hotel(rows, ids(231, 260))
    stages['07-hotel.xlsx'] = [dict(row) for row in rows]
    shift_stay(rows, ids(261, 290))
    stages['08-stay-date.xlsx'] = [dict(row) for row in rows]
    shift_arrival(rows, ids(1, 50), 15)
    for row in rows:
        if row['id'] in ids(291, 300):
            row['room'] = 'DBL' if row['room'] == 'SGL' else 'SGL'
    stages['09-second-wave.xlsx'] = [dict(row) for row in rows]
    shift_arrival(rows, ids(1, 40), 20)
    shift_departure(rows, ids(51, 90), 25)
    for row in rows:
        if row['id'] in ids(101, 140):
            row['arrival_flight'] = f"{row['arrival_flight']}-2"
            row['departure_flight'] = f"{row['departure_flight']}-2"
        if row['id'] in ids(151, 190):
            row['room'] = 'DBL' if row['room'] == 'SGL' else 'SGL'
    fresh = [make_row(index, f'b-{2000 + index:04d}', surname_shift=17) for index in range(1, 21)]
    rows = replace(rows, ids(1001, 1020), fresh)
    swap_hotel(rows, ids(231, 255))
    shift_stay(rows, ids(261, 285))
    stages['10-all-kinds.xlsx'] = [dict(row) for row in rows]
    return stages


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, rows in build().items():
        if len(rows) != 300:
            raise SystemExit(f'{name}: {len(rows)} rows')
        (OUT / name).write_bytes(workbook(rows))
        print(name, len(rows))


if __name__ == '__main__':
    main()
