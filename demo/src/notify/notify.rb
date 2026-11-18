# 通知ワーカー。order-events を消費して notifications に残す。
require "pg"
require "aws-sdk-sqs"
require "json"

def consume
  sqs = Aws::SQS::Client.new
  resp = sqs.receive_message(queue_url: "https://sqs.ap-northeast-1.amazonaws.com/1234/order-events")

  conn = PG.connect(host: "db", dbname: "orders")
  resp.messages.each do |m|
    body = JSON.parse(m.body)
    conn.exec_params(
      "INSERT INTO notifications (order_id, channel) VALUES ($1, 'email')",
      [body["order_id"]],
    )
    conn.exec_params("UPDATE orders SET status = 'notified' WHERE id = $1", [body["order_id"]])
  end
end
