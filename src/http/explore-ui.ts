import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';

const EXPLORE_HTML = String.raw`<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ContextHub Memory Explorer</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #08100f;
      --panel: rgba(16, 29, 26, .94);
      --panel-2: #13231f;
      --line: #29413c;
      --text: #edf7f2;
      --muted: #94aaa4;
      --mint: #72e3b5;
      --mint-2: #39b98a;
      --amber: #f3bd67;
      --blue: #84b9ff;
      --red: #ff9088;
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
        radial-gradient(circle at 10% 0%, rgba(42, 137, 104, .25), transparent 32rem),
        radial-gradient(circle at 100% 80%, rgba(38, 91, 111, .2), transparent 28rem),
        var(--bg);
    }
    button, input, select { font: inherit; }
    button { cursor: pointer; }
    .shell { width: min(1500px, 100%); margin: 0 auto; padding: 28px; }
    header {
      display: flex; align-items: flex-start; justify-content: space-between; gap: 24px;
      margin-bottom: 22px;
    }
    .eyebrow {
      color: var(--mint); font-size: 12px; letter-spacing: .14em; text-transform: uppercase;
      font-weight: 800; margin-bottom: 7px;
    }
    h1 { font-size: clamp(28px, 4vw, 46px); letter-spacing: -.04em; margin: 0; line-height: 1; }
    .lede { color: var(--muted); margin: 10px 0 0; max-width: 760px; line-height: 1.55; }
    .top-actions { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; justify-content: flex-end; }
    .pill, .nav-link {
      display: inline-flex; align-items: center; gap: 8px; padding: 10px 13px;
      border: 1px solid var(--line); background: rgba(10, 19, 17, .74); border-radius: 999px;
      color: var(--muted); font-size: 12px; white-space: nowrap; text-decoration: none;
    }
    .pill::before { content: ""; width: 8px; height: 8px; background: var(--mint); border-radius: 50%; }
    .nav-link:hover { color: var(--text); border-color: var(--mint-2); }
    .auth, .panel {
      border: 1px solid var(--line); background: var(--panel); border-radius: 18px; box-shadow: var(--shadow);
    }
    .auth {
      display: grid; grid-template-columns: minmax(240px, 1fr) auto; gap: 12px;
      padding: 16px; margin-bottom: 18px;
    }
    input, select {
      width: 100%; color: var(--text); background: #0b1714; border: 1px solid var(--line);
      border-radius: 11px; padding: 11px 13px; outline: none;
    }
    input:focus, select:focus { border-color: var(--mint-2); box-shadow: 0 0 0 3px rgba(57, 185, 138, .12); }
    .btn {
      border: 1px solid transparent; border-radius: 11px; padding: 10px 15px;
      color: #07110e; background: var(--mint); font-weight: 800;
    }
    .btn:hover { filter: brightness(1.06); }
    .btn.secondary { color: var(--text); background: transparent; border-color: var(--line); }
    .status { min-height: 22px; margin-top: 8px; color: var(--muted); font-size: 12px; grid-column: 1 / -1; }
    .status.bad { color: var(--red); }
    .hidden { display: none !important; }
    .stats {
      display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 18px;
    }
    .stat {
      padding: 17px; border: 1px solid var(--line); border-radius: 15px;
      background: linear-gradient(145deg, rgba(26, 48, 42, .92), rgba(13, 25, 22, .92));
    }
    .stat span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 7px; }
    .stat strong { font-size: 26px; letter-spacing: -.03em; }
    .overview {
      display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(300px, .8fr);
      gap: 18px; margin-bottom: 18px;
    }
    .panel-head {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 15px 17px; border-bottom: 1px solid var(--line);
    }
    .panel-head h2 { font-size: 15px; margin: 0; }
    .count { color: var(--muted); font-size: 12px; }
    .source-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; padding: 12px; }
    .source {
      padding: 13px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 13px;
    }
    .source-top { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
    .source strong { overflow-wrap: anywhere; }
    .source small { color: var(--muted); }
    .source-types { margin-top: 8px; color: var(--muted); font-size: 12px; line-height: 1.5; }
    .bars { display: grid; gap: 12px; padding: 16px; }
    .bar-meta { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; }
    .track { height: 7px; margin-top: 6px; border-radius: 999px; background: #0a1513; overflow: hidden; }
    .fill { height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--mint-2), var(--mint)); }
    .browser { overflow: hidden; }
    .filters {
      display: grid; grid-template-columns: minmax(220px, 1.5fr) repeat(3, minmax(140px, .65fr)) auto;
      gap: 9px; padding: 13px; border-bottom: 1px solid var(--line);
    }
    .content-layout { display: grid; grid-template-columns: minmax(300px, 430px) minmax(0, 1fr); min-height: 580px; }
    .memory-list { padding: 10px; border-right: 1px solid var(--line); max-height: 760px; overflow: auto; }
    .memory {
      display: block; width: 100%; padding: 13px; text-align: left; color: var(--text);
      background: transparent; border: 1px solid transparent; border-radius: 12px;
    }
    .memory + .memory { margin-top: 7px; }
    .memory:hover { background: rgba(112, 224, 180, .055); border-color: var(--line); }
    .memory.active { background: rgba(112, 224, 180, .11); border-color: var(--mint-2); }
    .memory-title { margin: 7px 0 5px; font-weight: 760; line-height: 1.4; }
    .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
    .chip {
      display: inline-flex; padding: 3px 7px; border-radius: 999px; font-size: 11px;
      font-weight: 800; letter-spacing: .03em; color: var(--amber); background: rgba(244, 189, 104, .1);
      border: 1px solid rgba(244, 189, 104, .25);
    }
    .chip.authority { color: var(--blue); background: rgba(130, 184, 255, .08); border-color: rgba(130, 184, 255, .25); }
    .chip.private { color: var(--red); background: rgba(255, 144, 136, .08); border-color: rgba(255, 144, 136, .25); }
    .empty { color: var(--muted); text-align: center; padding: 56px 20px; }
    .detail { padding: 22px; overflow: auto; max-height: 760px; }
    .detail h2 { font-size: clamp(24px, 3vw, 36px); line-height: 1.15; letter-spacing: -.025em; margin: 12px 0; }
    .detail-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 20px 0; }
    .datum { padding: 12px; border-radius: 12px; background: var(--panel-2); border: 1px solid var(--line); }
    .datum dt { color: var(--muted); font-size: 11px; margin-bottom: 5px; }
    .datum dd { margin: 0; font-size: 13px; overflow-wrap: anywhere; }
    .section { margin-top: 23px; }
    .section h3 { margin: 0 0 10px; font-size: 13px; color: var(--muted); letter-spacing: .08em; text-transform: uppercase; }
    .memory-content, pre {
      margin: 0; padding: 15px; border: 1px solid var(--line); border-radius: 12px;
      background: #0b1714; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.65;
    }
    pre { color: #bdd2cc; font-size: 12px; overflow: auto; }
    @media (max-width: 1000px) {
      .overview, .content-layout { grid-template-columns: 1fr; }
      .memory-list { border-right: 0; border-bottom: 1px solid var(--line); max-height: 390px; }
      .filters { grid-template-columns: 1fr 1fr; }
      .filters .btn { width: 100%; }
    }
    @media (max-width: 720px) {
      .shell { padding: 18px; }
      header { display: block; }
      .top-actions { justify-content: flex-start; margin-top: 15px; }
      .auth, .filters { grid-template-columns: 1fr; }
      .stats { grid-template-columns: 1fr 1fr; }
      .source-grid, .detail-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div>
        <div class="eyebrow">ContextHub · Context explorer</div>
        <h1>持久資訊總覽</h1>
        <p class="lede">查看目前已接受的 Source projection 與 Memory、來源分布及內容明細。短暫 Context Package 不會儲存在這裡；所有數字與項目都受這把 key 的 namespace、來源與敏感度權限限制。</p>
      </div>
      <div class="top-actions">
        <a class="nav-link" href="/review">前往 Candidate 審核台</a>
        <div class="pill">Key 只留在目前頁面</div>
      </div>
    </header>

    <section class="auth">
      <input id="token" type="password" autocomplete="off" spellcheck="false"
        placeholder="貼上具有 read 權限的 client key（建議使用 human reviewer key）">
      <button id="connect" class="btn">載入持久資訊</button>
      <div id="auth-status" class="status">不使用 ADMIN_TOKEN；關閉或重新整理頁面後 key 即消失。</div>
    </section>

    <section id="workspace" class="hidden">
      <div class="stats">
        <div class="stat"><span>可讀取的 Accepted items</span><strong id="stat-items">0</strong></div>
        <div class="stat"><span>有內容的來源</span><strong id="stat-sources">0</strong></div>
        <div class="stat"><span>資料類型</span><strong id="stat-types">0</strong></div>
        <div class="stat"><span>目前列表</span><strong id="stat-visible">0</strong></div>
      </div>

      <div class="overview">
        <section class="panel">
          <div class="panel-head">
            <h2>來源</h2>
            <span id="source-count" class="count"></span>
          </div>
          <div id="sources" class="source-grid"></div>
        </section>
        <section class="panel">
          <div class="panel-head">
            <h2>類型分布</h2>
            <span class="count">accepted only</span>
          </div>
          <div id="types" class="bars"></div>
        </section>
      </div>

      <section class="panel browser">
        <div class="panel-head">
          <h2>Source / Memory 瀏覽器</h2>
          <span id="result-note" class="count"></span>
        </div>
        <div class="filters">
          <input id="query" type="search" placeholder="搜尋標題、內容或標籤">
          <select id="source-filter"><option value="">全部來源</option></select>
          <select id="type-filter"><option value="">全部類型</option></select>
          <select id="status-filter">
            <option value="">全部生命週期</option>
            <option value="active">active</option>
            <option value="completed">completed</option>
            <option value="cancelled">cancelled</option>
            <option value="superseded">superseded</option>
          </select>
          <button id="search" class="btn secondary">套用篩選</button>
        </div>
        <div class="content-layout">
          <div id="memories" class="memory-list"></div>
          <article>
            <div id="empty" class="empty">從左側選一筆持久資訊查看完整內容。</div>
            <div id="detail" class="detail hidden">
              <div id="badges" class="meta"></div>
              <h2 id="title"></h2>
              <div id="subtitle" class="meta"></div>
              <dl id="facts" class="detail-grid"></dl>
              <section class="section">
                <h3>內容</h3>
                <div id="content" class="memory-content"></div>
              </section>
              <section id="data-section" class="section hidden">
                <h3>結構化資料</h3>
                <pre id="data"></pre>
              </section>
              <section id="relations-section" class="section hidden">
                <h3>標籤與關聯</h3>
                <div id="relations" class="memory-content"></div>
              </section>
            </div>
          </article>
        </div>
      </section>
    </section>
  </main>

  <script>
    (() => {
      let token = "";
      let sources = [];
      let items = [];
      let selectedId = null;

      const byId = (id) => document.getElementById(id);
      const tokenInput = byId("token");
      const workspace = byId("workspace");

      function setStatus(message, bad) {
        const target = byId("auth-status");
        target.textContent = message || "";
        target.classList.toggle("bad", Boolean(bad));
      }

      async function api(path) {
        const response = await fetch(path, {
          headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" }
        });
        const body = await response.json().catch(() => null);
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

      function addOption(select, value, label) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        select.append(option);
      }

      function aggregateTypes() {
        const result = {};
        for (const source of sources) {
          for (const pair of Object.entries(source.types || {})) {
            result[pair[0]] = (result[pair[0]] || 0) + Number(pair[1] || 0);
          }
        }
        return result;
      }

      function renderOverview() {
        const acceptedSources = sources.filter((source) => source.total_items > 0);
        const typeCounts = aggregateTypes();
        const totalItems = acceptedSources.reduce((sum, source) => sum + source.total_items, 0);
        byId("stat-items").textContent = String(totalItems);
        byId("stat-sources").textContent = String(acceptedSources.length);
        byId("stat-types").textContent = String(Object.keys(typeCounts).length);
        byId("source-count").textContent = acceptedSources.length + " 個有內容的來源";

        const sourceWrap = byId("sources");
        sourceWrap.replaceChildren();
        if (!acceptedSources.length) {
          sourceWrap.append(text("div", "這把 key 目前看不到任何 accepted Source／Memory。", "empty"));
        }
        for (const source of acceptedSources) {
          const card = text("div", "", "source");
          const top = text("div", "", "source-top");
          top.append(text("strong", source.name || source.source));
          top.append(text("small", source.total_items + " 筆"));
          card.append(top);
          card.append(text("small", source.source + " · " + source.kind));
          const typeText = Object.entries(source.types || {})
            .sort((a, b) => Number(b[1]) - Number(a[1]))
            .map((pair) => pair[0] + " " + pair[1])
            .join(" · ");
          card.append(text("div", typeText || "尚無 accepted items", "source-types"));
          sourceWrap.append(card);
        }

        const bars = byId("types");
        bars.replaceChildren();
        const entries = Object.entries(typeCounts).sort((a, b) => Number(b[1]) - Number(a[1]));
        const max = entries.length ? Math.max.apply(null, entries.map((entry) => Number(entry[1]))) : 1;
        for (const entry of entries) {
          const row = document.createElement("div");
          const meta = text("div", "", "bar-meta");
          meta.append(text("span", entry[0]));
          meta.append(text("strong", entry[1]));
          row.append(meta);
          const track = text("div", "", "track");
          const fill = text("div", "", "fill");
          fill.style.width = Math.max(5, Number(entry[1]) / max * 100) + "%";
          track.append(fill);
          row.append(track);
          bars.append(row);
        }
        if (!entries.length) bars.append(text("div", "尚無類型統計。", "empty"));

        const sourceSelect = byId("source-filter");
        const currentSource = sourceSelect.value;
        sourceSelect.replaceChildren();
        addOption(sourceSelect, "", "全部來源");
        for (const source of sources) addOption(sourceSelect, source.source, source.name || source.source);
        sourceSelect.value = currentSource;

        const typeSelect = byId("type-filter");
        const currentType = typeSelect.value;
        typeSelect.replaceChildren();
        addOption(typeSelect, "", "全部類型");
        for (const entry of entries) addOption(typeSelect, entry[0], entry[0]);
        typeSelect.value = currentType;
      }

      function renderItems() {
        const wrap = byId("memories");
        wrap.replaceChildren();
        byId("stat-visible").textContent = String(items.length);
        byId("result-note").textContent = items.length + " 筆（單次最多 100 筆）";
        if (!items.length) {
          selectedId = null;
          byId("empty").classList.remove("hidden");
          byId("detail").classList.add("hidden");
          wrap.append(text("div", "沒有符合條件的 accepted 持久資訊。", "empty"));
          return;
        }
        for (const item of items) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "memory" + (selectedId === item.id ? " active" : "");
          button.append(chip(item.information_class || "source"));
          button.append(chip(item.type));
          if (item.sensitivity === "private") button.append(chip("private", "private"));
          button.append(text("div", item.title, "memory-title"));
          const meta = text("div", "", "meta");
          meta.append(text("span", item.source));
          meta.append(text("span", item.status));
          meta.append(text("span", formatTime(item.occurred_at || item.created_at)));
          button.append(meta);
          button.addEventListener("click", () => selectItem(item.id));
          wrap.append(button);
        }
      }

      function addFact(label, value) {
        const wrap = document.createElement("div");
        wrap.className = "datum";
        wrap.append(text("dt", label));
        wrap.append(text("dd", value));
        byId("facts").append(wrap);
      }

      function selectItem(id) {
        const item = items.find((candidate) => candidate.id === id);
        if (!item) return;
        selectedId = id;
        renderItems();
        byId("empty").classList.add("hidden");
        byId("detail").classList.remove("hidden");
        const badges = byId("badges");
        badges.replaceChildren(chip(item.trust_state), chip(item.authority, "authority"), chip(item.information_class || "source"), chip(item.type));
        if (item.memory_kind) badges.append(chip(item.memory_kind));
        if (item.sensitivity === "private") badges.append(chip("private", "private"));
        byId("title").textContent = item.title;
        byId("subtitle").replaceChildren(
          text("span", "source: " + item.source),
          text("span", "namespace: " + item.namespace),
          text("span", "revision: " + item.revision)
        );
        byId("facts").replaceChildren();
        addFact("建立時間", formatTime(item.created_at));
        addFact("事件時間", formatTime(item.occurred_at));
        addFact("更新時間", formatTime(item.updated_at));
        addFact("生命週期", item.status);
        addFact("資訊角色", item.information_class);
        addFact("Memory 類型", item.memory_kind);
        addFact("Claim key", item.claim_key);
        addFact("有效起點", formatTime(item.valid_from));
        addFact("有效終點", formatTime(item.valid_until));
        addFact("最後驗證", formatTime(item.last_verified_at));
        addFact("衰減策略", item.decay_policy);
        addFact("接受方式", item.acceptance_method);
        addFact("接受者", item.accepted_by);
        byId("content").textContent = item.content || "（無內容）";

        const hasData = item.data !== null && item.data !== undefined;
        byId("data-section").classList.toggle("hidden", !hasData);
        byId("data").textContent = hasData ? JSON.stringify(item.data, null, 2) : "";
        const relations = []
          .concat((item.tags || []).map((value) => "tag:" + value))
          .concat(item.entities || [])
          .concat((item.derived_from || []).map((value) => "evidence:" + value));
        byId("relations-section").classList.toggle("hidden", relations.length === 0);
        byId("relations").textContent = relations.join(" · ");
      }

      async function loadItems() {
        const params = new URLSearchParams();
        params.set("limit", "100");
        params.set("sort", "occurred");
        const query = byId("query").value.trim();
        const source = byId("source-filter").value;
        const type = byId("type-filter").value;
        const status = byId("status-filter").value;
        if (query) params.set("q", query);
        if (source) params.set("source", source);
        if (type) params.set("type", type);
        if (status) params.set("status", status);
        const response = await api("/v1/items?" + params.toString());
        items = response.items || [];
        if (!items.find((item) => item.id === selectedId)) selectedId = null;
        renderItems();
        if (selectedId) selectItem(selectedId);
      }

      async function connect() {
        token = tokenInput.value.trim();
        tokenInput.value = "";
        if (!token.startsWith("chk_")) {
          token = "";
          setStatus("請輸入有效的 client key。", true);
          return;
        }
        setStatus("正在讀取 namespace 內的 accepted Source／Memory…", false);
        try {
          const sourceResponse = await api("/v1/sources");
          sources = sourceResponse.sources || [];
          renderOverview();
          await loadItems();
          workspace.classList.remove("hidden");
          setStatus("已連線；畫面只顯示這把 key 經 server-side policy 授權可讀的 accepted Source／Memory。", false);
        } catch (error) {
          token = "";
          workspace.classList.add("hidden");
          setStatus(error.message, true);
        }
      }

      byId("connect").addEventListener("click", connect);
      tokenInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") connect();
      });
      byId("search").addEventListener("click", async () => {
        try {
          await loadItems();
        } catch (error) {
          setStatus(error.message, true);
        }
      });
      byId("query").addEventListener("keydown", (event) => {
        if (event.key === "Enter") byId("search").click();
      });
    })();
  </script>
</body>
</html>`;

export function registerExploreUiRoutes(app: FastifyInstance, config?: Config): void {
  if (config?.controlCenterEnabled) return;
  app.get('/explore', async (_req, reply) => {
    return reply
      .header(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      )
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff')
      .type('text/html; charset=utf-8')
      .send(EXPLORE_HTML);
  });
}
