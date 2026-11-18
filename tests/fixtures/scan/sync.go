package main

import (
	"os"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/twmb/franz-go/pkg/kgo"
)

func publish(ctx context.Context, client *kgo.Client, id string) error {
	return client.Produce(ctx, &kgo.Record{Topic: "analytics-events", Value: []byte(id)}, nil)
}

func cache(ctx context.Context, rdb *redis.Client) error {
	body, _ := os.ReadFile("conf/app.yaml")
	return rdb.Set(ctx, "cache/summary", string(body), 24*time.Hour).Err()
}
