import requests

resources = [700102, 725331, 700509, 721070]
location_ids = [1, 13, 56, 72]
url = 'http://localhost:3001/api/edoc/calendar-dates'

print(f"{'resourceId':<12} | {'locationId':<12} | {'retcode':<8} | {'datesCount':<12} | {'error'}")
print('-' * 80)

for res_id in resources:
    for loc_id in location_ids:
        p = {'resourceId': res_id, 'regionId': 5, 'city': 'Hyderabad', 'locationId': loc_id}
        try:
            r = requests.post(url, json=p, timeout=5)
            c = 0
            if r.status_code == 200:
                d = r.json()
                if isinstance(d, list): c = len(d)
                elif isinstance(d, dict): c = len(d.get('dates', [])) if 'dates' in d else 'N/A'
            print(f"{res_id:<12} | {loc_id:<12} | {r.status_code:<8} | {str(c):<12} | {r.text[:30] if r.status_code != 200 else ''}")
        except Exception as e: print(f"{res_id:<12} | {loc_id:<12} | {'Err':<8} | {'0':<12} | {str(e)[:30]}")
