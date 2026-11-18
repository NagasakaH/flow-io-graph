import boto3
import requests

sqs = boto3.client("sqs")
BASE_URL = "https://catalog.internal"

def process(cur):
    # INSERT INTO ghost_table VALUES (1)  ← コメントなので拾ってはいけない
    cur.execute("SELECT id FROM orders WHERE status = 'new'")
    cur.execute("INSERT INTO audit_log (payload) VALUES ('x')")
    sqs.send_message(QueueName="job-queue", MessageBody="{}")
    r = requests.get(BASE_URL + "/v1/items")
    with open("data/in.json") as f:
        payload = f.read()
    out = open("data/out.json", "w")
    rdb.set("cache/last-run", "1")
    dynamodb.put_item(TableName="job_locks", Item={})
