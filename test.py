import requests
resources = [700102, 725331, 700509, 721070]
locs = [1, 13, 56, 72]
url = 'http://localhost:3001/api/edoc/calendar-dates'
print('resourceId   | locationId   | retcode  | datesCount   | error')
print('-' * 70)
for rid in resources:
    for lid in locs:
        p = {'resourceId': rid, 'regionId': 5, 'city': 'Hyderabad', 'locationId': lid}
        try:
            r = requests.post(url, json=p, timeout=5)
            c = r.status_code
            cnt = 0
            err = ''
            if c == 200:
                data = r.json()
                if isinstance(data, list): cnt = len(data)
                elif isinstance(data, dict): cnt = len(data.get('dates', []))
            else:
                err = r.text[:30].replace('\n', ' ')
            print(f'{rid:<12} | {lid:<12} | {c:<8} | {cnt:<12} | {err}')
        except Exception as e:
            print(f'{rid:<12} | {lid:<12} | Err      | 0            | {str(e)[:30]}')
