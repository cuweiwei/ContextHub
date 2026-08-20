# CI/CD 與 production release runbook

這份文件補足 [NAS Deployment Runbook](NAS-DEPLOY-RUNBOOK.md) 的外部設定。repo 內的
workflow、manifest、wrapper 與測試已準備好，但 GitHub ruleset、environment、Tailscale
ACL、NAS SSH key 和 Synology 排程必須由 owner 在各自系統套用；未套用前不得宣稱
**自動部署路徑**已 `provider_verified`。Owner 仍可在自己的 NAS SSH/sudo session 直接執行
root-owned deploy engine；只有該次精確 digest 的完整 evidence 通過時，該 release 才可個別標成
`live_verified`。

## Current evidence snapshot

截至 2026-08-20，[main CI run 32332161336](https://github.com/cuweiwei/ContextHub/actions/runs/32332161336)
已對 `0.9.0@3ef8f8ce40a7d2746de31b44b00562d56e38fe20` 完成全部 gates，並產生：

- GHCR `linux/amd64` immutable digest
  `sha256:a0517f05990a2419269bb210fd7c9bd23dc666242c9413f53fc0084114f49e45`；
- `contexthub-sbom-32332161336`；
- GitHub build provenance attestation；
- `ReleaseManifestV1`，其 version、commit、digest、CI URL 與 provenance subject 已交叉驗證。

GHCR manifest 可讀取，`gh attestation verify` 已通過，所以 immutable release 本身已
`provider_verified`。Owner 已透過 root-owned NAS deploy engine 部署相同 digest；該次
`DeploymentEvidenceV1` 記錄 backup manifest、schema 15、37/37 retrieval coverage、8788／8443
health、isolated restore drill、doctor、rollback image 與 `DEPLOYMENT VERIFIED`，因此這個 release
已 `live_verified`。

GitHub 目前仍無 `production` environment，也沒有 `ContextHub production deploy` workflow run；
所以以上證據只證明 owner-authorized manual production path 與該次 running release，不代表
GitHub Actions 自動部署路徑已 `provider_verified`。

## GitHub repository settings

在 `cuweiwei/ContextHub` 建立 `production` environment：

- deployment branch：只允許 `main`；
- required reviewer：owner；不要求第二位 reviewer；
- 不啟用 administrator bypass；
- workflow concurrency 由 `deploy-production.yml` 固定為 `contexthub-production`，不可取消舊部署；
- branch ruleset：`main` 禁止直接 push、force-push 與 deletion，required status check 只有
  `verify`。本 repo 不在 workflow 中自動修改 ruleset。

Production environment secrets（只存短效/部署用途，不放 `ADMIN_TOKEN`）：

| Name | 用途 |
|---|---|
| `TS_OAUTH_CLIENT_ID` | Tailscale GitHub OIDC workload identity client |
| `TS_AUDIENCE` | Tailscale OIDC audience |
| `NAS_DEPLOY_SSH_KEY` | 專用 deploy key，無 shell、只允許 forced command |
| `NAS_SSH_KNOWN_HOSTS` | pinned NAS host key（完整 `known_hosts` 行） |

Environment variables：`NAS_HOST`、`NAS_USER`、`NAS_HEALTH_URL`，可選
`NAS_CONTROL_HEALTH_URL`。`NAS_HEALTH_URL` 必須是 Tailscale/private URL；不要填 public IP。

## Tailscale and SSH boundary

建立 ephemeral GitHub runner identity，只授予 `tag:context-hub-deploy`。ACL 僅允許該 tag
到 `GNest` 的 SSH port；不要把整個 tailnet 或 NAS admin port 授予 runner。NAS 的
`authorized_keys` entry 應包含 `restrict`、`no-agent-forwarding`、`no-port-forwarding`、
`no-pty`、`no-user-rc` 與固定 `command=".../contexthub-deploy-wrapper.sh"`。

在 NAS 以 owner SSH terminal 安裝（target 必須是 root-owned filesystem）：

```bash
sudo -v
sudo /volume1/docker/contexthub/scripts/install-nas-deploy-wrapper.sh /usr/local/libexec
```

建立 root-only `/etc/contexthub/deploy.env`，只放明確絕對路徑：

```text
SOURCE_DIR=/volume1/docker/contexthub
APP_DIR=/volume1/docker/contexthub/v4-ee0e0e2
CONTAINER_NAME=contexthub
DEPLOY_SCRIPT=/usr/local/libexec/contexthub-deploy-engine
```

並用 sudoers 只允許 deploy SSH user 執行
`/usr/local/libexec/contexthub-deploy`（`NOPASSWD`、無 wildcard）。不要允許該 user 執行
`docker`、`bash`、`git` 或任意 compose command。source worktree 可以維持 owner 管理，因為
正式 image mode 的 deploy engine 與 `upgrade-gate.sh` 已由 helper 複製到 root-owned path；
dispatcher 會拒絕非 root-owned engine。

## Release and deploy flow

1. PR merge 到 `main`；`verify` 綠燈後 container job push `linux/amd64` GHCR image，並產生
   digest、SBOM、GitHub provenance attestation 與 `ReleaseManifestV1`。
2. 從 main workflow 取完整 SHA，在 Actions 手動執行 `ContextHub production deploy`，輸入
   `release_sha`。preflight 會確認 SHA 是 main ancestor、OCI version/revision 和 attestation
   都匹配。
3. GitHub `production` approval 通過後，runner 以 Tailscale ephemeral node + pinned SSH host
   key 呼叫 forced command。NAS 正式路徑使用 `--image repo@sha256:digest`，不在 NAS rebuild。
4. NAS 依序 snapshot、read-only gate、recreate、health、reindex、restore drill、doctor；任何
   post-start failure 都保留 metadata evidence 並自動 rollback image，不自動 restore SQLite。
5. 只有 log 出現 `DEPLOYMENT VERIFIED` 且 8788 health 的 version/build commit、projection、
   restore drill、doctor 均匹配時，才算 `live_verified`。

CI/CD workflow uses pinned action commits and the production environment approval/concurrency
boundary. GitHub's environment and artifact-attestation semantics are documented in the official
[environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
and [artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
references; Tailscale's OIDC action setup is documented in its
[GitHub Action guide](https://tailscale.com/docs/integrations/github/github-action).
