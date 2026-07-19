from dotenv import dotenv_values
from pymongo import MongoClient
cfg = dotenv_values('/app/backend/.env')
client = MongoClient(cfg['MONGO_URL'])
db = client[cfg['DB_NAME']]
res1 = db.devices.delete_many({'device_id': {'$regex': r'^qa-(iter28|access-visible)-'}})
res2 = db.users.delete_many({'email': {'$regex': r'^(super-admin-|qa-iter28-)'}})
res3 = db.escorts.delete_many({'id': {'$regex': r'^qa-iter28-'}})
db.users.update_one({'email':'admin@attendance.app'}, {'$set': {'role':'admin','mobile':'9849002111','mobile_last10':'9849002111'}})
print({'devices_deleted': res1.deleted_count, 'users_deleted': res2.deleted_count, 'escorts_deleted': res3.deleted_count})
print('admin', db.users.find_one({'email':'admin@attendance.app'}, {'_id':0,'email':1,'role':1,'mobile':1,'mobile_last10':1,'full_name':1}))
print('ghost_count', db.users.count_documents({'email': {'$regex': r'^super-admin-'}}))
client.close()
