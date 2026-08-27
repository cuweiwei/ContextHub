# NAS Deployment Runbook

這是 ContextHub NAS 正式升級的唯一標準流程。Codex 不應自行拼接 `git pull`、
`docker build`、backup 與 restart 命令；正式變更只透過共享、root-owned、非互動的
`/usr/local/bin/deployment` gateway。`scripts/nas-deploy.sh` 與 libexec engine 保留給 owner
明確執行的歷史 recovery/evidence 流程，不是 agent 繞過 gateway 的替代入口。

## 固定邊界

- **Source repository**：Git worktree，只提供待部署 commit，例如 `/volume1/docker/contexthub`。
- **Production app directory**：保存 `.env`、`docker-compose.yml` 與 `data/`，例如
  `/volume1/docker/contexthub/v4-ee0e0e2`。
- 兩者不得混用。特別是不要在 production app directory 執行 `git pull`；該目錄可能只是
  source repo 內的 untracked deployment directory。
- production database 只從 app directory 的 `data/` 掛載。deploy script 不讀出 `.env`、
  不輸出 credential、不自動還原 database。
- Docker host port 必須維持 `127.0.0.1`，Tailscale Serve 才是遠端入口。
- Codex 只能上傳 repo 的 `compose.prod.yml` 到 project staging；不得寫入 production
  `.env`、active Compose、`/etc/codex-deploy` 或 gateway 本身。

## Agent 執行前檢查

1. 先執行 `ssh Tim@gnest 'sudo -n /usr/local/bin/deployment list'`；只有 exact
   `contexthub` project id 存在才能繼續。
2. 確認 feature branch 已合併到 `main`，PR CI 與合併後 `main` CI 都是綠燈。
3. 記錄要部署的完整 commit SHA、`package.json` version、immutable image digest 與 workflow URL。
4. 確認 NAS production health 仍可達；不要用本機測試冒充 live health。
5. 所有 privileged gateway call 使用 `sudo -n`；失敗就立即停止，不要求或等待密碼。

## Codex 標準 gateway 流程

`compose.prod.yml` 必須引用 CI 已發布的 immutable image，且不得包含 `build:`、host network、
privileged、Docker socket 或非核准 bind root。然後依序執行：

```bash
ssh Tim@gnest \
  'sudo -n /usr/local/bin/deployment list'

scp -O compose.prod.yml \
  Tim@gnest:/volume1/docker-deploy/staging/contexthub/compose.prod.yml

ssh Tim@gnest \
  'sudo -n /usr/local/bin/deployment contexthub validate'

# 只有 owner 已明確授權 deployment 且 validate 成功後：
ssh Tim@gnest \
  'sudo -n /usr/local/bin/deployment contexthub deploy'

ssh Tim@gnest \
  'sudo -n /usr/local/bin/deployment contexthub status'
```

Validate 失敗只修 repo `compose.prod.yml`，重新 upload + validate；不得直接改 active production
Compose。Deploy 後仍須核對 private 8788／8443 health 的 version、commit、schema、audit、
projection，並保留 gateway/health evidence。若 gateway 支援且確實需要 rollback，使用
`deployment contexthub rollback`，不得改用 direct Docker。

## Owner recovery-only 流程

以下 source worktree、`nas-deploy.sh`、libexec engine 與 `DEPLOYMENT VERIFIED` 流程只供 owner
在明確 recovery 情境中使用。Codex 的一般 production deployment 到上一節為止。

### 更新 recovery deploy script

在 NAS source repository 使用明確的 `git -C`，避免更新到錯誤目錄：

```bash
SOURCE_DIR=/volume1/docker/contexthub
git -C "$SOURCE_DIR" fetch origin main
git -C "$SOURCE_DIR" merge --ff-only origin/main
```

若 tracked worktree 不乾淨或無法 fast-forward，停止部署並先處理差異；不得使用
`git reset --hard` 或刪除 production artifacts。

### Recovery read-only preflight

正式 immutable release 先從成功的 main CI `aihome-release-<commit>` artifact 內
`release-manifest.json` 取得 digest、commit、Compose checksum 與 health path；version 由該 commit
的 `package.json` 取得，workflow URL 則保留該次 Actions run，再執行：

```bash
bash /volume1/docker/contexthub/scripts/nas-deploy.sh \
  --source-dir /volume1/docker/contexthub \
  --app-dir /volume1/docker/contexthub/v4-ee0e0e2 \
  --image ghcr.io/cuweiwei/contexthub@sha256:<64-hex-digest> \
  --expected-commit <full-main-sha> \
  --expected-version <semver> \
  --workflow-url https://github.com/cuweiwei/ContextHub/actions/runs/<run-id> \
  --preflight-only
```

Owner 手動 recovery build 才使用 Git ref：

```bash
bash /volume1/docker/contexthub/scripts/nas-deploy.sh \
  --source-dir /volume1/docker/contexthub \
  --app-dir /volume1/docker/contexthub/v4-ee0e0e2 \
  --ref origin/main \
  --preflight-only
```

