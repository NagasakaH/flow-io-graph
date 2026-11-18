// 決済完了を Kafka へ流し、集計キャッシュを持つバッチ。
package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/twmb/franz-go/pkg/kgo"
)

func publish(ctx context.Context, client *kgo.Client, orderID string) error {
	rec := &kgo.Record{Topic: "analytics-events", Value: []byte(orderID)}
	return client.Produce(ctx, rec, nil)
}

func cacheSummary(ctx context.Context, rdb *redis.Client, summary string) error {
	return rdb.Set(ctx, "cache/daily-summary", summary, 24*time.Hour).Err()
}
