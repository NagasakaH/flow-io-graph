// 毎朝のレポート生成。orders を集計して CSV に書き、S3 へ上げ、BI へ合図する。
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const fs = require("node:fs");

const s3 = new S3Client({});

async function run(db) {
  const rows = await db.query("SELECT id, amount, status FROM orders WHERE status = 'paid'");
  const csv = toCsv(rows);
  fs.writeFileSync("reports/daily.csv", csv);

  await s3.send(
    new PutObjectCommand({
      Bucket: "analytics-bucket",
      Key: "reports/daily.csv",
      Body: csv,
    }),
  );

  // 宛先が設定由来なのでリテラルから決まらない（ワークシートに出る）
  await fetch(`${process.env.BI_WEBHOOK_URL}/notify`, { method: "POST" });
}

function toCsv(rows) {
  return ["id,amount,status", ...rows.map((r) => `${r.id},${r.amount},${r.status}`)].join("\n");
}

module.exports = { run };