成功標誌是 `PREFLIGHT PASS`。Preflight 驗證：

- source/app directory 分離；
- `.env`、compose 與 production DB 存在；
- bind address 是 `127.0.0.1`；
- target commit/version 可解析；
- current production health 可達。

### Recovery 一次完成部署

Owner 在同一個 NAS SSH terminal 執行；`sudo -v` 與 deploy script 必須在同一個 TTY。GitHub
production workflow 會使用下列 immutable image path；`--ref` 只給 owner 手動 recovery：

```bash
sudo -v
bash /usr/local/libexec/contexthub-deploy-engine \
  --source-dir /volume1/docker/contexthub \
  --app-dir /volume1/docker/contexthub/v4-ee0e0e2 \
  --image ghcr.io/cuweiwei/contexthub@sha256:<64-hex-digest> \
  --expected-commit <full-main-sha> \
  --expected-version 0.9.0 \
  --workflow-url https://github.com/cuweiwei/ContextHub/actions/runs/<run-id> \
  --yes
```

在 immutable path，script 只 pull 已驗證的 digest，並將 compose 的 image reference 指向該
digest；不依賴 `latest` 作為部署依據。Owner recovery build 才使用：

```bash
sudo -v
bash /volume1/docker/contexthub/scripts/nas-deploy.sh \
  --source-dir /volume1/docker/contexthub \
  --app-dir /volume1/docker/contexthub/v4-ee0e0e2 \
  --ref origin/main \
  --yes
```

Script 依序執行：

1. 以 running container image 建立 timestamped rollback tag。
2. 正式 image mode 只 pull 指定的 GHCR digest 並標成 candidate，不在 NAS build；
   owner recovery `--ref` mode 才從指定 commit 的 clean `git archive` 建 candidate，不把
   NAS untracked files、`.env` 或 production data 放進 Docker build context。
3. 驗證 OCI version/revision labels。
4. 由 running release 建 `BackupManifestV1`；legacy release 無 manifest 時，candidate 只以
   no-migration backup 模式建立 snapshot/manifest。
5. 對 read-only-mounted snapshot 執行 upgrade gate；candidate 此時尚未啟動。
6. Gate 通過後才將 candidate 標成 `contexthub:latest` 並 recreate container；image mode
   的 Compose 實際使用仍是精確 digest，recovery mode 才使用本機 candidate tag。
7. 驗證 redacted health 的 version/commit，執行 reindex、retrieval status、isolated restore
   drill、90-day idempotency GC 與 production doctor。
8. 驗證 running image ID，寫入 metadata-only release evidence。

成功標誌只有一個：

```text
DEPLOYMENT VERIFIED commit=<full-sha> version=<version>
```

Evidence 位於：

```text
<app-dir>/deployments/<UTC timestamp>-<short sha>/
```

其中只有 health、retrieval status、restore drill、doctor、event log 與 release metadata；
不含 `.env`、API key、Memory content 或 database copy。

## Failure 與 rollback

- Build、backup 或 upgrade gate 失敗：script 在 restart 前停止，production container 不變。
- Restart 後 health/reindex/restore drill/doctor 任一步失敗：script 自動把
  `contexthub:latest` 指回本次保存的 rollback image 並 recreate。
- Rollback health 仍失敗：停止自動操作。保留 rollback image、manifest 與 deployment report，
  由 owner 判斷是否因 schema 不相容或 DB 損壞需要使用對應 snapshot。
- Script **永遠不自動 restore database**；正式 restore 會替換 authoritative SQLite，必須由
  owner 針對 manifest 明確授權，並在 restore 後執行 reindex。

## Synology maintenance tasks

先以唯讀方式盤點既有 Task Scheduler，確認沒有重複 job，再由 owner 建立：

- daily：`scripts/nas-maintenance.sh --app-dir <app-dir> --task daily`（backup + doctor）；
- weekly：`... --task weekly`（90-day idempotency GC）；
- monthly：`... --task monthly`（isolated restore drill + audit anchor）。

Compose 將 `/audit-anchors` 綁定到 production app 外的 `audit-anchors/`；anchor 不得放入
`data/`。通知失敗由服務內的 metadata-only dispatcher 處理，成功不送 Telegram；失敗、
逾期 backup、projection degraded、磁碟不足與 connector stale 才由 owner-approved
Telegram subscription 接收。建立或啟用 subscription 前，確認 token/chat-id 是 NAS 上 mode
`0600` 的檔案，且不存在 raw Memory、query、路徑或 credential。

## Agent 交付格式

Agent 完成後必須回報：

- deployed commit/version；
- PR 與 `main` workflow URL；
- backup manifest basename；
- health/schema/retrieval model；
- restore drill 與 doctor status；
- rollback image tag；
- 是否改動 Control Center flags、Tailscale Serve、credential 或 NAS network 設定。

沒有 `DEPLOYMENT VERIFIED` 與 live evidence 時，只能說「candidate prepared」或
「deployment blocked」，不能宣稱已部署。
