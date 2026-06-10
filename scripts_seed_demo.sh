#!/bin/bash
BASE="http://localhost:8001/api"
TOKEN=$(curl -s -X POST $BASE/auth/login -H "Content-Type: application/json" -d '{"email":"admin@attendance.app","password":"Admin@12345"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
echo "Token: ${TOKEN:0:20}..."
create() {
  curl -s -X POST $BASE/members -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$1" -o /dev/null -w "%{http_code} "
}
create '{"email":"arjun@attendance.app","password":"pass123","full_name":"Arjun Nair","category":"sailor","rank":"Petty Officer"}'
create '{"email":"meera@attendance.app","password":"pass123","full_name":"Meera Kapoor","category":"sailor","rank":"Leading Seaman"}'
create '{"email":"rohit@attendance.app","password":"pass123","full_name":"Rohit Verma","category":"coach","rank":"Head Coach"}'
create '{"email":"sana@attendance.app","password":"pass123","full_name":"Sana Sheikh","category":"staff","rank":"Logistics"}'
create '{"email":"vikram@attendance.app","password":"pass123","full_name":"Vikram Singh","category":"sailor","rank":"Able Seaman"}'
create '{"email":"divya@attendance.app","password":"pass123","full_name":"Divya Rao","category":"coach","rank":"Fitness Coach"}'
echo ""
echo "Demo members seeded."
