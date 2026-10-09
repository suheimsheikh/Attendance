"""Generate passport PNG + seed MongoDB for iter100 UI tests."""
import os, sys, json, uuid, requests
from datetime import date
from PIL import Image, ImageDraw, ImageFont
from pymongo import MongoClient

BASE = "https://youth-regatta-app.preview.emergentagent.com"
mongo = MongoClient(os.environ.get("MONGO_URL","mongodb://localhost:27017"))
db = mongo[os.environ.get("DB_NAME","test_database")]

# 1) Admin login
s = requests.Session()
r = s.post(f"{BASE}/api/auth/login", json={"email":"admin@attendance.app","password":"Admin@12345"})
r.raise_for_status()
tok = r.json()["access_token"]
s.headers["Authorization"] = f"Bearer {tok}"

# 2) Create throwaway athlete member (TEST Anita Sharma)
mid_email = f"test_iter100_{uuid.uuid4().hex[:6]}@ishowedup-test.example.com"
payload = {"full_name":"TEST Anita Sharma","email":mid_email,"category":"athlete",
           "father_name":"TEST Rajesh Sharma","role":"member","mobile":"","password":"Test@12345"}
r = s.post(f"{BASE}/api/members", json=payload)
r.raise_for_status()
member = r.json()
mid = member["id"]
print("MEMBER_ID", mid)

# 3) Seed another member with expired passport so weekly popup pops
exp_email = f"test_iter100exp_{uuid.uuid4().hex[:6]}@ishowedup-test.example.com"
r = s.post(f"{BASE}/api/members", json={"full_name":"TEST Expired Passport","email":exp_email,"category":"athlete","role":"member","password":"Test@12345"})
r.raise_for_status()
exp_mid = r.json()["id"]
r = s.put(f"{BASE}/api/members/{exp_mid}/id-docs",
          json={"people":{"self":{"passport":"Z1112223","passport_expiry":"2000-01-01"}}})
r.raise_for_status()
print("EXP_MEMBER_ID", exp_mid)

# 4) Delete this week's passport_reminder_log row
r = s.get(f"{BASE}/api/id-docs/passport-expiry-week")
r.raise_for_status()
week = r.json()["week"]
print("WEEK", week)
db.passport_reminder_log.delete_many({"week": week})

# 5) Insert test regatta (overseas, future)
db.regattas.update_one({"id":"test-reg-qa"},
    {"$set":{"id":"test-reg-qa","name":"TEST Worlds","start_date":"2099-07-01",
             "end_date":"2099-07-10","country":"Portugal"}}, upsert=True)

# 6) Generate passport PNG
img = Image.new("RGB", (900, 500), "white")
d = ImageDraw.Draw(img)
try:
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 36)
    small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 28)
except Exception:
    font = ImageFont.load_default(); small = font
d.text((40,30),  "REPUBLIC OF INDIA PASSPORT", fill="black", font=font)
d.text((40,110), "Passport No.: Z7654321", fill="black", font=small)
d.text((40,170), "Surname: SHARMA", fill="black", font=small)
d.text((40,230), "Given Name(s): ANITA DEVI", fill="black", font=small)
d.text((40,290), "Date of Expiry: 15/03/2027", fill="black", font=small)
d.text((40,350), "Nationality: INDIAN", fill="black", font=small)
img.save("/tmp/passport_iter100.png")
print("PNG /tmp/passport_iter100.png")

# Dump context
with open("/tmp/iter100_ctx.json","w") as f:
    json.dump({"mid":mid,"email":mid_email,"exp_mid":exp_mid,"exp_email":exp_email,
               "week":week,"token":tok}, f)
print("CTX /tmp/iter100_ctx.json")
