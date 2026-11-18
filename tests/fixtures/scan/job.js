const fs = require("node:fs");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

async function run() {
  const rows = await db.query("SELECT * FROM orders JOIN customers ON orders.c_id = customers.id");
  fs.writeFileSync("reports/out.csv", "a,b");
  await s3.send(new PutObjectCommand({ Bucket: "report-bucket", Key: "out.csv" }));
  await fetch("http://alert-api:3000/v1/fire?team=core#now", { method: "POST" });
  await fetch(`${process.env.WEBHOOK_BASE}/ping`, { method: "POST" });
  /* DELETE FROM ghost_js コメントブロックも拾わない */
  fs.writeFileSync("tmp/x", s3_path);
}
