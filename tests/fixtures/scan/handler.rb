require "pg"

# DELETE FROM ghost_rb コメントなので拾わない
def consume(sqs, conn)
  resp = sqs.receive_message(queue_url: "https://sqs.ap-northeast-1.amazonaws.com/1234/order-events")
  resp.messages.each do |m|
    conn.exec_params("INSERT INTO notifications (order_id) VALUES ($1)", [m.body])
    conn.exec_params("UPDATE orders SET status = 'done' WHERE id = $1", [m.body])
  end
end
