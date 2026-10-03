package jobs

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"time"

	"lorelink.dev/lorelink/internal/maintainer"
	"lorelink.dev/lorelink/internal/publish"
	"lorelink.dev/lorelink/internal/searchidx"
	"lorelink.dev/lorelink/internal/store"
	"lorelink.dev/lorelink/internal/workspace"
)

const (
	KindSync       = "repo.sync"
	KindReindex    = "search.reindex"
	KindPublish    = "publish.run"
	KindMaintain   = "maintainer.sync"
	KindMaintainCk = "maintainer.check"
	KindPoll       = "connector.poll"
)

type Worker struct {
	Store      *store.Store
	WS         *workspace.Manager
	Publish    *publish.Service
	Index      *searchidx.Indexer
	Maintainer *maintainer.Service
	Log        *slog.Logger
	ID         string
}

func New(st *store.Store, ws *workspace.Manager, pub *publish.Service, idx *searchidx.Indexer, m *maintainer.Service, log *slog.Logger) *Worker {
	if log == nil {
		log = slog.Default()
	}
	host, _ := os.Hostname()
	return &Worker{Store: st, WS: ws, Publish: pub, Index: idx, Maintainer: m, Log: log, ID: host + "-worker"}
}

func (w *Worker) Start(ctx context.Context) {
	go w.loop(ctx)
	go w.pollLoop(ctx)
}

func (w *Worker) loop(ctx context.Context) {
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			jobs, err := w.Store.ClaimJobs(ctx, w.ID, 4)
			if err != nil {
				w.Log.Error("claim jobs", "err", err)
				continue
			}
			for i := range jobs {
				w.handle(ctx, jobs[i])
			}
		}
	}
}

func (w *Worker) pollLoop(ctx context.Context) {
	t := time.NewTicker(60 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			w.enqueuePoll(ctx)
		}
	}
}

func (w *Worker) enqueuePoll(ctx context.Context) {
	bindings, err := w.Store.ListPollBindings(ctx)
	if err != nil {
		w.Log.Error("list poll bindings", "err", err)
		return
	}
	for _, b := range bindings {
		id := b.ProjectID
		_, _ = w.Store.EnqueueJob(ctx, store.Job{ProjectID: &id, Kind: KindPoll, PayloadJSON: []byte(`{"project_id":"` + id + `"}`)})
	}
}

func (w *Worker) handle(ctx context.Context, job store.Job) {
	var err error
	switch job.Kind {
	case KindSync, KindPoll:
		if job.ProjectID != nil {
			_, err = w.WS.Sync(ctx, *job.ProjectID)
			if err == nil && w.Index != nil {
				err = w.Index.Reindex(ctx, *job.ProjectID, "latest")
			}
		}
	case KindReindex:
		if job.ProjectID != nil {
			err = w.Index.Reindex(ctx, *job.ProjectID, "latest")
		}
	case KindPublish:
		var payload struct {
			RunID string `json:"run_id"`
		}
		_ = json.Unmarshal(job.PayloadJSON, &payload)
		run, getErr := w.Store.GetPublishRun(ctx, payload.RunID)
		if getErr != nil {
			err = getErr
			break
		}
		p, getErr := w.Store.GetProject(ctx, run.ProjectID)
		if getErr != nil {
			err = getErr
			break
		}
		org, getErr := w.Store.GetOrganisation(ctx, p.OrgID)
		if getErr != nil {
			err = getErr
			break
		}
		err = w.Publish.Run(ctx, *run, p, org.Slug)
	case KindMaintain, KindMaintainCk:
		if job.ProjectID != nil && w.Maintainer != nil {
			if job.Kind == KindMaintain {
				_, err = w.Maintainer.Sync(ctx, *job.ProjectID)
			} else {
				_, err = w.Maintainer.Check(ctx, *job.ProjectID)
			}
		}
	default:
		err = errUnknown(job.Kind)
	}
	if err != nil {
		w.Log.Error("job failed", "id", job.ID, "kind", job.Kind, "err", err)
		if job.Attempts < 8 {
			_ = w.Store.RequeueJob(ctx, job.ID, time.Now().Add(time.Duration(job.Attempts)*30*time.Second), err.Error())
			return
		}
		_ = w.Store.FinishJob(ctx, job.ID, "error", err.Error())
		return
	}
	_ = w.Store.FinishJob(ctx, job.ID, "ok", "")
}

type unknownKind string

func errUnknown(kind string) error { return unknownKind(kind) }

func (e unknownKind) Error() string { return "unknown job kind: " + string(e) }
