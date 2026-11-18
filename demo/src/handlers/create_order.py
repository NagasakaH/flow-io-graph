"""注文受付ハンドラ。API 経由で受けた注文を orders テーブルへ書き、
決済を呼び、order-events キューへ通知する。"""

import boto3
import requests
import psycopg2

PAYMENT_URL = "http://payment-service:8080/charge"

sqs = boto3.client("sqs")


def handle_create_order(payload: dict) -> dict:
    conn = psycopg2.connect(dsn="postgresql://db:5432/orders")
    with conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO orders (customer_id, amount, status) VALUES (%s, %s, 'pending')",
            (payload["customer_id"], payload["amount"]),
        )
        cur.execute("SELECT id FROM order_drafts WHERE token = %s", (payload["token"],))
        row = cur.fetchone()

    charge = requests.post(PAYMENT_URL, json={"amount": payload["amount"]}, timeout=5)
    charge.raise_for_status()

    sqs.send_message(
        QueueUrl="https://sqs.ap-northeast-1.amazonaws.com/1234/order-events",
        MessageBody=charge.text,
    )
    return {"status": "created", "draft": row}
