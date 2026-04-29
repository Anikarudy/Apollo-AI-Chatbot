import requests

queries = [
    "/api/doctors?city=Hyderabad",
    "/api/doctors?specialty=Cardiology&city=Chennai",
    "/api/doctors?specialty=Neurology&city=Mumbai"
]

base_url = "http://localhost:3001"

for query in queries:
    print(f"--- Fetching: {query} ---")
    try:
        response = requests.get(f"{base_url}{query}")
        if response.status_code != 200:
            print(f"Failed to fetch doctors from {query}: {response.status_code}")
            continue
            
        data = response.json()
        doctors = data.get('doctors', [])
        if not doctors:
             print("No doctors found.")
             continue
             
        test_count = 0
        for doc in doctors:
            if test_count >= 12:
                break
            res_id = doc.get('resourceId')
            loc_id = doc.get('locationId')
            name = doc.get('name')
            
            if res_id and loc_id:
                test_count += 1
                payload                payload       ur            d,
                                                                                                                                                     }/api/ed                              ad)
                      t_                      t_                     prin                      t_                      t_    : {loc_id}) - Status: {post_resp.status_co                      t_                      t_                     prin        ep                           rint(f"                      t_   e}")

