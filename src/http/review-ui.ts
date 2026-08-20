import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';

const REVIEW_HTML = String.raw`<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ContextHub Review Console</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #09100f;
      --panel: rgba(17, 29, 27, .92);
      --panel-2: #152321;
      --line: #29413d;
      --text: #edf6f2;
      --muted: #9ab0aa;
      --mint: #70e0b4;
      --mint-2: #39b98a;
      --amber: #f4bd68;
      --red: #ff8e86;
      --blue: #82b8ff;
      --shadow: 0 24px 70px rgba(0, 0, 0, .3);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
        "Segoe UI", "Noto Sans TC", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      background:
        radial-gradient(circle at 13% 0%, rgba(42, 137, 104, .24), transparent 32rem),
        radial-gradient(circle at 100% 85%, rgba(38, 91, 111, .2), transparent 28rem),
        var(--bg);
    }
    button, input, textarea { font: inherit; }
    button { cursor: pointer; }
    .shell { width: min(1440px, 100%); margin: 0 auto; padding: 28px; }
    header {
      display: flex; align-items: flex-start; justify-content: space-between; gap: 24px;
      margin-bottom: 22px;
    }
    .eyebrow {
      color: var(--mint); font-size: 12px; letter-spacing: .14em; text-transform: uppercase;
      font-weight: 800; margin-bottom: 7px;
    }
    h1 { font-size: clamp(27px, 4vw, 44px); letter-spacing: -.04em; margin: 0; line-height: 1; }
    .lede { color: var(--muted); margin: 10px 0 0; max-width: 720px; line-height: 1.55; }
    .secure {
      display: flex; gap: 9px; align-items: center; padding: 10px 13px;
      border: 1px solid var(--line); background: rgba(10, 19, 17, .74); border-radius: 999px;
      color: var(--muted); font-size: 12px; white-space: nowrap;
    }
    .secure::before { content: ""; width: 8px; height: 8px; background: var(--mint); border-radius: 50%; }
    .top-actions { display: flex; align-items: center; justify-content: flex-end; gap: 9px; flex-wrap: wrap; }
    .nav-link {
      display: inline-flex; padding: 10px 13px; border: 1px solid var(--line); border-radius: 999px;
      color: var(--muted); background: rgba(10, 19, 17, .74); font-size: 12px; text-decoration: none;
    }
    .nav-link:hover { color: var(--text); border-color: var(--mint-2); }
    .auth, .empty {
      border: 1px solid var(--line); background: var(--panel); border-radius: 18px; box-shadow: var(--shadow);
    }
    .auth {
      display: grid; grid-template-columns: minmax(220px, 1fr) auto; gap: 12px;
      padding: 16px; margin-bottom: 18px;
    }
    input, textarea {
      width: 100%; color: var(--text); background: #0c1715; border: 1px solid var(--line);
      border-radius: 11px; padding: 11px 13px; outline: none;
    }
    input:focus, textarea:focus { border-color: var(--mint-2); box-shadow: 0 0 0 3px rgba(57, 185, 138, .12); }
    textarea { min-height: 96px; resize: vertical; }
    .btn {
      border: 1px solid transparent; border-radius: 11px; padding: 10px 15px;
      color: #07110e; background: var(--mint); font-weight: 800;
    }
    .btn:hover { filter: brightness(1.06); }
    .btn:disabled { cursor: not-allowed; opacity: .5; }
    .btn.secondary { background: transparent; color: var(--text); border-color: var(--line); }
    .btn.reject { background: transparent; color: var(--red); border-color: rgba(255, 142, 134, .5); }
    .layout {
      display: grid; grid-template-columns: minmax(285px, 360px) minmax(0, 1fr);
      gap: 18px; min-height: 640px;
    }
    .pane { border: 1px solid var(--line); background: var(--panel); border-radius: 18px; box-shadow: var(--shadow); overflow: hidden; }
    .pane-head {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 15px 17px; border-bottom: 1px solid var(--line);
    }
    .pane-head h2 { font-size: 15px; margin: 0; }
    .count { color: var(--muted); font-size: 12px; }
    .candidate-list { display: grid; gap: 8px; padding: 10px; max-height: 780px; overflow: auto; }
    .candidate {
      width: 100%; text-align: left; padding: 13px; color: var(--text); background: transparent;
      border: 1px solid transparent; border-radius: 12px;
    }
    .candidate:hover { background: rgba(112, 224, 180, .06); border-color: var(--line); }
    .candidate.active { background: rgba(112, 224, 180, .11); border-color: var(--mint-2); }
    .candidate-title { font-weight: 760; line-height: 1.4; margin: 7px 0 5px; }
    .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
    .chip {
      display: inline-flex; padding: 3px 7px; border-radius: 999px; font-size: 11px;
      font-weight: 800; letter-spacing: .03em; color: var(--amber); background: rgba(244, 189, 104, .1);
      border: 1px solid rgba(244, 189, 104, .25);
    }
    .chip.authority { color: var(--blue); background: rgba(130, 184, 255, .08); border-color: rgba(130, 184, 255, .25); }
    .detail { padding: 22px; }
    .empty { padding: 55px 24px; color: var(--muted); text-align: center; box-shadow: none; }
    .detail h2 { font-size: clamp(24px, 3vw, 36px); line-height: 1.15; letter-spacing: -.025em; margin: 12px 0; }
    .detail-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 20px 0; }
    .datum { padding: 12px; border-radius: 12px; background: var(--panel-2); border: 1px solid var(--line); }
    .datum dt { color: var(--muted); font-size: 11px; margin-bottom: 5px; }
    .datum dd { margin: 0; font-size: 13px; overflow-wrap: anywhere; }
    .section { margin-top: 23px; }
    .section h3 { margin: 0 0 10px; font-size: 13px; color: var(--muted); letter-spacing: .08em; text-transform: uppercase; }
    .content, pre {
      margin: 0; padding: 15px; border: 1px solid var(--line); border-radius: 12px;
      background: #0c1715; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.65;
    }
    pre { color: #bdd2cc; font-size: 12px; overflow: auto; }
    .review-box { margin-top: 24px; padding: 15px; border-radius: 14px; background: rgba(244, 189, 104, .055); border: 1px solid rgba(244, 189, 104, .25); }
    .quality-warning { color: var(--amber); background: rgba(244, 189, 104, .08); border: 1px solid rgba(244, 189, 104, .25); }
    .actions { display: flex; gap: 9px; justify-content: flex-end; margin-top: 10px; }
    .timeline { display: grid; gap: 8px; }
    .event { padding: 11px 13px; border-left: 2px solid var(--line); background: rgba(255,255,255,.018); }
    .event strong { font-size: 13px; }
    .event small { display: block; color: var(--muted); margin-top: 4px; }
    .status { min-height: 22px; margin-top: 9px; color: var(--muted); font-size: 12px; }
    .status.bad { color: var(--red); }
    .hidden { display: none !important; }
    @media (max-width: 850px) {
      .shell { padding: 18px; }
      header { display: block; }
      .secure { width: fit-content; margin-top: 15px; }
      .layout { grid-template-columns: 1fr; }
      .candidate-list { max-height: 360px; }
      .detail-grid { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 520px) {
      .auth { grid-template-columns: 1fr; }
      .detail-grid { grid-template-columns: 1fr; }
      .actions { flex-direction: column-reverse; }
      .actions .btn { width: 100%; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div>
        <div class="eyebrow">ContextHub · Human review</div>
        <h1>記憶審核台</h1>
        <p class="lede">檢視 agent 提案的來源、內容與版本，再決定是否升格為共享記憶。接受 successor 時，舊記憶會由核心層原子標記為 superseded。</p>
      </div>
      <div class="top-actions">
        <a class="nav-link" href="/explore">查看全部 Accepted 記憶</a>
        <div class="secure">Reviewer key 只留在目前頁面</div>
      </div>
    </header>

    <section class="auth">
      <input id="token" type="password" autocomplete="off" spellcheck="false"
        placeholder="貼上此 namespace 的 human reviewer key（chk_…）">
      <button id="connect" class="btn">載入待審記憶</button>
      <div id="auth-status" class="status">不使用 ADMIN_TOKEN；關閉或重新整理頁面後 key 即消失。</div>
    </section>

    <section id="workspace" class="layout hidden">
      <aside class="pane">
        <div class="pane-head">
          <div>
            <h2>Candidate inbox</h2>
            <span id="count" class="count">0 筆</span>
          </div>
          <button id="refresh" class="btn secondary">重新整理</button>
        </div>
        <div id="candidates" class="candidate-list"></div>
      </aside>

      <article class="pane">
        <div id="empty" class="empty">從左側選一筆提案，查看完整內容與歷史。</div>
        <div id="detail" class="detail hidden">
          <div id="badges" class="meta"></div>
          <h2 id="title"></h2>
          <div id="subtitle" class="meta"></div>
          <dl id="facts" class="detail-grid"></dl>

          <section class="section">
            <h3>內容</h3>
            <div id="content" class="content"></div>
          </section>
          <section id="data-section" class="section hidden">
            <h3>結構化資料</h3>
            <pre id="data"></pre>
          </section>
          <section id="evidence-section" class="section hidden">
            <h3>Evidence / 關聯</h3>
            <div id="evidence" class="content"></div>
          </section>
          <section id="quality-section" class="section hidden">
            <h3>分類品質提醒</h3>
            <div id="quality" class="content quality-warning"></div>
          </section>
          <section class="section">
            <h3>版本與裁決歷史</h3>
            <div id="timeline" class="timeline"></div>
          </section>

          <section class="review-box">
            <label for="note">審核註記</label>
            <textarea id="note" maxlength="2000" placeholder="接受：可簡述查證依據。拒絕：請填寫原因，讓提案 agent 能修正。"></textarea>
            <div id="review-status" class="status"></div>
            <div class="actions">
              <button id="reject" class="btn reject">拒絕</button>
              <button id="accept" class="btn">接受為共享記憶</button>
            </div>
          </section>
        </div>
      </article>
    </section>
  </main>

  <script>
    (() => {
      let token = "";
      let items = [];
      let selected = null;

      const byId = (id) => document.getElementById(id);
      const tokenInput = byId("token");
      const connectButton = byId("connect");
      const workspace = byId("workspace");
      const candidateList = byId("candidates");
      const count = byId("count");
      const empty = byId("empty");
      const detail = byId("detail");

      function setStatus(id, message, bad) {
        const target = byId(id);
        target.textContent = message || "";
        target.classList.toggle("bad", Boolean(bad));
      }

      async function api(path, options) {
        const init = options || {};
        init.headers = Object.assign({}, init.headers || {}, {
          "Authorization": "Bearer " + token,
          "Content-Type": "application/json"
        });
        const response = await fetch(path, init);
        const body = response.status === 204 ? null : await response.json().catch(() => null);
        if (!response.ok) {
          const message = body && body.error && body.error.message
            ? body.error.message
            : "HTTP " + response.status;
          throw new Error(message);
        }
        return body;
      }

      function text(tag, value, className) {
        const node = document.createElement(tag);
        node.textContent = value == null ? "—" : String(value);
        if (className) node.className = className;
        return node;
      }

      function formatTime(value) {
        if (!value) return "—";
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-TW");
      }

      function chip(value, className) {
        return text("span", value, "chip" + (className ? " " + className : ""));
      }

      function renderList() {
        candidateList.replaceChildren();
        count.textContent = items.length + " 筆";
        if (!items.length) {
          selected = null;
          empty.classList.remove("hidden");
          detail.classList.add("hidden");
          candidateList.append(text("div", "目前沒有待審提案。", "empty"));
          return;
        }
        for (const item of items) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "candidate" + (selected && selected.id === item.id ? " active" : "");
          button.append(chip(item.type));
          button.append(text("div", item.title, "candidate-title"));
          const meta = text("div", "", "meta");
          meta.append(text("span", item.source));
          meta.append(text("span", "rev " + item.revision));
          meta.append(text("span", formatTime(item.created_at)));
          button.append(meta);
          button.addEventListener("click", () => selectItem(item.id));
          candidateList.append(button);
        }
      }

      function showEmpty() {
        selected = null;
        empty.classList.remove("hidden");
        detail.classList.add("hidden");
        if (items.length) renderList();
      }

      function addFact(label, value) {
        const wrap = document.createElement("div");
        wrap.className = "datum";
        wrap.append(text("dt", label));
        wrap.append(text("dd", value));
        byId("facts").append(wrap);
      }

      function renderTimeline(history) {
        const timeline = byId("timeline");
        timeline.replaceChildren();
        const events = [];
        for (const version of history.versions || []) {
          events.push({
            at: version.changed_at,
            title: "Revision " + version.revision + " · " + version.change_kind,
            detail: "changed by " + version.changed_by
          });
        }
        for (const review of history.reviews || []) {
          events.push({
            at: review.reviewed_at,
            title: "Review · " + review.decision,
            detail: "by " + review.reviewed_by + (review.note ? " · " + review.note : "")
          });
        }
        events.sort((a, b) => String(b.at).localeCompare(String(a.at)));
        if (!events.length) {
          timeline.append(text("div", "尚無歷史紀錄。", "event"));
          return;
        }
        for (const event of events) {
          const card = text("div", "", "event");
          card.append(text("strong", event.title));
          card.append(text("small", formatTime(event.at) + " · " + event.detail));
          timeline.append(card);
        }
      }

      function renderQualityWarnings(item) {
        const warnings = [];
        if (item.information_class === "memory" && !item.memory_kind) {
          warnings.push("Memory 缺少 memory_kind；接受前請確認它是 fact、preference、decision、experience、procedure、relationship 或 working_state。");
        }
        if (item.information_class === "memory" && (!item.entities || !item.entities.length)) {
          warnings.push("尚未標記 entities；若內容涉及人物、專案、裝置或來源，請補上 canonical entity。");
        }
        if (item.information_class === "memory" && !item.valid_from && !item.valid_until && !item.expires_at) {
          warnings.push(item.memory_kind === "working_state"
            ? "working_state 沒有 valid_until 或 expires_at，可能長期污染目前脈絡。"
            : "尚未標記 valid_from、valid_until 或 expires_at；接受前請確認這筆 Memory 的時效範圍。");
        }
        if (["fact", "preference", "decision", "procedure", "relationship"].includes(item.memory_kind) && !item.last_verified_at) {
          warnings.push("耐久 Memory 尚未記錄 last_verified_at；接受前請確認是否已有查證依據。");
        }
        byId("quality-section").classList.toggle("hidden", warnings.length === 0);
        byId("quality").textContent = warnings.join("\n\n");
      }

      async function selectItem(id) {
        setStatus("review-status", "", false);
        try {
          const [itemResponse, history] = await Promise.all([
            api("/v1/items/" + encodeURIComponent(id)),
            api("/v1/items/" + encodeURIComponent(id) + "/history")
          ]);
          selected = itemResponse.item;
          renderList();
          empty.classList.add("hidden");
          detail.classList.remove("hidden");

          const badges = byId("badges");
          badges.replaceChildren(
            chip(selected.trust_state),
            chip(selected.authority, "authority"),
            chip(selected.type)
          );
          byId("title").textContent = selected.title;
          byId("subtitle").replaceChildren(
            text("span", "source: " + selected.source),
            text("span", "namespace: " + selected.namespace),
            text("span", "revision: " + selected.revision)
          );
          byId("facts").replaceChildren();
          addFact("建立時間", formatTime(selected.created_at));
          addFact("事件時間", formatTime(selected.occurred_at));
          addFact("敏感度", selected.sensitivity);
          addFact("狀態", selected.status);
          addFact("信心", selected.confidence == null ? "—" : selected.confidence);
          addFact("Successor of", selected.successor_of || "—");
          addFact("資訊角色", selected.information_class || "—");
          addFact("Memory 類型", selected.memory_kind || "—");
          addFact("Claim key", selected.claim_key || "—");
          addFact("最後驗證", formatTime(selected.last_verified_at));
          renderQualityWarnings(selected);
          byId("content").textContent = selected.content || "（無內容）";

          const hasData = selected.data !== null && selected.data !== undefined;
          byId("data-section").classList.toggle("hidden", !hasData);
          byId("data").textContent = hasData ? JSON.stringify(selected.data, null, 2) : "";

          const evidence = []
            .concat(selected.derived_from || [])
            .concat(selected.entities || [])
            .concat(selected.tags || []);
          byId("evidence-section").classList.toggle("hidden", evidence.length === 0);
          byId("evidence").textContent = evidence.join(" · ");
          byId("note").value = "";
          renderTimeline(history);
        } catch (error) {
          setStatus("auth-status", error.message, true);
        }
      }

      async function loadCandidates() {
        setStatus("auth-status", "正在讀取 reviewer inbox…", false);
        try {
          const response = await api("/v1/candidates?scope=inbox&limit=100");
          items = response.items || [];
          workspace.classList.remove("hidden");
          setStatus("auth-status", "已連線；server-side policy 會限制你只能審核這把 key 所屬的 namespace。", false);
          renderList();
          if (selected && !items.find((item) => item.id === selected.id)) showEmpty();
        } catch (error) {
          workspace.classList.add("hidden");
          setStatus("auth-status", error.message, true);
        }
      }

      async function review(decision) {
        if (!selected) return;
        const note = byId("note").value.trim();
        if (decision === "reject" && !note) {
          setStatus("review-status", "拒絕時請填寫原因，讓提案者知道如何修正。", true);
          return;
        }
        byId("accept").disabled = true;
        byId("reject").disabled = true;
        setStatus("review-status", "正在提交裁決…", false);
        try {
          await api("/v1/items/" + encodeURIComponent(selected.id) + "/review", {
            method: "POST",
            body: JSON.stringify({
              decision,
              expected_revision: selected.revision,
              note: note || undefined,
              idempotency_key: crypto.randomUUID()
            })
          });
          setStatus("review-status", decision === "accept" ? "已接受並寫入稽核。" : "已拒絕並寫入稽核。", false);
          selected = null;
          await loadCandidates();
        } catch (error) {
          setStatus("review-status", error.message, true);
        } finally {
          byId("accept").disabled = false;
          byId("reject").disabled = false;
        }
      }

      connectButton.addEventListener("click", () => {
        token = tokenInput.value.trim();
        tokenInput.value = "";
        if (!token.startsWith("chk_")) {
          token = "";
          setStatus("auth-status", "請輸入有效的 reviewer client key。", true);
          return;
        }
        loadCandidates();
      });
      tokenInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") connectButton.click();
      });
      byId("refresh").addEventListener("click", loadCandidates);
      byId("accept").addEventListener("click", () => review("accept"));
      byId("reject").addEventListener("click", () => review("reject"));
    })();
  </script>
</body>
</html>`;

export function registerReviewUiRoutes(app: FastifyInstance, config?: Config): void {
  if (config?.controlCenterEnabled) return;
  app.get('/review', async (_req, reply) => {
    return reply
      .header(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      )
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff')
      .type('text/html; charset=utf-8')
      .send(REVIEW_HTML);
  });
}
