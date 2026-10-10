# Jobs on the fleet

The fleet lists jobs and cancels one. It does not start one, and it never stores the command line (J1). Starting is `morndo job` on the node. Each `example` fence below is sent to a fleet by `apps/fleet/test/jobs-api-doc.test.ts`. The answer must contain every field the fence shows. It may contain more.

The list and the single job are `GET`. Cancel is `POST /v1/op` with `job.cancel`, the job id and the caller's token. A missing job is `404`. A cancel for an id the fleet does not have is refused in the body and is not forwarded.

```example list
GET /v1/jobs?node=pc&lane=builder&state=exited
---
200
{"stale":false,"jobs":[{"id":"job-1","node":"pc","lane":"builder","class":"default","state":"exited","outcome":"exited"}]}
```

```example one
GET /v1/jobs/pc/job-1
---
200
{"stale":false,"job":{"id":"job-1","node":"pc","state":"exited","class":"default"}}
```

```example missing
GET /v1/jobs/pc/missing
---
404
{"error":"no_such_job"}
```

```example cancel
POST /v1/op
{"node":"pc","op":"job.cancel","args":{"id":"job-9","token":"lane-token"}}
---
200
{"ok":true}
```
