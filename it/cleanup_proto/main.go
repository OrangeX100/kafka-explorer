//go:build ignore

// cleanup_proto: remove the FAILED early-experiment topic (schema id 8
// stored as an EMPTY schema on this registry — undecodable by design) and
// its registry subject, so testers don't mistake it for a decode bug.
//
//	go run ./it/cleanup_proto/main.go -brokers 110.40.185.78:9092 \
//	    -registry http://110.40.185.78:8081 -topic proto-probe-value
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
)

func main() {
	brokers := flag.String("brokers", "localhost:9092", "seed brokers")
	registry := flag.String("registry", "http://localhost:8081", "schema registry")
	topic := flag.String("topic", "proto-probe-value", "topic to delete")
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cl, err := kgo.NewClient(kgo.SeedBrokers(*brokers))
	if err != nil {
		panic(err)
	}
	adm := kadm.NewClient(cl)
	resps, err := adm.DeleteTopics(ctx, *topic)
	if err != nil {
		panic(err)
	}
	for _, r := range resps {
		fmt.Printf("topic %s delete: err=%v\n", *topic, r.Err)
	}
	cl.Close()

	req, _ := http.NewRequestWithContext(ctx, http.MethodDelete,
		*registry+"/subjects/"+*topic+"-value", nil)
	req.Header.Set("Accept", "application/vnd.schemaregistry.v1+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		panic(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	fmt.Printf("subject %s-value delete: HTTP %d %s\n", *topic, resp.StatusCode, string(body))
}
